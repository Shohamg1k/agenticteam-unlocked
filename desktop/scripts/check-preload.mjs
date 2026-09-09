/**
 * Does the preload bridge actually reach the renderer?
 *
 * This exists because the failure mode is silent: if the preload throws, the
 * window still loads, the app still renders, and `window.agentic` is simply
 * undefined — so "Open a folder" does nothing at all and there is no error
 * anywhere a user would look. That happened, and it is the kind of bug a unit
 * test cannot see because it only appears inside a real Electron window.
 *
 * Run with: npm run check:preload -w @agentic/desktop
 * Exits non-zero when the bridge is missing or incomplete.
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, '..', 'dist', 'preload.cjs');

const EXPECTED = ['pickFolder', 'showItemInFolder', 'openExternal', 'platform'];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      // Deliberately identical to the real window. `sandbox: true` is the
      // setting that made the original bug possible: a sandboxed preload may
      // only require('electron'), so anything else bundled into it throws.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const preloadErrors = [];
  win.webContents.on('preload-error', (_event, file, error) => {
    preloadErrors.push(`${file}: ${error.message}`);
  });

  await win.loadURL('data:text/html,<title>preload check</title>');

  const report = await win.webContents.executeJavaScript(`
    (() => {
      const bridge = window.agentic;
      return {
        present: Boolean(bridge),
        keys: bridge ? Object.keys(bridge) : [],
        types: bridge
          ? Object.fromEntries(Object.keys(bridge).map((k) => [k, typeof bridge[k]]))
          : {},
      };
    })()
  `);

  const problems = [];
  if (preloadErrors.length) problems.push(...preloadErrors.map((e) => `preload threw — ${e}`));
  if (!report.present) problems.push('window.agentic is undefined');
  for (const key of EXPECTED) {
    if (report.present && !report.keys.includes(key)) problems.push(`window.agentic.${key} is missing`);
  }
  if (report.present && report.types.pickFolder !== 'function') {
    problems.push(`window.agentic.pickFolder is ${report.types.pickFolder}, not a function`);
  }

  if (problems.length) {
    console.error('[check-preload] FAIL');
    for (const problem of problems) console.error(`  - ${problem}`);
    app.exit(1);
    return;
  }

  console.log(`[check-preload] OK — window.agentic exposes: ${report.keys.join(', ')}`);
  app.exit(0);
});
