import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describeError, log } from './log.js';

/**
 * Live Server, for projects that are just files.
 *
 * A great many things a person asks for — a calculator, a landing page, a
 * portfolio, a game — are one HTML file. Those projects have no `npm run dev`,
 * no port, and no build. Insisting on a dev server for them meant the preview
 * tab said "No dev server command was detected" for exactly the projects the
 * app is fastest at producing, which was the wrong answer to the wrong
 * question: what they need is a server, not a *dev* server.
 *
 * So this is the smallest honest one. It serves the project folder, injects the
 * same overlay the proxy injects, and reloads the page when a file changes —
 * which is what "Live Server" means to anyone who has used the VS Code
 * extension of that name.
 *
 * Deliberately not a general-purpose static server:
 *
 *  - It binds 127.0.0.1 only.
 *  - It refuses any path that escapes the project root, before touching disk.
 *  - It has no directory listing. A request for a directory serves that
 *    directory's index.html or 404s, because a listing of someone's project
 *    folder is a way to read files that are none of the browser's business.
 */

export interface StaticServer {
  port: number;
  /** Tell every open page to reload. */
  reload: () => void;
  close: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** The endpoint the injected overlay listens on for reload events. */
export const RELOAD_PATH = '/__agentic__/reload';

/**
 * The reload client, appended to every served HTML page.
 *
 * Server-sent events rather than a WebSocket: it is one-directional, it
 * reconnects on its own, and it needs no handshake code on either side. The
 * `lastEventId` handling browsers do for free means a reload that races the
 * connection is not lost.
 */
const RELOAD_CLIENT = `
(function () {
  if (window.__agenticReloadAttached) return;
  window.__agenticReloadAttached = true;
  var source = new EventSource(${JSON.stringify(RELOAD_PATH)});
  source.addEventListener('reload', function () { window.location.reload(); });
  // A dropped connection means the server went away — EventSource retries on
  // its own, so there is nothing to do but let it.
  source.onerror = function () {};
})();
`;

export async function startStaticServer(opts: {
  root: string;
  port: number;
  /** Injected into every HTML response, before the reload client. */
  overlay?: string;
  projectId: string;
  /**
   * Files to serve INSTEAD of what is on disk, keyed by project-relative path.
   *
   * This is what lets the visual check look at work that has not been accepted
   * yet. A task's output is held in memory until a human accepts it, so
   * rendering it any other way would mean writing it to the working tree first
   * — which is precisely the promise the whole review flow exists to keep.
   * With an overlay, the page is served as it WOULD be, and nothing is written.
   */
  overrides?: Map<string, string>;
}): Promise<StaticServer> {
  const root = path.resolve(opts.root);
  const clients = new Set<http.ServerResponse>();

  // Normalised once: a lookup happens on every request, and the map is keyed by
  // whatever the caller had — which is Windows separators about half the time.
  const overrides = new Map<string, string>();
  for (const [key, value] of opts.overrides ?? []) {
    overrides.set(key.split(path.sep).join('/').replace(/^\.?\//, ''), value);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === RELOAD_PATH) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
    const override =
      overrides.get(relative) ?? (relative === '' ? overrides.get('index.html') : undefined) ??
      (relative.endsWith('/') ? overrides.get(`${relative}index.html`) : undefined);

    if (override !== undefined) {
      const isHtml = /\.html?$/i.test(relative) || relative === '' || relative.endsWith('/');
      const body = isHtml ? injectIntoHtml(override, opts.overlay, RELOAD_CLIENT) : override;
      res.writeHead(200, {
        'content-type': isHtml ? 'text/html; charset=utf-8' : (MIME[path.extname(relative).toLowerCase()] ?? 'text/plain; charset=utf-8'),
        'cache-control': 'no-store, must-revalidate',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }

    const resolved = resolveWithinRoot(root, decodeURIComponent(url.pathname));
    if (!resolved) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('That path is outside the project folder.');
      return;
    }

    try {
      let target = resolved;
      const stat = await fsp.stat(target).catch(() => undefined);

      if (stat?.isDirectory()) {
        const index = path.join(target, 'index.html');
        if (!fs.existsSync(index)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No index.html in that folder.');
          return;
        }
        target = index;
      } else if (!stat) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Not found: ${url.pathname}`);
        return;
      }

      const ext = path.extname(target).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';

      // Never cache. The whole point is that an edit shows up immediately, and
      // a 304 from a stale validator is indistinguishable from "the agent's
      // change did not work".
      const headers: Record<string, string> = {
        'content-type': type,
        'cache-control': 'no-store, must-revalidate',
      };

      if (ext === '.html' || ext === '.htm') {
        const html = await fsp.readFile(target, 'utf8');
        const body = injectIntoHtml(html, opts.overlay, RELOAD_CLIENT);
        headers['content-length'] = String(Buffer.byteLength(body));
        res.writeHead(200, headers);
        res.end(body);
        return;
      }

      const data = await fsp.readFile(target);
      headers['content-length'] = String(data.length);
      res.writeHead(200, headers);
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Could not serve that file: ${describeError(err)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  log(`Serving ${root} at http://127.0.0.1:${opts.port}`, 'info', { projectId: opts.projectId });

  return {
    port: opts.port,
    reload: () => {
      for (const client of clients) {
        try {
          client.write('event: reload\ndata: 1\n\n');
        } catch {
          clients.delete(client);
        }
      }
    },
    close: () => {
      for (const client of clients) client.end();
      clients.clear();
      server.close();
    },
  };
}

/**
 * Resolve a URL path inside the root, or refuse.
 *
 * The check is on the RESOLVED path, not the requested one. Filtering for
 * `..` in the URL is the version of this that looks right and is not:
 * `%2e%2e`, a symlink, and a Windows short name all get past it, and by the
 * time the path has been normalised the comparison is trivially correct.
 */
function resolveWithinRoot(root: string, pathname: string): string | undefined {
  const candidate = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return candidate;
}

/**
 * Put the overlay and the reload client into a page.
 *
 * Before `</body>` so the page's own scripts have run and the picker sees a
 * rendered DOM. A page with no `</body>` — which agent output sometimes is —
 * still gets them, appended, because a preview that silently lacks its tools
 * is worse than a slightly malformed one.
 */
export function injectIntoHtml(html: string, overlay: string | undefined, reloadClient: string): string {
  const tags = [
    overlay ? `<script data-agentic-overlay>${overlay}</script>` : '',
    `<script data-agentic-reload>${reloadClient}</script>`,
  ].join('');

  // A REPLACER FUNCTION, not a replacement string. `String.replace` treats
  // $$, $&, $` and $' as substitutions inside a replacement string, and
  // picker.js contains `'__reactFiber$'` — so the naive version silently
  // spliced the rest of the document into the middle of a string literal,
  // producing a syntax error and an overlay that never installed. The element
  // picker had simply stopped working, with nothing in any log to say why.
  if (html.includes('</body>')) return html.replace('</body>', () => `${tags}</body>`);
  if (html.includes('</html>')) return html.replace('</html>', () => `${tags}</html>`);
  return html + tags;
}
