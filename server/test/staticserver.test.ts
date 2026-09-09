import { describe, expect, it } from 'vitest';
import { injectIntoHtml } from '../src/staticserver.js';
import { findHtmlFiles, parseDevServerUrl, pathOf, portOf, shouldServeStatically } from '../src/previewdetect.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('injectIntoHtml', () => {
  /**
   * The regression. `String.replace` with a replacement STRING expands `$$`,
   * `$&`, "$`" and `$'`, and the overlay contains `'__reactFiber$'`. The `$'`
   * expanded to "everything after the match", splicing the rest of the
   * document into the middle of a string literal. The script then died on a
   * syntax error and the element picker did nothing at all — with nothing in
   * any log, because the server had done its job perfectly.
   */
  it('does not let a $ in the script eat the rest of the document', () => {
    const overlay = "var k = '__reactFiber$'; var j = '$&'; var m = '$`';";
    const html = '<html><body><h1>Hi</h1></body></html>';

    const out = injectIntoHtml(html, overlay, '/* reload */');

    expect(out).toContain("'__reactFiber$'");
    expect(out).toContain("'$&'");
    expect(out).toContain("'$`'");
    // The give-away when it was broken: the closing tags appeared twice,
    // because `$'` had pasted the tail of the document back in.
    expect(out.match(/<\/body>/g)).toHaveLength(1);
  });

  it('puts the overlay before the reload client, both before </body>', () => {
    const out = injectIntoHtml('<html><body>x</body></html>', 'OVERLAY', 'RELOAD');
    expect(out.indexOf('OVERLAY')).toBeLessThan(out.indexOf('RELOAD'));
    expect(out.indexOf('RELOAD')).toBeLessThan(out.indexOf('</body>'));
  });

  it('still injects into the malformed HTML an agent sometimes produces', () => {
    // A preview that silently lacks its tools is worse than a slightly
    // malformed page, so a document with no </body> still gets them.
    expect(injectIntoHtml('<h1>no body tag</h1>', 'OVERLAY', 'RELOAD')).toContain('OVERLAY');
    expect(injectIntoHtml('<html><p>x</p></html>', 'OVERLAY', 'RELOAD')).toContain('RELOAD');
  });
});

describe('parseDevServerUrl', () => {
  it('reads the port Vite actually chose, not the one we guessed', () => {
    const output = [
      '  VITE v6.0.1  ready in 312 ms',
      '',
      '  ➜  Local:   http://localhost:5174/',
      '  ➜  Network: use --host to expose',
    ].join('\n');
    expect(parseDevServerUrl(output)).toBe('http://127.0.0.1:5174/');
  });

  it('reads a Next.js banner', () => {
    const output = ['   ▲ Next.js 15.0.3', '   - Local:        http://localhost:3001', ''].join('\n');
    expect(portOf(parseDevServerUrl(output)!)).toBe(3001);
  });

  it('keeps a base path, because the root may serve nothing', () => {
    expect(pathOf(parseDevServerUrl('Server running at http://127.0.0.1:8080/app/')!)).toBe('/app/');
  });

  it('prefers the loopback URL over the LAN one when both are printed', () => {
    const output = ['Local:   http://localhost:4321/', 'Network: http://192.168.1.20:4321/'].join('\n');
    expect(parseDevServerUrl(output)).toContain('127.0.0.1');
  });

  it('ignores a documentation link in a startup banner', () => {
    const output = 'Read the docs at https://vite.dev/guide/\nno server yet';
    expect(parseDevServerUrl(output)).toBeUndefined();
  });

  it('returns nothing when the server printed nothing useful', () => {
    expect(parseDevServerUrl('')).toBeUndefined();
    expect(parseDevServerUrl('compiling...\ndone in 1.2s')).toBeUndefined();
  });
});

describe('parseDevServerUrl, when the server announces a port rather than a URL', () => {
  it('reads the port out of prose', () => {
    // `app.listen(3000, () => console.log('Server running on port 3000'))` is
    // the first thing anyone writes and the first thing a model generates.
    // Without this the preview waited out its full timeout on a guessed port
    // while the server sat there working perfectly.
    expect(portOf(parseDevServerUrl('Server running on port 3000')!)).toBe(3000);
    expect(portOf(parseDevServerUrl('Listening on port 4001')!)).toBe(4001);
    expect(portOf(parseDevServerUrl('app listening at :8080')!)).toBe(8080);
    expect(portOf(parseDevServerUrl('Server started on port 5000')!)).toBe(5000);
  });

  it('does not mistake a duration, a count or a version for a port', () => {
    expect(parseDevServerUrl('compiled successfully in 1200 ms')).toBeUndefined();
    expect(parseDevServerUrl('Loaded 3000 records from cache')).toBeUndefined();
    expect(parseDevServerUrl('webpack 5.90.0 compiled')).toBeUndefined();
  });

  it('still prefers a real URL when there is one', () => {
    const output = ['Server running on port 3000', '  Local: http://localhost:5174/'].join('\n');
    expect(portOf(parseDevServerUrl(output)!)).toBe(5174);
  });
});

describe('findHtmlFiles', () => {
  const withTree = <T>(tree: Record<string, string>, fn: (root: string) => T): T => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-html-'));
    try {
      for (const [rel, content] of Object.entries(tree)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      return fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('puts the root index.html first, because that is the one to open', () => {
    withTree({ 'about.html': '', 'index.html': '', 'pages/contact.html': '' }, (root) => {
      expect(findHtmlFiles(root)[0]).toBe('index.html');
      expect(findHtmlFiles(root)).toContain('pages/contact.html');
    });
  });

  it('does not walk into node_modules, which would find thousands', () => {
    withTree({ 'index.html': '', 'node_modules/pkg/demo.html': '', 'dist/index.html': '' }, (root) => {
      expect(findHtmlFiles(root)).toEqual(['index.html']);
    });
  });

  it('finds nothing in a project that has no pages', () => {
    withTree({ 'main.py': 'print(1)' }, (root) => {
      expect(findHtmlFiles(root)).toEqual([]);
    });
  });
});

describe('shouldServeStatically', () => {
  it('serves a folder of HTML that has no dev server', () => {
    expect(shouldServeStatically({ hasDevServer: false, htmlFiles: ['index.html'] })).toBe(true);
  });

  it('never serves the source of a project that has a build step', () => {
    // A React app's index.html is a shell for a bundle. Serving it raw shows a
    // blank page, which reads as "the app is broken" rather than "wrong mode".
    expect(shouldServeStatically({ hasDevServer: true, htmlFiles: ['index.html'] })).toBe(false);
  });

  it('has nothing to offer a project with neither', () => {
    expect(shouldServeStatically({ hasDevServer: false, htmlFiles: [] })).toBe(false);
  });
});
