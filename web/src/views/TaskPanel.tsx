import React from 'react';
import type { Plan, Task, TaskStatus } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconPause, IconPlay, IconStop, IconTasks } from '../shell/Icons.js';
import { TaskRouting } from './TaskRouting.js';

/**
 * The task board in the sidebar: which agent is doing what, right now.
 *
 * This is the panel that answers the question the whole product exists for —
 * "several models are working on my code, what is each of them doing and what
 * is it costing me" — so every row names the provider and the model, not just
 * a spinner.
 */

const STATUS_STYLE: Record<TaskStatus, { label: string; badge: string }> = {
  planned: { label: 'Planned', badge: 'badge--neutral' },
  queued: { label: 'Queued', badge: 'badge--neutral' },
  running: { label: 'Running', badge: 'badge--info' },
  verifying: { label: 'Verifying', badge: 'badge--info' },
  review: { label: 'Needs you', badge: 'badge--warning' },
  done: { label: 'Done', badge: 'badge--success' },
  failed: { label: 'Failed', badge: 'badge--danger' },
  cancelled: { label: 'Cancelled', badge: 'badge--neutral' },
  blocked: { label: 'Blocked', badge: 'badge--warning' },
};

export function TaskRow({
  task,
  onOpen,
  showRouting,
}: {
  task: Task;
  onOpen?: () => void;
  /**
   * Show the per-task provider/model/effort controls.
   *
   * Off in the narrow sidebar, where three selects per row would bury the one
   * thing that panel is for — what is happening right now. On in the task
   * graph, which is where you go to change how the plan will run.
   */
  showRouting?: boolean;
}) {
  const { snapshot } = useApp();
  const run = useAction();
  const provider = snapshot.providers.find((p) => p.id === task.providerId);
  const style = STATUS_STYLE[task.status];
  const active = task.status === 'running' || task.status === 'verifying';

  const spent = task.attempts.reduce((sum, a) => sum + a.usage.costUsd, 0);
  const failedAttempts = task.attempts.filter((a) => a.outcome !== 'success').length;

  return (
    <div className="list__item" style={{ alignItems: 'flex-start', padding: '6px 12px' }}>
      <div className="col grow" style={{ gap: 2 }}>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="truncate grow"
            style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: 'pointer' }}
            onClick={onOpen}
            title={task.description}
          >
            {task.title}
          </button>
          <span className={`badge ${style.badge}`}>{style.label}</span>
        </div>

        <div className="row subtle" style={{ gap: 6, fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}>
          {provider ? (
            <span
              className="row"
              style={{ gap: 4 }}
              title={`Routed to ${provider.name} — ${task.plannedReason ?? 'by policy'}`}
            >
              <span className={`tier tier--${provider.kind}`} />
              {provider.name}
              {task.model && task.model !== provider.id && <span className="subtle">· {task.model}</span>}
            </span>
          ) : task.plannedProviderId ? (
            <span title={task.plannedReason}>planned for {task.plannedProviderId}</span>
          ) : (
            <span>not yet routed</span>
          )}

          {spent > 0 && <span title="Spent on this task so far">${spent.toFixed(4)}</span>}
          {failedAttempts > 0 && (
            <span
              className="badge badge--warning"
              title={task.attempts
                .filter((a) => a.outcome !== 'success')
                .map(
                  (a) =>
                    `Attempt ${a.n} on ${a.providerId}: ${a.outcome}${a.error ? ` — ${a.error.message}` : ''}`,
                )
                .join('\n')}
            >
              {failedAttempts} retried
            </span>
          )}
          {task.verification?.repairs ? (
            <span title="Repaired its own output before passing">self-repaired</span>
          ) : null}
        </div>

        {active && task.worklog.length > 0 && (
          <div className="subtle truncate" style={{ fontSize: 'var(--text-xs)' }}>
            {task.worklog[task.worklog.length - 1]!.text}
          </div>
        )}

        {showRouting && <TaskRouting task={task} />}
      </div>

      {active && (
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          title="Stop this agent"
          aria-label={`Stop ${task.title}`}
          onClick={() => void run(() => api.cancelTask(task.id), 'Agent stopped')}
        >
          <IconStop size={12} />
        </button>
      )}
    </div>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  const { tasksOfPlan } = useApp();
  const tabs = useTabs();
  const run = useAction();

  const tasks = tasksOfPlan(plan.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  const review = tasks.filter((t) => t.status === 'review').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <div className="section">
      <div className="section__header" style={{ cursor: 'default' }}>
        <span className="truncate grow" title={plan.goal}>
          {plan.goal}
        </span>
        <span className="badge badge--neutral">{plan.mode === 'professional' ? 'Pro' : 'Instant'}</span>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <div className="row subtle" style={{ fontSize: 'var(--text-xs)', gap: 8, marginBottom: 6 }}>
          <span>
            {done}/{tasks.length} done
          </span>
          {review > 0 && <span className="badge badge--warning">{review} need you</span>}
          {failed > 0 && <span className="badge badge--danger">{failed} failed</span>}
          <span className="grow" />
          <span
            title={`${plan.spend.calls} model calls, ${plan.spend.tokensIn.toLocaleString()} in / ${plan.spend.tokensOut.toLocaleString()} out`}
          >
            ${plan.spend.costUsd.toFixed(4)}
          </span>
        </div>

        <div
          style={{ height: 3, background: 'var(--bg-hover)', borderRadius: 2, overflow: 'hidden' }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${plan.goal}: ${pct}% complete`}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: 'var(--accent)',
              transition: 'width 200ms',
            }}
          />
        </div>

        <div className="row" style={{ gap: 4, marginTop: 8 }}>
          {plan.status === 'awaiting_approval' && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void run(() => api.startPlan(plan.id), 'Plan started')}
            >
              <IconPlay size={11} /> Start
            </button>
          )}
          {plan.status === 'running' && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void run(() => api.pausePlan(plan.id))}
            >
              <IconPause size={11} /> Pause
            </button>
          )}
          {plan.status === 'paused' && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void run(() => api.resumePlan(plan.id))}
            >
              <IconPlay size={11} /> Resume
            </button>
          )}
          {(plan.status === 'running' || plan.status === 'paused') && (
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => void run(() => api.cancelPlan(plan.id), 'Plan cancelled')}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => tabs.open({ kind: 'tasks', target: plan.id, title: 'Task graph' })}
          >
            Open graph
          </button>
        </div>
      </div>

      <div className="list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onOpen={() =>
              task.status === 'review'
                ? tabs.open({ kind: 'diff', target: task.id, title: `Review: ${task.title}` })
                : tabs.open({ kind: 'tasks', target: plan.id, title: 'Task graph' })
            }
          />
        ))}
      </div>
    </div>
  );
}

export function TaskPanel() {
  const { snapshot } = useApp();
  const tabs = useTabs();

  const plans = [...snapshot.plans].sort((a, b) => {
    const rank = (p: Plan) =>
      p.status === 'running' ? 0 : p.status === 'awaiting_approval' || p.status === 'paused' ? 1 : 2;
    return rank(a) - rank(b) || b.createdAt - a.createdAt;
  });

  return (
    <>
      <header className="sidebar__header">
        Tasks
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => tabs.open({ kind: 'chat', title: 'Chat' })}
        >
          New prompt
        </button>
      </header>

      <div className="sidebar__body">
        {plans.length === 0 ? (
          <div className="empty">
            <IconTasks size={28} />
            <div className="empty__title">No plans yet</div>
            <p className="empty__body">
              Describe what you want built. A planning model breaks it into a task graph, routes each task to
              the best-fit model, and runs them in parallel.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => tabs.open({ kind: 'chat', title: 'Chat' })}
            >
              Write a prompt
            </button>
          </div>
        ) : (
          plans.map((plan) => <PlanCard key={plan.id} plan={plan} />)
        )}
      </div>
    </>
  );
}
