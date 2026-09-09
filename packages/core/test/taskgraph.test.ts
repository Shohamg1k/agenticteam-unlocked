import { describe, expect, it } from 'vitest';
import {
  GraphError,
  ancestorsOf,
  criticalPath,
  dependenciesMet,
  executionWaves,
  findCycle,
  indexTasks,
  isPlanSettled,
  normalizeFilePath,
  progressOf,
  readyTasks,
  topoSort,
  unreachableTasks,
  validateGraph,
} from '../src/taskgraph.js';
import { graph, makeTask } from './helpers.js';

describe('validateGraph', () => {
  it('accepts a DAG', () => {
    expect(() => validateGraph(graph({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }))).not.toThrow();
  });

  it('rejects a dependency on an unknown task', () => {
    expect(() => validateGraph(graph({ a: ['nope'] }))).toThrow(GraphError);
  });

  it('rejects a self-dependency', () => {
    expect(() => validateGraph(graph({ a: ['a'] }))).toThrow(/unknown or self/);
  });

  it('rejects duplicate ids', () => {
    const dupe = [makeTask({ id: 'x' }), makeTask({ id: 'x' })];
    expect(() => validateGraph(dupe)).toThrow(/Duplicate task id/);
  });

  it('rejects a cycle and names it', () => {
    expect(() => validateGraph(graph({ a: ['c'], b: ['a'], c: ['b'] }))).toThrow(/cycle/);
  });
});

describe('findCycle', () => {
  it('returns null for a DAG', () => {
    expect(findCycle(graph({ a: [], b: ['a'] }))).toBeNull();
  });

  it('returns the cycle path', () => {
    const cycle = findCycle(graph({ a: ['b'], b: ['a'] }));
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('finds a cycle that is not reachable from the first node', () => {
    expect(findCycle(graph({ root: [], a: ['b'], b: ['a'] }))).not.toBeNull();
  });
});

describe('topoSort', () => {
  it('orders dependencies before dependents', () => {
    const order = topoSort(graph({ d: ['b', 'c'], b: ['a'], c: ['a'], a: [] })).map((t) => t.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('is deterministic across calls', () => {
    const g = graph({ a: [], b: [], c: [], d: ['a', 'b', 'c'] });
    expect(topoSort(g).map((t) => t.id)).toEqual(topoSort([...g].reverse()).map((t) => t.id));
  });

  it('breaks ties by complexity descending', () => {
    const tasks = [
      makeTask({ id: 'low', complexity: 1 }),
      makeTask({ id: 'high', complexity: 5 }),
      makeTask({ id: 'mid', complexity: 3 }),
    ];
    expect(topoSort(tasks).map((t) => t.id)).toEqual(['high', 'mid', 'low']);
  });

  it('handles an empty graph', () => {
    expect(topoSort([])).toEqual([]);
  });
});

describe('readyTasks', () => {
  it('returns only tasks whose dependencies are all done', () => {
    const tasks = graph({ a: [], b: ['a'] });
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['a']);

    tasks[0]!.status = 'done';
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['b']);
  });

  it('does not treat a task in review as a satisfied dependency', () => {
    const tasks = graph({ a: [], b: ['a'] });
    tasks[0]!.status = 'review';
    expect(readyTasks(tasks)).toEqual([]);
  });

  it('excludes tasks a worker already holds', () => {
    const tasks = graph({ a: [], b: [] });
    expect(readyTasks(tasks, { running: new Set(['a']) }).map((t) => t.id)).toEqual(['b']);
  });

  it('refuses a task whose files collide with a running task', () => {
    const tasks = [
      makeTask({ id: 'a', expectedFiles: ['src/App.tsx'] }),
      makeTask({ id: 'b', expectedFiles: ['src/other.ts'] }),
    ];
    const locked = new Set([normalizeFilePath('src/App.tsx')]);
    expect(readyTasks(tasks, { lockedFiles: locked }).map((t) => t.id)).toEqual(['b']);
  });

  it('compares lock paths case- and separator-insensitively', () => {
    const tasks = [makeTask({ id: 'a', expectedFiles: ['src\\App.tsx'] })];
    const locked = new Set([normalizeFilePath('./SRC/app.tsx')]);
    expect(readyTasks(tasks, { lockedFiles: locked })).toEqual([]);
  });

  it('filters by phase when one is given', () => {
    const tasks = [makeTask({ id: 'a', phase: 'design' }), makeTask({ id: 'b', phase: 'implementation' })];
    expect(readyTasks(tasks, { phase: 'design' }).map((t) => t.id)).toEqual(['a']);
  });

  it('returns the highest-complexity task first', () => {
    const tasks = [makeTask({ id: 'small', complexity: 1 }), makeTask({ id: 'big', complexity: 5 })];
    expect(readyTasks(tasks)[0]!.id).toBe('big');
  });

  it('honours the limit', () => {
    expect(readyTasks(graph({ a: [], b: [], c: [] }), { limit: 2 })).toHaveLength(2);
  });
});

describe('dependenciesMet', () => {
  it('is true only when every dependency is done', () => {
    const tasks = graph({ a: [], b: [], c: ['a', 'b'] });
    const index = indexTasks(tasks);
    expect(dependenciesMet(tasks[2]!, index)).toBe(false);
    tasks[0]!.status = 'done';
    expect(dependenciesMet(tasks[2]!, index)).toBe(false);
    tasks[1]!.status = 'done';
    expect(dependenciesMet(tasks[2]!, index)).toBe(true);
  });
});

describe('unreachableTasks', () => {
  it('is empty when nothing failed', () => {
    expect(unreachableTasks(graph({ a: [], b: ['a'] }))).toEqual([]);
  });

  it('propagates through the whole downstream chain', () => {
    const tasks = graph({ a: [], b: ['a'], c: ['b'], unrelated: [] });
    tasks[0]!.status = 'failed';
    expect(
      unreachableTasks(tasks)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['b', 'c']);
  });

  it('does not re-report the failed task itself', () => {
    const tasks = graph({ a: [], b: ['a'] });
    tasks[0]!.status = 'failed';
    expect(unreachableTasks(tasks).map((t) => t.id)).not.toContain('a');
  });
});

describe('isPlanSettled', () => {
  it('is true for an empty plan', () => {
    expect(isPlanSettled([])).toBe(true);
  });

  it('is false while work is runnable', () => {
    expect(isPlanSettled(graph({ a: [] }))).toBe(false);
  });

  it('is false while a task is running', () => {
    const tasks = graph({ a: [] });
    tasks[0]!.status = 'running';
    expect(isPlanSettled(tasks)).toBe(false);
  });

  it('is true when everything is terminal', () => {
    const tasks = graph({ a: [], b: ['a'] });
    tasks[0]!.status = 'done';
    tasks[1]!.status = 'done';
    expect(isPlanSettled(tasks)).toBe(true);
  });

  it('is true when everything left is waiting on a human', () => {
    const tasks = graph({ a: [] });
    tasks[0]!.status = 'review';
    expect(isPlanSettled(tasks)).toBe(true);
  });
});

describe('progressOf', () => {
  it('counts done only', () => {
    const tasks = graph({ a: [], b: [], c: [], d: [] });
    tasks[0]!.status = 'done';
    tasks[1]!.status = 'review';
    tasks[2]!.status = 'running';
    const p = progressOf(tasks);
    expect(p).toMatchObject({ total: 4, done: 1, review: 1, running: 1 });
    expect(p.fraction).toBeCloseTo(0.25);
  });
});

describe('criticalPath', () => {
  it('returns the longest complexity-weighted chain', () => {
    const tasks = [
      makeTask({ id: 'a', complexity: 1 }),
      makeTask({ id: 'b', dependsOn: ['a'], complexity: 5 }),
      makeTask({ id: 'c', dependsOn: ['a'], complexity: 1 }),
      makeTask({ id: 'd', dependsOn: ['b', 'c'], complexity: 1 }),
    ];
    expect(criticalPath(tasks)).toEqual(['a', 'b', 'd']);
  });
});

describe('executionWaves', () => {
  it('groups tasks by dependency depth', () => {
    const waves = executionWaves(graph({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }));
    expect(waves.map((w) => w.map((t) => t.id))).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('ancestorsOf', () => {
  it('returns transitive dependencies in dependency order', () => {
    const tasks = graph({ a: [], b: ['a'], c: ['b'], unrelated: [] });
    expect(ancestorsOf('c', tasks).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('is empty for a root task', () => {
    expect(ancestorsOf('a', graph({ a: [], b: ['a'] }))).toEqual([]);
  });
});
