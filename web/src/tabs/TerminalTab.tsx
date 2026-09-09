import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';

/**
 * An integrated terminal.
 *
 * xterm.js in the renderer, a real pty on the server, bytes over the shared
 * WebSocket. The terminal is created once per tab and never re-created, because
 * re-mounting loses the scrollback and the running process.
 */
export function TerminalTab({ tabId, active }: { tabId: string; active: boolean }) {
  const { activeProject, live, snapshot } = useApp();
  const run = useAction();

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const [terminalId, setTerminalId] = useState<string>();
  const [error, setError] = useState<string>();

  // ---- Create the xterm instance and the server-side pty -----------------
  useEffect(() => {
    if (!containerRef.current || !activeProject || termRef.current) return;

    const style = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: style.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      // A generous scrollback: build output is long and people scroll back
      // through it constantly.
      scrollback: 10_000,
      theme: {
        background: style.getPropertyValue('--bg-app').trim() || '#16181d',
        foreground: style.getPropertyValue('--fg').trim() || '#e4e6eb',
        cursor: style.getPropertyValue('--accent').trim() || '#6366f1',
        selectionBackground: style.getPropertyValue('--bg-selected').trim() || '#2d3648',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    void (async () => {
      const info = await run(() => api.createTerminal(activeProject.id));
      if (!info) {
        setError('Could not start a shell. See the activity log for why.');
        return;
      }
      if (disposed) {
        void api.closeTerminal(info.id);
        return;
      }
      setTerminalId(info.id);

      term.onData((data) => live?.terminalInput(info.id, data));
      term.onResize(({ cols, rows }) => live?.terminalResize(info.id, cols, rows));
      // The first input opens the server-side subscription, so send an empty
      // one to make the shell prompt appear without the user typing.
      live?.terminalInput(info.id, '');
      live?.terminalResize(info.id, term.cols, term.rows);
    })();

    return () => {
      disposed = true;
      term.dispose();
      termRef.current = undefined;
    };
  }, [activeProject, live, run]);

  // ---- Wire server output into this terminal -----------------------------
  useEffect(() => {
    if (!terminalId || !live) return;
    // The live connection multiplexes every terminal, so filter to ours.
    const handler = (id: string, data: string) => {
      if (id === terminalId) termRef.current?.write(data);
    };
    const exitHandler = (id: string, code: number | null) => {
      if (id !== terminalId) return;
      termRef.current?.writeln(`\r\n\x1b[2m[process exited with code ${code ?? 'unknown'}]\x1b[0m`);
    };

    // `LiveConnection` dispatches through the app-level handlers, so this tab
    // subscribes through a window event the provider re-broadcasts.
    const onData = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; data: string }>).detail;
      handler(detail.terminalId, detail.data);
    };
    const onExit = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; code: number | null }>).detail;
      exitHandler(detail.terminalId, detail.code);
    };

    window.addEventListener('agentic:terminal-data', onData);
    window.addEventListener('agentic:terminal-exit', onExit);
    return () => {
      window.removeEventListener('agentic:terminal-data', onData);
      window.removeEventListener('agentic:terminal-exit', onExit);
    };
  }, [terminalId, live]);

  // ---- Resize ------------------------------------------------------------
  useEffect(() => {
    if (!active) return;
    // A tab becoming visible has just gained its real size.
    const id = window.setTimeout(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // fit() throws if the element is display:none, which a hidden tab is.
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Close the pty when the tab is closed.
  useEffect(() => {
    return () => {
      if (terminalId) void api.closeTerminal(terminalId);
    };
  }, [terminalId]);

  const info = snapshot.terminals.find((t) => t.id === terminalId);

  if (!activeProject) return <div className="empty">Open a folder to use the terminal.</div>;

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div
        className="row"
        style={{
          gap: 8,
          padding: '3px var(--space-3)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <span className="mono subtle truncate grow">{info?.cwd ?? activeProject.root}</span>
        {info && !info.alive && <span className="badge badge--neutral">exited</span>}
      </div>

      {error && (
        <div className="pad" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        className="grow"
        style={{ minHeight: 0, padding: '4px 0 0 8px' }}
        data-tab={tabId}
      />
    </div>
  );
}
