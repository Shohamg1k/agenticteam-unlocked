/**
 * Domain model for Agentic Team.
 *
 * Everything the orchestrator, the adapters and the UI agree on lives here and
 * nowhere else. Two rules keep this file honest:
 *   1. No provider-specific fields. If a shape only makes sense for Anthropic,
 *      it belongs in the Anthropic adapter, not here.
 *   2. Every persisted structure is plain JSON. Canonical state is files on
 *      disk under `.agentic-team/`; any database is a rebuildable index.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a task needs from a model, and what a model claims to offer. This is the
 * join key the router uses — deliberately coarse, because fine-grained
 * capability claims age badly and nobody can verify them.
 */
export type Capability =
  /** Trivial work where the cheapest model that can hold a thought is correct. */
  | 'cheap-ok'
  /** Writing or editing real code. */
  | 'code'
  /** Architecture, schema design, tricky logic, final synthesis. */
  | 'strong-reasoning'
  /** Inputs that will not fit a small window (large files, whole-repo reads). */
  | 'long-context'
  /** Reads images (design comps, screenshots, preview captures). */
  | 'vision'
  /** Frontend/visual polish — models differ here far more than on raw code. */
  | 'frontend'
  /** Can drive tools/function calls in a loop rather than emitting one blob. */
  | 'tool-use';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'cheap-ok',
  'code',
  'strong-reasoning',
  'long-context',
  'vision',
  'frontend',
  'tool-use',
] as const;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * How a provider is paid for. This drives the failover ladder ordering: free
 * local capacity is spent before a metered key, and a subscription seat is
 * spent before money.
 */
export type ProviderKind =
  /** Runs on this machine. Unlimited, free, usually weakest. */
  | 'local'
  /** A hosted free tier with RPM/RPD caps. */
  | 'free-cloud'
  /** Covered by a subscription the user already pays for (Claude Pro/Max, ChatGPT). */
  | 'subscription'
  /** The user's own API key, billed per token. */
  | 'byok';

/** How the adapter reaches the model. */
export type ProviderTransport = 'http' | 'cli';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached-read input tokens, when the provider offers one. */
  cachedInputPerMTok?: number;
}

export interface ModelDescriptor {
  /** Provider-native model id, sent on the wire. */
  id: string;
  /** Human label for the UI. */
  label: string;
  capabilities: Capability[];
  /** Total context window in tokens. */
  contextWindow: number;
  /** Max tokens the model will emit in one response. */
  maxOutputTokens: number;
  /**
   * Zero for subscription and local models — they are not billed per token.
   * Cost-based routing still ranks them first because zero sorts first.
   */
  pricing: ModelPricing;
  /** Rough tokens/second, used to rank on latency. Estimates, not promises. */
  throughputTps?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}

/** Remaining headroom on a provider, as far as we can observe it. */
export interface QuotaState {
  /** Requests in the trailing minute / day. */
  usedMinute: number;
  usedDay: number;
  limitRpm?: number;
  limitRpd?: number;
  /** Estimated tokens spent today through the active account. */
  tokensToday: { input: number; output: number };
  /** Estimated USD spent today through the active account. */
  costTodayUsd: number;
  /** Epoch ms at which the minute/day sliding window frees a slot. */
  resetMinuteAt?: number;
  resetDayAt?: number;
  /**
   * Set when the provider told us it is exhausted (429 / usage-limit). The
   * router skips this provider until the cooldown passes; it is never a
   * permanent removal, because free tiers come back.
   */
  cooldownUntil?: number;
  /** Which named credential these counters belong to. 'default' = primary. */
  account: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  /**
   * Ladder rung. Lower runs first. Derived from `kind` by default but
   * overridable, because one user's BYOK key is cheaper than another's
   * rate-limited free tier.
   */
  tier: number;
  models: ModelDescriptor[];
  /** The model this provider will use unless a task pins another. */
  defaultModel: string;
  /** False when the key is missing, the CLI is not installed, or the daemon is down. */
  available: boolean;
  /** Why it is unavailable, or a note when it is — shown verbatim in the UI. */
  detail?: string;
  quota: QuotaState;
}

// ---------------------------------------------------------------------------
// Agent runs — the one event stream every adapter normalises into
// ---------------------------------------------------------------------------

export type AgentRunEvent =
  | { type: 'start'; runId: string; providerId: string; model: string; at: number }
  /** A chunk of assistant text. */
  | { type: 'delta'; runId: string; text: string }
  /** Model-visible reasoning, when the provider exposes it separately. */
  | { type: 'thinking'; runId: string; text: string }
  /** A tool/function call the model asked for. */
  | { type: 'tool-call'; runId: string; name: string; input: unknown; callId: string }
  | { type: 'tool-result'; runId: string; callId: string; output: string; isError: boolean }
  /** Adapter-level progress that is not model output (CLI stderr, spawn notes). */
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'usage'; runId: string; usage: TokenUsage }
  | { type: 'done'; runId: string; text: string; usage: TokenUsage; at: number }
  | { type: 'error'; runId: string; error: AgentRunError; at: number };

export interface TokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
  /** Computed from the model's pricing at the time of the call. */
  costUsd: number;
  /** True when the numbers came from the provider; false when we estimated them. */
  measured: boolean;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, costUsd: 0, measured: false };

export type AgentRunErrorKind =
  /** Rate limit / usage cap / quota exhausted. Recoverable by failover. */
  | 'quota'
  /** Bad or missing credentials. Failover helps; retrying does not. */
  | 'auth'
  /** Network, timeout, 5xx. Retrying the same provider may work. */
  | 'transient'
  /** The request was malformed or too large for this model. */
  | 'invalid-request'
  /** The CLI/binary is missing or would not start. */
  | 'unavailable'
  /** The user or the orchestrator cancelled the run. */
  | 'cancelled'
  /** Anything else. Not retried automatically. */
  | 'unknown';

export interface AgentRunError {
  kind: AgentRunErrorKind;
  message: string;
  /** Provider-native status/code, kept for the log and for adapter tests. */
  status?: number;
  code?: string;
  /** When the provider told us how long to wait. */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

export type TaskStatus =
  /** In the plan, dependencies unmet. */
  | 'planned'
  /** Dependencies met, waiting for a worker slot. */
  | 'queued'
  /** A worker holds it. */
  | 'running'
  /** Produced output; verification gates are running. */
  | 'verifying'
  /** Verified, waiting for the human gate (or the auto-accept policy). */
  | 'review'
  /** Accepted; its files are applied. */
  | 'done'
  /** Out of retries, or a gate refused it. */
  | 'failed'
  /** A human or the orchestrator stopped it. */
  | 'cancelled'
  /** Blocked on a question only a human can answer. */
  | 'blocked';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'] as const;

/** Which development mode produced this plan. */
export type DevelopmentMode = 'instant' | 'professional';

/**
 * SDLC roles used by Professional mode. Instant mode leaves `role` unset —
 * it routes on capability alone, which is the whole point of it being faster.
 */
export type TeamRole =
  | 'lead'
  | 'product-manager'
  | 'architect'
  | 'ux-designer'
  | 'backend-engineer'
  | 'frontend-engineer'
  | 'qa-engineer'
  | 'security-reviewer'
  | 'devops'
  | 'tech-writer';

export const ALL_TEAM_ROLES: readonly TeamRole[] = [
  'lead',
  'product-manager',
  'architect',
  'ux-designer',
  'backend-engineer',
  'frontend-engineer',
  'qa-engineer',
  'security-reviewer',
  'devops',
  'tech-writer',
] as const;

export interface AcceptanceCriterion {
  /** A statement that is objectively true or false about the produced output. */
  text: string;
  /** Set by the verification loop once it has an answer. */
  met?: boolean;
  note?: string;
}

export interface WorklogEntry {
  ts: number;
  /** Provider that wrote this entry, or 'orchestrator' / 'human'. */
  actor: string;
  text: string;
  level?: 'info' | 'warn' | 'error';
}

export interface TaskAttempt {
  n: number;
  providerId: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  usage: TokenUsage;
  outcome: 'success' | 'error' | 'verification-failed' | 'cancelled';
  error?: AgentRunError;
}

export interface Task {
  id: string;
  planId: string;
  title: string;
  /** The full brief handed to the executing agent. */
  description: string;
  capability: Capability;
  role?: TeamRole;
  /** Phase this task belongs to (Professional mode). */
  phase?: PhaseId;
  /** Ids of tasks that must be `done` before this one may start. */
  dependsOn: string[];
  status: TaskStatus;
  /**
   * 1-5. Drives routing (a 5 goes to the strongest reasoner) and the retry
   * budget. Set by the planner, overridable by the user.
   */
  complexity: number;
  acceptance: AcceptanceCriterion[];
  /**
   * The exact interface this task's output must expose — function signatures,
   * endpoint shapes, file paths. Dependents receive it verbatim, which is what
   * keeps parallel work from inventing conflicting contracts.
   */
  contract?: string;
  /** Files this task is expected to touch. Used by the file lock manager. */
  expectedFiles?: string[];
  /** Files actually produced, workspace-relative. */
  producedFiles?: string[];
  /** Provider the planner chose. Advisory: the ladder still backs it up. */
  plannedProviderId?: string;
  plannedModel?: string;
  plannedReason?: string;
  /** Provider the user pinned. Outranks the planner; ladder still backs it up. */
  pinnedProviderId?: string;
  /** Provider that actually ran the accepted attempt. */
  providerId?: string;
  model?: string;
  attempts: TaskAttempt[];
  /** Hard cap on attempts across all providers. */
  maxAttempts: number;
  worklog: WorklogEntry[];
  /** Raw model output of the latest attempt. */
  output?: string;
  error?: string;
  verification?: VerificationReport;
  /** True when this task carries content from outside the user's own repo/input. */
  tainted?: boolean;
  taintSource?: string;
  /** Set once a human has explicitly acknowledged the taint. */
  taintAcknowledgedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type PlanStatus =
  'planning' | 'awaiting_approval' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** Phase gates for Professional mode. Instant mode uses a single implicit phase. */
export type PhaseId = 'discovery' | 'design' | 'implementation' | 'verification' | 'release';

export const PROFESSIONAL_PHASES: readonly PhaseId[] = [
  'discovery',
  'design',
  'implementation',
  'verification',
  'release',
] as const;

export interface PhaseGate {
  phase: PhaseId;
  /** Every task in this phase must be `done` before the next phase starts. */
  taskIds: string[];
  status: 'pending' | 'open' | 'awaiting_approval' | 'passed' | 'failed';
  /** Set when a human (or the auto-accept policy) let the plan through. */
  approvedAt?: number;
  approvedBy?: string;
  notes?: string;
}

export interface Plan {
  id: string;
  projectId: string;
  goal: string;
  mode: DevelopmentMode;
  status: PlanStatus;
  taskIds: string[];
  phases: PhaseGate[];
  /** Budget ceilings for this plan. Exceeding them pauses and asks. */
  budget: PlanBudget;
  /** Rolling totals across every task in this plan. */
  spend: PlanSpend;
  /** Free-text summary the planner emitted alongside the graph. */
  summary?: string;
  /** Execution-mode override for this plan; falls back to the project setting. */
  executionMode?: ExecutionMode;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface PlanBudget {
  /** Hard cap on model calls. */
  maxCalls: number;
  /** Hard cap on USD. Zero-cost providers do not count against it. */
  maxCostUsd: number;
  /** Hard cap on wall-clock minutes before the plan pauses for a human. */
  maxWallClockMin: number;
  /** When true, hitting a ceiling pauses and asks instead of failing. */
  askBeforeExceeding: boolean;
}

export interface PlanSpend {
  calls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  startedAt?: number;
}

export const DEFAULT_PLAN_BUDGET: PlanBudget = {
  maxCalls: 120,
  maxCostUsd: 5,
  maxWallClockMin: 60,
  askBeforeExceeding: true,
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationIssue {
  file: string;
  line?: number;
  column?: number;
  message: string;
  source: 'syntax' | 'typecheck' | 'lint' | 'test' | 'build' | 'acceptance' | 'security';
  severity: 'error' | 'warning';
}

export interface VerificationCheck {
  name: string;
  /** The command that ran, when the check shelled out. */
  command?: string;
  ok: boolean;
  skipped?: string;
  exitCode?: number | null;
  durationMs: number;
  issues: VerificationIssue[];
}

export interface VerificationReport {
  ok: boolean;
  /** Tier 1: syntax parse of every produced file. Needs no project config. */
  tier1: VerificationCheck;
  /** Tier 2: the project's own typecheck/lint/test/build, in a throwaway worktree. */
  tier2: VerificationCheck[];
  /** How many times this task repaired its own failed verification. */
  repairs: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Human gate
// ---------------------------------------------------------------------------

/**
 * How much of the human gate a run keeps.
 * `approval` — every task acceptance waits for a person. The default.
 * `hybrid`   — fully-verified, untainted, non-sensitive work self-accepts.
 * `auto`     — verified work self-accepts; only work the system cannot vouch
 *              for escalates. Tainted content NEVER self-accepts in any mode.
 */
export type ExecutionMode = 'approval' | 'hybrid' | 'auto';

export type ReviewItemKind = 'task' | 'phase-gate' | 'budget' | 'question' | 'taint' | 'command';

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  projectId: string;
  planId?: string;
  taskId?: string;
  title: string;
  detail: string;
  /** Enumerated answers, when the item is a question with fixed options. */
  options?: string[];
  status: 'open' | 'approved' | 'rejected' | 'sent-back' | 'answered';
  answer?: string;
  createdAt: number;
  resolvedAt?: number;
}

// ---------------------------------------------------------------------------
// Projects, checkpoints, memory
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the user's real folder. Files are written here, not to a sandbox. */
  root: string;
  createdAt: number;
  lastOpenedAt: number;
  /** Per-project overrides of the node defaults. */
  settings: ProjectSettings;
}

export interface ProjectSettings {
  executionMode: ExecutionMode;
  budget: PlanBudget;
  /** Named routing policy this project uses. */
  routingPolicyId: string;
  /** Commands verification tier-2 runs. Empty = auto-detect from the manifest. */
  checks?: { typecheck?: string; lint?: string; test?: string; build?: string };
  /** Dev-server command for the preview tab. Empty = auto-detect. */
  devServer?: { command: string; port: number; url?: string };
  /** Skills enabled for this project, by name. */
  skills: string[];
  /** Max workers running in parallel for this project. */
  maxParallel: number;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  planId?: string;
  taskId?: string;
  label: string;
  /** Git ref the checkpoint restores to. */
  ref: string;
  /** Files changed since the previous checkpoint. */
  files: string[];
  createdAt: number;
}

export type MemoryKind =
  'requirement' | 'decision' | 'architecture' | 'convention' | 'task-note' | 'bug' | 'artifact';

export interface MemoryNote {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  /** Task or plan this came from, when it came from one. */
  sourceTaskId?: string;
  sourcePlanId?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Extensibility
// ---------------------------------------------------------------------------

export interface SkillDef {
  name: string;
  description: string;
  /** One line telling the router when this skill is relevant. */
  whenToUse: string;
  /** Markdown body injected into the agent's context. */
  body: string;
  /** Capability tags this skill is relevant to; empty = any. */
  appliesTo: Capability[];
  /** Roles this skill is relevant to; empty = any. */
  roles: TeamRole[];
  enabled: boolean;
  source: 'builtin' | 'project' | 'plugin';
  path?: string;
}

export interface AgentProfile {
  name: string;
  role?: TeamRole;
  description: string;
  whenToUse: string;
  capability: Capability;
  systemPrompt: string;
  /** Preferred providers, in order. The ladder still backs them up. */
  preferredProviders: string[];
  /** Tool names this profile may use. Empty = the orchestrator default set. */
  allowedTools: string[];
  skills: string[];
  enabled: boolean;
  source: 'builtin' | 'project' | 'plugin';
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Paths relative to the plugin root. */
  skills?: string[];
  agents?: string[];
  connectors?: ConnectorDef[];
  /** Minimum app version this plugin supports. */
  engines?: { agenticTeam?: string };
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Absolute path on disk. */
  root: string;
  source: { kind: 'folder' | 'git'; location: string };
  enabled: boolean;
  installedAt: number;
}

export interface ConnectorDef {
  id: string;
  name: string;
  /** MCP stdio server, MCP http server, or a first-party built-in. */
  transport: 'stdio' | 'http' | 'builtin';
  command?: string;
  args?: string[];
  url?: string;
  /** Env var names required; values come from the vault, never the manifest. */
  requiredSecrets: string[];
  enabled: boolean;
  /**
   * Everything a connector returns is untrusted. Tools that write outward
   * (open a PR, post a message) require an explicit human approval regardless.
   */
  writeRequiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  projectId?: string;
  planId?: string;
  taskId?: string;
}
