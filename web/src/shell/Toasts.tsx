import React from 'react';
import { useApp } from '../state.js';
import { IconClose } from './Icons.js';

/**
 * Toasts.
 *
 * Errors persist until dismissed; everything else clears itself. An error that
 * vanishes after three seconds is an error the user never read, and in an app
 * that spends their money that is not acceptable.
 */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;

  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.level}`}
          role={toast.level === 'error' ? 'alert' : 'status'}
        >
          <div className="toast__body">
            <div>{toast.message}</div>
            {toast.hint && <div className="toast__hint">{toast.hint}</div>}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
