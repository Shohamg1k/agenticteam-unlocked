import React from 'react';
import { useApp } from '../state.js';
import { ReviewCard } from '../views/InboxPanel.js';
import { IconInbox } from '../shell/Icons.js';

/**
 * The Inbox as a full tab: the same cards as the sidebar panel, with room to
 * actually read a phase-gate summary or a budget breakdown.
 */
export function InboxTab() {
  const { snapshot } = useApp();
  const open = snapshot.reviewQueue.filter((i) => i.status === 'open');
  const resolved = snapshot.reviewQueue.filter((i) => i.status !== 'open').slice(0, 20);

  return (
    <div className="scroll pad-lg" style={{ height: '100%' }}>
      <div style={{ maxWidth: 780 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Inbox</h2>
        <p className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
          One queue for every decision the system cannot make itself: work to accept, phase gates to open,
          budgets to raise, and external content to acknowledge.
        </p>

        {open.length === 0 ? (
          <div className="empty">
            <IconInbox size={30} />
            <div className="empty__title">Nothing waiting</div>
            <p className="empty__body">Everything that needed you has been decided.</p>
          </div>
        ) : (
          <div className="col" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
            {open.map((item) => (
              <ReviewCard key={item.id} item={item} />
            ))}
          </div>
        )}

        {resolved.length > 0 && (
          <section style={{ marginTop: 'var(--space-6)' }}>
            <h3
              className="subtle"
              style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Recently decided
            </h3>
            <div className="col" style={{ gap: 2 }}>
              {resolved.map((item) => (
                <div key={item.id} className="row" style={{ fontSize: 'var(--text-sm)', padding: '3px 0' }}>
                  <span
                    className={`badge badge--${item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'danger' : 'neutral'}`}
                  >
                    {item.status}
                  </span>
                  <span className="truncate grow muted">{item.title}</span>
                  <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                    {item.resolvedAt ? new Date(item.resolvedAt).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
