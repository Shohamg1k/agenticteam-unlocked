import fs from 'node:fs';
import path from 'node:path';

/**
 * Working out how to preview a project, and where it ended up.
 *
 * Two decisions live here, both previously guessed and both previously wrong
 * in ways the user experienced as "the preview is broken":
 *
 *  1. **Static or dev server.** The old code only knew about dev servers, so a
 *     single-page HTML app — the thing this product produces fastest — had no
 *     preview at all.
 *  2. **Which URL the dev server is actually on.** The old code guessed a port
 *     from the framework (3000 for Next, 5173 for Vite) and waited sixty
 *     seconds for it. A second project already on 5173 moves Vite to 5174 and
 *     the guess never arrives, so the preview fails on a dev server that
 *     started perfectly.
 *
 * Both are now read from evidence — the files on disk, and the dev server's own
 * output — with the guess kept only as a fallback.
 */

/** Directories never worth walking when looking for a page to open. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agentic-team',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'vendor',
  '__pycache__',
  'target',
]);

const MAX_DEPTH = 3;
const MAX_HTML_FILES = 40;

/**
 * Every HTML file a user might want to open, best first.
 *
 * "Best" is deliberately simple and predictable: a root `index.html` wins,
 * then a shallower path, then an `index.html` at that depth, then alphabetical.
 * A user who wanted a different page picks it; the ranking only decides which
 * one opens without being asked.
 */
export function findHtmlFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_HTML_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_HTML_FILES) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };

  walk(root, 0);

  return found.sort((a, b) => {
    const score = (p: string): number => {
      const depth = p.split('/').length;
      const isIndex = /(^|\/)index\.html?$/i.test(p);
      if (p.toLowerCase() === 'index.html') return -100;
      return depth * 10 + (isIndex ? 0 : 5);
    };
    return score(a) - score(b) || a.localeCompare(b);
  });
}

/**
 * Is this project one a browser can open directly?
 *
 * The test is not "does it contain HTML" — a React app contains an index.html
 * that is a shell for a bundle, and serving it raw shows a blank page. It is
 * "is there HTML *and* no dev server to run", which is the case exactly when
 * the project is hand-written files.
 */
export function shouldServeStatically(opts: { hasDevServer: boolean; htmlFiles: string[] }): boolean {
  return !opts.hasDevServer && opts.htmlFiles.length > 0;
}

/**
 * The URL a dev server printed about itself.
 *
 * Every dev server worth previewing announces where it is listening, because
 * humans need to know too. Reading that line is the difference between knowing
 * and guessing:
 *
 *     VITE v6.0.1  ready in 300 ms
 *     ➜  Local:   http://localhost:5174/
 *
 *     - Local:        http://localhost:3001
 *
 *     Server running at http://127.0.0.1:8080/app/
 *
 * Preference order matters. A "Local" or "localhost" URL is the one to open;
 * a "Network" URL on the LAN address works too but is the wrong thing to show,
 * and some servers print both. So loopback wins, and the last one printed wins
 * among equals — a server that retries a port prints the winner last.
 */
export function parseDevServerUrl(output: string): string | undefined {
  const urls = [...output.matchAll(/https?:\/\/[^\s"'<>()[\]]+/gi)].map((m) => m[0]);
  if (!urls.length) return undefined;

  const cleaned = urls
    .map((u) => u.replace(/[.,;:]+$/, ''))
    .filter((u) => {
      try {
        const parsed = new URL(u);
        // A docs link in a startup banner is not where the app is.
        return Boolean(parsed.port) || isLoopback(parsed.hostname);
      } catch {
        return false;
      }
    });

  if (!cleaned.length) return undefined;

  const loopback = cleaned.filter((u) => {
    try {
      return isLoopback(new URL(u).hostname);
    } catch {
      return false;
    }
  });

  const chosen = (loopback.length ? loopback : cleaned).at(-1);
  if (!chosen) return undefined;

  // Normalise the host so it is reachable from the app's own iframe. `::1` and
  // `localhost` both resolve differently on different machines; the loopback
  // literal always works and matches what the proxy binds to.
  try {
    const parsed = new URL(chosen);
    if (isLoopback(parsed.hostname)) parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return chosen;
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** The port from a URL, defaulting by scheme. Used to point the proxy at it. */
export function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

/** The path a dev server said to open, so a non-root base URL is honoured. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}
