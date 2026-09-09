import React, { useState } from 'react';
import type { ExecutionMode } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { ProviderRow } from '../views/ProviderPanel.js';
import { IconRefresh } from '../shell/Icons.js';

type Section = 'providers' | 'gate' | 'execution' | 'appearance' | 'plugins' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'providers', label: 'Providers and keys' },
  { id: 'gate', label: 'Human gate' },
  { id: 'execution', label: 'Execution' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'plugins', label: 'Plugins and connectors' },
  { id: 'about', label: 'About' },
];

const EXECUTION_MODES: { id: ExecutionMode; label: string; body: string }[] = [
  {
    id: 'approval',
    label: 'Approve everything',
    body: 'Nothing is written to your project until you accept it. The default, and the right choice while you are learning what the team does.',
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    body: 'Work that passes every check, carries no external content and touches no sensitive file applies itself. Everything else waits for you.',
  },
  {
    id: 'auto',
    label: 'Auto',
    body: 'Verified work applies itself, including sensitive files. External content still always waits for an explicit acknowledgement — that is not bypassable in any mode.',
  },
];

export function SettingsTab({ initialSection = 'providers' }: { initialSection?: Section }) {
  const { snapshot, activeProject } = useApp();
  const tabs = useTabs();
  const run = useAction();
  const [section, setSection] = useState<Section>(initialSection);
  const [pluginSource, setPluginSource] = useState('');

  const update = (patch: Parameters<typeof api.updateConfig>[0]) => run(() => api.updateConfig(patch));

  /**
   * Relaxing the human gate is the one setting where a stray click has real
   * consequences: it decides whether agent output reaches your files without
   * you seeing it. Moving to a stricter mode is always safe and applies
   * immediately; moving to a looser one asks first.
   */
  const STRICTNESS: Record<ExecutionMode, number> = { approval: 0, hybrid: 1, auto: 2 };
  const changeExecutionMode = (next: ExecutionMode) => {
    const current = snapshot.config.executionMode;
    if (next === current) return;

    if (STRICTNESS[next] > STRICTNESS[current]) {
      const detail =
        next === 'auto'
          ? 'Verified work will be applied to your project without waiting for you, including changes to sensitive files.'
          : 'Verified work that touches nothing sensitive will be applied to your project without waiting for you.';
      const confirmed = window.confirm(
        `Switch the human gate from "${current}" to "${next}"?

${detail}

External content still always waits for an explicit acknowledgement. Every automatic acceptance is recorded in the activity log, and you can switch back at any time.`,
      );
      if (!confirmed) return;
    }
    void update({ executionMode: next });
  };

  return (
    <div className="row" style={{ height: '100%', gap: 0, alignItems: 'stretch' }}>
      <nav
        style={{
          width: 200,
          borderRight: '1px solid var(--border)',
          padding: 'var(--space-3) 0',
          flex: '0 0 auto',
        }}
        aria-label="Settings sections"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="list__item"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="scroll grow pad-lg">
        <div style={{ maxWidth: 680 }}>
          {section === 'providers' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Providers</h2>
                <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  Listed in ladder order — this is the sequence the router falls through when one runs out of
                  quota. Keys are stored in your OS keychain, never in a project file, and are redacted from
                  logs.
                </p>
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void run(() => api.probeProviders(), 'Providers checked')}
                >
                  <IconRefresh size={12} /> Check them again
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => tabs.open({ kind: 'routing', title: 'Routing' })}
                >
                  Routing policy
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => tabs.open({ kind: 'cost', title: 'Cost' })}
                >
                  Cost dashboard
                </button>
              </div>

              <div className="card">
                {snapshot.providers.map((provider) => (
                  <ProviderRow key={provider.id} provider={provider} />
                ))}
              </div>

              <div className="card">
                <div className="card__body">
                  <strong>CLI agents</strong>
                  <p
                    className="muted"
                    style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}
                  >
                    Claude Code, Codex, Antigravity and Gemini CLI are detected on your PATH — there is no key
                    to paste. They are checked every 30 seconds, so installing one lights it up without
                    restarting the app. A subscription you already pay for is treated as free by the router,
                    which is why it is preferred over a metered key.
                  </p>
                </div>
              </div>
            </section>
          )}

          {section === 'gate' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Human gate</h2>
                <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  How much of your review the team keeps. This is enforced on the server, not in this window —
                  a bug in the UI cannot let work through.
                </p>
              </div>

              {EXECUTION_MODES.map((mode) => (
                <label key={mode.id} className="card" style={{ cursor: 'pointer' }}>
                  <div className="card__body row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <input
                      type="radio"
                      name="execution-mode"
                      checked={snapshot.config.executionMode === mode.id}
                      onChange={() => changeExecutionMode(mode.id)}
                      style={{ marginTop: 3 }}
                    />
                    <div className="col" style={{ gap: 2 }}>
                      <strong>{mode.label}</strong>
                      <span className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                        {mode.body}
                      </span>
                    </div>
                  </div>
                </label>
              ))}

              <div className="card">
                <div className="card__body">
                  <strong>Agent permissions</strong>
                  <p
                    className="muted"
                    style={{ margin: '4px 0 8px', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}
                  >
                    CLI agents can run with their own permission prompts skipped. That is the default because
                    their runs are contained: an isolated worktree, a command allow-list, and every file
                    landing in your review. Turning it off is honest about the cost — a CLI that stops on a
                    prompt in a non-interactive run will wait until its timeout, and the log will say so.
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void update({ agentPermissions: 'yolo' })}
                    >
                      Skip prompts (default)
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void update({ agentPermissions: 'manual' })}
                    >
                      Keep prompts
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {section === 'execution' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Execution</h2>
                <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  How many agents work at once, and which commands may run without asking.
                </p>
              </div>

              <div className="card">
                <div className="card__body col" style={{ gap: 'var(--space-3)' }}>
                  <div className="field">
                    <label className="field__label" htmlFor="max-parallel">
                      Agents working in parallel
                    </label>
                    <input
                      id="max-parallel"
                      className="input"
                      type="number"
                      min={1}
                      max={12}
                      value={snapshot.config.maxParallel}
                      onChange={(e) => void update({ maxParallel: Number(e.target.value) })}
                      style={{ width: 100 }}
                    />
                    <span className="field__hint">
                      Higher is faster only where tasks are genuinely independent. File locks already stop two
                      agents writing one file, so raising this cannot corrupt anything — it just spends quota
                      faster.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="allowed-commands">
                      Commands agents may run without asking
                    </label>
                    <textarea
                      id="allowed-commands"
                      className="textarea textarea--mono"
                      rows={3}
                      defaultValue={snapshot.config.allowedCommands.join(', ')}
                      onBlur={(e) =>
                        void update({
                          allowedCommands: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <span className="field__hint">
                      A guard rail, not a sandbox: `npm run` can execute whatever a package script says. Real
                      isolation comes from the worktree and your review. Destructive patterns always ask,
                      whatever is listed here.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="denied-commands">
                      Always ask before these
                    </label>
                    <textarea
                      id="denied-commands"
                      className="textarea textarea--mono"
                      rows={2}
                      defaultValue={snapshot.config.deniedCommands.join(', ')}
                      onBlur={(e) =>
                        void update({
                          deniedCommands: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              {activeProject && (
                <div className="card">
                  <div className="card__body">
                    <strong>Project checks</strong>
                    <p
                      className="muted"
                      style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}
                    >
                      Tier-2 verification runs your project’s own typecheck, lint, test and build in a
                      throwaway git worktree. Commands are detected from your manifest; a check the project
                      does not define is reported as <em>skipped</em>, never as passed.
                    </p>
                  </div>
                </div>
              )}
            </section>
          )}

          {section === 'appearance' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Appearance</h2>
              <div className="card">
                <div className="card__body field">
                  <label className="field__label" htmlFor="theme">
                    Theme
                  </label>
                  <select
                    id="theme"
                    className="select"
                    value={snapshot.config.theme}
                    onChange={(e) => void update({ theme: e.target.value as never })}
                    style={{ width: 220 }}
                  >
                    <option value="system">Match my system</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="high-contrast">High contrast</option>
                  </select>
                  <span className="field__hint">
                    The editor follows the app theme, so Monaco is not an obviously foreign rectangle in the
                    middle of the window.
                  </span>
                </div>
              </div>
            </section>
          )}

          {section === 'plugins' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Plugins and connectors</h2>
                <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  A plugin bundles skills, agent profiles and connectors. Plugins contribute data — Markdown
                  and manifests — never code this app executes, which is why installing one from a git URL is
                  a reasonable thing to offer.
                </p>
              </div>

              <div className="card">
                <div className="card__body">
                  <div className="field">
                    <label className="field__label" htmlFor="plugin-source">
                      Install from a folder or a git URL
                    </label>
                    <div className="row">
                      <input
                        id="plugin-source"
                        className="input grow"
                        value={pluginSource}
                        placeholder="/path/to/plugin or https://github.com/user/plugin"
                        onChange={(e) => setPluginSource(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!pluginSource.trim()}
                        onClick={() =>
                          void run(() => api.installPlugin(pluginSource.trim()), 'Plugin installed').then(
                            () => setPluginSource(''),
                          )
                        }
                      >
                        Install
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {snapshot.plugins.length > 0 && (
                <div className="card">
                  {snapshot.plugins.map((plugin) => (
                    <div
                      key={plugin.manifest.name}
                      className="row"
                      style={{ padding: 'var(--space-3)', borderBottom: '1px solid var(--border)' }}
                    >
                      <div className="col grow" style={{ gap: 2 }}>
                        <strong>
                          {plugin.manifest.name} <span className="subtle">v{plugin.manifest.version}</span>
                        </strong>
                        {plugin.manifest.description && (
                          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                            {plugin.manifest.description}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() =>
                          void run(() => api.uninstallPlugin(plugin.manifest.name), 'Plugin removed')
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="card">
                <div className="card__header">
                  <h3 className="card__title">Connectors</h3>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void run(() => api.refreshConnectors(), 'Connectors refreshed')}
                  >
                    Refresh
                  </button>
                </div>
                <div className="card__body">
                  <p
                    className="muted"
                    style={{ margin: '0 0 8px', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}
                  >
                    GitHub, Figma, Miro, Linear and Slack connect over MCP. Reading is routine; every outward
                    write — a pull request, a message, a design frame, a deploy — waits for you, in every
                    execution mode.
                  </p>
                  <div className="col" style={{ gap: 4 }}>
                    {snapshot.connectors.map((connector) => (
                      <div key={connector.id} className="row" style={{ fontSize: 'var(--text-sm)' }}>
                        <span className="grow">{connector.name}</span>
                        <span className={`badge badge--${connector.enabled ? 'success' : 'neutral'}`}>
                          {connector.enabled ? 'enabled' : 'off'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {section === 'about' && (
            <section className="col" style={{ gap: 'var(--space-3)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>About</h2>
              <div className="card">
                <div
                  className="card__body col"
                  style={{ gap: 8, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}
                >
                  <p style={{ margin: 0 }}>
                    <strong>Agentic Team</strong> — a desktop IDE that runs a team of AI coding agents on one
                    codebase.
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    Everything runs on this machine. The core service binds to 127.0.0.1 and is the only
                    process that holds credentials or calls a model. There is no account, no telemetry and no
                    hosted service.
                  </p>
                  <div
                    className="row subtle"
                    style={{ gap: 16, fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}
                  >
                    <span>{snapshot.providers.length} provider adapters</span>
                    <span>{snapshot.skills.length} skills</span>
                    <span>{snapshot.agents.length} agent profiles</span>
                    <span>{snapshot.plugins.length} plugins</span>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
