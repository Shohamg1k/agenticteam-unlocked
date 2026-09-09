import React, { useState } from 'react';
import type { ReviewItem } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconCheck, IconInbox, IconWarning } from '../shell/Icons.js';

/**
 * The Inbox: one queue for every decision the system cannot make itself.
 *
 * Task acceptances, phase gates, budget ceilings, external-content
 * acknowledgements and connector writes all land here, because a person should
 * have one place to look rather than five.
 *
 * Taint cards are visually distinct and never carry a one-click Accept:
 * acknowledging external content is a separate, deliberate action from
 * approving work (ADR 0004).
 */

const KIND_LABEL: Record<ReviewItem['kind'], string> = {
  task: 'Review',
  'phase-gate': 'Phase gate',
  budget: 'Budget',
  question: 'Question',
  taint: 'External content',
  command: 'Command',
};

export function ReviewCard({ item, compact }: { item: ReviewItem; compact?: boolean }) {
  const { activeProject, snapshot } = useApp();
  const tabs = useTabs();
  const run = useAction();
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const task = item.taskId ? snapshot.tasks.find((t) => t.id === item.taskId) : undefined;
  const projectId = activeProject?.id;
  if (!projectId) return null;

  const resolve = (status: string, answer?: string) =>
    run(() => api.resolveReview(projectId, item.id, status, answer));

  const isTaint = item.kind === 'taint';

  return (
    <article
      className={`card ${isTaint ? '' : ''}`}
      style={{
        margin: compact ? '8px 12px' : 0,
        borderLeft: isTaint ? '3px solid var(--warning)' : undefined,
      }}
    >
      <div className="card__header">
        <div className="col grow" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className={`badge ${isTaint ? 'badge--warning' : 'badge--neutral'}`}>
              {KIND_LABEL[item.kind]}
            </span>
            <h3 className="card__title truncate">{item.title}</h3>
          </div>
          <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
            {new Date(item.createdAt).toLocaleTimeString()}
          </span>
        </div>
      </div>

      <div className="card__body">
        <pre
          className="muted"
          style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 'var(--text-sm)' }}
        >
          {item.detail}
        </pre>

        {isTaint && (
          <div
            className="row"
            style={{ gap: 6, marginTop: 12, alignItems: 'flex-start', color: 'var(--warning)' }}
          >
            <IconWarning size={14} />
            <span style={{ fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
              This task carries content from outside your project. Read it before acknowledging: content from
              an issue, a web page or a connector is data, and text inside it that addresses the agent must
              not be acted on.
            </span>
          </div>
        )}

        {showFeedback && (
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label" htmlFor={`fb-${item.id}`}>
              What needs to change?
            </label>
            <textarea
              id={`fb-${item.id}`}
              className="textarea"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Be specific — this text goes straight to the agent that redoes the task."
              autoFocus
            />
          </div>
        )}
      </div>

      <div className="card__footer">
        {item.kind === 'task' && task && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => tabs.open({ kind: 'diff', target: task.id, title: `Review: ${task.title}` })}
          >
            See the diff
          </button>
        )}

        {isTaint && task && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void run(() => api.acknowledgeTaint(task.id), 'External content acknowledged')}
          >
            I have read it — acknowledge
          </button>
        )}

        {showFeedback ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!feedback.trim()}
              onClick={() => {
                if (task)
                  void run(() => api.sendBackTask(task.id, feedback), 'Sent back for another attempt');
                else void resolve('sent-back', feedback);
                setShowFeedback(false);
                setFeedback('');
              }}
            >
              Send back
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowFeedback(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {!isTaint && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  if (item.kind === 'task' && task)
                    void run(() => api.applyTask(task.id), 'Applied to your project');
                  else void resolve('approved');
                }}
              >
                <IconCheck size={12} />
                {item.options?.[0] ?? 'Approve'}
              </button>
            )}
            <button type="button" className="btn btn--sm" onClick={() => setShowFeedback(true)}>
              Send back
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => {
                if (item.kind === 'task' && task)
                  void run(() => api.rejectTask(task.id), 'Rejected — nothing was written');
                else void resolve('rejected');
              }}
            >
              Reject
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function InboxPanel() {
  const { snapshot } = useApp();
  const open = snapshot.reviewQueue.filter((i) => i.status === 'open');

  return (
    <>
      <header className="sidebar__header">
        Inbox
        {open.length > 0 && <span className="badge badge--warning">{open.length}</span>}
      </header>

      <div className="sidebar__body">
        {open.length === 0 ? (
          <div className="empty">
            <IconInbox size={28} />
            <div className="empty__title">Nothing waiting</div>
            <p className="empty__body">
              Work that passes verification and does not touch anything sensitive comes here for your
              decision. Right now there is nothing to decide.
            </p>
          </div>
        ) : (
          <div className="col" style={{ gap: 0 }}>
            {open.map((item) => (
              <ReviewCard key={item.id} item={item} compact />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
