import { beforeEach, describe, expect, it } from 'vitest';
import type { Plan, Task, VerificationReport } from '@agentic/core';
import { checkGate, isSensitivePath } from '../src/review.js';
import { DEFAULT_NODE_CONFIG, state } from '../src/store.js';

/**
 * The human gate (ADR 0004).
 *
 * These are the tests that pin the product's central safety promise. Two rules
 * must hold in EVERY execution mode:
 *
 *   1. Tainted content never auto-accepts.
 *   2. Unverified work never auto-accepts.
 *
 * If either of these ever goes green in `auto` mode, the gate is broken.
 */

const passingVerification: VerificationReport = {
  ok: true,
  tier1: { name: 'Syntax', ok: true, durationMs: 1, issues: [], checked: 1, skippedCount: 0 },
  tier2: [{ name: 'Tests', ok: true, durationMs: 1, issues: [] }],
  repairs: 0,
  at: Date.now(),
};

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    planId: 'p1',
    title: 'Add a thing',
    description: '',
    capability: 'code',
    dependsOn: [],
    status: 'review',
    complexity: 2,
    acceptance: [],
    attempts: [],
    maxAttempts: 3,
    worklog: [],
    producedFiles: ['src/thing.ts'],
    verification: passingVerification,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const plan = { id: 'p1', executionMode: undefined } as unknown as Plan;

beforeEach(() => {
  state.config = { ...DEFAULT_NODE_CONFIG };
  state.projects = [];
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    'apps/web/.env.local',
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    'Dockerfile',
    'src/auth.ts',
    'db/migrations/001_init.sql',
    '.agentic-team/config.json',
  ])('treats %s as sensitive', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(['src/components/Button.tsx', 'README.md', 'src/utils/format.ts'])(
    'treats %s as ordinary',
    (path) => {
      expect(isSensitivePath(path)).toBe(false);
    },
  );
});

describe('checkGate — approval mode', () => {
  beforeEach(() => {
    state.config.executionMode = 'approval';
  });

  it('holds everything for a person, even fully verified work', () => {
    const decision = checkGate({ projectId: 'x', kind: 'task', task: makeTask(), plan });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresReview).toBe(true);
    expect(decision.reason).toMatch(/every change waits for you/i);
  });
});

describe('checkGate — hybrid mode', () => {
  beforeEach(() => {
    state.config.executionMode = 'hybrid';
  });

  it('lets verified, ordinary work through', () => {
    expect(checkGate({ projectId: 'x', kind: 'task', task: makeTask(), plan }).allowed).toBe(true);
  });

  it('holds work that touches a sensitive file', () => {
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ producedFiles: ['src/thing.ts', '.env'] }),
      plan,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('.env');
  });
});

describe('checkGate — auto mode', () => {
  beforeEach(() => {
    state.config.executionMode = 'auto';
  });

  it('lets verified work through, including sensitive files', () => {
    // This is what the user asked for by choosing auto, and it is stated
    // plainly in the settings copy.
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ producedFiles: ['.env'] }),
      plan,
    });
    expect(decision.allowed).toBe(true);
  });

  it('NEVER lets tainted content through', () => {
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ tainted: true, taintSource: 'a GitHub issue' }),
      plan,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/external|outside your project/i);
    expect(decision.reason).toContain('a GitHub issue');
  });

  it('lets tainted content through once a human has acknowledged it', () => {
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ tainted: true, taintAcknowledgedAt: Date.now() }),
      plan,
    });
    expect(decision.allowed).toBe(true);
  });

  it('NEVER lets unverified work through', () => {
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ verification: undefined }),
      plan,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not been verified/i);
  });

  it('NEVER lets work through that failed verification', () => {
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ verification: { ...passingVerification, ok: false } }),
      plan,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/verification failed/i);
  });
});

describe('checkGate — per-plan override', () => {
  it('a plan can be stricter than the node default', () => {
    state.config.executionMode = 'auto';
    const strictPlan = { id: 'p1', executionMode: 'approval' } as unknown as Plan;
    expect(checkGate({ projectId: 'x', kind: 'task', task: makeTask(), plan: strictPlan }).allowed).toBe(
      false,
    );
  });

  it('a plan can be looser than the node default', () => {
    state.config.executionMode = 'approval';
    const autoPlan = { id: 'p1', executionMode: 'auto' } as unknown as Plan;
    expect(checkGate({ projectId: 'x', kind: 'task', task: makeTask(), plan: autoPlan }).allowed).toBe(true);
  });

  it('but a plan override still cannot bypass taint', () => {
    state.config.executionMode = 'approval';
    const autoPlan = { id: 'p1', executionMode: 'auto' } as unknown as Plan;
    const decision = checkGate({
      projectId: 'x',
      kind: 'task',
      task: makeTask({ tainted: true }),
      plan: autoPlan,
    });
    expect(decision.allowed).toBe(false);
  });
});
