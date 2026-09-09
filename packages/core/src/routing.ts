import { estimateTokens, hasRequestHeadroom, onCooldown, priceOf } from './provider.js';
import type { ProviderAdapter } from './provider.js';
import type { Capability, ModelDescriptor, ProviderKind, Task, TeamRole } from './types.js';

/**
 * Model routing.
 *
 * The router answers one question: given a task and the providers that are up
 * right now, which (provider, model) pair should run it, and what is the
 * fallback order if that pair fails?
 *
 * Two properties matter more than cleverness here:
 *
 *  1. It must be EXPLAINABLE. Every decision returns the score breakdown that
 *     produced it, and the UI shows it. A router the user cannot audit is a
 *     router the user will override blindly.
 *
 *  2. It must be DATA, not code. The policy is a JSON document the user edits
 *     in the settings UI. Adding "send UI work to Gemini" must never require a
 *     release.
 */

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------

/** Which axis a weight applies to. All are normalised to 0-1 before weighting. */
export interface RoutingWeights {
  /** Prefer providers whose declared capabilities cover the task's need. */
  capability: number;
  /** Prefer cheaper. Free providers score 1. */
  cost: number;
  /** Prefer faster (higher tokens/sec). */
  latency: number;
  /** Prefer models whose context window comfortably fits the packed context. */
  context: number;
  /** Prefer providers with quota headroom left. */
  quota: number;
  /** Prefer lower ladder tiers (local -> free -> subscription -> BYOK). */
  tier: number;
  /** Prefer models with a track record on this capability in this project. */
  reliability: number;
}

export interface RoutingRule {
  /** Shown in the UI and in the explanation. */
  name: string;
  /** All present conditions must match. An empty `when` matches everything. */
  when: {
    capability?: Capability[];
    role?: TeamRole[];
    /** Inclusive complexity range, 1-5. */
    complexityAtLeast?: number;
    complexityAtMost?: number;
    /** Match tasks whose title/description matches this (case-insensitive) regex. */
    titleMatches?: string;
    /** Match only when the packed context exceeds this many tokens. */
    contextTokensAtLeast?: number;
    /** Match only in this development mode. */
    mode?: ('instant' | 'professional')[];
  };
  /** Providers to prefer, in order. Unlisted providers stay eligible, ranked below. */
  prefer?: string[];
  /** Providers this rule refuses outright. */
  exclude?: string[];
  /** Pin a specific model. Only applied when the chosen provider offers it. */
  model?: string;
  /** Per-rule weight overrides, merged over the policy defaults. */
  weights?: Partial<RoutingWeights>;
  /** Skip the remaining rules once this one matches. */
  stop?: boolean;
}

export interface RoutingPolicy {
  id: string;
  name: string;
  description?: string;
  /** Base weights, before any rule override. */
  weights: RoutingWeights;
  /** Evaluated in order; later matches merge over earlier ones. */
  rules: RoutingRule[];
  /**
   * Providers never used, whatever the rules say. The user's "do not spend my
   * Anthropic key" switch.
   */
  disabledProviders: string[];
  /**
   * Hard USD ceiling for a single task. A candidate whose estimate exceeds this
   * is dropped, so an accidental long-context call cannot cost $40.
   */
  maxTaskCostUsd: number;
  /** How long a provider sits out after telling us it is exhausted. */
  cooldownMs: number;
}

// ---------------------------------------------------------------------------
// The default policy
// ---------------------------------------------------------------------------

export const DEFAULT_WEIGHTS: RoutingWeights = {
  capability: 3,
  cost: 2,
  latency: 1,
  context: 1.5,
  quota: 1.5,
  tier: 1,
  reliability: 1,
};

/**
 * The shipped default.
 *
 * The shape encodes the product thesis from the brief: hard thinking goes to
 * the strongest reasoner regardless of price, boilerplate goes to whatever is
 * fastest and free, UI work goes to a model with frontend taste, and anything
 * that will not fit goes to a long-context model before anything else is
 * considered.
 *
 * Provider ids referenced here are the built-in adapter ids. A rule naming a
 * provider the user has not connected is inert, not an error — that is what
 * makes one default policy work for a user with one key and a user with six.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  id: 'default',
  name: 'Balanced (default)',
  description:
    'Free and local capacity first for routine work; the strongest reasoner for architecture and security; long-context models when the pack is large.',
  weights: DEFAULT_WEIGHTS,
  disabledProviders: [],
  maxTaskCostUsd: 1.5,
  cooldownMs: 10 * 60_000,
  rules: [
    {
      name: 'Oversized context wins outright',
      when: { contextTokensAtLeast: 120_000 },
      prefer: ['google', 'anthropic', 'openai', 'openrouter'],
      weights: { context: 6, cost: 0.5, capability: 3 },
      stop: true,
    },
    {
      name: 'Architecture, security and planning need the strongest reasoner',
      when: {
        capability: ['strong-reasoning'],
        role: ['architect', 'security-reviewer', 'lead', 'product-manager'],
        complexityAtLeast: 3,
      },
      prefer: ['claude-code', 'anthropic', 'openai', 'google'],
      weights: { capability: 5, reliability: 2, cost: 0.5, tier: 0.5 },
    },
    {
      name: 'Hard reasoning, whatever the role',
      when: { capability: ['strong-reasoning'], complexityAtLeast: 4 },
      prefer: ['claude-code', 'anthropic', 'openai'],
      weights: { capability: 5, cost: 0.5 },
    },
    {
      name: 'Frontend and UI polish',
      when: { capability: ['frontend'], role: ['frontend-engineer', 'ux-designer'] },
      prefer: ['anthropic', 'claude-code', 'google', 'openrouter'],
      weights: { capability: 4, latency: 1.5 },
    },
    {
      name: 'Boilerplate, refactors and mechanical edits go cheap and fast',
      when: { capability: ['cheap-ok'], complexityAtMost: 2 },
      prefer: ['ollama', 'groq', 'openrouter', 'google'],
      weights: { cost: 4, latency: 3, tier: 2, capability: 2 },
    },
    {
      name: 'Tests and QA favour fast iteration over depth',
      when: { role: ['qa-engineer'], complexityAtMost: 3 },
      prefer: ['groq', 'openrouter', 'anthropic'],
      weights: { latency: 2.5, cost: 2.5 },
    },
    {
      name: 'Docs and release notes are cheap work',
      when: { role: ['tech-writer'] },
      prefer: ['groq', 'google', 'ollama', 'openrouter'],
      weights: { cost: 3, latency: 2 },
    },
  ],
};

/** A second shipped policy, for users who want to spend nothing. */
export const FREE_FIRST_POLICY: RoutingPolicy = {
  id: 'free-first',
  name: 'Free first',
  description: 'Never spend money unless nothing free can do the job. Local and free tiers exhausted first.',
  weights: { ...DEFAULT_WEIGHTS, cost: 6, tier: 4, latency: 0.5 },
  disabledProviders: [],
  maxTaskCostUsd: 0.25,
  cooldownMs: 5 * 60_000,
  rules: [
    {
      name: 'Everything free-first',
      when: {},
      prefer: ['ollama', 'groq', 'google', 'claude-code', 'openrouter'],
      weights: { cost: 6, tier: 4 },
    },
    {
      name: 'Only escalate for genuinely hard reasoning',
      when: { capability: ['strong-reasoning'], complexityAtLeast: 5 },
      prefer: ['claude-code', 'anthropic', 'openai'],
      weights: { capability: 5, cost: 2 },
    },
  ],
};

/** A policy for users who care about wall-clock above all. */
export const QUALITY_FIRST_POLICY: RoutingPolicy = {
  id: 'quality-first',
  name: 'Quality first',
  description: 'Route to the most capable model available for every task. Use when correctness beats cost.',
  weights: { ...DEFAULT_WEIGHTS, capability: 6, reliability: 3, cost: 0.25, tier: 0.25 },
  disabledProviders: [],
  maxTaskCostUsd: 8,
  cooldownMs: 10 * 60_000,
  rules: [
    {
      name: 'Strongest available, always',
      when: {},
      prefer: ['claude-code', 'anthropic', 'openai', 'google'],
      weights: { capability: 6, cost: 0.25 },
    },
  ],
};

export const BUILTIN_POLICIES: RoutingPolicy[] = [
  DEFAULT_ROUTING_POLICY,
  FREE_FIRST_POLICY,
  QUALITY_FIRST_POLICY,
];

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

export interface RoutingCandidate {
  providerId: string;
  providerName: string;
  model: ModelDescriptor;
  kind: ProviderKind;
  tier: number;
  score: number;
  estimatedCostUsd: number;
  /** Per-axis normalised scores, before weighting. For the explanation panel. */
  breakdown: Record<keyof RoutingWeights, number>;
  /** Rules that matched this task, in order. */
  matchedRules: string[];
  /** Set when the candidate was excluded, with the reason. */
  excluded?: string;
}

export interface RoutingDecision {
  /** Best candidate, or undefined when nothing is eligible. */
  chosen?: RoutingCandidate;
  /** Full ladder, best first. Failover walks this list. */
  ladder: RoutingCandidate[];
  /** Everything that was ruled out, with reasons. Shown on demand. */
  rejected: RoutingCandidate[];
  /** One-line human explanation of the choice. */
  explanation: string;
}

export interface RouteContext {
  task: Pick<
    Task,
    'capability' | 'complexity' | 'title' | 'description' | 'pinnedProviderId' | 'plannedProviderId'
  > & {
    role?: TeamRole;
    plannedModel?: string;
  };
  mode: 'instant' | 'professional';
  /** Tokens in the packed context — decides context fit and cost. */
  contextTokens: number;
  /** Expected output tokens; defaults to a quarter of the model's max. */
  expectedOutputTokens?: number;
  /**
   * Observed success rate per `providerId:capability`, 0-1. Missing keys score
   * neutral (0.5) rather than 0 — an unused provider is unknown, not bad.
   */
  reliability?: Record<string, number>;
  now?: number;
}

/** Merge the policy's base weights with every matching rule's overrides. */
function resolveWeights(policy: RoutingPolicy, rules: RoutingRule[]): RoutingWeights {
  let w = { ...policy.weights };
  for (const r of rules) if (r.weights) w = { ...w, ...r.weights };
  return w;
}

export function matchRules(policy: RoutingPolicy, ctx: RouteContext): RoutingRule[] {
  const matched: RoutingRule[] = [];
  const haystack = `${ctx.task.title}\n${ctx.task.description}`.toLowerCase();

  for (const rule of policy.rules) {
    const w = rule.when ?? {};
    if (w.capability && !w.capability.includes(ctx.task.capability)) continue;
    if (w.role && (!ctx.task.role || !w.role.includes(ctx.task.role))) continue;
    if (w.complexityAtLeast !== undefined && ctx.task.complexity < w.complexityAtLeast) continue;
    if (w.complexityAtMost !== undefined && ctx.task.complexity > w.complexityAtMost) continue;
    if (w.contextTokensAtLeast !== undefined && ctx.contextTokens < w.contextTokensAtLeast) continue;
    if (w.mode && !w.mode.includes(ctx.mode)) continue;
    if (w.titleMatches) {
      let re: RegExp;
      try {
        re = new RegExp(w.titleMatches, 'i');
      } catch {
        // A malformed user regex must not take the router down; skip the rule.
        continue;
      }
      if (!re.test(haystack)) continue;
    }
    matched.push(rule);
    if (rule.stop) break;
  }
  return matched;
}

/** Squash an unbounded positive quantity into 0-1, where `mid` scores 0.5. */
function soft(value: number, mid: number): number {
  if (value <= 0) return 1;
  return mid / (mid + value);
}

function capabilityScore(model: ModelDescriptor, need: Capability): number {
  if (model.capabilities.includes(need)) return 1;
  // A strong reasoner can do cheap work; the reverse is not true. Partial credit
  // keeps a plan moving when the exact capability is offline, rather than
  // stranding the task — the verification gate is what catches a bad fit.
  const fallbacks: Record<Capability, Capability[]> = {
    'cheap-ok': ['code', 'strong-reasoning'],
    code: ['strong-reasoning'],
    'strong-reasoning': [],
    'long-context': [],
    vision: [],
    frontend: ['code', 'strong-reasoning'],
    'tool-use': ['code'],
  };
  return fallbacks[need].some((c) => model.capabilities.includes(c)) ? 0.45 : 0;
}

export function scoreCandidates(
  adapters: ProviderAdapter[],
  policy: RoutingPolicy,
  ctx: RouteContext,
): RoutingDecision {
  const now = ctx.now ?? Date.now();
  const rules = matchRules(policy, ctx);
  const weights = resolveWeights(policy, rules);
  const preferOrder = rules.flatMap((r) => r.prefer ?? []);
  const excluded = new Set([...policy.disabledProviders, ...rules.flatMap((r) => r.exclude ?? [])]);
  const pinnedModel = [...rules].reverse().find((r) => r.model)?.model;
  const ruleNames = rules.map((r) => r.name);

  const eligible: RoutingCandidate[] = [];
  const rejected: RoutingCandidate[] = [];

  // Highest tier present, used to normalise the tier axis without assuming 0-3.
  const maxTier = Math.max(1, ...adapters.map((a) => a.tier));

  for (const adapter of adapters) {
    const quota = adapter.getQuotaState();
    for (const model of adapter.models) {
      const outputTokens = ctx.expectedOutputTokens ?? Math.min(4_000, Math.floor(model.maxOutputTokens / 4));
      const estimate = adapter.estimateCost({
        model: model.id,
        inputTokens: ctx.contextTokens,
        outputTokens,
      });

      const capability = capabilityScore(model, ctx.task.capability);
      const fits = model.contextWindow >= ctx.contextTokens + outputTokens;
      const breakdown: Record<keyof RoutingWeights, number> = {
        capability,
        cost: estimate.free ? 1 : soft(estimate.usd, 0.05),
        latency: soft(1 / Math.max(1, model.throughputTps ?? 40), 1 / 60),
        // Headroom past the requirement, saturating at 2x — a 1M window is not
        // twice as good as a 400k one for a 200k pack.
        context: fits
          ? Math.min(1, model.contextWindow / Math.max(1, (ctx.contextTokens + outputTokens) * 2))
          : 0,
        quota: onCooldown(quota, now) ? 0 : hasRequestHeadroom(quota) ? 1 : 0.1,
        tier: 1 - adapter.tier / maxTier,
        reliability: ctx.reliability?.[`${adapter.id}:${ctx.task.capability}`] ?? 0.5,
      };

      let score = (Object.keys(weights) as (keyof RoutingWeights)[]).reduce(
        (sum, k) => sum + weights[k] * breakdown[k],
        0,
      );

      // Preference order is a nudge, not an override: a preferred provider that
      // is out of quota should still lose to an available one.
      const preferIdx = preferOrder.indexOf(adapter.id);
      if (preferIdx >= 0) score += (preferOrder.length - preferIdx) * 0.5;
      if (ctx.task.pinnedProviderId === adapter.id) score += 1000;
      else if (ctx.task.plannedProviderId === adapter.id) score += 3;
      if (pinnedModel && model.id === pinnedModel) score += 2;
      if (ctx.task.plannedModel && model.id === ctx.task.plannedModel) score += 1;

      const candidate: RoutingCandidate = {
        providerId: adapter.id,
        providerName: adapter.name,
        model,
        kind: adapter.kind,
        tier: adapter.tier,
        score,
        estimatedCostUsd: estimate.usd,
        breakdown,
        matchedRules: ruleNames,
      };

      const reason = rejectionReason(candidate, adapter, policy, ctx, excluded, fits, now);
      if (reason) rejected.push({ ...candidate, excluded: reason, score: 0 });
      else eligible.push(candidate);
    }
  }

  eligible.sort((a, b) => b.score - a.score);

  // One entry per provider in the ladder: failing over from a provider's best
  // model to its second-best rarely helps, and it burns a retry on the same
  // quota that just refused us.
  const ladder: RoutingCandidate[] = [];
  const seenProviders = new Set<string>();
  for (const c of eligible) {
    if (seenProviders.has(c.providerId)) continue;
    seenProviders.add(c.providerId);
    ladder.push(c);
  }

  const chosen = ladder[0];
  return { chosen, ladder, rejected, explanation: explain(chosen, rules, ctx, rejected) };
}

function rejectionReason(
  c: RoutingCandidate,
  adapter: ProviderAdapter,
  policy: RoutingPolicy,
  ctx: RouteContext,
  excluded: Set<string>,
  fits: boolean,
  now: number,
): string | undefined {
  if (excluded.has(adapter.id)) return 'excluded by policy';
  if (!fits) {
    return `context window too small (${c.model.contextWindow.toLocaleString()} < ${ctx.contextTokens.toLocaleString()} needed)`;
  }
  if (c.breakdown.capability === 0) return `no ${ctx.task.capability} capability`;
  const quota = adapter.getQuotaState();
  if (onCooldown(quota, now)) {
    const mins = Math.ceil(((quota.cooldownUntil ?? now) - now) / 60_000);
    return `cooling down after a usage limit (~${mins} min left)`;
  }
  if (!hasRequestHeadroom(quota)) return 'rate limit reached for this window';
  // A pin is an explicit instruction; honour it even past the ceiling and let
  // the budget guard raise it with the user instead of silently rerouting.
  if (c.estimatedCostUsd > policy.maxTaskCostUsd && ctx.task.pinnedProviderId !== adapter.id) {
    return `estimated $${c.estimatedCostUsd.toFixed(2)} exceeds the $${policy.maxTaskCostUsd.toFixed(2)} per-task ceiling`;
  }
  return undefined;
}

function explain(
  chosen: RoutingCandidate | undefined,
  rules: RoutingRule[],
  ctx: RouteContext,
  rejected: RoutingCandidate[],
): string {
  if (!chosen) {
    const why = rejected.length
      ? `${rejected.length} candidate(s) ruled out — ${rejected[0]!.excluded}`
      : 'no providers are connected';
    return `No provider can run this task: ${why}.`;
  }
  const rule = rules[rules.length - 1];
  const cost = chosen.estimatedCostUsd === 0 ? 'free' : `~$${chosen.estimatedCostUsd.toFixed(3)}`;
  const why =
    ctx.task.pinnedProviderId === chosen.providerId ? 'pinned by you' : (rule?.name ?? 'base weights');
  return `${chosen.providerName} / ${chosen.model.label} for ${ctx.task.capability} at complexity ${ctx.task.complexity} (${why}); ${cost}.`;
}

/**
 * Route a task. Convenience wrapper that takes text instead of a token count.
 */
export function route(
  adapters: ProviderAdapter[],
  policy: RoutingPolicy,
  ctx: Omit<RouteContext, 'contextTokens'> & { contextText: string },
): RoutingDecision {
  const { contextText, ...rest } = ctx;
  return scoreCandidates(adapters, policy, { ...rest, contextTokens: estimateTokens(contextText) });
}

/** Cost of a completed call at a model's published prices. Re-exported for callers. */
export { priceOf };

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

export interface PolicyProblem {
  path: string;
  message: string;
}

/**
 * Validate a user-edited policy. Returns problems rather than throwing, so the
 * settings editor can show them all at once next to the fields.
 */
export function validatePolicy(policy: unknown): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const p = policy as Partial<RoutingPolicy> | null;
  if (!p || typeof p !== 'object') return [{ path: '', message: 'Policy must be an object' }];
  if (!p.id) problems.push({ path: 'id', message: 'Required' });
  if (!p.name) problems.push({ path: 'name', message: 'Required' });

  const weightKeys: (keyof RoutingWeights)[] = [
    'capability',
    'cost',
    'latency',
    'context',
    'quota',
    'tier',
    'reliability',
  ];
  if (!p.weights || typeof p.weights !== 'object') {
    problems.push({ path: 'weights', message: 'Required' });
  } else {
    for (const k of weightKeys) {
      const v = p.weights[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        problems.push({ path: `weights.${k}`, message: 'Must be a number >= 0' });
      }
    }
  }

  if (p.maxTaskCostUsd !== undefined && (typeof p.maxTaskCostUsd !== 'number' || p.maxTaskCostUsd < 0)) {
    problems.push({ path: 'maxTaskCostUsd', message: 'Must be a number >= 0' });
  }
  if (p.cooldownMs !== undefined && (typeof p.cooldownMs !== 'number' || p.cooldownMs < 0)) {
    problems.push({ path: 'cooldownMs', message: 'Must be a number >= 0' });
  }

  if (p.rules && !Array.isArray(p.rules)) {
    problems.push({ path: 'rules', message: 'Must be an array' });
  } else {
    for (const [i, rule] of (p.rules ?? []).entries()) {
      if (!rule.name) problems.push({ path: `rules[${i}].name`, message: 'Required' });
      if (rule.when?.titleMatches) {
        try {
          new RegExp(rule.when.titleMatches);
        } catch (e) {
          problems.push({ path: `rules[${i}].when.titleMatches`, message: `Invalid regex: ${String(e)}` });
        }
      }
      for (const [k, v] of Object.entries(rule.weights ?? {})) {
        if (typeof v !== 'number' || v < 0) {
          problems.push({ path: `rules[${i}].weights.${k}`, message: 'Must be a number >= 0' });
        }
      }
    }
  }
  return problems;
}

/** Fill in the optional fields of a partial policy so it is safe to score with. */
export function normalizePolicy(input: Partial<RoutingPolicy>): RoutingPolicy {
  return {
    id: input.id ?? 'custom',
    name: input.name ?? 'Custom',
    description: input.description,
    weights: { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) },
    rules: input.rules ?? [],
    disabledProviders: input.disabledProviders ?? [],
    maxTaskCostUsd: input.maxTaskCostUsd ?? DEFAULT_ROUTING_POLICY.maxTaskCostUsd,
    cooldownMs: input.cooldownMs ?? DEFAULT_ROUTING_POLICY.cooldownMs,
  };
}
