import type { ExecutionProfile } from './profiles.js';
import type {
  AgentRunError,
  AgentRunEvent,
  Capability,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  ProviderTransport,
  QuotaState,
  Task,
  TokenUsage,
} from './types.js';

/**
 * The provider adapter contract.
 *
 * Adding a provider means adding ONE file that exports a `ProviderAdapter`.
 * Nothing outside `server/src/providers/` may import a provider SDK, branch on
 * a provider id, or know that (say) Anthropic exists. The orchestrator only
 * ever sees this interface.
 *
 * Design notes worth keeping:
 *
 * - `stream()` is the only method that actually talks to a model. `plan()` and
 *   `execute()` are thin, opinionated wrappers over it so the orchestrator has
 *   task-shaped entry points, and so a provider with a native planning mode
 *   (a CLI agent that already decomposes work) can override just that one.
 *
 * - Every method takes an `AbortSignal`. A user hitting "kill" on a lane must
 *   actually stop the subprocess or the HTTP request, not just stop listening.
 *
 * - Errors are classified into `AgentRunErrorKind` by the ADAPTER, because only
 *   the adapter knows what its provider's 429 body looks like. The orchestrator
 *   routes on the classification and never parses a provider message itself.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly transport: ProviderTransport;

  /**
   * Ladder rung; lower is tried first. Defaults come from `kind`
   * (see `defaultTierFor`) and are overridable per provider in settings.
   */
  tier: number;

  /** Models this adapter can drive. Populated or filtered by `probe()`. */
  models: ModelDescriptor[];

  /** Model used when a task does not pin one. */
  defaultModel: string;

  /**
   * Check whether this provider is usable right now: key present, CLI on PATH,
   * daemon reachable. Cheap and side-effect free; called on boot and on a timer.
   * Must never throw — an unreachable provider is `available: false` with a
   * `detail` a human can act on, not an exception.
   */
  probe(): Promise<ProviderProbeResult>;

  /**
   * Run one completion and stream normalised events. This is the only place a
   * provider's wire format exists.
   *
   * Implementations MUST:
   *   - emit exactly one terminal event (`done` or `error`);
   *   - emit `usage` (or carry usage on `done`) even when estimating;
   *   - honour `signal` by aborting the request/subprocess.
   */
  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent>;

  /**
   * Decompose a goal into a task graph. Default implementation (see
   * `runPlanner` in the server) prompts through `stream()` and parses JSON;
   * a CLI agent that plans natively may override this.
   */
  plan?(request: PlanRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent>;

  /**
   * Execute one task. Default implementation builds a prompt from the task and
   * its context pack and calls `stream()`. A provider with a real agentic loop
   * (Claude Code, Codex CLI) overrides this so the loop runs where it lives.
   */
  execute?(request: ExecuteRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent>;

  /**
   * Predicted cost of a request, before it runs. Used by the router to rank
   * candidates and by the budget guard to decide whether to ask first.
   * Zero for local and subscription providers — they are not billed per token.
   */
  estimateCost(request: CostEstimateRequest): CostEstimate;

  /** Current observed quota headroom for the active account. */
  getQuotaState(): QuotaState;

  /**
   * Record that a request happened, so `getQuotaState()` stays honest. Called
   * by the runtime, not by the adapter, so ledger accounting lives in one place.
   */
  recordUsage(usage: TokenUsage): void;

  /**
   * Classify a raw provider failure. The orchestrator's failover logic depends
   * entirely on this being right, which is why it is the adapter's job.
   */
  classifyError(err: unknown): AgentRunError;

  /** Switch to a different named credential without restarting. */
  setAccount?(account: string): void;

  /** Free subprocesses/sockets. Called on shutdown and on provider disable. */
  dispose?(): Promise<void>;
}

export interface ProviderProbeResult {
  available: boolean;
  /** Human-readable reason, shown verbatim in the UI. */
  detail?: string;
  /** Models discovered at probe time, when the provider enumerates them. */
  models?: ModelDescriptor[];
}

/** One message in a completion request. */
export interface CompletionMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Images, for vision-capable models. */
  images?: { base64: string; mimeType: string }[];
}

export interface CompletionRequest {
  runId: string;
  model: string;
  /**
   * The stable, cacheable prefix. Kept separate from `messages` so providers
   * that support prompt caching can mark it, and so the context packer can
   * reason about "what is stable" versus "what changes every attempt".
   */
  system: string;
  messages: CompletionMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Working directory for CLI-transport adapters. Ignored by HTTP adapters. */
  cwd?: string;
  /** Tools the model may call, when the provider supports tool use. */
  tools?: ToolSchema[];
  /** Hint that this prefix is worth caching. Adapters that cannot, ignore it. */
  cachePrefix?: boolean;
  /**
   * How hard to try. Adapters translate this into whatever their provider
   * exposes — a model tier, a reasoning-effort flag, whether to run a tool
   * loop. An adapter that exposes none of it ignores this entirely, which is
   * why it is optional rather than a required knob every adapter must fake.
   */
  profile?: ExecutionProfile;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface PlanRequest {
  runId: string;
  model: string;
  goal: string;
  /** Project context the planner should respect (conventions, existing files). */
  context: string;
  /** Providers the planner may assign work to, already filtered to available. */
  roster: PlannerRosterEntry[];
  mode: 'instant' | 'professional';
  cwd?: string;
}

export interface PlannerRosterEntry {
  providerId: string;
  model: string;
  label: string;
  kind: ProviderKind;
  capabilities: Capability[];
  /** Free-text cost note the planner can reason about ("free", "$3/Mtok in"). */
  costNote: string;
}

export interface ExecuteRequest {
  runId: string;
  model: string;
  task: Task;
  /** The packed context for this task — see `contextpack` on the server. */
  context: string;
  /** System prompt from the agent profile / role. */
  system: string;
  /** Absolute path the agent may write into. */
  cwd: string;
  tools?: ToolSchema[];
  /** See `CompletionRequest.profile`. */
  profile?: ExecutionProfile;
}

export interface CostEstimateRequest {
  model: string;
  /** Estimated input tokens. Callers use `estimateTokens()` when they only have text. */
  inputTokens: number;
  /** Estimated output tokens. Defaults to the model's max when omitted. */
  outputTokens?: number;
  /** Portion of `inputTokens` expected to hit a provider cache. */
  cachedInputTokens?: number;
}

export interface CostEstimate {
  usd: number;
  /** True when the provider is not billed per token (local, subscription). */
  free: boolean;
  /** Rough seconds, from the model's throughput estimate. */
  etaSeconds?: number;
  /** Which model the estimate is for — adapters may substitute. */
  model: string;
}

/**
 * Rough token count. Deliberately a constant-factor character estimate rather
 * than a real tokenizer: every provider tokenizes differently, a real tokenizer
 * would be a per-provider dependency in shared code, and this number is only
 * ever used for ranking and budget warnings — never for billing.
 *
 * ~3.7 chars/token is a reasonable blend across code and prose for modern BPE
 * vocabularies. Code skews lower, prose higher.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.7);
}

/** Cost of a known token split at a model's published prices. */
export function priceOf(
  model: ModelDescriptor,
  usage: { input: number; output: number; cachedInput?: number },
): number {
  const p = model.pricing;
  const cached = usage.cachedInput ?? 0;
  const freshInput = Math.max(0, usage.input - cached);
  const cachedRate = p.cachedInputPerMTok ?? p.inputPerMTok;
  return (
    (freshInput / 1_000_000) * p.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (usage.output / 1_000_000) * p.outputPerMTok
  );
}

/** Ladder rung a provider gets when it does not override one. */
export function defaultTierFor(kind: ProviderKind): number {
  switch (kind) {
    case 'local':
      return 0;
    case 'free-cloud':
      return 1;
    case 'subscription':
      return 2;
    case 'byok':
      return 3;
  }
}

/** Is this provider currently sidelined by a cooldown? */
export function onCooldown(q: QuotaState, now = Date.now()): boolean {
  return q.cooldownUntil !== undefined && q.cooldownUntil > now;
}

/** Does this provider have request headroom under its own declared caps? */
export function hasRequestHeadroom(q: QuotaState): boolean {
  if (q.limitRpm !== undefined && q.usedMinute >= q.limitRpm) return false;
  if (q.limitRpd !== undefined && q.usedDay >= q.limitRpd) return false;
  return true;
}

/** Build a `ProviderStatus` snapshot from an adapter. UI and router both read this. */
export function statusOf(a: ProviderAdapter, available: boolean, detail?: string): ProviderStatus {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    transport: a.transport,
    tier: a.tier,
    models: a.models,
    defaultModel: a.defaultModel,
    available,
    detail,
    quota: a.getQuotaState(),
  };
}

/**
 * Shared heuristic for "the provider says it is out of capacity".
 *
 * Adapters should prefer a status code or a typed provider error and fall back
 * to this only for opaque CLI stderr, where there is genuinely nothing else to
 * go on. Getting this wrong in the permissive direction costs a wasted failover;
 * getting it wrong in the strict direction strands a task, so it errs permissive.
 */
export function looksLikeQuotaError(message: string): boolean {
  return /rate.?limit|usage limit|quota|429|too many requests|exhausted|resource.?exhausted|limit reached|out of (credits|usage|tokens)|insufficient_quota|overloaded/i.test(
    message,
  );
}

/** Shared heuristic for "the credentials are wrong", used the same way. */
export function looksLikeAuthError(message: string): boolean {
  return /401|403|unauthor|forbidden|invalid.?api.?key|authentication|not logged in|please log ?in|no credentials/i.test(
    message,
  );
}
