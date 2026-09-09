/**
 * Drive the real desktop app, end to end.
 *
 * Not a unit test and not the Playwright suite: this launches the packaged
 * Electron main process, with the core service running in it, the real preload,
 * and the built renderer — and then uses the app the way a person would.
 *
 * It exists because several things only exist in that configuration and are
 * therefore invisible to every other test:
 *
 *  - The core service runs IN the Electron process, not as a separate server.
 *  - The visual check renders through Electron's own Chromium, registered at
 *    boot. Every other test exercises the Playwright fallback instead, so the
 *    path that actually ships was never run.
 *  - `window.agentic` comes from a sandboxed preload over a contextBridge.
 *
 * Run with: node desktop/scripts/smoke-desktop.mjs
 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(here, '..');

const results = [];
let failures = 0;

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail, ms: Date.now() - started });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    results.push({ ok: false, name, detail: err?.message ?? String(err), ms: Date.now() - started });
    console.log(`  FAIL  ${name} — ${err?.message ?? err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A throwaway project with a page that is deliberately fine, so the visual
// check has something to pass on, and a second page to switch to.
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-desktop-smoke-'));
const PAGE = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
  *{box-sizing:border-box} body{margin:0;padding:24px;font-family:system-ui;background:#111;color:#eee}
  .grid{display:grid;grid-template-columns:repeat(3,80px);gap:8px}
  .grid>button{height:40px;border-radius:6px;border:1px solid #444;background:#222;color:#eee}
</style></head>
<body><h1 id="headline">${title}</h1>
  <div class="grid"><button>1</button><button>2</button><button>3</button></div>
</body></html>`;

fs.writeFileSync(path.join(project, 'index.html'), PAGE('Desktop smoke test'));
fs.writeFileSync(path.join(project, 'about.html'), PAGE('About page'));

// A second project whose page is broken, to prove the visual check FAILS when
// it should. A check that only ever passes proves nothing.
const brokenProject = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-desktop-broken-'));
fs.writeFileSync(
  path.join(brokenProject, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Broken</title><style>
     body{margin:0;font-family:system-ui;background:#fff;color:#111}
     .keys{display:grid;grid-template-columns:repeat(4,64px);gap:8px}
     .keys>button{height:48px}.wide{grid-column:span 2}
   </style></head><body>
   <div class="keys">${Array.from({ length: 11 }, (_, i) => `<button>${i}</button>`).join('')}<button class="wide">=</button><button>.</button></div>
   </body></html>`,
);

console.log('\nLaunching the desktop app...\n');

const app = await electron.launch({
  args: ['dist/main.cjs'],
  cwd: desktopRoot,
  env: { ...process.env, AGENTIC_DEV: '', NODE_ENV: 'production' },
  timeout: 60_000,
});

// The main process's own output. When the app dies during launch this is the
// only place that says why, so it is captured before anything else happens.
const mainLog = [];
app.process().stdout?.on('data', (d) => mainLog.push(String(d)));
app.process().stderr?.on('data', (d) => mainLog.push(String(d)));
const dumpMainLog = () => {
  if (!mainLog.length) return;
  const lines = mainLog.join('').trim().split(/\r?\n/);
  console.log('\n--- main process output (last 30 lines) ---');
  console.log(lines.slice(-30).join('\n'));
  console.log('-------------------------------------------');
};

/** Anything the renderer threw while we were using it. */
const rendererErrors = [];

let window;
try {
  window = await app.firstWindow({ timeout: 60_000 });

  window.on('pageerror', (err) => rendererErrors.push(err?.message ?? String(err)));
  window.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // A failed fetch during teardown is noise, not a defect in the app.
    if (/Failed to load resource|ERR_CONNECTION_REFUSED/i.test(text)) return;
    rendererErrors.push(text.slice(0, 200));
  });

  await window.waitForLoadState('domcontentloaded');

  const api = async (route, body) =>
    window.evaluate(
      async ([r, b]) => {
        const res = await fetch(`http://127.0.0.1:4400/api${r}`, {
          method: b === null ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: b === null ? undefined : JSON.stringify(b),
        });
        const json = await res.json();
        return json?.data ?? json;
      },
      [route, body ?? null],
    );

  // -------------------------------------------------------------------------
  console.log('The app itself');

  await step('the window opens and renders the shell', async () => {
    // The rail, not the welcome heading: the app restores the tabs from last
    // time, so on any machine that has used it there is no welcome screen and
    // an assertion about one is an assertion about session state.
    await window.getByRole('button', { name: 'Explorer', exact: true }).waitFor({ timeout: 30_000 });
    await window.getByRole('button', { name: 'Providers', exact: true }).waitFor({ timeout: 10_000 });
    const title = await window.title();
    return `titled "${title}", rail rendered`;
  });

  await step('the preload exposes only the narrow bridge', async () => {
    const bridge = await window.evaluate(() => ({
      keys: Object.keys(window.agentic ?? {}),
      node: typeof window.require,
      process: typeof window.process,
    }));
    assert(bridge.keys.includes('pickFolder'), 'pickFolder is missing from window.agentic');
    assert(bridge.node === 'undefined', 'require() is reachable from the renderer');
    assert(bridge.process === 'undefined', 'process is reachable from the renderer');
    return bridge.keys.join(', ');
  });

  await step('the core service is running inside this process', async () => {
    const health = await api('/health', null);
    assert(health?.ok, 'the service did not report healthy');
    return `protocol v${health.protocolVersion}, vault: ${health.vault}`;
  });

  await step('the WebSocket connected and a snapshot arrived', async () => {
    await window.waitForSelector('[title="Core service: Connected"]', { timeout: 30_000 });
    return 'status bar reports Connected';
  });

  // -------------------------------------------------------------------------
  console.log('\nProviders and library');

  await step('providers are all reported with a reason', async () => {
    const snapshot = await api('/snapshot', null);
    const listed = snapshot.providers.map((p) => `${p.name}${p.available ? '' : ' (off)'}`);
    assert(snapshot.providers.length >= 8, `only ${snapshot.providers.length} providers listed`);
    assert(
      snapshot.providers.every((p) => p.available || p.detail),
      'an unavailable provider gave no reason',
    );
    return `${snapshot.providers.filter((p) => p.available).length} available of ${listed.length}`;
  });

  await step('the specialist and skill library loaded', async () => {
    const snapshot = await api('/snapshot', null);
    assert(snapshot.agents.length >= 20, `only ${snapshot.agents.length} agent profiles`);
    assert(snapshot.skills.length >= 15, `only ${snapshot.skills.length} skills`);
    return `${snapshot.agents.length} agents, ${snapshot.skills.length} skills`;
  });

  // -------------------------------------------------------------------------
  console.log('\nOpening a project');

  let projectId;
  await step('opening a folder works from the renderer', async () => {
    const opened = await api('/projects/open', { root: project });
    assert(opened?.id, 'the project did not open');
    projectId = opened.id;
    await api(`/projects/${projectId}/activate`, {});
    return opened.name;
  });

  await step('the preview capability is reported before anything starts', async () => {
    const snapshot = await api('/snapshot', null);
    const preview = snapshot.previews.find((p) => p.projectId === projectId);
    assert(preview, 'no preview capability in the snapshot');
    assert(preview.mode === 'static', `expected a static project, got ${preview.mode}`);
    assert(preview.entryFile === 'index.html', `entry was ${preview.entryFile}`);
    return `mode=${preview.mode}, entry=${preview.entryFile}, pages=${preview.htmlFiles?.length}`;
  });

  await step('the Go Live button appears and says what it will do', async () => {
    await window.reload();
    await window.waitForSelector('[title="Core service: Connected"]', { timeout: 30_000 });
    const button = window.getByRole('button', { name: /Go Live/ }).first();
    await button.waitFor({ state: 'visible', timeout: 15_000 });
    return await button.textContent();
  });

  // -------------------------------------------------------------------------
  console.log('\nThe preview');

  await step('Go Live starts the server and the page renders in the app', async () => {
    await window.getByRole('button', { name: /Go Live/ }).first().click();
    const frame = window.frameLocator('iframe[title="Application preview"]');
    await frame.locator('#headline').waitFor({ state: 'visible', timeout: 30_000 });
    const text = await frame.locator('#headline').textContent();
    assert(text === 'Desktop smoke test', `the page showed "${text}"`);
    return text;
  });

  await step('the overlay is live in the previewed page', async () => {
    const installed = await window
      .frameLocator('iframe[title="Application preview"]')
      .locator('body')
      .evaluate(() => Boolean(window.__agenticOverlayInstalled));
    assert(installed, 'the overlay did not install — the picker and annotations would be dead');
    return 'picker and annotations are attached';
  });

  await step('the live-reload client is attached', async () => {
    const attached = await window
      .frameLocator('iframe[title="Application preview"]')
      .locator('body')
      .evaluate(() => Boolean(window.__agenticReloadAttached));
    assert(attached, 'no reload client');
    return 'edits will reload the page';
  });

  await step('switching page works', async () => {
    await window.getByLabel('Page to preview').selectOption('about.html');
    const frame = window.frameLocator('iframe[title="Application preview"]');
    await frame.locator('#headline').waitFor({ state: 'visible', timeout: 20_000 });
    // Give the reload a moment to land before reading.
    for (let i = 0; i < 20; i++) {
      const text = await frame.locator('#headline').textContent();
      if (text === 'About page') return text;
      await window.waitForTimeout(250);
    }
    throw new Error('the about page never appeared');
  });

  await step('the annotate control toggles', async () => {
    const annotate = window.getByRole('button', { name: /Annotate/ });
    await annotate.click();
    await window.getByRole('button', { name: /Drawing/ }).waitFor({ state: 'visible', timeout: 10_000 });
    // Leave it off so later steps are not fighting a crosshair cursor.
    await window.getByRole('button', { name: /Drawing/ }).click();
    return 'drawing mode on and off';
  });

  // -------------------------------------------------------------------------
  console.log('\nVisual verification, through Electron’s own renderer');

  await step('the visual check runs and passes a page that is fine', async () => {
    // Back to the page we know is clean.
    await api('/preview/start', { projectId, entryFile: 'index.html' });
    const audit = await api('/preview/audit', { projectId, width: 1280, height: 900 });
    assert(!audit.unavailable, `no renderer: ${audit.unavailable}`);
    assert(Array.isArray(audit.findings), 'the audit returned no findings array');
    const errors = audit.findings.filter((f) => f.severity === 'error');
    assert(errors.length === 0, `it invented problems: ${errors.map((e) => e.message).join('; ')}`);
    // Report what the viewport actually was. A window is clamped by the screen
    // work area and by display scaling, so the desktop width is approximate —
    // which does not matter, because nothing breaks between 1266px and 1280px.
    // The narrow render is the one that has to be exact, and it is checked
    // separately below.
    assert(audit.viewport.width >= 1000, `the desktop render was only ${audit.viewport.width}px wide`);
    return `rendered "${audit.title}" at ${audit.viewport.width}x${audit.viewport.height}, nothing broken`;
  });

  await step('a narrow render really is narrow', async () => {
    // This is the one that must be exact. Layouts break between 390px and
    // 420px, so a "phone" check that quietly rendered at 500 would pass pages
    // that are broken on every phone — the exact failure it exists to catch.
    const audit = await api('/preview/audit', { projectId, width: 390, height: 844 });
    assert(!audit.unavailable, `no renderer: ${audit.unavailable}`);
    assert(
      audit.viewport.width === 390,
      `asked for a 390px viewport and got ${audit.viewport.width}px`,
    );
    return `${audit.viewport.width}x${audit.viewport.height}, exactly as asked`;
  });

  await step('the visual check catches a grid hole in a real page', async () => {
    const broken = await api('/projects/open', { root: brokenProject });
    await api(`/projects/${broken.id}/activate`, {});
    await api('/preview/start', { projectId: broken.id });
    const audit = await api('/preview/audit', { projectId: broken.id, width: 1280, height: 900 });
    assert(!audit.unavailable, `no renderer: ${audit.unavailable}`);
    const hole = audit.findings.find((f) => /empty cell/i.test(f.message));
    assert(hole, `the grid hole was missed. Findings: ${JSON.stringify(audit.findings)}`);
    await api('/preview/stop', { projectId: broken.id });
    await api(`/projects/${projectId}/activate`, {});
    return hole.detail?.slice(0, 70) ?? hole.message.slice(0, 70);
  });

  // -------------------------------------------------------------------------
  console.log('\nThe rest of the shell');

  await step('the terminal opens and actually runs a command', async () => {
    const created = await api('/terminals', { projectId, cwd: project });
    assert(created?.id, 'no terminal was created');

    // Drive it the way the renderer does, over the WebSocket, and read the
    // output back. Opening a terminal proves a tab exists; running something in
    // it proves the pty works — which is the question node-pty's noisy
    // "AttachConsole failed" helper raises on Windows.
    const output = await window.evaluate(
      // Runs in the page, not in Node: WebSocket is the browser's.
      /* global WebSocket */
      ([terminalId]) =>
        new Promise((resolve) => {
          const ws = new WebSocket('ws://127.0.0.1:4400/ws');
          let seen = '';
          const done = (value) => {
            try { ws.close(); } catch { /* already closing */ }
            resolve(value);
          };
          const timer = setTimeout(() => done(seen || '(no output within 15s)'), 15_000);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'terminal:input', terminalId, data: 'echo agentic-pty-works\r' }));
          };
          ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type !== 'terminal:data' || message.terminalId !== terminalId) return;
            seen += message.data;
            if (seen.includes('agentic-pty-works')) {
              clearTimeout(timer);
              done(seen);
            }
          };
          ws.onerror = () => { clearTimeout(timer); done('(websocket error)'); };
        }),
      [created.id],
    );

    assert(
      String(output).includes('agentic-pty-works'),
      `the shell produced nothing usable: ${String(output).slice(0, 200)}`,
    );
    return 'a command ran and its output came back';
  });

  await step('the rail switches sidebar panels', async () => {
    await window.getByRole('button', { name: 'Search', exact: true }).click();
    await window.waitForSelector('[placeholder="Search this project…"]', { timeout: 15_000 });
    await window.getByRole('button', { name: 'Providers', exact: true }).click();
    await window.waitForSelector('text=Ollama (local)', { timeout: 15_000 });
    return 'Explorer, Search and Providers all render';
  });

  await step('the human gate defaults to approval', async () => {
    const snapshot = await api('/snapshot', null);
    assert(
      snapshot.config.executionMode === 'approval',
      `execution mode was "${snapshot.config.executionMode}" on a clean boot`,
    );
    return 'nothing self-accepts without a person';
  });

  await step('no uncaught errors in the renderer', async () => {
    assert(rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));
    return 'console is clean';
  });
} finally {
  console.log('\nClosing the app...');
  dumpMainLog();
  await app.close().catch(() => undefined);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(brokenProject, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(70)}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
if (failures) {
  console.log('\nFailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
console.log('='.repeat(70));

process.exit(failures ? 1 : 0);
