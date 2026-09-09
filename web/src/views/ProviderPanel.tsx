import React, { useState } from 'react';
import type { ProviderStatus } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconRefresh } from '../shell/Icons.js';

/**
 * The provider ladder, as the router sees it.
 *
 * Sorted by tier, so the list *is* the failover order: local first, then free
 * tiers, then subscriptions you already pay for, then metered keys. Making that
 * visible is most of what makes the routing behaviour comprehensible.
 */

const KIND_LABEL: Record<ProviderStatus['kind'], string> = {
  local: 'Local · free, unlimited',
  'free-cloud': 'Free tier · capped',
  subscription: 'Subscription · already paid for',
  byok: 'Your API key · billed per token',
};

function quotaLine(provider: ProviderStatus): { text: string; level: 'ok' | 'warn' | 'error' } | undefined {
  const q = provider.quota;
  const now = Date.now();

  if (q.cooldownUntil && q.cooldownUntil > now) {
    const mins = Math.ceil((q.cooldownUntil - now) / 60_000);
    return { text: `Cooling down after a usage limit — about ${mins} min left`, level: 'error' };
  }
  if (q.limitRpd) {
    const pct = Math.round((q.usedDay / q.limitRpd) * 100);
    return {
      text: `${q.usedDay} of ${q.limitRpd} requests today (${pct}%)`,
      level: pct >= 90 ? 'error' : pct >= 75 ? 'warn' : 'ok',
    };
  }
  if (q.tokensToday.input + q.tokensToday.output > 0) {
    return {
      text: `${(q.tokensToday.input + q.tokensToday.output).toLocaleString()} tokens today · $${q.costTodayUsd.toFixed(4)}`,
      level: 'ok',
    };
  }
  return undefined;
}

export function ProviderRow({ provider }: { provider: ProviderStatus }) {
  const run = useAction();
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState(false);
  const quota = quotaLine(provider);

  const needsKey = provider.transport === 'http' && !provider.available;

  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 6 }}>
        <span className={`tier tier--${provider.kind}`} title={KIND_LABEL[provider.kind]} />
        <span className="grow truncate" style={{ fontWeight: 500 }}>
          {provider.name}
        </span>
        <span className={`badge ${provider.available ? 'badge--success' : 'badge--neutral'}`}>
          {provider.available ? 'Ready' : 'Off'}
        </span>
      </div>

      <div className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
        tier {provider.tier} · {KIND_LABEL[provider.kind]}
      </div>

      {provider.detail && (
        <div className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 2, lineHeight: 1.4 }}>
          {provider.detail}
        </div>
      )}

      {quota && (
        <div
          style={{
            fontSize: 'var(--text-xs)',
            marginTop: 4,
            color:
              quota.level === 'error'
                ? 'var(--danger)'
                : quota.level === 'warn'
                  ? 'var(--warning)'
                  : 'var(--fg-subtle)',
          }}
        >
          {quota.text}
        </div>
      )}

      {needsKey &&
        (adding ? (
          <form
            className="row"
            style={{ marginTop: 6, gap: 4 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!key.trim()) return;
              void run(() => api.setProviderKey(provider.id, key), `${provider.name} connected`).then(() => {
                setKey('');
                setAdding(false);
              });
            }}
          >
            <input
              className="input"
              type="password"
              value={key}
              autoFocus
              placeholder="Paste the API key"
              onChange={(e) => setKey(e.target.value)}
              // A key must never be recoverable from the page later.
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={!key.trim()}>
              Save
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginTop: 6 }}
            onClick={() => setAdding(true)}
          >
            Add a key
          </button>
        ))}
    </div>
  );
}

export function ProviderPanel() {
  const { snapshot } = useApp();
  const tabs = useTabs();
  const run = useAction();
  const [probing, setProbing] = useState(false);

  const ready = snapshot.providers.filter((p) => p.available).length;

  return (
    <>
      <header className="sidebar__header">
        Providers
        <div className="row">
          <span className="subtle" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {ready} ready
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title="Check them again"
            disabled={probing}
            onClick={() => {
              setProbing(true);
              void run(() => api.probeProviders()).finally(() => setProbing(false));
            }}
          >
            {probing ? (
              <span className="spinner" style={{ width: 12, height: 12 }} />
            ) : (
              <IconRefresh size={13} />
            )}
          </button>
        </div>
      </header>

      <div className="sidebar__body">
        {ready === 0 && (
          <div className="pad" style={{ borderBottom: '1px solid var(--border)' }}>
            <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Nothing is connected yet, so no work can run. The cheapest way to start is a free Groq key or a
              local Ollama model — both cost nothing.
            </p>
          </div>
        )}

        {snapshot.providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} />
        ))}

        <div className="pad">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => tabs.open({ kind: 'routing', title: 'Routing' })}
          >
            Edit the routing policy
          </button>
        </div>
      </div>
    </>
  );
}
