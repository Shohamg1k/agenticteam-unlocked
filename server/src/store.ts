import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentProfile,
  Checkpoint,
  ConnectorDef,
  InstalledPlugin,
  MemoryNote,
  NodeConfig,
  Plan,
  Project,
  ReviewItem,
  RoutingPolicy,
  SkillDef,
  Task,
} from '@agentic/core';
import { BUILTIN_POLICIES, DEFAULT_PLAN_BUDGET } from '@agentic/core';
import { ensureDir, nodePaths, projectPaths, readJson, writeJsonAtomic } from './paths.js';
import { log } from './log.js';

/**
 * In-memory state, backed by files (ADR 0003).
 *
 * Reads are served from memory; every mutation writes through to disk. The
 * write is debounced per file, because a running plan mutates a task on every
 * streamed chunk and we are not writing the plan file 400 times a second.
 *
 * A `change()` call bumps the sequence number, which is what makes the
 * WebSocket snapshot push work: anything that mutates state calls it, and the
 * broadcaster coalesces.
 */

export interface NodeState {
  config: NodeConfig;
  projects: Project[];
  activeProjectId?: string;
  /** Plans, tasks and everything project-scoped, keyed by project id. */
  byProject: Map<string, ProjectState>;
  plugins: InstalledPlugin[];
  connectors: ConnectorDef[];
  seq: number;
}

export interface ProjectState {
  projectId: string;
  root: string;
  plans: Plan[];
  tasks: Task[];
  reviewQueue: ReviewItem[];
  checkpoints: Checkpoint[];
  memory: MemoryNote[];
  skills: SkillDef[];
  agents: AgentProfile[];
  policies: RoutingPolicy[];
  loaded: boolean;
}

export const DEFAULT_NODE_CONFIG: NodeConfig = {
  executionMode: 'approval',
  maxParallel: 3,
  routingPolicyId: 'default',
  disabledProviders: [],
  allowedCommands: [
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'node',
    'git',
    'tsc',
    'eslint',
    'prettier',
    'vitest',
    'jest',
    'pytest',
    'python',
    'pip',
    'cargo',
    'go',
    'make',
    'ls',
    'cat',
    'echo',
    'pwd',
  ],
  deniedCommands: ['rm', 'rmdir', 'del', 'format', 'mkfs', 'dd', 'shutdown', 'reboot', 'curl', 'wget'],
  theme: 'system',
  onboarded: false,
};

export const state: NodeState = {
  config: { ...DEFAULT_NODE_CONFIG },
  projects: [],
  byProject: new Map(),
  plugins: [],
  connectors: [],
  seq: 0,
};

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

export function onChange(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Mark state dirty. Broadcasts are coalesced by the listener, not here. */
export function changed(): void {
  state.seq++;
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      // A listener throwing must not corrupt the mutation that triggered it.
    }
  }
}

// ---------------------------------------------------------------------------
// Debounced persistence
// ---------------------------------------------------------------------------

const pendingWrites = new Map<string, unknown>();
let flushTimer: NodeJS.Timeout | undefined;
const FLUSH_MS = 250;

function scheduleWrite(file: string, value: unknown): void {
  pendingWrites.set(file, value);
  if (flushTimer) return;
  flushTimer = setTimeout(flushWrites, FLUSH_MS);
  // Never hold the process open for a pending write; `flushWrites` also runs on
  // exit, so nothing is lost.
  flushTimer.unref?.();
}

export function flushWrites(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  for (const [file, value] of pendingWrites) {
    try {
      writeJsonAtomic(file, value);
    } catch (err) {
      log(`Could not save ${file}: ${String(err)}`, 'error');
    }
  }
  pendingWrites.clear();
}

process.on('exit', flushWrites);

// ---------------------------------------------------------------------------
// Node-level state
// ---------------------------------------------------------------------------

export function loadNodeState(): void {
  const p = nodePaths();
  ensureDir(p.base);
  state.config = { ...DEFAULT_NODE_CONFIG, ...readJson<Partial<NodeConfig>>(p.config, {}) };
  const stored = readJson<{ projects: Project[]; activeProjectId?: string }>(p.projects, { projects: [] });
  // A project whose folder was deleted or moved is dropped from the list rather
  // than left as a row that errors on every click.
  state.projects = stored.projects.filter((proj) => {
    const ok = fs.existsSync(proj.root);
    if (!ok) log(`Project "${proj.name}" no longer exists at ${proj.root} — removed from the list`, 'warn');
    return ok;
  });
  state.activeProjectId = state.projects.some((x) => x.id === stored.activeProjectId)
    ? stored.activeProjectId
    : state.projects[0]?.id;
}

export function saveNodeConfig(): void {
  scheduleWrite(nodePaths().config, state.config);
  changed();
}

export function saveProjects(): void {
  scheduleWrite(nodePaths().projects, { projects: state.projects, activeProjectId: state.activeProjectId });
  changed();
}

// ---------------------------------------------------------------------------
// Project-level state
// ---------------------------------------------------------------------------

export function projectState(projectId: string): ProjectState | undefined {
  const existing = state.byProject.get(projectId);
  if (existing) return existing;

  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return undefined;

  const fresh: ProjectState = {
    projectId,
    root: project.root,
    plans: [],
    tasks: [],
    reviewQueue: [],
    checkpoints: [],
    memory: [],
    skills: [],
    agents: [],
    policies: [...BUILTIN_POLICIES],
    loaded: false,
  };
  state.byProject.set(projectId, fresh);
  loadProjectState(fresh);
  return fresh;
}

/** Same as `projectState`, but throws a message an HTTP handler can return. */
export function requireProject(projectId: string): ProjectState {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);
  return ps;
}

function loadProjectState(ps: ProjectState): void {
  const p = projectPaths(ps.root);
  ensureDir(p.base);
  ensureDir(p.plans);

  // Plans are one file each: a plan and its tasks are written together, so they
  // can never be half-updated relative to each other.
  try {
    for (const name of fs.readdirSync(p.plans)) {
      if (!name.endsWith('.json')) continue;
      const stored = readJson<{ plan: Plan; tasks: Task[] } | null>(path.join(p.plans, name), null);
      if (!stored?.plan) continue;
      ps.plans.push(stored.plan);
      ps.tasks.push(...(stored.tasks ?? []));
    }
  } catch {
    // An unreadable plans directory means no plans, not a dead project.
  }

  ps.checkpoints = readJson<Checkpoint[]>(p.checkpoints, []);
  ps.reviewQueue = readJson<ReviewItem[]>(p.reviewQueue, []);

  // On load, anything that claims to be mid-flight is a lie: the process that
  // was running it is gone. Reset it to queued so the orchestrator picks it up
  // again rather than leaving a plan wedged forever.
  for (const t of ps.tasks) {
    if (t.status === 'running' || t.status === 'verifying') {
      t.status = 'queued';
      t.worklog.push({
        ts: Date.now(),
        actor: 'orchestrator',
        text: 'Requeued: the server restarted while this task was running.',
        level: 'warn',
      });
    }
  }
  for (const plan of ps.plans) {
    if (plan.status === 'running') plan.status = 'paused';
  }

  ps.loaded = true;
  writeProjectGitignore(ps.root);
}

/**
 * Keep the volatile parts of `.agentic-team/` out of git by default, while
 * leaving plans, memory and config trackable for teams that want a shared
 * board (see docs/OPEN-QUESTIONS.md Q8).
 */
function writeProjectGitignore(root: string): void {
  const p = projectPaths(root);
  if (fs.existsSync(p.gitignore)) return;
  const body = [
    '# Written by Agentic Team. Delete this file to track everything,',
    '# e.g. to share a task board with your team through the repo.',
    'worktrees/',
    'index.json',
    'checkpoints.json',
    '*.tmp',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(p.gitignore, body, 'utf8');
  } catch {
    // Not being able to write this is not worth failing project load over.
  }
}

export function savePlan(projectId: string, planId: string): void {
  const ps = projectState(projectId);
  if (!ps) return;
  const plan = ps.plans.find((x) => x.id === planId);
  if (!plan) return;
  const tasks = ps.tasks.filter((t) => t.planId === planId);
  scheduleWrite(path.join(projectPaths(ps.root).plans, `${planId}.json`), { plan, tasks });
  changed();
}

export function saveCheckpoints(projectId: string): void {
  const ps = projectState(projectId);
  if (!ps) return;
  scheduleWrite(projectPaths(ps.root).checkpoints, ps.checkpoints);
  changed();
}

export function saveReviewQueue(projectId: string): void {
  const ps = projectState(projectId);
  if (!ps) return;
  scheduleWrite(projectPaths(ps.root).reviewQueue, ps.reviewQueue);
  changed();
}

// ---------------------------------------------------------------------------
// Convenience lookups
// ---------------------------------------------------------------------------

export function findTask(taskId: string): { ps: ProjectState; task: Task } | undefined {
  for (const ps of state.byProject.values()) {
    const task = ps.tasks.find((t) => t.id === taskId);
    if (task) return { ps, task };
  }
  return undefined;
}

export function findPlan(planId: string): { ps: ProjectState; plan: Plan } | undefined {
  for (const ps of state.byProject.values()) {
    const plan = ps.plans.find((p) => p.id === planId);
    if (plan) return { ps, plan };
  }
  return undefined;
}

export function tasksOfPlan(ps: ProjectState, planId: string): Task[] {
  return ps.tasks.filter((t) => t.planId === planId);
}

export function defaultProjectSettings() {
  return {
    executionMode: state.config.executionMode,
    budget: { ...DEFAULT_PLAN_BUDGET },
    routingPolicyId: state.config.routingPolicyId,
    skills: [] as string[],
    maxParallel: state.config.maxParallel,
  };
}
