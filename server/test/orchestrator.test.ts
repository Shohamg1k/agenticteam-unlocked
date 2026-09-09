import { describe, expect, it } from 'vitest';
import type { Task, TaskAttempt } from '@agentic/core';
import { hasHadItsRepairAttempt } from '../src/orchestrator.js';

/**
 * The repair rule.
 *
 * A provider gets two goes at a task — the original and one repair — before the
 * work moves to a different model. Getting this off by one is not a cosmetic
 * bug: it retires the provider on its first failure, so the repair attempt
 * never happens, and on the very common single-provider setup that turns any
 * verification failure into a dead task.
 *
 * That is exactly what happened, and these tests exist so it cannot happen
 * again quietly.
 */

function attempt(
  n: number,
  providerId: string,
  outcome: TaskAttempt['outcome'] = 'verification-failed',
): TaskAttempt {
  return {
    n,
    providerId,
    model: 'm',
    startedAt: 0,
    endedAt: 1,
    usage: { input: 0, output: 0, costUsd: 0, measured: false },
    outcome,
  };
}

function taskWith(attempts: TaskAttempt[], repairs = 0): Task {
  return {
    id: 't1',
    planId: 'p1',
    title: 'x',
    description: '',
    capability: 'code',
    dependsOn: [],
    status: 'running',
    complexity: 2,
    acceptance: [],
    attempts,
    maxAttempts: 3,
    worklog: [],
    verification: {
      ok: false,
      tier1: { name: 'Syntax', ok: true, durationMs: 1, issues: [] },
      tier2: [],
      repairs,
      at: 0,
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('hasHadItsRepairAttempt', () => {
  it('is false after the first failure, so the repair actually happens', () => {
    // The regression. `verification.repairs` is already 1 here, which is what
    // used to retire the provider immediately.
    const task = taskWith([attempt(1, 'claude-code')], 1);
    expect(hasHadItsRepairAttempt(task, 'claude-code')).toBe(false);
  });

  it('is true after the repair attempt also failed', () => {
    const task = taskWith([attempt(1, 'claude-code'), attempt(2, 'claude-code')], 2);
    expect(hasHadItsRepairAttempt(task, 'claude-code')).toBe(true);
  });

  it('counts per provider, not per task', () => {
    // After failing over, the new provider is entitled to its own repair.
    const task = taskWith([attempt(1, 'groq'), attempt(2, 'groq'), attempt(3, 'claude-code')], 3);
    expect(hasHadItsRepairAttempt(task, 'groq')).toBe(true);
    expect(hasHadItsRepairAttempt(task, 'claude-code')).toBe(false);
  });

  it('is false for a provider that has never run it', () => {
    const task = taskWith([attempt(1, 'claude-code')]);
    expect(hasHadItsRepairAttempt(task, 'anthropic')).toBe(false);
  });

  it('is false on a task with no attempts at all', () => {
    expect(hasHadItsRepairAttempt(taskWith([]), 'claude-code')).toBe(false);
  });

  it('does not read verification.repairs, whatever it says', () => {
    // The whole point of counting from the attempt log.
    const inflated = taskWith([attempt(1, 'claude-code')], 99);
    expect(hasHadItsRepairAttempt(inflated, 'claude-code')).toBe(false);
  });

  it('counts a successful attempt too, so a flaky provider is not retried forever', () => {
    const task = taskWith([attempt(1, 'claude-code', 'success'), attempt(2, 'claude-code')], 1);
    expect(hasHadItsRepairAttempt(task, 'claude-code')).toBe(true);
  });
});
