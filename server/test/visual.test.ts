import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileArtifact } from '@agentic/core';
import { pagesToAudit, runVisualCheck, touchesSomethingVisual, visualFeedback } from '../src/visual/check.js';
import { getVisualRenderer } from '../src/visual/renderer.js';

/**
 * The visual check, against pages that really render.
 *
 * These are integration tests and they are slow — a real browser, two viewports
 * per page. That is the point: the thing being tested is whether a rendered
 * page is broken, and there is no way to establish that without rendering one.
 *
 * The fixtures are paired deliberately. A check that finds problems is easy; a
 * check that finds problems AND stays quiet on a page that is fine is the only
 * kind worth shipping, because the alternative is a gate people learn to
 * ignore. So every "this is caught" test has a counterpart proving the same
 * detector does not fire on the legitimate version of the same pattern.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-visual-test-'));
let rendererAvailable = false;

beforeAll(async () => {
  rendererAvailable = Boolean(await getVisualRenderer());
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a page into its own folder and audit it as an unaccepted artifact. */
async function audit(name: string, html: string) {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  // Deliberately NOT written to disk: the file is passed as a pending artifact,
  // which is how the orchestrator has it — held in memory until accepted.
  const files: FileArtifact[] = [{ path: 'index.html', content: html, language: 'html' }];
  return runVisualCheck({ projectId: 'test', root, files, budgetMs: 60_000 });
}

const errors = (result: Awaited<ReturnType<typeof audit>>) =>
  result.check.issues.filter((i) => i.severity === 'error').map((i) => i.message);

const page = (body: string, style = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fixture</title><style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:system-ui;background:#fff;color:#111}${style}</style>
</head><body>${body}</body></html>`;

describe('runVisualCheck', () => {
  it('skips, with a reason, when the task changed nothing visual', async () => {
    const root = path.join(dir, 'nonvisual');
    fs.mkdirSync(root, { recursive: true });
    const result = await runVisualCheck({
      projectId: 'test',
      root,
      files: [{ path: 'README.md', content: '# hi', language: 'markdown' }],
    });

    // Skipped is not passed. The report has to say nobody looked.
    expect(result.unavailable).toBeTruthy();
    expect(result.check.skipped).toBeTruthy();
    expect(result.check.ok).toBe(false);
  });

  it.runIf(true)('catches the grid hole that started all of this', async () => {
    if (!rendererAvailable) return;
    // The calculator, reduced: one key spans two columns, so every key after it
    // shifts and a cell in the middle is left empty. Renders fine. Is wrong.
    const result = await audit(
      'grid-hole',
      page(
        `<div class="keys">${Array.from({ length: 11 }, (_, i) => `<button>${i}</button>`).join('')}<button class="wide">=</button><button>.</button></div>`,
        '.keys{display:grid;grid-template-columns:repeat(4,64px);gap:8px}.keys>button{height:48px}.wide{grid-column:span 2}',
      ),
    );

    expect(result.ok).toBe(false);
    expect(errors(result).join(' ')).toMatch(/empty cell/i);
  }, 90_000);

  it('does not flag a grid whose last row is simply short', async () => {
    if (!rendererAvailable) return;
    // Five items in a three-column grid leaves the last row half empty. That is
    // what every partially-filled grid looks like and is completely normal.
    const result = await audit(
      'grid-fine',
      page(
        `<div class="cards">${Array.from({ length: 5 }, (_, i) => `<div>card ${i}</div>`).join('')}</div>`,
        '.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:420px}.cards>div{padding:16px;border:1px solid #ddd}',
      ),
    );

    expect(errors(result).join(' ')).not.toMatch(/empty cell/i);
  }, 90_000);

  it('catches a page that scrolls sideways, and names what is too wide', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'overflow',
      page('<div class="banner">too wide</div>', '.banner{width:1900px;height:40px;background:#eee}'),
    );

    expect(result.ok).toBe(false);
    const message = errors(result).join(' ');
    expect(message).toMatch(/scrolls sideways/i);
    // Naming the culprit is what makes the repair possible.
    expect(message).toMatch(/banner/);
  }, 90_000);

  it('catches a control with no clickable area', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'unclickable',
      page('<button class="ghost">save</button>', '.ghost{width:0;height:0;padding:0;border:0;overflow:hidden}'),
    );

    expect(errors(result).join(' ')).toMatch(/no clickable area/i);
  }, 90_000);

  it('catches text that is invisible against its own background', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'invisible',
      page('<p class="ghost">important notice</p>', '.ghost{color:#fdfdfd;background:#fff}'),
    );

    expect(errors(result).join(' ')).toMatch(/unreadable/i);
  }, 90_000);

  it('catches a page that rendered blank', async () => {
    if (!rendererAvailable) return;
    const result = await audit('blank', page('<div id="root"></div>'));
    expect(errors(result).join(' ')).toMatch(/blank/i);
  }, 90_000);

  it('catches a script that threw before the page could build itself', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'throws',
      page('<div id="root"></div><script>document.getElementById("nope").textContent = "x";</script>'),
    );

    expect(result.ok).toBe(false);
    expect(errors(result).join(' ')).toMatch(/threw while loading|blank/i);
  }, 90_000);

  it('stays completely quiet on a page that is fine', async () => {
    if (!rendererAvailable) return;
    // Everything here is a pattern the detectors look for, done correctly: a
    // visually-hidden label, a deliberate ellipsis, a spanning grid item on the
    // last row, absolutely-positioned overlap.
    const result = await audit(
      'clean',
      page(
        `<h1>A page that is fine</h1>
         <span class="sr-only">Skip to content</span>
         <p class="truncate">A deliberately truncated line that ends with an ellipsis</p>
         <div class="badge-wrap"><img alt="" width="48" height="48" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><span class="badge">3</span></div>
         <div class="grid"><button>1</button><button>2</button><button>3</button><button class="wide">wide</button></div>`,
        `.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
         .truncate{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
         .badge-wrap{position:relative;display:inline-block}
         .badge{position:absolute;top:-4px;right:-4px;background:#c00;color:#fff;border-radius:8px;padding:0 6px}
         .grid{display:grid;grid-template-columns:repeat(3,80px);gap:8px}
         .grid>button{height:40px}.wide{grid-column:span 3}`,
      ),
    );

    expect(result.check.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  }, 90_000);
});

describe('what it refuses to look at', () => {
  it('does not render a React shell as a plain file', async () => {
    // A Vite entry is an empty root and a module script pointing at an unbuilt
    // source path. Served as a file it renders nothing, and every check then
    // reports a blank page — which failed a correct MERN scaffold twice, at
    // thirteen minutes an attempt, for a defect entirely in the checking.
    const root = path.join(dir, 'react-shell');
    fs.mkdirSync(root, { recursive: true });
    const result = await runVisualCheck({
      projectId: 'test',
      root,
      files: [
        {
          path: 'index.html',
          content:
            '<!doctype html><html><head><title>App</title></head><body>' +
            '<div id="root"></div><script type="module" src="/src/main.jsx"></script>' +
            '</body></html>',
          language: 'html',
        },
      ],
    });

    expect(result.check.skipped).toMatch(/shell for a bundler/i);
    // Skipped, never failed: there is nothing wrong with the page.
    expect(result.check.issues).toEqual([]);
  });

  it('still renders a real page that happens to have a root div', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'real-root',
      page('<div id="root"><h1>Actually rendered on the server</h1><p>Real content here.</p></div>'),
    );
    expect(result.check.skipped).toBeUndefined();
  }, 90_000);
});

describe('visualFeedback', () => {
  it('gives the agent the measurement and the mechanism, not just the symptom', async () => {
    if (!rendererAvailable) return;
    const result = await audit(
      'feedback',
      page('<div class="banner">too wide</div>', '.banner{width:1900px;height:40px;background:#eee}'),
    );

    const feedback = visualFeedback(result.check);

    // The agent cannot see the page, so the brief has to carry what was seen.
    expect(feedback).toMatch(/rendered in a real browser/i);
    expect(feedback).toMatch(/banner/);
    expect(feedback).toMatch(/1900px/);
    // And what to do about it, since "it is broken" is not a repair.
    expect(feedback).toMatch(/emit the complete files/i);
    expect(feedback).toMatch(/wider than its container/i);
  }, 90_000);

  it('does not present a style opinion as a failure', () => {
    const feedback = visualFeedback({
      name: 'Visual',
      ok: false,
      durationMs: 1,
      issues: [{ file: 'index.html', source: 'build', severity: 'error', message: 'measured thing' }],
    });
    expect(feedback).toMatch(/not a style opinion/i);
  });
});

describe('touchesSomethingVisual', () => {
  const file = (p: string): FileArtifact => ({ path: p, content: '', language: 'text' });

  it('recognises what can change how a page looks', () => {
    expect(touchesSomethingVisual([file('index.html')])).toBe(true);
    expect(touchesSomethingVisual([file('src/app.css')])).toBe(true);
    expect(touchesSomethingVisual([file('src/App.tsx')])).toBe(true);
  });

  it('does not render a page for work that cannot change one', () => {
    expect(touchesSomethingVisual([file('README.md')])).toBe(false);
    expect(touchesSomethingVisual([file('migrations/001.sql'), file('.gitignore')])).toBe(false);
  });
});

describe('pagesToAudit', () => {
  it('renders the HTML the task produced', () => {
    const files: FileArtifact[] = [
      { path: 'about.html', content: '', language: 'html' },
      { path: 'style.css', content: '', language: 'css' },
    ];
    expect(pagesToAudit(files, dir)).toEqual(['about.html']);
  });

  it('falls back to the project entry when only a stylesheet changed', () => {
    // A stylesheet renders nothing on its own. The page that includes it is
    // where the change will be visible, so that is what gets rendered.
    const root = path.join(dir, 'entry');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');

    const files: FileArtifact[] = [{ path: 'style.css', content: '', language: 'css' }];
    expect(pagesToAudit(files, root)).toEqual(['index.html']);
  });
});
