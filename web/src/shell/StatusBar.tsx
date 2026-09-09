import React from 'react';
import { useApp } from '../state.js';
import { useTabs } from './tabs.js';
import { openTab } from './AppShell.js';

/**
 * The status bar.
 *
 * It answers, without a click: is the app connected, what is running, what is
 * waiting for me, what has this cost, and is any provider about to run out.
 *
 * The quota warning is the one the brief calls out specifically — a cap that
 * arrives as a surprise. It appears *before* the spend, not after.
 */
export function StatusBar({ onOpenPanel }: { onOpenPanel: (panel: string) => void }) {
  const { snapshot, connection, activeProject } = useApp();
  const tabs = useTabs();

  const runningPlans = snapshot.plans.filter((p) => p.status === 'running');
  const runningTasks = snapshot.tasks.filter((t) => t.status === 'running' || t.status === 'verifying');
  const openReviews = snapshot.reviewQueue.filter((i) => i.status === 'open').length;
  const available = snapshot.providers.filter((p) => p.available);

  // A provider is "tight" when it has burned 80% of a declared cap, or is
  // cooling down. Saying so now is the entire point.
  const now = Date.now();
  const tight = available.filter((p) => {
    if (p.quota.cooldownUntil && p.quota.cooldownUntil > now) return true;
    if (p.quota.limitRpd && p.quota.usedDay / p.quota.limitRpd >= 0.8) return true;
    if (p.quota.limitRpm && p.quota.usedMinute / p.quota.limitRpm >= 0.8) return true;
    return false;
  });

  const todaySpend = snapshot.usage.totalCostUsd;
  const saved = Math.max(0, snapshot.usage.baselineCostUsd - todaySpend);

  const connectionLabel: Record<typeof connection, { dot: string; text: string }> = {
    open: { dot: 'dot--ok', text: 'Connected' },
    connecting: { dot: 'dot--busy', text: 'Connecting…' },
    reconnecting: { dot: 'dot--warn', text: 'Reconnecting…' },
    closed: { dot: 'dot--error', text: 'Disconnected' },
  };
  const conn = connectionLabel[connection];

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={`Core service: ${conn.text}`}>
        <span className={`dot ${conn.dot}`} />
        {conn.text}
      </span>

      {activeProject && (
        <button
          type="button"
          className="statusbar__item"
          onClick={() => onOpenPanel('files')}
          title={activeProject.root}
        >
          {activeProject.name}
        </button>
      )}

      {runningTasks.length > 0 ? (
        <button
          type="button"
          className="statusbar__item"
          onClick={() => openTab(tabs, 'tasks', runningPlans[0]?.id)}
          title={runningTasks.map((t) => `${t.title} — ${t.providerId ?? 'routing'}`).join('\n')}
        >
          <span className="dot dot--busy" />
          {runningTasks.length} agent{runningTasks.length === 1 ? '' : 's'} working
        </button>
      ) : runningPlans.length > 0 ? (
        <span className="statusbar__item">
          <span className="dot dot--busy" />
          Planning…
        </span>
      ) : (
        <span className="statusbar__item">
          <span className="dot dot--idle" />
          Idle
        </span>
      )}

      {openReviews > 0 && (
        <button
          type="button"
          className="statusbar__item"
          onClick={() => onOpenPanel('inbox')}
          title="Work is waiting for your decision"
        >
          <span className="dot dot--warn" />
          {openReviews} awaiting you
        </button>
      )}

      <span className="statusbar__spacer" />

      {tight.length > 0 && (
        <button
          type="button"
          className="statusbar__item"
          onClick={() => onOpenPanel('providers')}
          title={tight
            .map((p) => {
              if (p.quota.cooldownUntil && p.quota.cooldownUntil > now) {
                return `${p.name}: cooling down until ${new Date(p.quota.cooldownUntil).toLocaleTimeString()}`;
              }
              return `${p.name}: ${p.quota.usedDay}/${p.quota.limitRpd ?? '?'} requests today`;
            })
            .join('\n')}
        >
          <span className="dot dot--warn" />
          {tight.length} provider{tight.length === 1 ? '' : 's'} near their limit
        </button>
      )}

      <button
        type="button"
        className="statusbar__item"
        onClick={() => openTab(tabs, 'cost')}
        title={
          saved > 0
            ? `$${todaySpend.toFixed(4)} spent today. Routing to the cheapest capable model saved about $${saved.toFixed(2)} versus sending everything to the most expensive connected model.`
            : `$${todaySpend.toFixed(4)} spent today`
        }
      >
        ${todaySpend < 0.01 && todaySpend > 0 ? todaySpend.toFixed(4) : todaySpend.toFixed(2)} today
        {saved > 0.005 && <span className="subtle"> · saved ~${saved.toFixed(2)}</span>}
      </button>

      <button
        type="button"
        className="statusbar__item"
        onClick={() => onOpenPanel('providers')}
        title={
          available.length
            ? available.map((p) => `${p.name} (${p.kind})`).join('\n')
            : 'No providers are connected. Open Providers to add one.'
        }
      >
        <span className={`dot ${available.length ? 'dot--ok' : 'dot--error'}`} />
        {available.length} provider{available.length === 1 ? '' : 's'}
      </button>

      <span className="statusbar__item" title={`Human gate: ${snapshot.config.executionMode}`}>
        {snapshot.config.executionMode === 'approval'
          ? 'Approval mode'
          : snapshot.config.executionMode === 'hybrid'
            ? 'Hybrid mode'
            : 'Auto mode'}
      </span>
    </footer>
  );
}
