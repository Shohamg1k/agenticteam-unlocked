import React from 'react';
import type { ProviderStatus } from '@agentic/core';
import { api } from '../api.js';
import { useApp } from '../state.js';

/**
 * Who does the work.
 *
 * The product's argument is that no single model is the right one for every
 * task, and the default here says so: Auto routes each task on its own merits
 * and is what almost everyone should leave it on. But "almost everyone" is not
 * everyone. Someone comparing two models on the same prompt, or spending a
 * budget that is not theirs, or who has simply decided they trust one, has a
 * reason that no cost score gets to overrule — and until now the app had no
 * way for them to say it.
 *
 * The choice is two decisions, not one, because they are different sizes:
 * picking Claude is a decision about who, picking Opus inside it is a decision
 * about how much you are paying. Both are reasonable places to stop, so the
 * provider row and the model row are separate and the model row only appears
 * once a provider is chosen.
 *
 * It lives in the composer, next to the mode buttons, because it is the same
 * kind of question — a thing you decide about this build, visible while you
 * type it, not buried in a settings screen.
 */

const AUTO = '__auto__';

export function ModelPicker({ compact }: { compact?: boolean }) {
  const { snapshot, activeProject } = useApp();
  if (!activeProject) return null;

  const providers = snapshot.providers.filter((p) => p.available);
  const preferred = activeProject.settings.preferredProvider;
  const chosen = providers.find((p) => p.id === preferred?.providerId);

  // `null` is the patch's word for "unset"; `undefined` would be dropped by
  // JSON.stringify and read as "leave it alone", which is the opposite.
  const set = (next: { providerId: string; modelId?: string } | undefined) => {
    void api.updateProjectSettings(activeProject.id, {
      preferredProvider: next ?? (null as never),
    });
  };

  // Nothing to choose between. Saying so is more useful than an empty dropdown
  // that looks broken.
  if (providers.length === 0) {
    return (
      <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
        No models connected
      </span>
    );
  }

  return (
    <span className="row" style={{ gap: 4, alignItems: 'center' }}>
      <label className="row subtle" style={{ gap: 4, fontSize: 'var(--text-xs)' }}>
        {compact ? null : 'Model'}
        <select
          className="select"
          style={{ width: 'auto', padding: '2px 6px' }}
          value={preferred?.providerId ?? AUTO}
          title="Which model runs the work. Auto picks the best fit for each task on its own."
          onChange={(e) => {
            const value = e.target.value;
            if (value === AUTO) return set(undefined);
            // Changing provider drops the model: an Opus id means nothing to
            // OpenAI, and silently carrying it over would pin something that
            // does not exist and quietly fall back.
            set({ providerId: value });
          }}
        >
          <option value={AUTO}>Auto — best fit per task</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {chosen && chosen.models.length > 1 && (
        <select
          className="select"
          style={{ width: 'auto', padding: '2px 6px' }}
          value={preferred?.modelId ?? AUTO}
          title={`Which ${chosen.name} model. Auto lets the router choose within ${chosen.name}.`}
          onChange={(e) => {
            const value = e.target.value;
            set({ providerId: chosen.id, modelId: value === AUTO ? undefined : value });
          }}
        >
          <option value={AUTO}>Any {chosen.name} model</option>
          {chosen.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/** One line saying what the current choice means, for the settings screen. */
export function describeChoice(
  providers: ProviderStatus[],
  preferred: { providerId: string; modelId?: string } | undefined,
): string {
  if (!preferred?.providerId) {
    return 'Every task is routed to whichever connected model suits it best — the default, and the right answer unless you have a reason.';
  }
  const provider = providers.find((p) => p.id === preferred.providerId);
  if (!provider) {
    return `Pinned to "${preferred.providerId}", which is not connected right now. Tasks route normally until it is back.`;
  }
  const model = provider.models.find((m) => m.id === preferred.modelId);
  return model
    ? `Every task runs on ${provider.name} ${model.label}, whatever it costs and whatever the task is.`
    : `Every task runs on ${provider.name}; the router still picks which of its models.`;
}
