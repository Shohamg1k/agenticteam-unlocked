/**
 * Does "Open a folder" actually work in the desktop app?
 *
 * Boots the real window with the real preload, then drives the renderer the way
 * a click would: call `window.agentic.pickFolder()` and confirm the request
 * reaches the main process and a native dialog is opened.
 *
 * The dialog is intercepted rather than shown, because a modal waiting on a
 * human is not something a check can complete — but everything up to that point
 * is exercised for real: the contextBridge, the IPC channel, the handler, and
 * the renderer's own open-folder flow including the call to the core service.
 *
 * Run with: npm run check:open-folder -w @agentic/desktop
 */
import { app, BrowserWindow, dialog } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, '..', 'dist', 'preload.cjs');

// The REAL handlers, not a copy — a check against a reimplementation of the
// thing it is checking proves nothing.
const require = createRequire(import.meta.url);
const { registerIpcHandlers } = require(path.join(here, '..', 'dist', 'ipc.cjs'));

// A real folder for the intercepted dialog to "return".
const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-open-folder-check-'));

let dialogOpened = false;
const originalShowOpenDialog = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = async (...args) => {
  dialogOpened = true;
  // Confirm the handler asked for the right kind of dialog before short-circuiting.
  const options = args.length > 1 ? args[1] : args[0];
  const properties = options?.properties ?? [];
  if (!properties.includes('openDirectory')) {
    throw new Error(`dialog opened without openDirectory (got: ${properties.join(', ')})`);
  }
  return { canceled: false, filePaths: [chosen] };
};

function fail(message) {
  console.error(`[check-open-folder] FAIL — ${message}`);
  fs.rmSync(chosen, { recursive: true, force: true });
  app.exit(1);
}

let win = null;

app.whenReady().then(async () => {
  // Exactly what main.ts does on ready, with the same window accessor.
  registerIpcHandlers(() => win);

  win = new BrowserWindow({
    show: false,
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  const preloadErrors = [];
  win.webContents.on('preload-error', (_e, file, error) => preloadErrors.push(`${file}: ${error.message}`));

  // A blank page is enough: this checks the bridge and the main-process
  // handler, not the React tree, which the Playwright suite already covers.
  await win.loadURL('data:text/html,<title>open folder check</title>');

  if (preloadErrors.length) return fail(`the preload threw — ${preloadErrors.join('; ')}`);

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      if (!window.agentic || typeof window.agentic.pickFolder !== 'function') {
        return { ok: false, why: 'window.agentic.pickFolder is not available' };
      }
      try {
        const folder = await window.agentic.pickFolder();
        return { ok: true, folder };
      } catch (err) {
        return { ok: false, why: 'pickFolder rejected: ' + (err && err.message ? err.message : String(err)) };
      }
    })()
  `);

  if (!result.ok) return fail(result.why);
  if (!dialogOpened) return fail('pickFolder resolved without the main process opening a dialog');
  if (result.folder !== chosen) {
    return fail(`the renderer received ${JSON.stringify(result.folder)}, expected ${JSON.stringify(chosen)}`);
  }

  console.log('[check-open-folder] OK — the picker opened and the chosen path reached the renderer');
  dialog.showOpenDialog = originalShowOpenDialog;
  fs.rmSync(chosen, { recursive: true, force: true });
  app.exit(0);
});

// Never hang a CI job on a wedged dialog.
setTimeout(() => fail('timed out after 30s'), 30_000).unref?.();
