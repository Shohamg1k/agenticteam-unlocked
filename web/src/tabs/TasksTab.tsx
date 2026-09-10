import React, { useMemo, useState } from 'react';
import type { Task } from '@agentic/core';
import { criticalPath, executionWaves, progressOf } from '@agentic/core';
import { TaskRouting } from '../views/TaskRouting.js';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconStop } from '../shell/Icons.js';

/**
 * The task graph.
 *
 * Laid out in waves — the sets that could run at the same time given unlimited
 * workers — because that is the shape that makes parallelism visible. A list
 * would hide the single most interesting property of the plan.
 *
 * The critical path is highlighted: it is the chain that actually determines
 * how long the plan takes, and adding workers off it changes nothing.
 */

const STATUS_COLOR: Record<Task['status'], string> = {
  planned: 'var(--fg-subtle)',
  queued: 'var(--fg-muted)',
  running: 'var(--info)',
  verifying: 'var(--info)',
  review: 'var(--warning)',
  done: 'var(--success)',
  failed: 'var(--danger)',
  cancelled: 'var(--fg-subtle)',
  blocked: 'var(--warning)',
};

function TaskCard({ task, onCritical }: { task: Task; onCritical: boolean }) {
  const { snapshot } = useApp();
  const tabs = useTabs();
  const run = useAction();
  const [expanded, setExpanded] = useState(false);

  const provider = snapshot.providers.find((p) => p.id === task.providerId);
  const active = task.status === 'running' || task.status === 'verifying';
  const spent = task.attempts.reduce((sum, a) => sum + a.usage.costUsd, 0);

  return (
    <div
      className="card"
      style={{
        width: 260,
        flex: '0 0 auto',
        borderLeft: `3px solid ${STATUS_COLOR[task.status]}`,
        boxShadow: onCritical ? '0 0 0 1px var(--accent)' : undefined,
      }}
    >
      <div className="card__body" style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
          <button
            type="button"
            className="grow truncate"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            onClick={() => setExpanded((e) => !e)}
            title={task.description}
          >
            {task.title}
          </button>
          {active && (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              title="Stop this agent"
              onClick={() => void run(() => api.cancelTask(task.id))}
            >
              <IconStop size={11} />
            </button>
          )}
        </div>

        <div className="row subtle" style={{ gap: 6, fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}>
          <span style={{ color: STATUS_COLOR[task.status] }}>{task.status}</span>
          <span>·</span>
          <span title={`Complexity ${task.complexity} of 5`}>c{task.complexity}</span>
          {task.role && <span>· {task.role}</span>}
          {onCritical && (
            <span
              className="badge badge--accent"
              title="On the critical path — this chain sets how long the plan takes"
            >
              critical
            </span>
          )}
        </div>

        <div
          className="row subtle"
          style={{ gap: 6, fontSize: 'var(--text-xs)', marginTop: 3, flexWrap: 'wrap' }}
        >
          {provider ? (
            <span className="row" style={{ gap: 4 }} title={task.plannedReason}>
              <span className={`tier tier--${provider.kind}`} />
              {provider.name}
            </span>
          ) : (
            <span>{task.plannedProviderId ? `planned: ${task.plannedProviderId}` : 'unrouted'}</span>
          )}
          {spent > 0 && <span>${spent.toFixed(4)}</span>}
        </div>

        {expanded && (
          <div className="col" style={{ gap: 6, marginTop: 8, fontSize: 'var(--text-xs)' }}>
            {/*
              Who runs this one, and how hard.

              It lives in the graph rather than the sidebar because this is the
              screen where you look at the whole plan at once — and the useful
              decision is almost never "use Opus", it is "use Opus for the
              schema and something cheap for the rest".
            */}
            <div className="col" style={{ gap: 4 }}>
              <strong className="subtle">Run this on</strong>
              <TaskRouting task={task} />
            </div>

            <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
              {task.description.slice(0, 600)}
              {task.description.length > 600 ? '…' : ''}
            </p>

            {task.acceptance.length > 0 && (
              <div>
                <strong className="subtle">Done when</strong>
                <ul style={{ margin: '2px 0 0', paddingLeft: 16 }} className="muted">
                  {task.acceptance.map((a, i) => (
                    <li key={i}>{a.text}</li>
                  ))}
                </ul>
              </div>
            )}

            {task.expectedFiles?.length ? (
              <div className="mono subtle truncate" title={task.expectedFiles.join('\n')}>
                {task.expectedFiles.join(', ')}
              </div>
            ) : null}

            {task.worklog.length > 0 && (
              <div>
                <strong className="subtle">Worklog</strong>
                <div className="col" style={{ gap: 1, marginTop: 2 }}>
                  {task.worklog.slice(-6).map((entry, i) => (
                    <div
                      key={i}
                      className="muted"
                      style={{
                        color:
                          entry.level === 'error'
                            ? 'var(--danger)'
                            : entry.level === 'warn'
                              ? 'var(--warning)'
                              : undefined,
                      }}
                    >
                      {entry.text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {task.error && <div style={{ color: 'var(--danger)' }}>{task.error}</div>}

            {task.status === 'review' && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => tabs.open({ kind: 'diff', target: task.id, title: `Review: ${task.title}` })}
              >
                Review the diff
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function TasksTab({ planId }: { planId?: string }) {
  const { snapshot, tasksOfPlan } = useApp();
  const run = useAction();

  const plan = planId
    ? snapshot.plans.find((p) => p.id === planId)
    : [...snapshot.plans].sort((a, b) => b.createdAt - a.createdAt)[0];

  const tasks = plan ? tasksOfPlan(plan.id) : [];

  const { waves, critical, progress } = useMemo(() => {
    if (!tasks.length) return { waves: [] as Task[][], critical: new Set<string>(), progress: undefined };
    try {
      return {
        waves: executionWaves(tasks),
        critical: new Set(criticalPath(tasks)),
        progress: progressOf(tasks),
      };
    } catch {
      // A graph that will not validate should still be viewable — show it flat
      // rather than showing nothing.
      return { waves: [tasks], critical: new Set<string>(), progress: progressOf(tasks) };
    }
  }, [tasks]);

  if (!plan) {
    return (
      <div className="empty">
        <div className="empty__title">No plan yet</div>
        <p className="empty__body">Write a prompt and the planner will build a task graph here.</p>
      </div>
    );
  }

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div
        style={{
          padding: 'var(--space-3)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
        }}
      >
        <div className="row" style={{ gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-md)' }} className="truncate grow">
            {plan.goal}
          </h2>
          <span className="badge badge--neutral">
            {plan.mode === 'professional' ? 'Professional' : 'Instant'}
          </span>
          <span
            className={`badge badge--${plan.status === 'running' ? 'info' : plan.status === 'failed' ? 'danger' : 'neutral'}`}
          >
            {plan.status}
          </span>
        </div>

        <div
          className="row subtle"
          style={{ gap: 12, marginTop: 6, fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}
        >
          {progress && (
            <span>
              {progress.done}/{progress.total} done
              {progress.running > 0 && ` · ${progress.running} running`}
              {progress.review > 0 && ` · ${progress.review} awaiting you`}
              {progress.failed > 0 && ` · ${progress.failed} failed`}
            </span>
          )}
          <span
            title={`${plan.spend.tokensIn.toLocaleString()} tokens in, ${plan.spend.tokensOut.toLocaleString()} out`}
          >
            {plan.spend.calls} calls · ${plan.spend.costUsd.toFixed(4)} of $
            {plan.budget.maxCostUsd.toFixed(2)}
          </span>
          {plan.status === 'running' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void run(() => api.pausePlan(plan.id))}
            >
              Pause
            </button>
          )}
        </div>

        {plan.mode === 'professional' && plan.phases.length > 0 && (
          <div className="row" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
            {plan.phases.map((gate) => (
              <span
                key={gate.phase}
                className={`badge badge--${
                  gate.status === 'passed'
                    ? 'success'
                    : gate.status === 'awaiting_approval'
                      ? 'warning'
                      : gate.status === 'open'
                        ? 'info'
                        : 'neutral'
                }`}
                title={`${gate.taskIds.length} task(s) — ${gate.status.replace('_', ' ')}`}
              >
                {gate.phase}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="scroll grow pad">
        {waves.map((wave, index) => (
          <section key={index} style={{ marginBottom: 'var(--space-5)' }}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <h3
                className="subtle"
                style={{
                  margin: 0,
                  fontSize: 'var(--text-xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {index === 0 ? 'Starts immediately' : `After wave ${index}`}
              </h3>
              <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                {wave.length} task{wave.length === 1 ? '' : 's'}
                {wave.length > 1 ? ' · can run in parallel' : ''}
              </span>
            </div>

            <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'stretch' }}>
              {wave.map((task) => (
                <TaskCard key={task.id} task={task} onCritical={critical.has(task.id)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
