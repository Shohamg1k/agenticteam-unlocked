import React, { useState } from 'react';
import type { PreviewState } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from './tabs.js';
import { openTab } from './AppShell.js';

/**
 * One click from a finished project to using it.
 *
 * The gap this closes: an agent finishes building something and the only way to
 * look at it was to know that a Preview tab existed, open it, and press start.
 * The thing you actually want to do the moment a build finishes should be the
 * most obvious control on screen, and it should say what it is going to do —
 * "Go Live" on a folder of HTML and "Run the dev server" on a Next.js app are
 * different promises, and a button that says "Preview" for both makes the user
 * find out by pressing it.
 *
 * Named after the VS Code Live Server button, deliberately. It sits in the same
 * place, says roughly the same thing, and does what someone who has used that
 * extension would expect.
 */
export function GoLiveButton({ compact = false }: { compact?: boolean }) {
  const { snapshot, activeProject } = useApp();
  const tabs = useTabs();
  const run = useAction();
  const [starting, setStarting] = useState(false);

  if (!activeProject) return null;

  const preview = snapshot.previews.find((p) => p.projectId === activeProject.id);
  // A project with neither an HTML page nor a dev server has nothing to show,
  // and a button that can only fail is worse than no button.
  if (!preview?.mode) return null;

  const running = preview.status === 'running' && Boolean(preview.url);
  const label = describe(preview, running, compact);

  const start = async () => {
    setStarting(true);
    try {
      const started = await run(() => api.startPreview(activeProject.id));
      // Open the tab either way. When it failed, the tab is where the reason is.
      openTab(tabs, 'preview');
      return started;
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      className={compact ? 'statusbar__item' : 'btn btn--primary'}
      disabled={starting}
      title={title(preview, running)}
      onClick={() => {
        if (running) {
          openTab(tabs, 'preview');
          return;
        }
        void start();
      }}
    >
      {starting ? <span className="spinner" /> : <span className={`dot ${running ? 'dot--ok' : ''}`} />}
      {starting ? 'Starting…' : label}
    </button>
  );
}

/**
 * What the button says.
 *
 * Three states and they are genuinely different actions: start a file server,
 * start the project's dev server, or look at the one already running.
 */
function describe(preview: PreviewState, running: boolean, compact: boolean): string {
  if (running) return compact ? 'Live' : 'Open the preview';
  if (preview.mode === 'static') return compact ? 'Go Live' : 'Go Live — open this page';
  return compact ? 'Run dev server' : 'Run the dev server';
}

function title(preview: PreviewState, running: boolean): string {
  if (running) return `Running at ${preview.url}. Click to open the preview tab.`;
  if (preview.mode === 'static') {
    return `Serve this folder and open ${preview.entryFile ?? 'its page'}, reloading whenever a file changes.`;
  }
  return preview.command
    ? `Run \`${preview.command}\` and show the app here once it is listening.`
    : 'Run the project’s dev server and show the app here.';
}
