import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The Electron main process (ADR 0001).
 *
 * Its whole job is the three things a browser tab cannot do: own a window,
 * show a native folder picker, and start the local core service. Everything
 * else the app does happens in the renderer talking HTTP to that service.
 *
 * Security posture, which is not negotiable because the renderer displays
 * model output and proxies a page an agent may have just written:
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
 *   - the preload exposes four functions and nothing else;
 *   - any navigation away from the app's own origin is refused and handed to
 *     the user's real browser instead;
 *   - `window.open` never opens an Electron window.
 */

const DEV = process.env.AGENTIC_DEV === '1';
const DEV_URL = process.env.AGENTIC_DEV_URL ?? 'http://localhost:5273';

let mainWindow: BrowserWindow | null = null;
let stopServer: (() => Promise<void>) | undefined;

/**
 * Start the core service in this process.
 *
 * In-process rather than a child process on purpose: a child would need
 * supervision, a shutdown protocol, and a story for what happens when the app
 * is killed while it is mid-write. Sharing the process means the service dies
 * exactly when the app does.
 */
async function startCoreService(): Promise<number> {
  const { startServer } = (await import('@agentic/server')) as {
    startServer: () => Promise<{ port: number; close: () => Promise<void> }>;
  };
  const { port, close } = await startServer();
  stopServer = close;
  return port;
}

function resolveRendererIndex(): string | undefined {
  const candidates = [
    path.join(__dirname, '..', '..', 'web', 'dist', 'index.html'),
    path.join(process.resourcesPath ?? '', 'app', 'web', 'dist', 'index.html'),
    path.join(__dirname, '..', 'web', 'dist', 'index.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#16181d',
    // Frameless-with-inset on macOS looks native; other platforms keep their
    // own chrome, because a custom title bar on Windows and Linux is a long
    // tail of small papercuts for no real gain.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Paint only once there is something to see; showing an empty window first
  // reads as a crash.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (DEV) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // The built renderer is served by the core service, so relative /api and
    // /ws calls work without a special case for packaged builds.
    const index = resolveRendererIndex();
    if (index) void mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    else {
      void mainWindow.loadURL(
        `data:text/html,${encodeURIComponent(
          '<body style="font-family:system-ui;padding:40px;background:#16181d;color:#e4e6eb">' +
            '<h2>The interface was not built</h2>' +
            '<p>Run <code>npm run build</code> in the project root, then start the app again.</p></body>',
        )}`,
      );
    }
  }

  // Navigation guard: the app's own origin only.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const allowed = DEV
      ? target.origin === new URL(DEV_URL).origin
      : target.hostname === '127.0.0.1' || target.hostname === 'localhost';
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Anything the page tries to open goes to the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('agentic:menu', 'open-folder'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => void shell.openExternal('https://github.com/Shohamg1k/agenticteam-unlocked#readme'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC — the entire privileged surface
// ---------------------------------------------------------------------------

ipcMain.handle('agentic:pick-folder', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a project folder',
    // `createDirectory` matters: starting a new project from nothing is a real
    // first-run path, and forcing the user out to Explorer first is friction.
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open as project',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.on('agentic:show-item', (_event, filePath: unknown) => {
  if (typeof filePath === 'string') shell.showItemInFolder(filePath);
});

ipcMain.on('agentic:open-external', (_event, url: unknown) => {
  // Only http(s). A `file://` or `javascript:` URL from the renderer would be
  // a way to run something the user did not ask for.
  if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second instance would bind the same port and fight over the same state
// files. Focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      const port = await startCoreService();
      createWindow(port);
    } catch (err) {
      // On Windows the main process has no console, so a startup failure would
      // otherwise be a window that never appears and no way to find out why.
      // Write it somewhere a user can be pointed at, then say where.
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      let logPath = '';
      try {
        logPath = path.join(app.getPath('userData'), 'startup-error.log');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, `${new Date().toISOString()}\n${detail}\n`, 'utf8');
      } catch {
        // If even that fails, the dialog below still carries the message.
      }
      console.error('[agentic] could not start:', detail);
      dialog.showErrorBox(
        'Agentic Team could not start',
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          'If another copy is already running, close it and try again.' +
          (logPath ? `\n\nDetails were written to:\n${logPath}` : ''),
      );
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
        void startCoreService().then(createWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Give the core service a chance to flush pending writes before exit —
  // otherwise a plan mutated in the last 250ms would be lost.
  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown || !stopServer) return;
    shuttingDown = true;
    event.preventDefault();
    void stopServer().finally(() => app.exit(0));
  });
}
