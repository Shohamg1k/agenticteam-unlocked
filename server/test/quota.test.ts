import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The quota ledger and cooldowns — the mechanism behind loss-free failover
 * (ADR 0006). A cooldown that does not expire strands a provider for the
 * session; one that is not recorded means the router keeps hitting a wall.
 *
 * The data directory is redirected before the module loads, so a test run never
 * touches a developer's real ledger.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-quota-test-'));
process.env.AGENTIC_DATA_DIR = dataDir;

const {
  activeAccount,
  clearCooldown,
  loadQuota,
  quotaState,
  recordRequest,
  recordUsage,
  resetLedger,
  setActiveAccount,
  startCooldown,
  usageRollup,
} = await import('../src/quota.js');

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  loadQuota();
  resetLedger();
});

describe('request ledger', () => {
  it('starts empty', () => {
    const state = quotaState('groq', { rpm: 30, rpd: 1000 });
    expect(state.usedMinute).toBe(0);
    expect(state.usedDay).toBe(0);
    expect(state.limitRpm).toBe(30);
  });

  it('counts requests in both windows', () => {
    recordRequest('groq');
    recordRequest('groq');
    const state = quotaState('groq');
    expect(state.usedMinute).toBe(2);
    expect(state.usedDay).toBe(2);
  });

  it('keeps providers separate', () => {
    recordRequest('groq');
    expect(quotaState('anthropic').usedDay).toBe(0);
  });

  it('reports when the minute window frees a slot', () => {
    recordRequest('groq');
    const state = quotaState('groq');
    expect(state.resetMinuteAt).toBeGreaterThan(Date.now());
    expect(state.resetMinuteAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('token and cost ledger', () => {
  it('accumulates tokens and cost for the day', () => {
    recordUsage('anthropic', { input: 1_000, output: 500, costUsd: 0.0175, measured: true });
    recordUsage('anthropic', { input: 2_000, output: 100, costUsd: 0.0125, measured: true });

    const state = quotaState('anthropic');
    expect(state.tokensToday).toEqual({ input: 3_000, output: 600 });
    expect(state.costTodayUsd).toBeCloseTo(0.03, 4);
  });

  it('ignores negative token counts rather than corrupting the total', () => {
    recordUsage('groq', { input: -5, output: 10, costUsd: 0, measured: false });
    expect(quotaState('groq').tokensToday.input).toBe(0);
  });
});

describe('cooldowns', () => {
  it('is absent until a provider reports exhaustion', () => {
    expect(quotaState('groq').cooldownUntil).toBeUndefined();
  });

  it('is set by startCooldown and reported', () => {
    const until = startCooldown('groq', 10 * 60_000);
    expect(until).toBeGreaterThan(Date.now());
    expect(quotaState('groq').cooldownUntil).toBe(until);
  });

  it("respects the provider's own retry-after when it gives one", () => {
    const until = startCooldown('groq', 10 * 60_000, 30_000);
    // The provider knows better than our default.
    expect(until - Date.now()).toBeLessThan(60_000);
  });

  it('clamps an absurd retry-after to an hour', () => {
    // A provider claiming a 24-hour retry-after would otherwise remove itself
    // for the whole session, which is worse than retrying and being refused.
    const until = startCooldown('groq', 60_000, 24 * 3_600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  it('can be cleared', () => {
    startCooldown('groq', 60_000);
    clearCooldown('groq');
    expect(quotaState('groq').cooldownUntil).toBeUndefined();
  });

  it('reports as absent once it has passed', () => {
    // A cooldown is never permanent — free tiers come back.
    startCooldown('groq', 60_000, 1);
    expect(quotaState('groq').cooldownUntil).toBeUndefined();
  });
});

describe('accounts', () => {
  it('defaults to "default"', () => {
    expect(activeAccount('groq')).toBe('default');
  });

  it('gives a switched account its own counters', () => {
    recordRequest('groq');
    expect(quotaState('groq').usedDay).toBe(1);

    // The point of multi-account: a second key starts on a clean free tier
    // rather than inheriting the exhausted one.
    setActiveAccount('groq', 'work');
    expect(quotaState('groq').usedDay).toBe(0);
    expect(quotaState('groq').account).toBe('work');

    setActiveAccount('groq', 'default');
    expect(quotaState('groq').usedDay).toBe(1);
  });
});

describe('usageRollup', () => {
  it('totals per provider and computes the routing counterfactual', () => {
    recordUsage('groq', { input: 100_000, output: 20_000, costUsd: 0, measured: true });
    recordUsage('anthropic', { input: 10_000, output: 2_000, costUsd: 0.1, measured: true });

    const rollup = usageRollup(
      [
        { providerId: 'groq', name: 'Groq' },
        { providerId: 'anthropic', name: 'Anthropic' },
      ],
      { in: 5, out: 25 },
    );

    expect(rollup.totalCostUsd).toBeCloseTo(0.1, 4);
    // 110k in at $5/M + 22k out at $25/M = $0.55 + $0.55 = $1.10
    expect(rollup.baselineCostUsd).toBeCloseTo(1.1, 3);
    // The saving is the whole reason routing is worth explaining.
    expect(rollup.baselineCostUsd).toBeGreaterThan(rollup.totalCostUsd);
  });

  it('lists a provider with no usage as zero rather than omitting it', () => {
    const rollup = usageRollup([{ providerId: 'openai', name: 'OpenAI' }], { in: 5, out: 25 });
    expect(rollup.byProvider).toHaveLength(1);
    expect(rollup.byProvider[0]?.calls).toBe(0);
  });
});
