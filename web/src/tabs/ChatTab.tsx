import React, { useEffect, useRef, useState } from 'react';
import type { DevelopmentMode, ExecutionMode } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { TaskRow } from '../views/TaskPanel.js';
import { OpenFolderButton } from '../views/FileTree.js';
import { IconSend } from '../shell/Icons.js';

/**
 * The prompt surface.
 *
 * The mode picker is here rather than in settings because the brief puts it
 * there — it is a per-prompt decision, not a preference. Instant and
 * Professional are genuinely different products for different jobs, and asking
 * once per prompt is the only place the question makes sense.
 */

const MODES: { id: DevelopmentMode; title: string; blurb: string }[] = [
  {
    id: 'instant',
    title: 'Instant',
    blurb: 'One planning call, generic workers, tuned for speed and low token spend. Right for most work.',
  },
  {
    id: 'professional',
    title: 'Full Professional',
    blurb:
      'A role-based team with phase gates: PM, architect, UX, engineers, QA, security, DevOps, writer. Produces a PRD, ADRs, tests and a security review. Slower and more expensive on purpose.',
  },
];

const EXECUTION_MODES: { id: ExecutionMode; label: string; blurb: string }[] = [
  { id: 'approval', label: 'Approve everything', blurb: 'Nothing touches your files until you accept it.' },
  {
    id: 'hybrid',
    label: 'Hybrid',
    blurb: 'Verified, non-sensitive work applies itself. Anything risky waits.',
  },
  { id: 'auto', label: 'Auto', blurb: 'Verified work applies itself. External content still always waits.' },
];

export function ChatTab() {
  const { snapshot, activeProject, tasksOfPlan, runOutput, watchTask, runTick } = useApp();
  const tabs = useTabs();
  const run = useAction();

  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<DevelopmentMode>('instant');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(snapshot.config.executionMode);
  const [planning, setPlanning] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const plan = activePlanId ? snapshot.plans.find((p) => p.id === activePlanId) : undefined;
  const tasks = plan ? tasksOfPlan(plan.id) : [];
  const availableProviders = snapshot.providers.filter((p) => p.available);

  // Follow whichever task is running, so its output streams into this tab.
  const runningTask = tasks.find((t) => t.status === 'running' || t.status === 'verifying');
  useEffect(() => {
    if (!runningTask) return;
    return watchTask(runningTask.id);
  }, [runningTask, watchTask]);

  const streamed = runningTask ? runOutput(runningTask.id) : '';
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    // Only follow the tail when the user is already at the bottom; yanking the
    // scroll away from someone reading is worse than not auto-scrolling.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [streamed, runTick]);

  const submit = async () => {
    if (!activeProject || !prompt.trim() || planning) return;
    setPlanning(true);
    const result = await run(() =>
      api.createPlan({
        projectId: activeProject.id,
        goal: prompt.trim(),
        mode,
        executionMode,
        autoStart: true,
      }),
    );
    setPlanning(false);
    if (result) {
      setActivePlanId(result.plan.id);
      setPrompt('');
    }
  };

  if (!activeProject) {
    return (
      <div className="empty">
        <div className="empty__title">Open a folder first</div>
        <p className="empty__body">
          Agentic Team works against a real folder on your machine. Pick one and everything the agents produce
          is written there, after you accept it.
        </p>
        <OpenFolderButton />
      </div>
    );
  }

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div className="scroll grow" style={{ padding: 'var(--space-5)' }} ref={outputRef}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          {!plan && (
            <>
              <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 8px' }}>What should the team build?</h1>
              <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
                Describe the outcome, not the steps. A planning model breaks it into a task graph, routes each
                task to the model best suited to it, and runs them in parallel against{' '}
                <span className="mono">{activeProject.root}</span>.
              </p>

              {availableProviders.length === 0 && (
                <div className="card" style={{ marginTop: 16, borderLeft: '3px solid var(--warning)' }}>
                  <div className="card__body">
                    <strong>No providers are connected.</strong>
                    <p className="muted" style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
                      Nothing can run yet. A free Groq key or a local Ollama model costs nothing and is enough
                      to get started — add one in Providers.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {plan && (
            <section className="col" style={{ gap: 12 }}>
              <div className="card">
                <div className="card__header">
                  <h2 className="card__title">{plan.goal}</h2>
                  <span className="badge badge--neutral">
                    {plan.mode === 'professional' ? 'Professional' : 'Instant'}
                  </span>
                </div>
                {plan.summary && (
                  <div className="card__body muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                    {plan.summary}
                  </div>
                )}
                <div className="card__footer" style={{ justifyContent: 'space-between' }}>
                  <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                    {tasks.length} tasks · {plan.spend.calls} model calls · ${plan.spend.costUsd.toFixed(4)}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => tabs.open({ kind: 'tasks', target: plan.id, title: 'Task graph' })}
                  >
                    Open the task graph
                  </button>
                </div>
              </div>

              <div className="card">
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

              {runningTask && streamed && (
                <div className="card">
                  <div className="card__header">
                    <h3 className="card__title truncate">
                      <span className="spinner" style={{ display: 'inline-block', marginRight: 8 }} />
                      {runningTask.title}
                    </h3>
                    <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                      {runningTask.providerId}
                    </span>
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 'var(--space-3)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 340,
                      overflow: 'auto',
                      fontSize: 'var(--text-xs)',
                      lineHeight: 1.5,
                    }}
                  >
                    {streamed.slice(-8_000)}
                  </pre>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          padding: 'var(--space-3)',
        }}
      >
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn btn--sm ${mode === m.id ? 'btn--primary' : ''}`}
                title={m.blurb}
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
              >
                {m.title}
              </button>
            ))}

            <span className="grow" />

            <label className="row subtle" style={{ gap: 4, fontSize: 'var(--text-xs)' }}>
              Gate
              <select
                className="select"
                style={{ width: 'auto', padding: '2px 6px' }}
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
                title={EXECUTION_MODES.find((e) => e.id === executionMode)?.blurb}
              >
                {EXECUTION_MODES.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <textarea
              ref={textareaRef}
              className="textarea grow"
              rows={3}
              value={prompt}
              placeholder={
                mode === 'professional'
                  ? 'e.g. Build a task management app with accounts, projects and due dates'
                  : 'e.g. Add Google sign-in to the settings page'
              }
              disabled={planning}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline. Ctrl/Cmd+Enter also
                // sends, for people whose fingers expect that instead.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!prompt.trim() || planning}
              onClick={() => void submit()}
              style={{ height: 34 }}
            >
              {planning ? <span className="spinner" /> : <IconSend size={14} />}
              {planning ? 'Planning…' : 'Build it'}
            </button>
          </div>

          <div className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>
            {MODES.find((m) => m.id === mode)?.blurb}
          </div>
        </div>
      </div>
    </div>
  );
}
