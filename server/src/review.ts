import type { ExecutionMode, Plan, ReviewItem, ReviewItemKind, Task } from '@agentic/core';
import { rid } from '@agentic/core';
import { getProject } from './projects.js';
import { changed, projectState, saveReviewQueue, state } from './store.js';
import { log } from './log.js';

/**
 * The human gate.
 *
 * ADR 0004: the check lives here and is called from every write-class handler,
 * not from a middleware and never from the UI. `ExecutionMode` is an input to
 * the check, not a way around it.
 *
 * Two rules hold in every mode, including `auto`:
 *   1. Tainted content never auto-accepts.
 *   2. Every automatic acceptance is audited with the policy that allowed it.
 */

export interface GateContext {
  projectId: string;
  kind: ReviewItemKind;
  task?: Task;
  plan?: Plan;
}

export interface GateDecision {
  /** True when the action may proceed now. */
  allowed: boolean;
  /** Why — shown in the audit log and, when blocked, in the UI. */
  reason: string;
  /** Set when the caller should queue a review item instead of proceeding. */
  requiresReview: boolean;
}

/** Paths where an unreviewed change is disproportionately dangerous. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i,
  /(^|\/)(auth|security|crypto|session|password|token|secret)[^/]*\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/i,
  /(^|\/)migrations?\//i,
  /(^|\/)\.agentic-team\//i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(path));
}

function effectiveMode(projectId: string, plan?: Plan): ExecutionMode {
  return plan?.executionMode ?? getProject(projectId)?.settings.executionMode ?? state.config.executionMode;
}

/**
 * Decide whether an action may proceed without a person.
 *
 * The order of the checks is the policy: taint first (never bypassable), then
 * verification, then sensitivity, then the user's chosen mode. Reordering any
 * of these would change what the product guarantees.
 */
export function checkGate(ctx: GateContext): GateDecision {
  const mode = effectiveMode(ctx.projectId, ctx.plan);

  // 1. Taint. Not bypassable by any mode, ever.
  if (ctx.task?.tainted && !ctx.task.taintAcknowledgedAt) {
    return {
      allowed: false,
      requiresReview: true,
      reason: `This task carries content from outside your project (${ctx.task.taintSource ?? 'an external source'}). External content is never applied without an explicit acknowledgement, in any execution mode.`,
    };
  }

  // 2. Verification. Unverified output never self-accepts.
  if (ctx.kind === 'task') {
    const verification = ctx.task?.verification;
    if (!verification) {
      return { allowed: false, requiresReview: true, reason: 'This task has not been verified yet.' };
    }
    if (!verification.ok) {
      return {
        allowed: false,
        requiresReview: true,
        reason: 'Verification failed, so this needs a person to look at it.',
      };
    }
  }

  // 3. Sensitivity. Hybrid mode escalates these; auto mode accepts them,
  //    because a user who chose auto asked for exactly that.
  const sensitive = (ctx.task?.producedFiles ?? []).filter(isSensitivePath);
  if (sensitive.length && mode !== 'auto') {
    return {
      allowed: false,
      requiresReview: true,
      reason: `Touches sensitive files (${sensitive.slice(0, 3).join(', ')}${sensitive.length > 3 ? `, +${sensitive.length - 3} more` : ''}), so it waits for you.`,
    };
  }

  // 4. The user's standing policy.
  switch (mode) {
    case 'approval':
      return { allowed: false, requiresReview: true, reason: 'Approval mode: every change waits for you.' };
    case 'hybrid':
      return {
        allowed: true,
        requiresReview: false,
        reason: 'Hybrid mode: verified, untainted, non-sensitive work is applied automatically.',
      };
    case 'auto':
      return {
        allowed: true,
        requiresReview: false,
        reason: 'Auto mode: verified work is applied automatically.',
      };
  }
}

/** Record an automatic acceptance. Auditing these is what makes auto mode defensible. */
export function auditAutoAccept(projectId: string, task: Task, reason: string): void {
  log(`Auto-accepted "${task.title}" (${task.producedFiles?.length ?? 0} file(s)) — ${reason}`, 'info', {
    projectId,
    planId: task.planId,
    taskId: task.id,
  });
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export function reviewQueue(projectId: string): ReviewItem[] {
  return projectState(projectId)?.reviewQueue ?? [];
}

export function openReviewItems(projectId: string): ReviewItem[] {
  return reviewQueue(projectId).filter((i) => i.status === 'open');
}

export interface EnqueueOptions {
  projectId: string;
  kind: ReviewItemKind;
  title: string;
  detail: string;
  planId?: string;
  taskId?: string;
  options?: string[];
}

export function enqueueReview(opts: EnqueueOptions): ReviewItem {
  const ps = projectState(opts.projectId);
  if (!ps) throw new Error(`No such project: ${opts.projectId}`);

  // A task can only be waiting on one decision at a time; a second card for the
  // same task would be two ways to answer one question.
  const existing = ps.reviewQueue.find(
    (i) =>
      i.status === 'open' && i.kind === opts.kind && i.taskId === opts.taskId && i.planId === opts.planId,
  );
  if (existing) {
    existing.title = opts.title;
    existing.detail = opts.detail;
    saveReviewQueue(opts.projectId);
    return existing;
  }

  const item: ReviewItem = {
    id: rid('rev'),
    kind: opts.kind,
    projectId: opts.projectId,
    planId: opts.planId,
    taskId: opts.taskId,
    title: opts.title,
    detail: opts.detail,
    options: opts.options,
    status: 'open',
    createdAt: Date.now(),
  };

  ps.reviewQueue.unshift(item);
  // Bound the stored queue; resolved items are history, not state.
  const resolved = ps.reviewQueue.filter((i) => i.status !== 'open');
  if (resolved.length > 200) {
    const keep = new Set(resolved.slice(0, 200).map((i) => i.id));
    ps.reviewQueue = ps.reviewQueue.filter((i) => i.status === 'open' || keep.has(i.id));
  }

  saveReviewQueue(opts.projectId);
  return item;
}

export function resolveReview(
  projectId: string,
  itemId: string,
  status: 'approved' | 'rejected' | 'sent-back' | 'answered',
  answer?: string,
): ReviewItem | undefined {
  const ps = projectState(projectId);
  const item = ps?.reviewQueue.find((i) => i.id === itemId);
  if (!ps || !item) return undefined;

  item.status = status;
  item.answer = answer;
  item.resolvedAt = Date.now();
  saveReviewQueue(projectId);
  changed();
  return item;
}

/** Close any open items for a task — used when a task is cancelled or superseded. */
export function closeReviewsFor(projectId: string, taskId: string): void {
  const ps = projectState(projectId);
  if (!ps) return;
  let touched = false;
  for (const item of ps.reviewQueue) {
    if (item.taskId === taskId && item.status === 'open') {
      item.status = 'rejected';
      item.resolvedAt = Date.now();
      touched = true;
    }
  }
  if (touched) saveReviewQueue(projectId);
}
