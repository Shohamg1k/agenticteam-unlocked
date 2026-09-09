import { contextBridge, ipcRenderer } from 'electron';

/**
 * The preload bridge.
 *
 * This is the entire privileged surface the renderer gets. Four functions, all
 * of them things a browser genuinely cannot do. Everything else — files, git,
 * models, terminals — goes over HTTP to the local core service, which can
 * validate its inputs properly.
 *
 * Nothing here forwards an arbitrary channel or exposes `ipcRenderer` itself.
 * A generic `invoke(channel, ...args)` would hand the renderer the whole main
 * process, which is the exact mistake `contextIsolation` exists to prevent.
 */
contextBridge.exposeInMainWorld('agentic', {
  /** Native folder picker. Resolves to an absolute path, or null if cancelled. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('agentic:pick-folder'),

  /** Reveal a path in Explorer/Finder. */
  showItemInFolder: (filePath: string): void => {
    if (typeof filePath === 'string') ipcRenderer.send('agentic:show-item', filePath);
  },

  /** Open a URL in the user's real browser, never inside the app. */
  openExternal: (url: string): void => {
    if (typeof url === 'string') ipcRenderer.send('agentic:open-external', url);
  },

  platform: process.platform,
  version: process.env.npm_package_version ?? '0.1.0',
});

/**
 * Menu commands are one-way, main to renderer, and are re-broadcast as a DOM
 * event so React components can listen without importing anything Electron.
 */
ipcRenderer.on('agentic:menu', (_event, command: string) => {
  window.dispatchEvent(new CustomEvent('agentic:menu', { detail: command }));
});
