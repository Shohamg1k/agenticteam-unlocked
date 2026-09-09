import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffHunk, FileDiff, TaskDiff } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconCheck, IconWarning } from '../shell/Icons.js';

/**
 * Per-hunk diff review.
 *
 * The unit of decision is a hunk, not a file: an agent's change is often 90%
 * right and 10% wrong, and a review that forces all-or-nothing pushes people
 * into accepting the 10% and fixing it later.
 *
 * Nothing here has touched the working tree yet. Rejecting costs nothing and
 * needs no rollback, which is the property that makes accepting safe.
 */

function HunkView({ hunk, accepted, onToggle }: { hunk: DiffHunk; accepted: boolean; onToggle: () => void }) {
  const added = hunk.lines.filter((l) => l.kind === 'add').length;
  const removed = hunk.lines.filter((l) => l.kind === 'remove').length;

  return (
    <div style={{ borderTop: '1px solid var(--border)', opacity: accepted ? 1 : 0.55 }}>
      <div
        className="row"
        style={{
          gap: 8,
          padding: '3px var(--space-3)',
          background: 'var(--bg-panel)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <label className="checkbox">
          <input type="checkbox" checked={accepted} onChange={onToggle} />
          <span className="mono subtle">{hunk.header}</span>
        </label>
        <span className="grow" />
        {added > 0 && <span style={{ color: 'var(--diff-add-fg)' }}>+{added}</span>}
        {removed > 0 && <span style={{ color: 'var(--diff-remove-fg)' }}>−{removed}</span>}
      </div>

      <pre
        className="mono"
        style={{ margin: 0, fontSize: 'var(--text-xs)', lineHeight: 1.55, overflowX: 'auto' }}
      >
        {hunk.lines.map((line, index) => (
          <div
            key={index}
            style={{
              background:
                line.kind === 'add'
                  ? 'var(--diff-add-bg)'
                  : line.kind === 'remove'
                    ? 'var(--diff-remove-bg)'
                    : 'transparent',
              color:
                line.kind === 'add'
                  ? 'var(--diff-add-fg)'
                  : line.kind === 'remove'
                    ? 'var(--diff-remove-fg)'
                    : 'var(--fg-muted)',
              padding: '0 var(--space-3)',
              whiteSpace: 'pre',
            }}
          >
            <span aria-hidden="true" style={{ opacity: 0.6, userSelect: 'none' }}>
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            </span>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function FileDiffView({
  file,
  accepted,
  onToggleHunk,
  onToggleFile,
}: {
  file: FileDiff;
  accepted: Set<number>;
  onToggleHunk: (hunkId: number) => void;
  onToggleFile: (all: boolean) => void;
}) {
  const allAccepted = file.hunks.length > 0 && file.hunks.every((h) => accepted.has(h.id));
  const noneAccepted = file.hunks.every((h) => !accepted.has(h.id));

  const stat = file.hunks.reduce(
    (acc, hunk) => {
      for (const line of hunk.lines) {
        if (line.kind === 'add') acc.added++;
        else if (line.kind === 'remove') acc.removed++;
      }
      return acc;
    },
    { added: 0, removed: 0 },
  );

  return (
    <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
      <div className="card__header">
        <label className="checkbox grow" style={{ minWidth: 0 }}>
          <input
            type="checkbox"
            checked={allAccepted}
            ref={(el) => {
              // Indeterminate is the honest state for a partially accepted file.
              if (el) el.indeterminate = !allAccepted && !noneAccepted;
            }}
            onChange={() => onToggleFile(!allAccepted)}
          />
          <span className="mono truncate" title={file.path}>
            {file.path}
          </span>
        </label>

        <span
          className={`badge badge--${file.status === 'added' ? 'success' : file.status === 'deleted' ? 'danger' : 'neutral'}`}
        >
          {file.status}
        </span>
        <span className="subtle mono" style={{ fontSize: 'var(--text-xs)' }}>
          +{stat.added} −{stat.removed}
        </span>
      </div>

      {file.binary ? (
        <div className="card__body muted">Binary file — nothing to show.</div>
      ) : file.hunks.length === 0 ? (
        <div className="card__body muted">No changes.</div>
      ) : (
        file.hunks.map((hunk) => (
          <HunkView
            key={hunk.id}
            hunk={hunk}
            accepted={accepted.has(hunk.id)}
            onToggle={() => onToggleHunk(hunk.id)}
          />
        ))
      )}
    </div>
  );
}

export function DiffTab({ taskId }: { taskId: string }) {
  const { snapshot } = useApp();
  const tabs = useTabs();
  const run = useAction();

  const [diff, setDiff] = useState<TaskDiff>();
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const task = snapshot.tasks.find((t) => t.id === taskId);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await run(() => api.taskDiff(taskId));
    setDiff(result);
    // Everything is accepted by default: the common case is "this is fine",
    // and making the user tick 30 boxes to agree would be hostile.
    if (result) {
      const next: Record<string, Set<number>> = {};
      for (const file of result.files) next[file.path] = new Set(file.hunks.map((h) => h.id));
      setSelection(next);
    }
    setLoading(false);
  }, [taskId, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let hunks = 0;
    let accepted = 0;
    for (const file of diff?.files ?? []) {
      hunks += file.hunks.length;
      accepted += file.hunks.filter((h) => selection[file.path]?.has(h.id)).length;
    }
    return { hunks, accepted };
  }, [diff, selection]);

  if (!task) {
    return (
      <div className="empty">
        <div className="empty__title">That task is gone</div>
        <p className="empty__body">It may have been cancelled, or the plan was removed.</p>
      </div>
    );
  }

  const apply = async () => {
    const partial = totals.accepted < totals.hunks;
    const body = partial
      ? {
          selection: (diff?.files ?? [])
            .map((file) => ({ path: file.path, hunkIds: [...(selection[file.path] ?? [])] }))
            .filter((s) => s.hunkIds.length > 0),
        }
      : {};

    const result = await run(
      () => api.applyTask(taskId, body),
      partial ? `Applied ${totals.accepted} of ${totals.hunks} hunks` : 'Applied to your project',
    );
    if (result) tabs.close(`diff:${taskId}`);
  };

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div
        style={{
          padding: 'var(--space-3)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
        }}
      >
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-md)' }} className="truncate grow">
            {task.title}
          </h2>
          {task.providerId && (
            <span className="badge badge--neutral" title={task.plannedReason}>
              {task.providerId}
            </span>
          )}
        </div>

        {task.verification && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 'var(--text-xs)' }}>
            <span className={`badge ${task.verification.tier1.ok ? 'badge--success' : 'badge--danger'}`}>
              Syntax {task.verification.tier1.ok ? 'passed' : 'failed'}
              {task.verification.tier1.checked ? ` (${task.verification.tier1.checked} files)` : ''}
            </span>
            {task.verification.tier2.map((check) => (
              <span
                key={check.name}
                className={`badge ${check.skipped ? 'badge--neutral' : check.ok ? 'badge--success' : 'badge--danger'}`}
                title={check.skipped ?? check.command}
              >
                {check.name} {check.skipped ? 'skipped' : check.ok ? 'passed' : 'failed'}
              </span>
            ))}
            {task.verification.repairs > 0 && (
              <span className="badge badge--info" title="It fixed its own output before this reached you">
                self-repaired ×{task.verification.repairs}
              </span>
            )}
          </div>
        )}

        {task.tainted && !task.taintAcknowledgedAt && (
          <div
            className="row"
            style={{
              gap: 6,
              marginTop: 8,
              padding: 8,
              background: 'var(--warning-bg)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <IconWarning size={14} />
            <span className="grow" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
              This task used content from outside your project ({task.taintSource ?? 'unknown source'}).
              Acknowledge it before applying.
            </span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void run(() => api.acknowledgeTaint(taskId), 'Acknowledged')}
            >
              Acknowledge
            </button>
          </div>
        )}
      </div>

      <div className="scroll grow pad">
        {loading ? (
          <div className="empty">
            <span className="spinner" />
          </div>
        ) : !diff?.files.length ? (
          <div className="empty">
            <div className="empty__title">Nothing to review</div>
            <p className="empty__body">
              This task produced no files. That is expected for a research or planning task; for a build task
              it usually means the model described its work instead of emitting it.
            </p>
          </div>
        ) : (
          diff.files.map((file) => (
            <FileDiffView
              key={file.path}
              file={file}
              accepted={selection[file.path] ?? new Set()}
              onToggleHunk={(hunkId) =>
                setSelection((prev) => {
                  const next = new Set(prev[file.path] ?? []);
                  if (next.has(hunkId)) next.delete(hunkId);
                  else next.add(hunkId);
                  return { ...prev, [file.path]: next };
                })
              }
              onToggleFile={(all) =>
                setSelection((prev) => ({
                  ...prev,
                  [file.path]: all ? new Set(file.hunks.map((h) => h.id)) : new Set(),
                }))
              }
            />
          ))
        )}
      </div>

      {showFeedback && (
        <div style={{ padding: 'var(--space-3)', borderTop: '1px solid var(--border)' }}>
          <div className="field">
            <label className="field__label" htmlFor="diff-feedback">
              What needs to change?
            </label>
            <textarea
              id="diff-feedback"
              className="textarea"
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="This goes straight to the agent that redoes the task, so be specific."
            />
          </div>
        </div>
      )}

      <div
        className="row"
        style={{
          gap: 8,
          padding: 'var(--space-3)',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-panel)',
        }}
      >
        <span className="subtle grow" style={{ fontSize: 'var(--text-xs)' }}>
          {totals.accepted === totals.hunks
            ? `${totals.hunks} hunk${totals.hunks === 1 ? '' : 's'} across ${diff?.files.length ?? 0} file${diff?.files.length === 1 ? '' : 's'}`
            : `${totals.accepted} of ${totals.hunks} hunks selected`}
          {' · nothing has been written yet'}
        </span>

        {showFeedback ? (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!feedback.trim()}
              onClick={() =>
                void run(() => api.sendBackTask(taskId, feedback), 'Sent back').then(() =>
                  tabs.close(`diff:${taskId}`),
                )
              }
            >
              Send back
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setShowFeedback(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={totals.accepted === 0 || (task.tainted && !task.taintAcknowledgedAt)}
              onClick={() => void apply()}
              title={
                task.tainted && !task.taintAcknowledgedAt
                  ? 'Acknowledge the external content first'
                  : 'Write the selected hunks into your project'
              }
            >
              <IconCheck size={14} />
              {totals.accepted === totals.hunks ? 'Accept all' : `Accept ${totals.accepted}`}
            </button>
            <button type="button" className="btn" onClick={() => setShowFeedback(true)}>
              Send back
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() =>
                void run(() => api.rejectTask(taskId), 'Rejected — nothing was written').then(() =>
                  tabs.close(`diff:${taskId}`),
                )
              }
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
