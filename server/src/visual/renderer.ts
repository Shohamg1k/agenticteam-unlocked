import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError, log } from '../log.js';

/**
 * Somewhere to render a page.
 *
 * The visual audit needs a browser, and this file's job is to get one without
 * the server depending on any particular way of having one.
 *
 * The dependency is deliberately inverted. The desktop app already ships
 * Chromium — every Electron app does — so it can render a page for free, and it
 * registers itself here at boot. The server never imports Electron, because the
 * moment it does, `npm run dev:server` needs an Electron install and the layer
 * boundary that keeps this codebase testable is gone.
 *
 * When nothing has registered, a Playwright install is tried, which covers the
 * development checkout and CI. When there is no renderer at all, the audit is
 * reported as SKIPPED with a reason — never as passed. A check that silently
 * says nothing is worse than one that is absent, because the report claims the
 * work was looked at.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AuditFinding {
  check: string;
  severity: 'error' | 'warning';
  selector: string;
  message: string;
  detail?: string;
}

export interface PageAudit {
  url: string;
  viewport: { width: number; height: number };
  title: string;
  findings: AuditFinding[];
  /** Uncaught exceptions the page threw while loading. */
  consoleErrors: string[];
  /** Sub-resources the page asked for and did not get. */
  failedRequests: string[];
}

export interface RenderOptions {
  width: number;
  height: number;
  /** How long to wait for the page to settle before auditing. */
  timeoutMs: number;
}

/**
 * Load a URL, run a script in it, and report what the page did while loading.
 *
 * `script` is an expression that evaluates to the audit result — see
 * `public/audit.js`. Implementations return whatever it evaluated to, plus the
 * console and network trouble they observed, which the page itself cannot see
 * reliably.
 */
export interface VisualRenderer {
  readonly name: string;
  render(
    url: string,
    script: string,
    opts: RenderOptions,
  ): Promise<{ result: unknown; consoleErrors: string[]; failedRequests: string[] }>;
  dispose?(): Promise<void>;
}

let registered: VisualRenderer | undefined;
let fallbackTried = false;
let fallback: VisualRenderer | undefined;

/**
 * Called by the desktop process at boot.
 *
 * Exported rather than discovered, so the flow of control is visible: there is
 * exactly one caller, in `desktop/src/main.ts`, and it is greppable.
 */
export function registerVisualRenderer(renderer: VisualRenderer): void {
  registered = renderer;
  log(`Visual checks will render with ${renderer.name}`);
}

export function clearVisualRenderer(): void {
  registered = undefined;
}

/**
 * Held in a variable so TypeScript does not resolve it statically: Playwright is
 * a devDependency, and a literal specifier would make it a compile-time
 * requirement of the packaged server.
 */
const PLAYWRIGHT_MODULE = 'playwright';

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean; args?: string[] }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newPage(opts: { viewport: { width: number; height: number } }): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  on(event: string, handler: (arg: never) => void): void;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  close(): Promise<void>;
}

/** The renderer to use, or undefined when this installation has none. */
export async function getVisualRenderer(): Promise<VisualRenderer | undefined> {
  if (registered) return registered;
  if (fallbackTried) return fallback;
  fallbackTried = true;

  try {
    const playwright = (await import(PLAYWRIGHT_MODULE)) as unknown as PlaywrightModule;
    fallback = playwrightRenderer(playwright);
    log('Visual checks will render with Playwright');
  } catch {
    // Expected in a packaged app that is not the desktop shell. Not an error.
  }
  return fallback;
}

function playwrightRenderer(playwright: PlaywrightModule): VisualRenderer {
  return {
    name: 'Playwright (Chromium)',
    async render(url, script, opts) {
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];

      // Launched per audit rather than kept warm. An audit happens once per
      // task at most, a browser process holds real memory, and a leaked one
      // outliving the app is a much worse bug than a second of startup.
      const browser = await playwright.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });

        page.on('pageerror', ((err: Error) => {
          consoleErrors.push(err?.message ? err.message : String(err));
        }) as (arg: never) => void);

        page.on('console', ((message: { type(): string; text(): string }) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        }) as (arg: never) => void);

        page.on('requestfailed', ((request: { url(): string; failure(): { errorText: string } | null }) => {
          failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
        }) as (arg: never) => void);

        page.on('response', ((response: { status(): number; url(): string }) => {
          if (response.status() >= 400) failedRequests.push(`${response.url()} — HTTP ${response.status()}`);
        }) as (arg: never) => void);

        await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs });
        // A moment for fonts, images and any script that renders on load.
        await page.waitForTimeout(400);

        const result = await page.evaluate(script);
        await page.close();
        return { result, consoleErrors, failedRequests };
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}

let cachedScript: string | undefined;

/**
 * The audit script, read from disk rather than bundled.
 *
 * Same reason as `picker.js`: it is evaluated as a string inside a page, so it
 * has to stay a real file. The candidate list covers running from source and
 * from a built `dist`, and the desktop build copies `server/public` next to its
 * own bundle.
 */
export function auditScript(): string {
  if (cachedScript) return cachedScript;

  const candidates = [
    path.join(__dirname, '..', 'public', 'audit.js'),
    path.join(__dirname, '..', '..', 'public', 'audit.js'),
    path.join(__dirname, '..', '..', '..', 'public', 'audit.js'),
    path.join(__dirname, 'public', 'audit.js'),
  ];

  for (const candidate of candidates) {
    try {
      cachedScript = fs.readFileSync(candidate, 'utf8');
      return cachedScript;
    } catch {
      // Try the next layout.
    }
  }

  log('Could not find audit.js — visual checks will be unavailable', 'warn');
  cachedScript = '';
  return cachedScript;
}

/** Run the audit against one URL. Never throws; a failure is a reported result. */
export async function auditUrl(
  url: string,
  opts: Partial<RenderOptions> = {},
): Promise<PageAudit | { unavailable: string }> {
  const renderer = await getVisualRenderer();
  if (!renderer) {
    return {
      unavailable:
        'No browser is available to render the page. The desktop app provides one; ' +
        'running the core service on its own needs Playwright installed.',
    };
  }

  const script = auditScript();
  if (!script) return { unavailable: 'The audit script could not be found in this installation.' };

  const width = opts.width ?? 1280;
  const height = opts.height ?? 900;

  try {
    const { result, consoleErrors, failedRequests } = await renderer.render(url, script, {
      width,
      height,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });

    const page = (result ?? {}) as Partial<PageAudit>;
    return {
      url: page.url ?? url,
      viewport: page.viewport ?? { width, height },
      title: page.title ?? '',
      findings: Array.isArray(page.findings) ? page.findings : [],
      consoleErrors,
      failedRequests,
    };
  } catch (err) {
    return { unavailable: `Could not render the page: ${describeError(err)}` };
  }
}
