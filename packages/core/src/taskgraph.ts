import type { PhaseId, Task, TaskStatus } from './types.js';
import { TERMINAL_TASK_STATUSES } from './types.js';

/**
 * Task-graph operations.
 *
 * Pure functions over a task list — no I/O, no clock beyond what is passed in.
 * That is deliberate: this is the part of the orchestrator that must be
 * exhaustively unit-testable, because a bug here either deadlocks a plan or
 * runs two conflicting tasks at once.
 */

export class GraphError extends Error {
  constructor(
    message: string,
    readonly detail: { cycle?: string[]; missing?: { taskId: string; dependsOn: string }[] } = {},
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export type TaskIndex = Map<string, Task>;

export function indexTasks(tasks: Task[]): TaskIndex {
  return new Map(tasks.map((t) => [t.id, t]));
}

/**
 * Validate a graph before anything runs. Cheap, and it converts a whole class
 * of runtime deadlocks into one loud error at plan time.
 */
export function validateGraph(tasks: Task[]): void {
  const index = indexTasks(tasks);
  if (index.size !== tasks.length) {
    const seen = new Set<string>();
    const dupe = tasks.find((t) => (seen.has(t.id) ? true : (seen.add(t.id), false)));
    throw new GraphError(`Duplicate task id: ${dupe?.id ?? 'unknown'}`);
  }

  const missing: { taskId: string; dependsOn: string }[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) missing.push({ taskId: t.id, dependsOn: dep });
      else if (!index.has(dep)) missing.push({ taskId: t.id, dependsOn: dep });
    }
  }
  if (missing.length) {
    const list = missing.map((m) => `${m.taskId} -> ${m.dependsOn}`).join(', ');
    throw new GraphError(`Task graph references unknown or self dependencies: ${list}`, { missing });
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    throw new GraphError(`Task graph contains a cycle: ${cycle.join(' -> ')}`, { cycle });
  }
}

/**
 * Depth-first cycle detection. Returns the cycle as a path (first node repeated
 * at the end) so the error message can name it, or null when the graph is a DAG.
 */
export function findCycle(tasks: Task[]): string[] | null {
  const index = indexTasks(tasks);
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const seen = state.get(id);
    if (seen === 'done') return null;
    if (seen === 'visiting') {
      const from = stack.indexOf(id);
      return [...stack.slice(from), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of index.get(id)?.dependsOn ?? []) {
      if (!index.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const t of tasks) {
    const found = visit(t.id);
    if (found) return found;
  }
  return null;
}

/**
 * Kahn topological sort. Ties are broken by (complexity desc, id asc) so the
 * order is deterministic across runs — which matters for reproducing a plan and
 * for snapshot tests.
 */
export function topoSort(tasks: Task[]): Task[] {
  validateGraph(tasks);
  const index = indexTasks(tasks);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, t.dependsOn.length);
    for (const dep of t.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(t.id);
      dependents.set(dep, list);
    }
  }

  const rank = (id: string) => {
    const t = index.get(id)!;
    return [-t.complexity, t.id] as const;
  };
  const cmp = (a: string, b: string) => {
    const [ac, ai] = rank(a);
    const [bc, bi] = rank(b);
    return ac !== bc ? ac - bc : ai < bi ? -1 : ai > bi ? 1 : 0;
  };

  const ready = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  ready.sort(cmp);

  const out: Task[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(index.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) {
        ready.push(next);
        ready.sort(cmp);
      }
    }
  }

  // validateGraph already ruled out cycles, so this is a genuine invariant break.
  if (out.length !== tasks.length) {
    throw new GraphError('Topological sort did not cover every task — the graph changed under us');
  }
  return out;
}

/** Has this task reached a state it will not leave on its own? */
export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Every dependency satisfied? A dependency is satisfied only by `done`. */
export function dependenciesMet(task: Task, index: TaskIndex): boolean {
  return task.dependsOn.every((id) => index.get(id)?.status === 'done');
}

/** A dependency that failed or was cancelled makes this task unreachable. */
export function isBlockedByFailure(task: Task, index: TaskIndex): boolean {
  return task.dependsOn.some((id) => {
    const dep = index.get(id);
    return dep?.status === 'failed' || dep?.status === 'cancelled';
  });
}

export interface ReadyOptions {
  /** Only consider tasks in this phase (Professional mode gating). */
  phase?: PhaseId;
  /** Tasks currently held by workers, by id. */
  running?: Set<string>;
  /** Files currently locked by running tasks. */
  lockedFiles?: Set<string>;
  /** Hard cap on how many are returned. */
  limit?: number;
}

/**
 * Which tasks can start right now.
 *
 * A task is ready when it is `planned` or `queued`, every dependency is `done`,
 * no worker already holds it, and none of the files it declares would collide
 * with a file a running task holds. The file check is what makes
 * "never two agents on one file" a property of the scheduler rather than a
 * hope about the planner.
 *
 * Returned highest-complexity-first: long poles start early, which shortens the
 * critical path when the worker pool is the constraint.
 */
export function readyTasks(tasks: Task[], opts: ReadyOptions = {}): Task[] {
  const index = indexTasks(tasks);
  const running = opts.running ?? new Set<string>();
  const locked = opts.lockedFiles ?? new Set<string>();

  const ready = tasks.filter((t) => {
    if (running.has(t.id)) return false;
    if (t.status !== 'planned' && t.status !== 'queued') return false;
    if (opts.phase && t.phase !== opts.phase) return false;
    if (!dependenciesMet(t, index)) return false;
    if ((t.expectedFiles ?? []).some((f) => locked.has(normalizeFilePath(f)))) return false;
    return true;
  });

  ready.sort((a, b) => (b.complexity !== a.complexity ? b.complexity - a.complexity : a.id < b.id ? -1 : 1));
  return opts.limit === undefined ? ready : ready.slice(0, opts.limit);
}

/** Lowercased, forward-slashed, de-dotted — so lock keys compare correctly on Windows. */
export function normalizeFilePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Tasks that can never run because an ancestor failed. Surfacing these as a set
 * lets the orchestrator fail them in one pass instead of leaving a plan
 * "running" forever with nothing runnable.
 */
export function unreachableTasks(tasks: Task[]): Task[] {
  const poisoned = new Set(
    tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').map((t) => t.id),
  );
  if (!poisoned.size) return [];

  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (poisoned.has(t.id) || isTerminal(t.status)) continue;
      if (t.dependsOn.some((d) => poisoned.has(d))) {
        poisoned.add(t.id);
        grew = true;
      }
    }
  }
  // Only the downstream victims — the originally-failed tasks are already terminal.
  return tasks.filter((t) => poisoned.has(t.id) && !isTerminal(t.status));
}

/** Is the plan finished — nothing running, nothing runnable? */
export function isPlanSettled(tasks: Task[]): boolean {
  if (!tasks.length) return true;
  if (tasks.some((t) => t.status === 'running' || t.status === 'verifying')) return false;
  if (readyTasks(tasks).length > 0) return false;
  return tasks.every((t) => isTerminal(t.status) || t.status === 'review' || t.status === 'blocked');
}

export interface GraphProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  review: number;
  blocked: number;
  /** 0-1. Counts `done` only — review is not progress until a human says so. */
  fraction: number;
}

export function progressOf(tasks: Task[]): GraphProgress {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const done = count('done');
  return {
    total: tasks.length,
    done,
    failed: count('failed'),
    running: count('running') + count('verifying'),
    review: count('review'),
    blocked: count('blocked'),
    fraction: tasks.length ? done / tasks.length : 0,
  };
}

/**
 * Longest dependency chain, weighted by complexity. Used to show the user which
 * chain actually determines how long the plan takes — adding workers only helps
 * off the critical path.
 */
export function criticalPath(tasks: Task[]): string[] {
  validateGraph(tasks);
  const index = indexTasks(tasks);
  const best = new Map<string, { cost: number; path: string[] }>();

  for (const t of topoSort(tasks)) {
    let prev = { cost: 0, path: [] as string[] };
    for (const dep of t.dependsOn) {
      const candidate = best.get(dep);
      if (candidate && candidate.cost > prev.cost) prev = candidate;
    }
    best.set(t.id, { cost: prev.cost + (index.get(t.id)?.complexity ?? 1), path: [...prev.path, t.id] });
  }

  let winner: { cost: number; path: string[] } = { cost: 0, path: [] };
  for (const v of best.values()) if (v.cost > winner.cost) winner = v;
  return winner.path;
}

/**
 * Group tasks into waves — the sets that could run simultaneously given
 * unlimited workers. Purely for display: the scheduler uses `readyTasks`,
 * because real execution never matches the idealised wave shape.
 */
export function executionWaves(tasks: Task[]): Task[][] {
  validateGraph(tasks);
  const index = indexTasks(tasks);
  const depth = new Map<string, number>();
  for (const t of topoSort(tasks)) {
    const d = Math.max(0, ...t.dependsOn.map((id) => (depth.get(id) ?? 0) + 1));
    depth.set(t.id, d);
  }
  const waves: Task[][] = [];
  for (const [id, d] of depth) {
    (waves[d] ??= []).push(index.get(id)!);
  }
  return waves.map((w) => w.sort((a, b) => (a.id < b.id ? -1 : 1)));
}

/**
 * The subset of `tasks` whose outputs a given task should see. A task needs its
 * transitive dependencies' contracts, not the whole plan — this is what keeps
 * the context pack small as the graph grows.
 */
export function ancestorsOf(taskId: string, tasks: Task[]): Task[] {
  const index = indexTasks(tasks);
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const dep of index.get(id)?.dependsOn ?? []) {
      if (out.has(dep)) continue;
      out.add(dep);
      walk(dep);
    }
  };
  walk(taskId);
  // Dependency order, so a context pack reads top-down.
  return topoSort(tasks).filter((t) => out.has(t.id));
}
