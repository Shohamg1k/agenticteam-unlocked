import type { RoutingPolicy } from './routing.js';
import type {
  ActivityEntry,
  AgentRunEvent,
  AgentProfile,
  Checkpoint,
  ConnectorDef,
  ExecutionMode,
  InstalledPlugin,
  MemoryNote,
  Plan,
  Project,
  ProviderStatus,
  ReviewItem,
  SkillDef,
  Task,
} from './types.js';

/**
 * The wire protocol between the server and every client (the web shell, the
 * CLI, and anything else).
 *
 * One design choice worth stating: the server pushes ONE snapshot of the whole
 * relevant state over a WebSocket rather than exposing a REST endpoint per
 * feature that the UI polls. Snapshots are diffed client-side.
 *
 * That is a deliberate trade — it costs bandwidth on large projects and buys
 * the absence of an entire bug class (panels disagreeing with each other
 * because they polled at different times). Streaming model output is the one
 * exception: it goes over a separate high-frequency channel, because putting
 * per-token deltas in the snapshot would make the snapshot useless.
 */

export const PROTOCOL_VERSION = 1;

export interface Snapshot {
  protocolVersion: number;
  /** Monotonic, so a client can discard an out-of-order frame. */
  seq: number;
  at: number;
  projects: Project[];
  activeProjectId?: string;
  plans: Plan[];
  tasks: Task[];
  providers: ProviderStatus[];
  reviewQueue: ReviewItem[];
  activity: ActivityEntry[];
  checkpoints: Checkpoint[];
  memory: MemoryNote[];
  skills: SkillDef[];
  agents: AgentProfile[];
  plugins: InstalledPlugin[];
  connectors: ConnectorDef[];
  policies: RoutingPolicy[];
  config: NodeConfig;
  /** Aggregated spend, for the cost dashboard. */
  usage: UsageRollup;
  /** Live preview servers, by project. */
  previews: PreviewState[];
  terminals: TerminalInfo[];
}

export interface NodeConfig {
  /** Default human-gate posture for new projects. */
  executionMode: ExecutionMode;
  /** Default worker-pool size. */
  maxParallel: number;
  /** Active routing policy id. */
  routingPolicyId: string;
  /** Provider ids the user has explicitly disabled. */
  disabledProviders: string[];
  /** Commands the sandbox will run without asking. */
  allowedCommands: string[];
  /** Commands that always require approval, even in auto mode. */
  deniedCommands: string[];
  theme: 'system' | 'light' | 'dark' | 'high-contrast';
  /** True once the user has completed onboarding. */
  onboarded: boolean;
}

export interface UsageRollup {
  /** Per-provider totals for today. */
  byProvider: {
    providerId: string;
    name: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }[];
  /** Per-day totals for the last 30 days, oldest first. */
  daily: { day: string; costUsd: number; tokensIn: number; tokensOut: number; calls: number }[];
  totalCostUsd: number;
  /**
   * What the same work would have cost if every task had gone to the most
   * expensive connected model. The difference is what routing bought.
   */
  baselineCostUsd: number;
}

/**
 * How a project gets previewed.
 *
 * `static` is the Live Server case: the project is HTML, CSS and JS that a
 * browser can open directly, and running `npm run dev` on it would be both
 * unnecessary and impossible. `dev-server` is everything with a build step.
 *
 * The distinction matters because the failure modes are opposite. A static
 * project fails when we insist on a dev server it does not have; a framework
 * project fails when we serve its source unbuilt and the browser is handed
 * JSX.
 */
export type PreviewMode = 'static' | 'dev-server';

export interface PreviewState {
  projectId: string;
  status: 'stopped' | 'starting' | 'running' | 'failed';
  url?: string;
  port?: number;
  command?: string;
  error?: string;
  /** Which kind of preview this is. Drives the button's label and behaviour. */
  mode?: PreviewMode;
  /**
   * Static mode: the HTML file being served, relative to the project root.
   * This is what makes the preview open the user's page rather than a
   * directory listing.
   */
  entryFile?: string;
  /** Static mode: every HTML file found, so the user can switch page. */
  htmlFiles?: string[];
  /**
   * Dev-server mode: the URL the dev server itself printed.
   *
   * Authoritative, and different from the guessed one more often than not — a
   * port collision moves Vite to 5174, Next to 3001, and a guess then waits
   * sixty seconds for a port nobody is listening on before failing.
   */
  detectedUrl?: string;
  /** Last N console lines captured from the previewed page. */
  consoleLines: PreviewConsoleLine[];
  /** Recent failed network requests from the previewed page. */
  networkErrors: PreviewNetworkError[];
  /** Notes the user drew on the running page. */
  annotations: PreviewAnnotation[];
}

/**
 * A note the user drew on the running page.
 *
 * The point of annotating rather than describing is that pointing is precise:
 * "this button" plus a rectangle around it removes the entire class of
 * misunderstanding where the agent changes a different button. So an annotation
 * always carries a resolved element target where one exists, and its geometry
 * relative to the page regardless.
 */
export interface PreviewAnnotation {
  id: string;
  kind: 'note' | 'box' | 'arrow';
  /** What the user wrote. Empty while they are still drawing it. */
  text: string;
  /** Page coordinates, so the drawing can be restored on reload. */
  rect: { x: number; y: number; width: number; height: number };
  /** The element under the annotation, when one could be resolved. */
  target?: ElementTarget;
  /** Which page it was drawn on, for a multi-page static site. */
  pageUrl?: string;
  createdAt: number;
}

export interface PreviewConsoleLine {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  ts: number;
  /** Source location, when the page reported one. */
  source?: string;
}

export interface PreviewNetworkError {
  url: string;
  method: string;
  status: number;
  ts: number;
}

export interface TerminalInfo {
  id: string;
  projectId?: string;
  title: string;
  cwd: string;
  /** False once the shell exits; the buffer stays readable. */
  alive: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'subscribe'; projectId?: string }
  /** Keystrokes into a live terminal. */
  | { type: 'terminal:input'; terminalId: string; data: string }
  | { type: 'terminal:resize'; terminalId: string; cols: number; rows: number }
  /** Follow a task's live model output. */
  | { type: 'run:subscribe'; taskId: string }
  | { type: 'run:unsubscribe'; taskId: string }
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  /** Streaming model output for one task. */
  | { type: 'run:event'; taskId: string; event: AgentRunEvent }
  | { type: 'terminal:data'; terminalId: string; data: string }
  | { type: 'terminal:exit'; terminalId: string; code: number | null }
  /** A file changed on disk — the editor reloads it if open and unmodified. */
  | { type: 'fs:changed'; projectId: string; paths: string[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// HTTP request/response shapes
// ---------------------------------------------------------------------------

export interface CreatePlanRequest {
  projectId: string;
  goal: string;
  mode: 'instant' | 'professional';
  executionMode?: ExecutionMode;
  /** Skip the approval step and start immediately. */
  autoStart?: boolean;
}

export interface ScopedEditRequest {
  projectId: string;
  /** What the user typed. */
  instruction: string;
  /** Where they clicked, resolved by the preview overlay. */
  target?: ElementTarget;
  /**
   * Annotations to act on instead of, or as well as, a single target.
   *
   * A round of visual feedback is usually several notes at once — "this is too
   * cramped", "wrong colour", "move this below" — and sending them as one
   * request is both faster and better, because the agent can see them together
   * and make one coherent change rather than three conflicting ones.
   */
  annotations?: PreviewAnnotation[];
}

/**
 * An element the user picked in the preview, resolved back to source. Filled in
 * best-effort: `file` comes from the dev-plugin's data attributes when present,
 * and the selector is always available as a fallback the agent can search for.
 */
export interface ElementTarget {
  selector: string;
  tagName: string;
  /** Text content, truncated — this is what the user actually pointed at. */
  text?: string;
  file?: string;
  line?: number;
  column?: number;
  componentName?: string;
  /** The element's own classes, useful when there is no source map. */
  className?: string;
  /** Outer HTML, truncated, so the agent can find it if the selector is stale. */
  html?: string;
}

export interface DiffHunk {
  /** Index within the file's hunk list; the unit of accept/reject. */
  id: number;
  header: string;
  lines: { kind: 'context' | 'add' | 'remove'; text: string }[];
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: DiffHunk[];
  /** Full contents, for the side-by-side view. */
  before?: string;
  after?: string;
  binary?: boolean;
}

export interface TaskDiff {
  taskId: string;
  files: FileDiff[];
}

export interface ApplyDiffRequest {
  taskId: string;
  /** Per-file hunk ids to apply. Omit a file to apply all of its hunks. */
  selection?: { path: string; hunkIds: number[] }[];
}

export interface ApiError {
  error: string;
  /** Actionable next step, when there is one. */
  hint?: string;
  code?: string;
}
