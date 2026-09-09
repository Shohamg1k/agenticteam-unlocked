import type { QuotaState, TokenUsage, UsageRollup } from '@agentic/core';
import { log } from './log.js';
import { nodePaths, readJson, writeJsonAtomic } from './paths.js';

/**
 * Quota ledgers and usage accounting.
 *
 * Two things are tracked, per provider **per account**:
 *   - requests, in sliding minute and day windows, against the provider's own
 *     declared caps;
 *   - tokens and cost, per day, for the cost dashboard.
 *
 * Per-account is the point: swapping to a second Groq key must swap to a clean
 * free-tier budget, not inherit the exhausted one.
 *
 * A cooldown is separate from a cap. Caps are what we predict; a cooldown is
 * what the provider told us after refusing a call. The router respects both.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Keep 30 days of per-day rollups; enough for the dashboard, bounded on disk. */
const RETAIN_DAYS = 30;

interface Bucket {
  /** Epoch ms of each request in the trailing day. Pruned on read. */
  requests: number[];
  /** Per-day totals, keyed YYYY-MM-DD. */
  days: Record<string, { input: number; output: number; costUsd: number; calls: number }>;
  cooldownUntil?: number;
}

interface Ledger {
  buckets: Record<string, Bucket>;
  /** Active account per provider. */
  activeAccount: Record<string, string>;
}

const ledger: Ledger = { buckets: {}, activeAccount: {} };
let loaded = false;
let dirty = false;

export function loadQuota(): void {
  if (loaded) return;
  loaded = true;
  const stored = readJson<Partial<Ledger>>(nodePaths().quota, {});
  ledger.buckets = stored.buckets ?? {};
  ledger.activeAccount = stored.activeAccount ?? {};
  for (const key of Object.keys(ledger.buckets)) prune(key);
}

export function saveQuota(): void {
  if (!dirty) return;
  dirty = false;
  writeJsonAtomic(nodePaths().quota, ledger);
}

/** Flushed on a timer by the server rather than on every request. */
export function startQuotaAutosave(intervalMs = 10_000): () => void {
  const timer = setInterval(saveQuota, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    saveQuota();
  };
}

export function activeAccount(providerId: string): string {
  return ledger.activeAccount[providerId] ?? 'default';
}

export function setActiveAccount(providerId: string, account: string): void {
  ledger.activeAccount[providerId] = account;
  dirty = true;
  saveQuota();
  log(`${providerId}: switched to account "${account}" — its own quota counters apply`);
}

function bucketKey(providerId: string, account = activeAccount(providerId)): string {
  return account === 'default' ? providerId : `${providerId}#${account}`;
}

function bucket(providerId: string, account?: string): Bucket {
  const key = bucketKey(providerId, account);
  const existing = ledger.buckets[key];
  if (existing) return existing;
  const fresh: Bucket = { requests: [], days: {} };
  ledger.buckets[key] = fresh;
  return fresh;
}

function prune(key: string): void {
  const b = ledger.buckets[key];
  if (!b) return;
  const now = Date.now();
  b.requests = b.requests.filter((t) => now - t < DAY);
  const days = Object.keys(b.days).sort();
  while (days.length > RETAIN_DAYS) delete b.days[days.shift()!];
}

const today = () => new Date().toISOString().slice(0, 10);

/** Record one request against a provider's request windows. */
export function recordRequest(providerId: string): void {
  const b = bucket(providerId);
  b.requests.push(Date.now());
  prune(bucketKey(providerId));
  dirty = true;
}

/** Record the token and cost outcome of one completed call. */
export function recordUsage(providerId: string, usage: TokenUsage): void {
  const b = bucket(providerId);
  const day = (b.days[today()] ??= { input: 0, output: 0, costUsd: 0, calls: 0 });
  day.input += Math.max(0, Math.round(usage.input));
  day.output += Math.max(0, Math.round(usage.output));
  day.costUsd += Math.max(0, usage.costUsd);
  day.calls += 1;
  dirty = true;
}

/**
 * Take a provider out of rotation after it reported exhaustion.
 *
 * `retryAfterMs` from the provider is respected when it gives one — it knows
 * better than our default — but is clamped, because a provider claiming a
 * 24-hour retry-after would silently remove it for the rest of the session
 * when the real window is usually much shorter.
 */
export function startCooldown(providerId: string, defaultMs: number, retryAfterMs?: number): number {
  const ms = Math.min(retryAfterMs ?? defaultMs, 60 * 60_000);
  const until = Date.now() + ms;
  bucket(providerId).cooldownUntil = until;
  dirty = true;
  saveQuota();
  const when = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  log(
    `${providerId} reported its usage limit — cooling down until ${when}. ` +
      'Work in flight fails over to the next provider with its full context.',
    'warn',
  );
  return until;
}

export function clearCooldown(providerId: string): void {
  const b = ledger.buckets[bucketKey(providerId)];
  if (b?.cooldownUntil) {
    delete b.cooldownUntil;
    dirty = true;
  }
}

export interface Limits {
  rpm?: number;
  rpd?: number;
}

export function quotaState(providerId: string, limits?: Limits): QuotaState {
  const key = bucketKey(providerId);
  prune(key);
  const b = ledger.buckets[key] ?? { requests: [], days: {} };
  const now = Date.now();
  const minuteHits = b.requests.filter((t) => now - t < MINUTE);
  const day = b.days[today()] ?? { input: 0, output: 0, costUsd: 0, calls: 0 };

  return {
    usedMinute: minuteHits.length,
    usedDay: b.requests.length,
    limitRpm: limits?.rpm,
    limitRpd: limits?.rpd,
    tokensToday: { input: day.input, output: day.output },
    costTodayUsd: day.costUsd,
    resetMinuteAt: minuteHits.length ? minuteHits[0]! + MINUTE : undefined,
    resetDayAt: b.requests.length ? b.requests[0]! + DAY : undefined,
    cooldownUntil: b.cooldownUntil && b.cooldownUntil > now ? b.cooldownUntil : undefined,
    account: activeAccount(providerId),
  };
}

// ---------------------------------------------------------------------------
// Cost dashboard
// ---------------------------------------------------------------------------

export interface RollupInput {
  providerId: string;
  name: string;
}

/**
 * Aggregate usage for the cost dashboard.
 *
 * `baselineCostUsd` answers "what did routing actually save?" by repricing
 * today's tokens as if every call had gone to the most expensive connected
 * model. It is a counterfactual, not a measurement, and the UI labels it as
 * one — but it is the only honest way to show the value of routing, because
 * the cheap calls that never happened leave no trace.
 */
export function usageRollup(
  providers: RollupInput[],
  mostExpensivePerMTok: { in: number; out: number },
): UsageRollup {
  const byProvider: UsageRollup['byProvider'] = [];
  const dailyMap = new Map<string, { costUsd: number; tokensIn: number; tokensOut: number; calls: number }>();
  let totalCostUsd = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const p of providers) {
    const key = bucketKey(p.providerId);
    prune(key);
    const b = ledger.buckets[key];
    if (!b) {
      byProvider.push({
        providerId: p.providerId,
        name: p.name,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      });
      continue;
    }

    let calls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    for (const [day, totals] of Object.entries(b.days)) {
      calls += totals.calls;
      tokensIn += totals.input;
      tokensOut += totals.output;
      costUsd += totals.costUsd;

      const acc = dailyMap.get(day) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0, calls: 0 };
      acc.costUsd += totals.costUsd;
      acc.tokensIn += totals.input;
      acc.tokensOut += totals.output;
      acc.calls += totals.calls;
      dailyMap.set(day, acc);
    }

    byProvider.push({ providerId: p.providerId, name: p.name, calls, tokensIn, tokensOut, costUsd });
    totalCostUsd += costUsd;
    totalIn += tokensIn;
    totalOut += tokensOut;
  }

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, totals]) => ({ day, ...totals }));

  const baselineCostUsd =
    (totalIn / 1_000_000) * mostExpensivePerMTok.in + (totalOut / 1_000_000) * mostExpensivePerMTok.out;

  return {
    byProvider: byProvider.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    daily,
    totalCostUsd,
    baselineCostUsd,
  };
}

/** Reset every counter. Exposed in settings for users who rotate keys. */
export function resetLedger(): void {
  ledger.buckets = {};
  dirty = true;
  saveQuota();
  log('Quota and usage ledgers reset');
}
