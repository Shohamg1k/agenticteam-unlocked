import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementTarget, PageAuditResult } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { IconPlay, IconRefresh, IconStop, IconTarget } from '../shell/Icons.js';

/**
 * The browser preview, the element picker, and annotations.
 *
 * Two kinds of project end up here and the difference is deliberately visible,
 * because it changes what the button does:
 *
 *  - A project of plain HTML/CSS/JS is SERVED, the way the Live Server
 *    extension serves one, and the button says so. There is no dev server to
 *    start, and the old code's insistence on one meant these projects — the
 *    ones this app produces fastest — had no preview at all.
 *  - A project with a build step has its own dev server RUN, and the app then
 *    proxies whatever URL that server reports, rather than the one we guessed.
 *
 * Everything the page sends over postMessage is untrusted: it originates in
 * code an agent may have written moments ago. It is validated for shape, used
 * only to populate a form the user confirms, and relayed to the server as data.
 * Nothing in a message can cause an action on its own.
 */
export function PreviewTab({ active }: { active: boolean }) {
  const { activeProject, snapshot } = useApp();
  const run = useAction();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [target, setTarget] = useState<ElementTarget>();
  const [instruction, setInstruction] = useState('');
  const [starting, setStarting] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [audit, setAudit] = useState<PageAuditResult>();
  const [auditNote, setAuditNote] = useState<string>();
  const [auditing, setAuditing] = useState(false);
  // Bumping this remounts the iframe. The preview is served from a different
  // origin than the app, so `contentWindow.location.reload()` would throw —
  // a remount is the only reload available to us, and it is also the one that
  // reliably re-runs the injected overlay.
  const [reloadNonce, setReloadNonce] = useState(0);

  const preview = snapshot.previews.find((p) => p.projectId === activeProject?.id);
  const running = preview?.status === 'running' && preview.url;
  const isStatic = preview?.mode === 'static';
  const annotations = preview?.annotations ?? [];

  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: 'agentic-app', ...message }, '*');
  }, []);

  // ---- Messages from the previewed page ----------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; payload?: Record<string, unknown> };
      if (data?.source !== 'agentic-preview' || !data.type) return;
      if (!activeProject) return;

      if (data.type === 'element-picked' && data.payload) {
        setTarget(readTarget(data.payload));
        setPicking(false);
      } else if (data.type === 'picker-state') {
        setPicking(Boolean((data.payload as { picking?: boolean })?.picking));
      } else if (data.type === 'annotate-state') {
        setAnnotating(Boolean((data.payload as { annotating?: boolean })?.annotating));
      } else if (data.type === 'annotation-added' && data.payload) {
        const p = data.payload as Record<string, unknown>;
        const rect = (p.rect ?? {}) as Record<string, unknown>;
        // Coerced field by field, like a picked element: the page supplies
        // these numbers and strings, so nothing unrecognised gets through.
        void api
          .addAnnotation(activeProject.id, {
            id: String(p.id ?? '').slice(0, 64),
            kind: p.kind === 'arrow' || p.kind === 'note' ? p.kind : 'box',
            text: String(p.text ?? '').slice(0, 2_000),
            rect: {
              x: Number(rect.x) || 0,
              y: Number(rect.y) || 0,
              width: Number(rect.width) || 0,
              height: Number(rect.height) || 0,
            },
            target: p.target ? readTarget(p.target as Record<string, unknown>) : undefined,
            pageUrl: p.pageUrl ? String(p.pageUrl).slice(0, 500) : undefined,
            createdAt: Number(p.createdAt) || Date.now(),
          })
          .catch(() => undefined);
      } else if (data.type === 'annotation-removed' && data.payload) {
        const id = String((data.payload as { id?: unknown }).id ?? '');
        if (id) void api.removeAnnotation(activeProject.id, id).catch(() => undefined);
      } else if (data.type === 'console' || data.type === 'network-error') {
        // Relayed for the debugging panel and for agents. Fire-and-forget:
        // losing a console line is not worth surfacing an error for.
        void api.previewTelemetry(activeProject.id, data.type, data.payload).catch(() => undefined);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeProject]);

  const setPickingInPage = useCallback(
    (on: boolean) => {
      post({ type: 'set-picking', picking: on });
      setPicking(on);
      if (on) setAnnotating(false);
    },
    [post],
  );

  const setAnnotatingInPage = useCallback(
    (on: boolean) => {
      post({ type: 'set-annotating', annotating: on, kind: 'box' });
      setAnnotating(on);
      if (on) setPicking(false);
    },
    [post],
  );

  useEffect(() => {
    // Leaving the tab must not leave the page in crosshair mode.
    if (active) return;
    if (picking) setPickingInPage(false);
    if (annotating) setAnnotatingInPage(false);
  }, [active, picking, annotating, setPickingInPage, setAnnotatingInPage]);

  // Push the server's annotations back into the page after it reloads, so a
  // hot reload or a file change does not wipe the notes the user has drawn.
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => post({ type: 'set-annotations', annotations }), 400);
    return () => clearTimeout(timer);
  }, [running, reloadNonce, annotations, post]);

  const submitEdit = async () => {
    if (!activeProject) return;
    const text = instruction.trim();
    if (!text && !annotations.length) return;

    const result = await run(
      () => api.scopedEdit(activeProject.id, text, target, annotations),
      annotations.length
        ? `${annotations.length} note${annotations.length === 1 ? '' : 's'} sent — the team is on it`
        : 'Change requested — the team is on it',
    );
    if (result) {
      setTarget(undefined);
      setInstruction('');
      setAnnotatingInPage(false);
    }
  };

  /**
   * Render the page and report what is objectively broken.
   *
   * The same check the verification loop runs on a task's output, on demand.
   * Useful for the case the automatic gate cannot cover: a page that breaks
   * from a combination of accepted changes, which no single task produced.
   */
  const checkLayout = async () => {
    if (!activeProject) return;
    setAuditing(true);
    setAudit(undefined);
    setAuditNote(undefined);
    try {
      const result = await api.auditPreview(activeProject.id);
      if (result && 'unavailable' in result) setAuditNote(result.unavailable);
      else if (result) setAudit(result);
    } catch (err) {
      setAuditNote(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditing(false);
    }
  };

  /**
   * Hand the findings to an agent verbatim.
   *
   * Each one already carries the element and the measurement, which is exactly
   * what a repair needs and exactly what a person retyping "the layout looks
   * wrong" would leave out.
   */
  const fixFindings = async (result: PageAuditResult) => {
    if (!activeProject) return;
    const issues = auditIssues(result);
    const instruction = [
      `The page at ${result.url} was rendered at ${result.viewport.width}x${result.viewport.height} and`,
      'these problems were measured on it. Fix the layout and emit the complete files.',
      '',
      ...issues.map((i) => `- [${i.severity}] ${i.message}${i.detail ? ` ${i.detail}` : ''}${i.selector ? ` (${i.selector})` : ''}`),
    ].join('\n');

    const sent = await run(() => api.scopedEdit(activeProject.id, instruction), 'Sent to the team');
    if (sent) {
      setAudit(undefined);
      setAuditNote(undefined);
    }
  };

  if (!activeProject) return <div className="empty">Open a folder to use the preview.</div>;

  const errors = (preview?.consoleLines ?? []).filter((l) => l.level === 'error');
  const startLabel = describeStart(preview?.htmlFiles?.length, preview?.command);

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
              {picking ? 'Picking… (Esc to cancel)' : 'Pick'}
            </button>

            <button
              type="button"
              className={`btn btn--sm ${annotating ? 'btn--primary' : ''}`}
              aria-pressed={annotating}
              onClick={() => setAnnotatingInPage(!annotating)}
              title="Draw boxes on the page and leave a note on each one"
            >
              ✎ {annotating ? 'Drawing…' : 'Annotate'}
              {annotations.length > 0 && <span className="badge badge--accent">{annotations.length}</span>}
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--icon"
              title="Reload"
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <IconRefresh size={13} />
            </button>

            {/* A static site is usually more than one page, and the preview is
                only useful if you can get to the others. */}
            {isStatic && (preview.htmlFiles?.length ?? 0) > 1 ? (
              <select
                className="input"
                style={{ maxWidth: 220, fontSize: 'var(--text-xs)', padding: '2px 6px' }}
                value={preview.entryFile ?? ''}
                aria-label="Page to preview"
                onChange={(event) => {
                  void run(() => api.startPreview(activeProject.id, event.target.value));
                  setReloadNonce((n) => n + 1);
                }}
              >
                {preview.htmlFiles?.map((file) => (
                  <option key={file} value={file}>
                    {file}
                  </option>
                ))}
              </select>
            ) : null}

            <span className="mono subtle truncate grow" style={{ fontSize: 'var(--text-xs)' }}>
              {preview.url}
            </span>

            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={auditing}
              onClick={() => void checkLayout()}
              title="Render the page and report anything visibly broken"
            >
              {auditing ? <span className="spinner" /> : null}
              {auditing ? 'Checking…' : 'Check layout'}
            </button>

            {/* Opening in the real browser is the one thing the embedded frame
                cannot be: a place to test with your own extensions, your own
                devtools and your own logged-in session. */}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="Open this page in your own browser"
              onClick={() => window.agentic?.openExternal?.(preview.url!)}
            >
              Open in browser
            </button>

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
              title={isStatic ? 'Stop serving' : 'Stop the dev server'}
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
              {starting ? 'Starting…' : startLabel.button}
            </button>
            <span className="subtle grow" style={{ fontSize: 'var(--text-xs)' }}>
              {startLabel.hint}
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
          <strong style={{ color: 'var(--danger)' }}>
            {preview.mode === 'static' ? 'The preview could not start' : 'The dev server did not start'}
          </strong>
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
              {startLabel.empty} Once it is running you can click any element or draw a note on it and
              describe the change you want — the request is routed to an agent and comes back as a diff for
              review.
            </p>
          </div>
        )}
      </div>

      {(audit || auditNote) && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          <div
            className="row"
            style={{
              gap: 8,
              padding: '4px var(--space-3)',
              borderBottom: '1px solid var(--border)',
              fontSize: 'var(--text-xs)',
              position: 'sticky',
              top: 0,
              background: 'var(--bg-panel)',
            }}
          >
            <strong>Layout check</strong>
            {audit && (
              <span className="subtle">
                rendered at {audit.viewport.width}×{audit.viewport.height}
              </span>
            )}
            <span className="grow" />
            {/* Sending the findings to an agent is the point of having them:
                each one carries the element and the measurement, which is
                exactly what a repair needs and what a person retyping it would
                leave out. */}
            {audit && auditIssues(audit).length > 0 && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void fixFindings(audit)}
              >
                Ask the team to fix these
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setAudit(undefined);
                setAuditNote(undefined);
              }}
            >
              Dismiss
            </button>
          </div>

          {auditNote && (
            <div className="pad subtle" style={{ fontSize: 'var(--text-xs)' }}>
              {auditNote}
            </div>
          )}

          {audit && auditIssues(audit).length === 0 && (
            <div className="pad" style={{ fontSize: 'var(--text-xs)' }}>
              <span className="dot dot--ok" /> Nothing visibly broken: no overflow, no overlapping
              elements, no unreachable controls, no unreadable text.
            </div>
          )}

          {audit && (
            <ul style={{ margin: 0, padding: '4px 0', listStyle: 'none' }}>
              {auditIssues(audit).map((issue, index) => (
                <li
                  key={index}
                  style={{
                    padding: '4px var(--space-3)',
                    fontSize: 'var(--text-xs)',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span
                    className={`badge ${issue.severity === 'error' ? 'badge--danger' : 'badge--warning'}`}
                  >
                    {issue.severity === 'error' ? 'broken' : 'check'}
                  </span>
                  <span className="grow">
                    {issue.message}
                    {issue.detail && <span className="subtle"> {issue.detail}</span>}
                    {issue.selector && (
                      <span className="mono subtle"> — {issue.selector}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {annotations.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: 'var(--space-2) var(--space-3)',
            maxHeight: 160,
            overflow: 'auto',
          }}
        >
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 'var(--text-xs)' }}>
              {annotations.length} note{annotations.length === 1 ? '' : 's'} on this page
            </strong>
            <span className="grow" />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void run(() => api.clearAnnotations(activeProject.id));
                post({ type: 'set-annotations', annotations: [] });
              }}
            >
              Clear all
            </button>
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
            {annotations.map((note) => (
              <li key={note.id}>
                {note.text || <span className="subtle">(no note — just this element)</span>}{' '}
                {note.target && (
                  <span className="mono subtle">
                    &lt;{note.target.componentName ?? note.target.tagName}&gt;
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {(target || annotations.length > 0) && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            padding: 'var(--space-3)',
          }}
        >
          {target && (
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
          )}

          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow"
              autoFocus
              value={instruction}
              placeholder={
                annotations.length && !target
                  ? 'Anything to add? The notes on the page are sent with this.'
                  : 'What should change about this element?'
              }
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitEdit();
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!instruction.trim() && !annotations.length}
              onClick={() => void submitEdit()}
            >
              {annotations.length ? `Send ${annotations.length} note${annotations.length === 1 ? '' : 's'}` : 'Make the change'}
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

/**
 * Everything the audit found, page findings and load failures together.
 *
 * The page cannot see its own uncaught exceptions or its failed requests
 * reliably — the renderer observes those from outside — so they arrive
 * separately and are folded in here, because to a reader they are all just
 * "what is wrong with this page".
 */
function auditIssues(audit: PageAuditResult): {
  severity: 'error' | 'warning';
  message: string;
  detail?: string;
  selector?: string;
}[] {
  return [
    ...audit.findings.map((f) => ({
      severity: f.severity,
      message: f.message,
      detail: f.detail,
      selector: f.selector,
    })),
    ...audit.consoleErrors.slice(0, 5).map((text) => ({
      severity: 'error' as const,
      message: `The page threw while loading: ${text}`,
    })),
    ...audit.failedRequests
      .filter((url) => !url.includes('__agentic__/reload'))
      .slice(0, 5)
      .map((text) => ({
        severity: 'error' as const,
        message: `The page asked for something it did not get: ${text}`,
      })),
  ];
}

/**
 * Take only the fields we understand from a page message, coerced.
 *
 * The page cannot inject extra keys into anything downstream, however many it
 * puts in the message.
 */
function readTarget(p: Record<string, unknown>): ElementTarget {
  return {
    selector: String(p.selector ?? ''),
    tagName: String(p.tagName ?? 'unknown'),
    text: p.text ? String(p.text).slice(0, 200) : undefined,
    file: p.file ? String(p.file) : undefined,
    line: typeof p.line === 'number' ? p.line : undefined,
    column: typeof p.column === 'number' ? p.column : undefined,
    componentName: p.componentName ? String(p.componentName) : undefined,
    className: p.className ? String(p.className).slice(0, 200) : undefined,
    html: p.html ? String(p.html).slice(0, 800) : undefined,
  };
}

/**
 * What the start button says.
 *
 * The wording is the feature. "Start the dev server" on a folder of HTML files
 * is a promise the app cannot keep and an instruction the user cannot follow;
 * "Open index.html" says exactly what will happen, and matches what anyone who
 * has used Live Server already expects.
 *
 * Before the first start there is no preview state to read, so the count of
 * HTML files is unknown and the neutral wording is correct.
 */
function describeStart(
  htmlFileCount: number | undefined,
  command: string | undefined,
): { button: string; hint: string; empty: string } {
  if (command && !command.startsWith('serving ')) {
    return {
      button: 'Start the dev server',
      hint: `Will run: ${command}`,
      empty: 'Start your project’s dev server to see the app here.',
    };
  }
  if (htmlFileCount) {
    return {
      button: 'Open in browser',
      hint: 'Serves this folder and opens its page — like Live Server, with reload on save',
      empty: 'Open your page to see it here, reloading whenever a file changes.',
    };
  }
  return {
    button: 'Start preview',
    hint: 'Runs your dev server, or serves the folder if the project is plain HTML',
    empty: 'Start the preview to see your project here.',
  };
}
