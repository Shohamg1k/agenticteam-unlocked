import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  FREE_FIRST_POLICY,
  matchRules,
  normalizePolicy,
  scoreCandidates,
  validatePolicy,
} from '../src/routing.js';
import type { RouteContext } from '../src/routing.js';
import { FakeAdapter, makeModel, makeQuota } from './helpers.js';

/** A representative provider set: local, free tier, subscription, and a paid key. */
function providerSet() {
  return [
    new FakeAdapter({
      id: 'ollama',
      name: 'Ollama',
      kind: 'local',
      models: [
        makeModel({
          id: 'qwen2.5-coder',
          capabilities: ['cheap-ok', 'code'],
          contextWindow: 32_000,
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          throughputTps: 30,
        }),
      ],
    }),
    new FakeAdapter({
      id: 'groq',
      name: 'Groq',
      kind: 'free-cloud',
      models: [
        makeModel({
          id: 'gpt-oss-120b',
          capabilities: ['cheap-ok', 'code', 'strong-reasoning'],
          contextWindow: 128_000,
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          throughputTps: 400,
        }),
      ],
      quota: makeQuota({ limitRpm: 30, limitRpd: 1000 }),
    }),
    new FakeAdapter({
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'subscription',
      models: [
        makeModel({
          id: 'claude-opus-5',
          capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
          contextWindow: 200_000,
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          throughputTps: 45,
        }),
      ],
    }),
    new FakeAdapter({
      id: 'anthropic',
      name: 'Anthropic API',
      kind: 'byok',
      models: [
        makeModel({
          id: 'claude-sonnet-5',
          capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'vision', 'tool-use'],
          contextWindow: 200_000,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
          throughputTps: 80,
        }),
      ],
    }),
    new FakeAdapter({
      id: 'google',
      name: 'Google',
      kind: 'byok',
      models: [
        makeModel({
          id: 'gemini-long',
          capabilities: ['code', 'long-context', 'strong-reasoning', 'vision'],
          contextWindow: 1_000_000,
          pricing: { inputPerMTok: 1.25, outputPerMTok: 5 },
          throughputTps: 100,
        }),
      ],
    }),
  ];
}

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    task: { capability: 'code', complexity: 3, title: 'Do a thing', description: '' },
    mode: 'instant',
    contextTokens: 4_000,
    ...over,
  } as RouteContext;
}

describe('scoreCandidates', () => {
  it('picks something and explains why', () => {
    const d = scoreCandidates(providerSet(), DEFAULT_ROUTING_POLICY, ctx());
    expect(d.chosen).toBeDefined();
    expect(d.explanation).toMatch(/for code at complexity 3/);
  });

  it('routes trivial cheap-ok work to a free provider', () => {
    const d = scoreCandidates(
      providerSet(),
      DEFAULT_ROUTING_POLICY,
      ctx({ task: { capability: 'cheap-ok', complexity: 1, title: 'Rename a variable', description: '' } }),
    );
    expect(d.chosen!.estimatedCostUsd).toBe(0);
    expect(['ollama', 'groq']).toContain(d.chosen!.providerId);
  });

  it('routes hard architecture work to a strong reasoner', () => {
    const d = scoreCandidates(
      providerSet(),
      DEFAULT_ROUTING_POLICY,
      ctx({
        task: {
          capability: 'strong-reasoning',
          complexity: 5,
          title: 'Design the data model',
          description: '',
          role: 'architect',
        },
      }),
    );
    expect(['claude-code', 'anthropic', 'openai']).toContain(d.chosen!.providerId);
  });

  it('routes an oversized context to the long-context model, ignoring price', () => {
    const d = scoreCandidates(providerSet(), DEFAULT_ROUTING_POLICY, ctx({ contextTokens: 400_000 }));
    expect(d.chosen!.providerId).toBe('google');
  });

  it('excludes every model whose window cannot hold the pack', () => {
    const d = scoreCandidates(providerSet(), DEFAULT_ROUTING_POLICY, ctx({ contextTokens: 400_000 }));
    expect(
      d.rejected.some((r) => r.providerId === 'ollama' && /context window too small/.test(r.excluded!)),
    ).toBe(true);
  });

  it('honours a user pin above everything else', () => {
    const d = scoreCandidates(
      providerSet(),
      DEFAULT_ROUTING_POLICY,
      ctx({
        task: {
          capability: 'cheap-ok',
          complexity: 1,
          title: 'trivial',
          description: '',
          pinnedProviderId: 'anthropic',
        },
      }),
    );
    expect(d.chosen!.providerId).toBe('anthropic');
    expect(d.explanation).toMatch(/pinned by you/);
  });

  it("prefers the planner's choice, but does not treat it as a pin", () => {
    const withPlan = scoreCandidates(
      providerSet(),
      DEFAULT_ROUTING_POLICY,
      ctx({
        task: { capability: 'code', complexity: 3, title: 't', description: '', plannedProviderId: 'google' },
      }),
    );
    expect(withPlan.chosen!.providerId).toBe('google');

    // Same plan, but the planner named a provider that is cooling down.
    const providers = providerSet();
    providers.find((p) => p.id === 'google')!.quota = makeQuota({ cooldownUntil: Date.now() + 60_000 });
    const cooled = scoreCandidates(
      providers,
      DEFAULT_ROUTING_POLICY,
      ctx({
        task: { capability: 'code', complexity: 3, title: 't', description: '', plannedProviderId: 'google' },
      }),
    );
    expect(cooled.chosen!.providerId).not.toBe('google');
  });

  it('skips a provider on cooldown and says so', () => {
    const providers = providerSet();
    providers.find((p) => p.id === 'groq')!.quota = makeQuota({ cooldownUntil: Date.now() + 5 * 60_000 });
    const d = scoreCandidates(providers, DEFAULT_ROUTING_POLICY, ctx());
    expect(d.ladder.map((c) => c.providerId)).not.toContain('groq');
    expect(d.rejected.find((r) => r.providerId === 'groq')!.excluded).toMatch(/cooling down/);
  });

  it('skips a provider that is out of requests for the window', () => {
    const providers = providerSet();
    providers.find((p) => p.id === 'groq')!.quota = makeQuota({ limitRpm: 30, usedMinute: 30 });
    const d = scoreCandidates(providers, DEFAULT_ROUTING_POLICY, ctx());
    expect(d.rejected.find((r) => r.providerId === 'groq')!.excluded).toMatch(/rate limit/);
  });

  it('drops a candidate that would cost more than the per-task ceiling', () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, maxTaskCostUsd: 0.001 };
    const d = scoreCandidates(providerSet(), policy, ctx({ contextTokens: 150_000 }));
    expect(d.ladder.every((c) => c.estimatedCostUsd <= 0.001)).toBe(true);
  });

  it('lets a pin through the per-task cost ceiling', () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, maxTaskCostUsd: 0.0001 };
    const d = scoreCandidates(
      providerSet(),
      policy,
      ctx({
        contextTokens: 150_000,
        task: {
          capability: 'code',
          complexity: 3,
          title: 't',
          description: '',
          pinnedProviderId: 'anthropic',
        },
      }),
    );
    expect(d.chosen!.providerId).toBe('anthropic');
  });

  it('respects disabledProviders', () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, disabledProviders: ['anthropic', 'google'] };
    const d = scoreCandidates(providerSet(), policy, ctx());
    expect(d.ladder.map((c) => c.providerId)).not.toContain('anthropic');
    expect(d.rejected.find((r) => r.providerId === 'anthropic')!.excluded).toBe('excluded by policy');
  });

  it('builds a failover ladder with one entry per provider', () => {
    const providers = providerSet();
    providers[0]!.models.push(
      makeModel({ id: 'second-model', capabilities: ['code'], contextWindow: 32_000 }),
    );
    const d = scoreCandidates(providers, DEFAULT_ROUTING_POLICY, ctx());
    const ids = d.ladder.map((c) => c.providerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns no choice when nothing is eligible, and explains it', () => {
    const d = scoreCandidates([], DEFAULT_ROUTING_POLICY, ctx());
    expect(d.chosen).toBeUndefined();
    expect(d.explanation).toMatch(/no providers are connected/);
  });

  it('exposes a per-axis breakdown for every candidate', () => {
    const d = scoreCandidates(providerSet(), DEFAULT_ROUTING_POLICY, ctx());
    expect(Object.keys(d.chosen!.breakdown).sort()).toEqual([
      'capability',
      'context',
      'cost',
      'latency',
      'quota',
      'reliability',
      'tier',
    ]);
  });

  it('free-first never spends money on routine work', () => {
    const d = scoreCandidates(providerSet(), FREE_FIRST_POLICY, ctx());
    expect(d.chosen!.estimatedCostUsd).toBe(0);
  });

  it('gives partial credit rather than stranding a task with no exact capability match', () => {
    const onlyStrong = [
      new FakeAdapter({
        id: 'anthropic',
        kind: 'byok',
        models: [makeModel({ id: 'm', capabilities: ['strong-reasoning'] })],
      }),
    ];
    const d = scoreCandidates(
      onlyStrong,
      DEFAULT_ROUTING_POLICY,
      ctx({ task: { capability: 'code', complexity: 2, title: 't', description: '' } }),
    );
    expect(d.chosen).toBeDefined();
    expect(d.chosen!.breakdown.capability).toBeCloseTo(0.45);
  });

  it('rejects a provider with no usable capability at all', () => {
    const visionOnly = [
      new FakeAdapter({ id: 'v', kind: 'byok', models: [makeModel({ id: 'm', capabilities: ['vision'] })] }),
    ];
    const d = scoreCandidates(
      visionOnly,
      DEFAULT_ROUTING_POLICY,
      ctx({ task: { capability: 'code', complexity: 2, title: 't', description: '' } }),
    );
    expect(d.chosen).toBeUndefined();
    expect(d.rejected[0]!.excluded).toMatch(/no code capability/);
  });
});

describe('matchRules', () => {
  it('matches on capability and complexity together', () => {
    const names = matchRules(
      DEFAULT_ROUTING_POLICY,
      ctx({ task: { capability: 'cheap-ok', complexity: 1, title: 't', description: '' } }),
    ).map((r) => r.name);
    expect(names).toContain('Boilerplate, refactors and mechanical edits go cheap and fast');
  });

  it('stops at a rule marked stop', () => {
    const rules = matchRules(DEFAULT_ROUTING_POLICY, ctx({ contextTokens: 500_000 }));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('Oversized context wins outright');
  });

  it('skips a rule with a malformed regex instead of throwing', () => {
    const policy = {
      ...DEFAULT_ROUTING_POLICY,
      rules: [{ name: 'bad', when: { titleMatches: '([unclosed' } }],
    };
    expect(() => matchRules(policy, ctx())).not.toThrow();
    expect(matchRules(policy, ctx())).toEqual([]);
  });

  it('matches on a title regex', () => {
    const policy = {
      ...DEFAULT_ROUTING_POLICY,
      rules: [{ name: 'migrations', when: { titleMatches: 'migration' }, prefer: ['anthropic'] }],
    };
    expect(
      matchRules(
        policy,
        ctx({ task: { capability: 'code', complexity: 2, title: 'Add a Migration', description: '' } }),
      ),
    ).toHaveLength(1);
    expect(matchRules(policy, ctx())).toHaveLength(0);
  });
});

describe('validatePolicy', () => {
  it('accepts every built-in policy', () => {
    expect(validatePolicy(DEFAULT_ROUTING_POLICY)).toEqual([]);
    expect(validatePolicy(FREE_FIRST_POLICY)).toEqual([]);
  });

  it('reports a missing name and bad weights together', () => {
    const problems = validatePolicy({ id: 'x', weights: { capability: -1 } });
    expect(problems.map((p) => p.path)).toContain('name');
    expect(problems.map((p) => p.path)).toContain('weights.capability');
  });

  it('reports an invalid rule regex with its index', () => {
    const problems = validatePolicy({
      ...DEFAULT_ROUTING_POLICY,
      rules: [{ name: 'r', when: { titleMatches: '([' } }],
    });
    expect(problems[0]!.path).toBe('rules[0].when.titleMatches');
  });

  it('rejects a non-object', () => {
    expect(validatePolicy(null)).toHaveLength(1);
  });
});

describe('normalizePolicy', () => {
  it('fills in defaults for a partial policy', () => {
    const p = normalizePolicy({ id: 'mine', name: 'Mine' });
    expect(p.weights.capability).toBeGreaterThan(0);
    expect(p.rules).toEqual([]);
    expect(validatePolicy(p)).toEqual([]);
  });
});
