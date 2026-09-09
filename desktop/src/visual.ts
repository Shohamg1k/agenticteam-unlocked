import { BrowserWindow } from 'electron';

/**
 * The visual renderer, backed by the Chromium this app already ships.
 *
 * Every Electron app carries a browser. Using it for the visual check means the
 * desktop build needs no extra dependency, no download on first run, and no
 * second browser engine to keep patched — and it renders with exactly the
 * engine the user's own preview tab uses, so a check that passes and a preview
 * that looks wrong cannot disagree.
 *
 * It lives in the desktop package and registers itself into the server, rather
 * than the server reaching for Electron. That direction matters: the server
 * runs headless too (`npm run dev:server`, the CLI, CI), and an import of
 * `electron` anywhere in it would make every one of those require an Electron
 * install.
 *
 * The window is real but never shown, and never given a preload, node
 * integration or a shared session. It is loading a page an agent wrote minutes
 * ago; it gets the same containment as any untrusted content and slightly more,
 * because nothing needs to come back out of it except one JSON value.
 */

export interface RenderResult {
  result: unknown;
  consoleErrors: string[];
  failedRequests: string[];
}

export function createElectronRenderer(): {
  readonly name: string;
  render(
    url: string,
    script: string,
    opts: { width: number; height: number; timeoutMs: number },
  ): Promise<RenderResult>;
} {
  return {
    name: 'Electron (Chromium)',

    async render(url, script, opts) {
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];

      const win = new BrowserWindow({
        show: false,
        width: opts.width,
        height: opts.height,
        webPreferences: {
          // No preload, no node, no shared session: this window exists to draw
          // one page and hand back one value.
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          // Offscreen would be lighter, but it does not paint reliably on all
          // platforms without a GPU, and a check that reports a blank page
          // because it failed to draw one would be worse than no check.
          backgroundThrottling: false,
          partition: `agentic-visual-${Date.now().toString(36)}`,
        },
      });

      const onConsole = (
        _event: unknown,
        level: number | string,
        message: string,
        _line: number,
        _source: string,
      ) => {
        // Electron reports the level as a number on older versions and a string
        // on newer ones; 3 and 'error' are the same thing.
        if (level === 3 || level === 'error') consoleErrors.push(String(message).slice(0, 500));
      };
      win.webContents.on('console-message', onConsole as never);

      win.webContents.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
        if (isMainFrame) failedRequests.push(`${failedUrl} — ${description} (${code})`);
      });

      win.webContents.session.webRequest.onCompleted((details) => {
        if (details.statusCode >= 400) {
          failedRequests.push(`${details.url} — HTTP ${details.statusCode}`);
        }
      });
      win.webContents.session.webRequest.onErrorOccurred((details) => {
        failedRequests.push(`${details.url} — ${details.error}`);
      });

      try {
        // A page that never finishes loading must not hold the whole
        // verification open, so the wait is bounded and the audit runs on
        // whatever did render — a half-loaded page is itself a finding.
        await withTimeout(win.loadURL(url), opts.timeoutMs).catch((err: unknown) => {
          failedRequests.push(`${url} — ${err instanceof Error ? err.message : String(err)}`);
        });

        // A moment for fonts, images and anything that renders on load.
        await new Promise((resolve) => setTimeout(resolve, 400));

        const result = await withTimeout(
          win.webContents.executeJavaScript(script, true),
          Math.min(opts.timeoutMs, 15_000),
        );

        return { result, consoleErrors, failedRequests };
      } finally {
        // Always. A leaked hidden window is invisible by definition, and it
        // would keep both a renderer process and a session alive.
        if (!win.isDestroyed()) win.destroy();
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
