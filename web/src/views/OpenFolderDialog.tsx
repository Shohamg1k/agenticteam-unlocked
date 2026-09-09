import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../state.js';
import { IconClose, IconFolder } from '../shell/Icons.js';

/**
 * Opening a project folder.
 *
 * Two paths, and the fallback is a real dialog rather than `window.prompt`:
 * Electron does not implement `prompt` at all, so a bridge failure there meant
 * the button did nothing, with no error anywhere a user would look.
 *
 * In the desktop app the native picker opens directly — no dialog, one click.
 * The dialog appears only when there is no picker (a browser) or when the
 * picker itself failed, and in the second case it says so.
 */

/** String.raw so the backslashes stay backslashes rather than escape sequences. */
const WINDOWS_PATH_EXAMPLE = String.raw`C:\Users\you\code\my-project`;
const POSIX_PATH_EXAMPLE = '/Users/you/code/my-project';

export interface OpenFolderDialogProps {
  onClose: () => void;
  /** Shown above the input when the native picker was tried and failed. */
  pickerError?: string;
}

export function OpenFolderDialog({ onClose, pickerError }: OpenFolderDialogProps) {
  const { snapshot, toast } = useApp();
  const [pathValue, setPathValue] = useState('');
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes, as it does in every dialog anyone has used.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (candidate: string) => {
    const root = candidate.trim();
    if (!root) return;

    setBusy(true);
    setError(undefined);
    setHint(undefined);
    try {
      const project = await api.openProject(root);
      toast('success', `Working in ${project.name}`, project.root);
      onClose();
    } catch (err) {
      // The server's errors here are specific and actionable — "not a folder",
      // "not writable", "no such path" — so show them rather than a generic
      // failure, and keep the dialog open with what they typed intact.
      const e = err as { message?: string; hint?: string };
      setError(e.message ?? 'Could not open that folder');
      setHint(e.hint);
    } finally {
      setBusy(false);
    }
  };

  // Prefer a folder they have actually opened. Otherwise guess the platform —
  // the desktop bridge knows it exactly, and a browser can infer it well enough
  // that a Windows user is not shown a macOS path.
  const onWindows = window.agentic
    ? window.agentic.platform === 'win32'
    : /windows/i.test(navigator.userAgent);
  const example = snapshot.projects[0]?.root ?? (onWindows ? WINDOWS_PATH_EXAMPLE : POSIX_PATH_EXAMPLE);

  return (
    <div
      className="modal__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="open-folder-title">
        <div className="modal__header">
          <h2 id="open-folder-title" className="card__title">
            Open a project folder
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Close" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body col" style={{ gap: 'var(--space-3)' }}>
          {pickerError && (
            <div className="callout callout--warn">
              The native folder picker did not open ({pickerError}). Type the path instead.
            </div>
          )}

          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
            Everything the team builds is written into this folder on your machine — there is no hidden
            sandbox, and nothing is written until you accept it.
          </p>

          <form
            className="field"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(pathValue);
            }}
          >
            <label className="field__label" htmlFor="folder-path">
              Full path to the folder
            </label>
            <input
              id="folder-path"
              ref={inputRef}
              className="input input--mono"
              value={pathValue}
              placeholder={example}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => {
                setPathValue(event.target.value);
                setError(undefined);
              }}
            />
            {error ? (
              <span className="field__error">{error}</span>
            ) : (
              <span className="field__hint">
                The folder does not have to exist yet in git — a repository is created if there is not one,
                which is what makes checkpoints and rollback work.
              </span>
            )}
            {hint && <span className="field__hint">{hint}</span>}
          </form>

          {snapshot.projects.length > 0 && (
            <div className="col" style={{ gap: 'var(--space-1)' }}>
              <span className="field__label">Recent</span>
              {snapshot.projects.slice(0, 5).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="list__item"
                  style={{ borderRadius: 'var(--radius-sm)' }}
                  disabled={busy}
                  onClick={() => void submit(project.root)}
                >
                  <IconFolder size={13} />
                  <span className="truncate grow">{project.name}</span>
                  <span className="subtle truncate" style={{ fontSize: 'var(--text-xs)', maxWidth: '55%' }}>
                    {project.root}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!pathValue.trim() || busy}
            onClick={() => void submit(pathValue)}
          >
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Opening…' : 'Open'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asking for the open-folder flow, from anywhere.
 *
 * A DOM event rather than a prop or a context, because the request arrives from
 * two unrelated places — a button in the tree, and the File menu, which comes
 * in over IPC from the main process — and both must reach the same dialog.
 */
const OPEN_FOLDER_EVENT = 'agentic:open-folder';

export function requestOpenFolder(): void {
  window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT));
}

/**
 * Mounted once by the shell. Owns the native picker and the fallback dialog.
 *
 * One host rather than one per button: there is only ever one folder being
 * opened, and it means the File menu and every button share a single code path
 * instead of the menu quietly having none — which is exactly what it had.
 */
export function OpenFolderHost() {
  const { toast } = useApp();
  const [dialog, setDialog] = useState<{ open: boolean; pickerError?: string }>({ open: false });

  useEffect(() => {
    const start = async () => {
      const bridge = window.agentic;

      // No native picker (a browser): straight to the path dialog.
      if (!bridge?.pickFolder) {
        setDialog({ open: true });
        return;
      }

      try {
        const root = await bridge.pickFolder();
        if (!root) return; // Cancelled — not an error, and not worth a toast.
        const project = await api.openProject(root);
        toast('success', `Working in ${project.name}`, project.root);
      } catch (err) {
        // A path chosen from the native picker can still be refused — an
        // unwritable folder, for instance — and the picker itself can fail to
        // open. Either way the dialog carries the reason, rather than the
        // click appearing to do nothing.
        const e = err as { message?: string };
        setDialog({ open: true, pickerError: e.message ?? 'unknown error' });
      }
    };

    const onRequest = () => void start();

    // The File menu sends this through the preload as a DOM event.
    const onMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'open-folder') void start();
    };

    window.addEventListener(OPEN_FOLDER_EVENT, onRequest);
    window.addEventListener('agentic:menu', onMenu);
    return () => {
      window.removeEventListener(OPEN_FOLDER_EVENT, onRequest);
      window.removeEventListener('agentic:menu', onMenu);
    };
  }, [toast]);

  if (!dialog.open) return null;
  return <OpenFolderDialog onClose={() => setDialog({ open: false })} pickerError={dialog.pickerError} />;
}

/** The button itself — it only ever asks; the host does the work. */
export function OpenFolderButton({ icon, label }: { icon?: boolean; label?: string }) {
  if (icon) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        title="Open another folder"
        aria-label="Open another folder"
        onClick={requestOpenFolder}
      >
        <IconFolder size={13} />
      </button>
    );
  }
  return (
    <button type="button" className="btn btn--primary" onClick={requestOpenFolder}>
      {label ?? 'Open a folder'}
    </button>
  );
}
