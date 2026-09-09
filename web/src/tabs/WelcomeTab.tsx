import React from 'react';
import { useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { OpenFolderButton } from '../views/FileTree.js';

/**
 * The empty state.
 *
 * Onboarding is three real steps with live status, not a carousel: open a
 * folder, connect one provider, write a prompt. Each step shows whether it is
 * already done, so a returning user sees at a glance what is missing rather
 * than reading a tour they have seen before.
 */
export function WelcomeTab() {
  const { snapshot, activeProject } = useApp();
  const tabs = useTabs();

  const providersReady = snapshot.providers.filter((p) => p.available);
  const freeOptions = snapshot.providers.filter((p) => p.kind === 'local' || p.kind === 'free-cloud');

  const steps = [
    {
      done: Boolean(activeProject),
      title: 'Open a folder',
      body: activeProject
        ? `Working in ${activeProject.name}.`
        : 'Everything the team builds is written into a real folder on your machine. There is no hidden sandbox, and nothing is written until you accept it.',
      action: activeProject ? null : <OpenFolderButton />,
    },
    {
      done: providersReady.length > 0,
      title: 'Connect at least one model',
      body: providersReady.length
        ? `${providersReady.length} connected: ${providersReady.map((p) => p.name).join(', ')}.`
        : `Nothing can run until a model is connected. ${
            freeOptions.length
              ? 'Two cost nothing: a free Groq key, or Ollama running locally.'
              : 'Add an API key for any supported provider.'
          }`,
      action: (
        <button
          type="button"
          className={providersReady.length ? 'btn' : 'btn btn--primary'}
          onClick={() => tabs.open({ kind: 'settings', title: 'Settings' })}
        >
          {providersReady.length ? 'Manage providers' : 'Connect a model'}
        </button>
      ),
    },
    {
      done: snapshot.plans.length > 0,
      title: 'Describe what you want built',
      body: 'A planning model turns your prompt into a task graph, routes each task to the model best suited to it, and runs them in parallel. You review the diff before anything lands.',
      action: (
        <button
          type="button"
          className={activeProject && providersReady.length ? 'btn btn--primary' : 'btn'}
          disabled={!activeProject}
          onClick={() => tabs.open({ kind: 'chat', title: 'Chat' })}
        >
          Write a prompt
        </button>
      ),
    },
  ];

  return (
    <div className="scroll" style={{ padding: 'var(--space-6) var(--space-5)', height: '100%' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26, margin: '0 0 6px', letterSpacing: '-0.01em' }}>Agentic Team</h1>
        <p className="muted" style={{ marginTop: 0, fontSize: 'var(--text-md)', lineHeight: 1.6 }}>
          A team of AI agents on one codebase, instead of one agent in one session. Work is split into a task
          graph, each task goes to the model best suited to it, and a provider running out of quota hands its
          work to the next one with the context intact.
        </p>

        <ol className="col" style={{ gap: 12, listStyle: 'none', padding: 0, margin: '28px 0 0' }}>
          {steps.map((step, index) => (
            <li key={step.title} className="card">
              <div className="card__body row" style={{ gap: 14, alignItems: 'flex-start' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    flex: '0 0 auto',
                    background: step.done ? 'var(--success-bg)' : 'var(--bg-hover)',
                    color: step.done ? 'var(--success)' : 'var(--fg-muted)',
                    fontWeight: 600,
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  {step.done ? '✓' : index + 1}
                </span>

                <div className="col grow" style={{ gap: 4 }}>
                  <strong>{step.title}</strong>
                  <span className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                    {step.body}
                  </span>
                  {step.action && <div style={{ marginTop: 6 }}>{step.action}</div>}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="row" style={{ gap: 8, marginTop: 28, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => tabs.open({ kind: 'routing', title: 'Routing' })}
          >
            How routing works
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => tabs.open({ kind: 'cost', title: 'Cost' })}
          >
            Cost dashboard
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => tabs.open({ kind: 'skills', title: 'Skills' })}
          >
            Skills and agents
          </button>
        </div>
      </div>
    </div>
  );
}
