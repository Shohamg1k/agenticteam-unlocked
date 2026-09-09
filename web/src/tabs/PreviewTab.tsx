import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementTarget } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { IconPlay, IconRefresh, IconStop, IconTarget } from '../shell/Icons.js';

/**
 * The browser preview with the element picker.
 *
 * The iframe points at the app's proxy, not at the dev server directly, which
 * is what lets the overlay be injected without touching the user's project.
 *
 * Everything the page sends over postMessage is untrusted: it originates in
 * code an agent may have written moments ago. It is validated for shape, used
 * only to populate a form the user then confirms, and relayed to the server as
 * data. Nothing in a message can cause an action on its own.
 */
export function PreviewTab({ active }: { active: boolean }) {
  const { activeProject, snapshot } = useApp();
  const run = useAction();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<ElementTarget>();
  const [instruction, setInstruction] = useState('');
  const [starting, setStarting] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  // Bumping this remounts the iframe. The preview is served from a different
  // origin than the app, so `contentWindow.location.reload()` would throw —
  // a remount is the only reload available to us, and it is also the one that
  // reliably re-runs the injected overlay.
  const [reloadNonce, setReloadNonce] = useState(0);

  const preview = snapshot.previews.find((p) => p.projectId === activeProject?.id);
  const running = preview?.status === 'running' && preview.url;

  // ---- Messages from the previewed page ----------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; payload?: Record<string, unknown> };
      if (data?.source !== 'agentic-preview' || !data.type) return;
      if (!activeProject) return;

      if (data.type === 'element-picked' && data.payload) {
        const p = data.payload as Record<string, unknown>;
        // Take only the fields we understand, coerced. The page cannot inject
        // extra keys into anything downstream.
        setTarget({
          selector: String(p.selector ?? ''),
          tagName: String(p.tagName ?? 'unknown'),
          text: p.text ? String(p.text).slice(0, 200) : undefined,
          file: p.file ? String(p.file) : undefined,
          line: typeof p.line === 'number' ? p.line : undefined,
          column: typeof p.column === 'number' ? p.column : undefined,
          componentName: p.componentName ? String(p.componentName) : undefined,
          className: p.className ? String(p.className).slice(0, 200) : undefined,
          html: p.html ? String(p.html).slice(0, 800) : undefined,
        });
        setPicking(false);
      } else if (data.type === 'picker-state') {
        setPicking(Boolean((data.payload as { picking?: boolean })?.picking));
      } else if (data.type === 'console' || data.type === 'network-error') {
        // Relayed for the debugging panel and for agents. Fire-and-forget:
        // losing a console line is not worth surfacing an error for.
        void api.previewTelemetry(activeProject.id, data.type, data.payload).catch(() => undefined);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeProject]);

  const setPickingInPage = useCallback((on: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: 'agentic-app', type: 'set-picking', picking: on },
      '*',
    );
    setPicking(on);
  }, []);

  useEffect(() => {
    // Leaving the tab must not leave the page in crosshair mode.
    if (!active && picking) setPickingInPage(false);
  }, [active, picking, setPickingInPage]);

  const submitEdit = async () => {
    if (!activeProject || !target || !instruction.trim()) return;
    const result = await run(
      () => api.scopedEdit(activeProject.id, instruction.trim(), target),
      'Change requested — the team is on it',
    );
    if (result) {
      setTarget(undefined);
      setInstruction('');
    }
  };

  if (!activeProject) return <div className="empty">Open a folder to use the preview.</div>;

  const errors = (preview?.consoleLines ?? []).filter((l) => l.level === 'error');

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div
        className="row"
        style={{
          gap: 8,
          padding: '4px var(--space-3)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
        }}
      >
        {running ? (
          <>
            <button
              type="button"
              className={`btn btn--sm ${picking ? 'btn--primary' : ''}`}
              aria-pressed={picking}
              onClick={() => setPickingInPage(!picking)}
              title="Click an element in the page and describe the change you want"
            >
              <IconTarget size={12} />
              {picking ? 'Picking… (Esc to cancel)' : 'Pick an element'}
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--icon"
              title="Reload"
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <IconRefresh size={13} />
            </button>

            <span className="mono subtle truncate grow" style={{ fontSize: 'var(--text-xs)' }}>
              {preview.url}
            </span>

            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setShowConsole((s) => !s)}
              aria-pressed={showConsole}
            >
              Console
              {errors.length > 0 && <span className="badge badge--danger">{errors.length}</span>}
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--icon"
              title="Stop the dev server"
              onClick={() => void run(() => api.stopPreview(activeProject.id))}
            >
              <IconStop size={12} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={starting}
              onClick={() => {
                setStarting(true);
                void run(() => api.startPreview(activeProject.id)).finally(() => setStarting(false));
              }}
            >
              {starting ? <span className="spinner" /> : <IconPlay size={12} />}
              {starting ? 'Starting…' : 'Start the dev server'}
            </button>
            <span className="subtle grow" style={{ fontSize: 'var(--text-xs)' }}>
              {preview?.command ? `Will run: ${preview.command}` : 'Detected from your project’s scripts'}
            </span>
          </>
        )}
      </div>

      {preview?.status === 'failed' && preview.error && (
        <div
          role="alert"
          className="pad"
          style={{ background: 'var(--danger-bg)', borderBottom: '1px solid var(--border)' }}
        >
          <strong style={{ color: 'var(--danger)' }}>The dev server did not start</strong>
          <pre
            className="mono"
            style={{
              margin: '6px 0 0',
              fontSize: 'var(--text-xs)',
              whiteSpace: 'pre-wrap',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {preview.error}
          </pre>
        </div>
      )}

      <div className="grow" style={{ minHeight: 0, position: 'relative', display: 'flex' }}>
        {running ? (
          <iframe
            key={reloadNonce}
            ref={iframeRef}
            src={preview.url}
            title="Application preview"
            style={{ flex: 1, border: 'none', background: '#fff' }}
            // The previewed app is the user's own, running locally, but it may
            // contain code an agent wrote minutes ago. Same-origin is needed for
            // the picker; everything else the page could do is denied.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="empty">
            <div className="empty__title">Preview is not running</div>
            <p className="empty__body">
              Start your project’s dev server to see the app here. Once it is running you can click any
              element and describe the change you want — the request is routed to an agent and comes back as a
              diff for review.
            </p>
          </div>
        )}
      </div>

      {target && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: 'var(--space-3)',
          }}
        >
          <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="badge badge--accent">
              {target.componentName ? `<${target.componentName}>` : `<${target.tagName}>`}
            </span>
            {target.file ? (
              <span className="mono subtle" style={{ fontSize: 'var(--text-xs)' }}>
                {target.file}
                {target.line ? `:${target.line}` : ''}
              </span>
            ) : (
              <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
                Source file not resolved — the agent will find it from the selector and text.
              </span>
            )}
            {target.text && (
              <span className="subtle truncate" style={{ fontSize: 'var(--text-xs)', maxWidth: 260 }}>
                “{target.text}”
              </span>
            )}
            <span className="grow" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTarget(undefined)}>
              Clear
            </button>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow"
              autoFocus
              value={instruction}
              placeholder="What should change about this element?"
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitEdit();
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!instruction.trim()}
              onClick={() => void submitEdit()}
            >
              Make the change
            </button>
          </div>
        </div>
      )}

      {showConsole && preview && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            maxHeight: 220,
            overflow: 'auto',
            background: 'var(--bg-app)',
          }}
        >
          <div
            className="row"
            style={{
              padding: '4px var(--space-3)',
              borderBottom: '1px solid var(--border)',
              fontSize: 'var(--text-xs)',
            }}
          >
            <span className="subtle grow">
              Captured from the running page — available to agents when debugging
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void run(() => api.clearPreview(activeProject.id))}
            >
              Clear
            </button>
          </div>

          {preview.consoleLines.length === 0 && preview.networkErrors.length === 0 ? (
            <div className="pad subtle" style={{ fontSize: 'var(--text-xs)' }}>
              Nothing logged yet.
            </div>
          ) : (
            <div className="mono" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
              {preview.networkErrors.map((entry, index) => (
                <div key={`net-${index}`} style={{ padding: '1px var(--space-3)', color: 'var(--danger)' }}>
                  [{entry.status || 'failed'}] {entry.method} {entry.url}
                </div>
              ))}
              {preview.consoleLines.map((line, index) => (
                <div
                  key={`log-${index}`}
                  style={{
                    padding: '1px var(--space-3)',
                    color:
                      line.level === 'error'
                        ? 'var(--danger)'
                        : line.level === 'warn'
                          ? 'var(--warning)'
                          : 'var(--fg-muted)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  [{line.level}] {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
