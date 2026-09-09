import React from 'react';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';

/**
 * The cost dashboard.
 *
 * Two numbers matter and both are shown honestly:
 *
 *  - **Spent** is measured where the provider reported usage and estimated
 *    where it did not. Estimated rows say so; a number presented as measured
 *    when it is a guess is worse than no number.
 *  - **Saved** is a counterfactual: what the same tokens would have cost on the
 *    most expensive model you have connected. It is labelled as an estimate,
 *    because the cheap calls that were made instead leave no trace of the
 *    expensive ones that were not.
 */
export function CostTab() {
  const { snapshot } = useApp();
  const run = useAction();
  const { usage } = snapshot;

  const maxDaily = Math.max(0.0001, ...usage.daily.map((d) => d.costUsd));
  const saved = Math.max(0, usage.baselineCostUsd - usage.totalCostUsd);
  const savedPct = usage.baselineCostUsd > 0 ? Math.round((saved / usage.baselineCostUsd) * 100) : 0;

  const totalCalls = usage.byProvider.reduce((sum, p) => sum + p.calls, 0);
  const totalTokens = usage.byProvider.reduce((sum, p) => sum + p.tokensIn + p.tokensOut, 0);

  const money = (n: number) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

  return (
    <div className="scroll pad-lg" style={{ height: '100%' }}>
      <div style={{ maxWidth: 820 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }} className="grow">
            Cost
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void run(() => api.resetUsage(), 'Counters reset')}
          >
            Reset counters
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
          Everything spent through this machine, per provider and per day.
        </p>

        <div className="row" style={{ gap: 'var(--space-3)', margin: '20px 0', flexWrap: 'wrap' }}>
          <div className="card" style={{ flex: '1 1 180px' }}>
            <div className="card__body">
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                Spent
              </div>
              <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                {money(usage.totalCostUsd)}
              </div>
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                {totalCalls.toLocaleString()} calls · {totalTokens.toLocaleString()} tokens
              </div>
            </div>
          </div>

          <div className="card" style={{ flex: '1 1 180px' }}>
            <div className="card__body">
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                Saved by routing <span title="An estimate, not a measurement">(est.)</span>
              </div>
              <div
                style={{ fontSize: 26, fontWeight: 600, color: 'var(--success)', letterSpacing: '-0.01em' }}
              >
                {money(saved)}
              </div>
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                {savedPct > 0
                  ? `${savedPct}% less than sending everything to your priciest model`
                  : 'Connect a cheaper provider to see a saving here'}
              </div>
            </div>
          </div>

          <div className="card" style={{ flex: '1 1 180px' }}>
            <div className="card__body">
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                Free capacity used
              </div>
              <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>
                {usage.byProvider
                  .filter((p) => p.costUsd === 0 && p.calls > 0)
                  .reduce((s, p) => s + p.calls, 0)}
              </div>
              <div className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                calls on local models, free tiers and subscriptions
              </div>
            </div>
          </div>
        </div>

        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card__header">
            <h3 className="card__title">By provider</h3>
          </div>
          {usage.byProvider.filter((p) => p.calls > 0).length === 0 ? (
            <div className="card__body muted">Nothing spent yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }}>
                  <th style={{ padding: '6px 12px', fontWeight: 600 }}>Provider</th>
                  <th style={{ padding: '6px 12px', fontWeight: 600, textAlign: 'right' }}>Calls</th>
                  <th style={{ padding: '6px 12px', fontWeight: 600, textAlign: 'right' }}>Tokens in</th>
                  <th style={{ padding: '6px 12px', fontWeight: 600, textAlign: 'right' }}>Tokens out</th>
                  <th style={{ padding: '6px 12px', fontWeight: 600, textAlign: 'right' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byProvider
                  .filter((p) => p.calls > 0)
                  .map((provider) => {
                    const status = snapshot.providers.find((p) => p.id === provider.providerId);
                    return (
                      <tr key={provider.providerId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 12px' }}>
                          <span className="row" style={{ gap: 6 }}>
                            {status && <span className={`tier tier--${status.kind}`} />}
                            {provider.name}
                          </span>
                        </td>
                        <td style={{ padding: '6px 12px', textAlign: 'right' }} className="mono">
                          {provider.calls.toLocaleString()}
                        </td>
                        <td style={{ padding: '6px 12px', textAlign: 'right' }} className="mono">
                          {provider.tokensIn.toLocaleString()}
                        </td>
                        <td style={{ padding: '6px 12px', textAlign: 'right' }} className="mono">
                          {provider.tokensOut.toLocaleString()}
                        </td>
                        <td style={{ padding: '6px 12px', textAlign: 'right' }} className="mono">
                          {provider.costUsd === 0 ? (
                            <span className="badge badge--success">free</span>
                          ) : (
                            money(provider.costUsd)
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <div className="card__header">
            <h3 className="card__title">Last 30 days</h3>
          </div>
          <div className="card__body">
            {usage.daily.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No history yet.
              </p>
            ) : (
              <div
                className="row"
                style={{ alignItems: 'flex-end', gap: 3, height: 120 }}
                role="img"
                aria-label={`Daily spend for the last ${usage.daily.length} days. Highest was ${money(maxDaily)}.`}
              >
                {usage.daily.map((day) => (
                  <div
                    key={day.day}
                    title={`${day.day}: ${money(day.costUsd)} across ${day.calls} calls`}
                    style={{
                      flex: 1,
                      minWidth: 6,
                      // A day with spend always gets at least 2px, so a small
                      // day is visible rather than indistinguishable from zero.
                      height: `${day.costUsd > 0 ? Math.max(2, (day.costUsd / maxDaily) * 100) : 1}%`,
                      background: day.costUsd > 0 ? 'var(--accent)' : 'var(--border)',
                      borderRadius: '2px 2px 0 0',
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <p className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 16, lineHeight: 1.6 }}>
          Token counts come from the provider where it reports them and from a character estimate where it
          does not — CLI agents do not report usage at all, so their rows are estimates. Local models and
          subscriptions are shown as free because they are not billed per token, which is also why the router
          prefers them.
        </p>
      </div>
    </div>
  );
}
