import type { BrowserWindow } from 'electron';
import { dialog, ipcMain, shell } from 'electron';

/**
 * The main process's entire IPC surface.
 *
 * Its own module for two reasons. It is the privileged half of the preload
 * bridge, so having it in one readable place matters more than saving a file;
 * and it can be registered without booting the whole app, which is what lets
 * `scripts/check-open-folder.mjs` exercise the real handlers rather than a
 * reimplementation of them.
 *
 * Three channels, all of them things a browser genuinely cannot do. Everything
 * else the renderer needs goes over HTTP to the local core service, which can
 * validate its inputs properly.
 */
export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('agentic:pick-folder', async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a project folder',
      // `createDirectory` matters: starting a new project from nothing is a
      // real first-run path, and forcing the user out to Explorer first is
      // friction at exactly the wrong moment.
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open as project',
    };

    try {
      // Parented to the window when there is one, so it behaves as a sheet on
      // macOS. A missing window must not mean a silently dead button — a
      // parentless dialog still works, and the renderer cannot tell "no
      // window" apart from "cancelled" if this just returns null.
      const window = getWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    } catch (err) {
      // Thrown across the bridge on purpose: the renderer catches it and opens
      // its own path-entry dialog with this message, rather than appearing to
      // do nothing at all.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[agentic] folder picker failed:', message);
      throw new Error(`The system folder picker did not open: ${message}`);
    }
  });

  ipcMain.on('agentic:show-item', (_event, filePath: unknown) => {
    if (typeof filePath === 'string') shell.showItemInFolder(filePath);
  });

  ipcMain.on('agentic:open-external', (_event, url: unknown) => {
    // Only http(s). A `file://` or `javascript:` URL from the renderer would
    // be a way to run something the user never asked for.
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });
}
