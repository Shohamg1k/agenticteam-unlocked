import React, { useMemo, useState } from 'react';
import type { Capability, RoutingPolicy, RoutingWeights } from '@agentic/core';
import { ALL_CAPABILITIES, validatePolicy } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';

/**
 * The routing policy editor.
 *
 * Two views over the same document, because two different people need it: a
 * form for adjusting weights, and raw JSON for the rules, which are more
 * expressive than a form can be without becoming a worse JSON editor.
 *
 * Validation runs on every keystroke and reports every problem at once with a
 * JSON path, so the editor can show them all rather than failing on the first.
 */

const WEIGHT_LABELS: Record<keyof RoutingWeights, { label: string; hint: string }> = {
  capability: { label: 'Capability match', hint: 'How much to insist the model claims what the task needs.' },
  cost: { label: 'Cost', hint: 'Higher means cheaper wins more often. Free providers always score 1 here.' },
  latency: { label: 'Speed', hint: 'Prefer faster models. Matters most for many small tasks.' },
  context: { label: 'Context headroom', hint: 'Prefer models with room to spare over ones that just fit.' },
  quota: { label: 'Remaining quota', hint: 'Avoid providers that are close to a cap or cooling down.' },
  tier: { label: 'Ladder tier', hint: 'Prefer local, then free, then subscription, then metered keys.' },
  reliability: {
    label: 'Track record',
    hint: 'Prefer providers that have succeeded on this kind of task here before.',
  },
};

export function RoutingTab() {
  const { snapshot, activeProject } = useApp();
  const run = useAction();

  const [selectedId, setSelectedId] = useState(snapshot.config.routingPolicyId);
  const [draft, setDraft] = useState<RoutingPolicy | undefined>();
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string>();

  const policy = draft ?? snapshot.policies.find((p) => p.id === selectedId) ?? snapshot.policies[0];
  const problems = useMemo(() => (policy ? validatePolicy(policy) : []), [policy]);

  if (!activeProject || !policy) {
    return (
      <div className="empty">
        <div className="empty__title">Open a project</div>
        <p className="empty__body">
          Routing policies are per-project, so one is needed before you can edit them.
        </p>
      </div>
    );
  }

  const edit = (patch: Partial<RoutingPolicy>) => setDraft({ ...policy, ...patch });

  const save = async () => {
    const saved = await run(() => api.savePolicy(activeProject.id, policy), 'Routing policy saved');
    if (saved) {
      setDraft(undefined);
      await run(() => api.updateConfig({ routingPolicyId: saved.id }));
    }
  };

  return (
    <div className="scroll pad-lg" style={{ height: '100%' }}>
      <div style={{ maxWidth: 760 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Model routing</h2>
        <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
          Every task is scored against every connected model on seven axes, and the winner runs it. The rest
          become the failover ladder. Nothing here is hard-coded — this document is the policy.
        </p>

        <div className="row" style={{ gap: 8, margin: '16px 0' }}>
          <select
            className="select"
            style={{ width: 260 }}
            value={policy.id}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setDraft(undefined);
            }}
          >
            {snapshot.policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setJsonText(JSON.stringify(policy, null, 2));
              setJsonMode((m) => !m);
              setJsonError(undefined);
            }}
          >
            {jsonMode ? 'Form view' : 'Edit as JSON'}
          </button>

          <span className="grow" />

          {draft && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft(undefined)}>
              Discard changes
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={problems.length > 0}
            onClick={() => void save()}
          >
            {draft ? 'Save and use' : 'Use this policy'}
          </button>
        </div>

        {policy.description && (
          <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
            {policy.description}
          </p>
        )}

        {problems.length > 0 && (
          <div className="card" style={{ borderLeft: '3px solid var(--danger)', marginBottom: 16 }}>
            <div className="card__body">
              <strong style={{ color: 'var(--danger)' }}>This policy has {problems.length} problem(s)</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--text-sm)' }}>
                {problems.map((p, i) => (
                  <li key={i}>
                    <span className="mono">{p.path || 'root'}</span> — {p.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {jsonMode ? (
          <div className="field">
            <label className="field__label" htmlFor="policy-json">
              Policy document
            </label>
            <textarea
              id="policy-json"
              className="textarea textarea--mono"
              style={{ minHeight: 460, fontSize: 'var(--text-xs)' }}
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                try {
                  const parsed = JSON.parse(e.target.value) as RoutingPolicy;
                  setDraft(parsed);
                  setJsonError(undefined);
                } catch (err) {
                  setJsonError((err as Error).message);
                }
              }}
            />
            {jsonError && <span className="field__error">{jsonError}</span>}
            <span className="field__hint">
              A rule naming a provider you have not connected is inert, not an error — that is what lets one
              policy work whether you have one key or six. An invalid regex disables that rule; it never takes
              the router down.
            </span>
          </div>
        ) : (
          <>
            <section className="card" style={{ marginBottom: 16 }}>
              <div className="card__header">
                <h3 className="card__title">Weights</h3>
                <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                  Each axis is normalised to 0–1, then multiplied by its weight
                </span>
              </div>
              <div className="card__body col" style={{ gap: 'var(--space-3)' }}>
                {(Object.keys(WEIGHT_LABELS) as (keyof RoutingWeights)[]).map((key) => (
                  <div key={key} className="field">
                    <div className="row">
                      <label className="field__label grow" htmlFor={`w-${key}`}>
                        {WEIGHT_LABELS[key].label}
                      </label>
                      <span className="mono subtle" style={{ fontSize: 'var(--text-xs)' }}>
                        {policy.weights[key].toFixed(2)}
                      </span>
                    </div>
                    <input
                      id={`w-${key}`}
                      type="range"
                      min={0}
                      max={6}
                      step={0.25}
                      value={policy.weights[key]}
                      onChange={(e) =>
                        edit({ weights: { ...policy.weights, [key]: Number(e.target.value) } })
                      }
                    />
                    <span className="field__hint">{WEIGHT_LABELS[key].hint}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card" style={{ marginBottom: 16 }}>
              <div className="card__header">
                <h3 className="card__title">Ceilings</h3>
              </div>
              <div className="card__body col" style={{ gap: 'var(--space-3)' }}>
                <div className="field">
                  <label className="field__label" htmlFor="max-task-cost">
                    Most a single task may cost
                  </label>
                  <input
                    id="max-task-cost"
                    className="input"
                    type="number"
                    step={0.25}
                    min={0}
                    style={{ width: 140 }}
                    value={policy.maxTaskCostUsd}
                    onChange={(e) => edit({ maxTaskCostUsd: Number(e.target.value) })}
                  />
                  <span className="field__hint">
                    A candidate estimated above this is dropped, so an accidental long-context call cannot
                    cost $40. A provider you pin explicitly is the one exception — the budget guard asks you
                    instead.
                  </span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="cooldown">
                    Cooldown after a usage limit (minutes)
                  </label>
                  <input
                    id="cooldown"
                    className="input"
                    type="number"
                    min={1}
                    style={{ width: 140 }}
                    value={Math.round(policy.cooldownMs / 60_000)}
                    onChange={(e) => edit({ cooldownMs: Number(e.target.value) * 60_000 })}
                  />
                  <span className="field__hint">
                    How long a provider sits out after telling us it is exhausted. Never permanent — free
                    tiers come back.
                  </span>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card__header">
                <h3 className="card__title">Rules</h3>
                <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                  Evaluated in order; later matches merge over earlier ones
                </span>
              </div>
              <div className="card__body col" style={{ gap: 'var(--space-2)' }}>
                {policy.rules.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
                    No rules — every task is scored on the base weights alone.
                  </p>
                ) : (
                  policy.rules.map((rule, index) => (
                    <div
                      key={index}
                      style={{
                        padding: 'var(--space-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                        <strong className="grow" style={{ fontSize: 'var(--text-sm)' }}>
                          {rule.name}
                        </strong>
                        {rule.stop && (
                          <span
                            className="badge badge--neutral"
                            title="Stops evaluating further rules once matched"
                          >
                            stop
                          </span>
                        )}
                      </div>

                      <div
                        className="row subtle"
                        style={{ gap: 6, fontSize: 'var(--text-xs)', flexWrap: 'wrap' }}
                      >
                        {rule.when?.capability?.map((c: Capability) => (
                          <span key={c} className="badge badge--neutral">
                            {c}
                          </span>
                        ))}
                        {rule.when?.role?.map((r) => (
                          <span key={r} className="badge badge--neutral">
                            {r}
                          </span>
                        ))}
                        {rule.when?.complexityAtLeast !== undefined && (
                          <span>complexity ≥ {rule.when.complexityAtLeast}</span>
                        )}
                        {rule.when?.complexityAtMost !== undefined && (
                          <span>complexity ≤ {rule.when.complexityAtMost}</span>
                        )}
                        {rule.when?.contextTokensAtLeast !== undefined && (
                          <span>context ≥ {rule.when.contextTokensAtLeast.toLocaleString()} tokens</span>
                        )}
                        {rule.prefer?.length ? <span>→ {rule.prefer.join(', ')}</span> : null}
                      </div>
                    </div>
                  ))
                )}
                <p className="field__hint" style={{ margin: 0 }}>
                  Rules are edited in the JSON view — they are more expressive than a form can be without
                  becoming a worse JSON editor. See <span className="mono">docs/ROUTING.md</span> for the full
                  schema.
                </p>
              </div>
            </section>

            <section className="card" style={{ marginTop: 16 }}>
              <div className="card__header">
                <h3 className="card__title">What this means right now</h3>
              </div>
              <div className="card__body">
                <p className="muted" style={{ margin: '0 0 8px', fontSize: 'var(--text-sm)' }}>
                  With the providers you have connected, tasks would route roughly like this:
                </p>
                <div className="col" style={{ gap: 4, fontSize: 'var(--text-sm)' }}>
                  {ALL_CAPABILITIES.map((capability) => {
                    const candidates = snapshot.providers.filter(
                      (p) => p.available && p.models.some((m) => m.capabilities.includes(capability)),
                    );
                    return (
                      <div key={capability} className="row">
                        <span className="mono subtle" style={{ width: 150, flex: '0 0 auto' }}>
                          {capability}
                        </span>
                        <span className={candidates.length ? '' : 'subtle'}>
                          {candidates.length
                            ? candidates
                                .slice(0, 3)
                                .map((p) => p.name)
                                .join(' → ')
                            : 'nothing connected can do this'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
