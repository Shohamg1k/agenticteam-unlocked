import React from 'react';
import type { ExecutionProfile, Task } from '@agentic/core';
import { api } from '../api.js';
import { useApp } from '../state.js';

/**
 * Who runs THIS task, and how hard they try.
 *
 * The project-wide picker answers "which model do I trust"; this answers the
 * question a plan actually raises, which is different. A plan is almost always
 * one genuinely hard task and several easy ones, and the interesting control is
 * not "use Opus" — it is "use Opus for the schema and Haiku for the rest".
 * Until now the only way to express that was to accept whatever the router
 * decided.
 *
 * Three separate decisions, because they are genuinely separate:
 *
 *  - **Provider** — which agent. Auto means the router picks, and picks
 *    differently per task, which is the product's whole argument.
 *  - **Model** — which rung inside that agent. Only shown once a provider is
 *    chosen, because "Opus" is meaningless until you have said Claude.
 *  - **Effort** — how long it thinks. Orthogonal to the model on purpose:
 *    "Opus on low" and "Haiku on high" are both sensible and mean different
 *    things.
 *
 * Everything defaults to Auto, and Auto is the right answer for almost every
 * task. This exists for the one where it is not.
 */

const AUTO = '__auto__';

const EFFORTS: { id: ExecutionProfile['effort']; label: string; hint: string }[] = [
  { id: 'low', label: 'Low', hint: 'Answers fast. Right for anything mechanical.' },
  { id: 'medium', label: 'Medium', hint: 'The usual balance.' },
  { id: 'high', label: 'High', hint: 'Thinks longer. For work that is easy to get subtly wrong.' },
  { id: 'xhigh', label: 'Max', hint: 'Slowest and most thorough. Save it for the hard one.' },
];

export function TaskRouting({ task, compact }: { task: Task; compact?: boolean }) {
  const { snapshot } = useApp();

  const providers = snapshot.providers.filter((p) => p.available);
  const chosen = providers.find((p) => p.id === task.pinnedProviderId);

  // Changing anything mid-run would not affect the attempt already in flight,
  // and a control that silently does nothing is worse than one that is off.
  const locked = task.status === 'running' || task.status === 'verifying' || task.status === 'done';

  const set = (body: Parameters<typeof api.updateTask>[1]) => {
    void api.updateTask(task.id, body);
  };

  if (!providers.length) return null;

  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {!compact && (
        <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
          Run on
        </span>
      )}

      <select
        className="select"
        style={{ width: 'auto', padding: '2px 6px', fontSize: 'var(--text-xs)' }}
        value={task.pinnedProviderId ?? AUTO}
        disabled={locked}
        title={
          locked
            ? 'This task has already started — changing it now would not affect the run.'
            : 'Which agent runs this task. Auto lets the router decide from the task itself.'
        }
        onChange={(e) => {
          const value = e.target.value;
          // `null` is the patch's word for "unset"; `undefined` would be
          // dropped by JSON.stringify and read as "leave it alone".
          set(
            value === AUTO
              ? { pinnedProviderId: null as never, pinnedModelId: null as never }
              : { pinnedProviderId: value },
          );
        }}
      >
        <option value={AUTO}>Auto</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {chosen && chosen.models.length > 1 && (
        <select
          className="select"
          style={{ width: 'auto', padding: '2px 6px', fontSize: 'var(--text-xs)' }}
          value={task.pinnedModelId ?? AUTO}
          disabled={locked}
          title={`Which ${chosen.name} model runs this task.`}
          onChange={(e) => {
            const value = e.target.value;
            set({
              pinnedProviderId: chosen.id,
              pinnedModelId: value === AUTO ? (null as never) : value,
            });
          }}
        >
          <option value={AUTO}>Any model</option>
          {chosen.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}

      <select
        className="select"
        style={{ width: 'auto', padding: '2px 6px', fontSize: 'var(--text-xs)' }}
        value={task.pinnedEffort ?? AUTO}
        disabled={locked}
        title={
          EFFORTS.find((e) => e.id === task.pinnedEffort)?.hint ??
          'How hard to think about this task. Auto decides from its complexity.'
        }
        onChange={(e) => {
          const value = e.target.value;
          set({ pinnedEffort: value === AUTO ? (null as never) : (value as ExecutionProfile['effort']) });
        }}
      >
        <option value={AUTO}>Auto effort</option>
        {EFFORTS.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What actually ran, for a task that has already been given to someone. */
export function TaskRanOn({ task }: { task: Task }) {
  const { snapshot } = useApp();
  if (!task.providerId) return null;

  const provider = snapshot.providers.find((p) => p.id === task.providerId);
  const model = provider?.models.find((m) => m.id === task.model);
  const name = provider?.name ?? task.providerId;

  return (
    <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
      {model ? `${name} · ${model.label}` : name}
      {task.pinnedProviderId ? ' · you chose this' : ''}
    </span>
  );
}
