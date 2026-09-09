import type { Checkpoint } from '@agentic/core';
import { newCheckpointId } from '@agentic/core';
import {
  changedFiles,
  createCheckpoint as gitCheckpoint,
  restoreCheckpoint as gitRestore,
  headSha,
} from './git.js';
import { projectState, saveCheckpoints } from './store.js';
import { describeError, log } from './log.js';

/**
 * Checkpoints: every agent action is reversible.
 *
 * One is taken before applying a task's files and after. The "before" is what
 * a rollback returns to; the "after" is what makes "show me what this task
 * changed" answerable later, once the working tree has moved on.
 *
 * They are git objects on a hidden ref namespace, so they cost almost nothing,
 * survive a restart, and cannot be lost to garbage collection — but they never
 * appear in the user's branch list or get pushed.
 */

export async function takeCheckpoint(
  projectId: string,
  label: string,
  scope: { planId?: string; taskId?: string } = {},
): Promise<Checkpoint | undefined> {
  const ps = projectState(projectId);
  if (!ps) return undefined;

  try {
    const previous = ps.checkpoints[0];
    const result = await gitCheckpoint(ps.root, label);
    if (!result) return undefined;

    const files = previous ? await changedFiles(ps.root, previous.ref, result.sha).catch(() => []) : [];

    const checkpoint: Checkpoint = {
      id: newCheckpointId(),
      projectId,
      planId: scope.planId,
      taskId: scope.taskId,
      label,
      ref: result.ref,
      files,
      createdAt: Date.now(),
    };

    ps.checkpoints.unshift(checkpoint);
    // Bound the list. The git objects stay reachable through their refs, so an
    // older checkpoint is recoverable by hand even after it leaves this list.
    if (ps.checkpoints.length > 200) ps.checkpoints.length = 200;
    saveCheckpoints(projectId);
    return checkpoint;
  } catch (err) {
    // A project without git loses checkpoints, and that was already said out
    // loud when the project opened. Do not fail the work over it.
    log(`Could not take a checkpoint (${describeError(err)})`, 'warn', { projectId, ...scope });
    return undefined;
  }
}

export async function rollbackTo(projectId: string, checkpointId: string): Promise<{ restored: string }> {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  const checkpoint = ps.checkpoints.find((c) => c.id === checkpointId);
  if (!checkpoint) throw new Error(`No such checkpoint: ${checkpointId}`);

  // `gitRestore` takes its own checkpoint first, so undoing a rollback is
  // always possible. A rollback that loses work is worse than what it undid.
  await gitRestore(ps.root, checkpoint.ref);
  const sha = (await headSha(ps.root)) ?? checkpoint.ref;

  log(
    `Rolled back to "${checkpoint.label}". The state before the rollback was saved as its own checkpoint.`,
    'info',
    {
      projectId,
    },
  );
  saveCheckpoints(projectId);
  return { restored: sha };
}

export function listCheckpoints(projectId: string): Checkpoint[] {
  return projectState(projectId)?.checkpoints ?? [];
}
