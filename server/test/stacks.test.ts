import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileProject } from '../src/projects.js';
import { looksLikeBundlerShell } from '../src/previewdetect.js';

/**
 * "How do I run this?", across the stacks people actually ask for.
 *
 * Every entry here is a project shape that previously had no preview at all,
 * and the reason each one failed was the same: detection read the root
 * package.json and stopped. A generated Express app has no `start` script. A
 * MERN app keeps its dev script in `client/`. A Flask app has no package.json
 * at all. In each case the answer was "no dev server", which the user
 * experienced as the preview button not working.
 */

function withProject<T>(tree: Record<string, string>, fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-stack-'));
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
}

const json = (value: unknown) => JSON.stringify(value);

describe('finding a dev server', () => {
  it('uses the root dev script when there is one', () => {
    withProject({ 'package.json': json({ scripts: { dev: 'next dev' } }) }, (root) => {
      expect(profileProject(root).devServer?.command).toBe('npm run dev');
    });
  });

  it('runs a bare Express app that has no script at all', () => {
    // The shape a generated Express app usually has. Refusing to preview it
    // because the author did not add a `start` script is a technicality the
    // user would have to solve on our behalf.
    withProject(
      { 'package.json': json({ dependencies: { express: '^4.19.2' } }), 'server.js': '' },
      (root) => expect(profileProject(root).devServer?.command).toBe('node server.js'),
    );
  });

  it('finds a MERN app whose dev script lives in client/', () => {
    // Reading only the root made this look like a folder of static files —
    // which is how a React shell came to be served as a plain page and fail its
    // own verification, twice, at thirteen minutes an attempt.
    withProject(
      {
        'package.json': json({ dependencies: { concurrently: '^8.0.0' } }),
        'client/package.json': json({ scripts: { dev: 'vite' }, dependencies: { vite: '^5.0.0' } }),
        'client/index.html': '<div id="root"></div>',
        'server/package.json': json({ scripts: { start: 'node index.js' } }),
      },
      (root) => {
        const detected = profileProject(root).devServer;
        // The client, not the API: landing on the API shows a JSON endpoint and
        // reads as a broken preview. And run from the sub-project's own
        // directory, because that is where its node_modules are.
        expect(detected?.command).toBe('npm --prefix client run dev');
        expect(detected?.port).toBe(5173);
      },
    );
  });

  it('finds a MERN app that has no root package.json at all', () => {
    // A completely ordinary layout: just `client/` and `server/`, each
    // self-contained. Every other branch of detection asks about the root, so
    // this one found no ecosystem, no dev server and a `client/index.html`,
    // concluded it was a folder of static files, and served a React shell as a
    // plain page. Measured end to end, that is what "the preview doesn't work"
    // looks like on a real MERN build.
    withProject(
      {
        'README.md': '# app',
        'client/package.json': json({ scripts: { dev: 'vite' }, dependencies: { vite: '^5.0.0' } }),
        'client/index.html': '<div id="root"></div>',
        'server/package.json': json({ scripts: { dev: 'nodemon src/index.js' } }),
      },
      (root) => {
        const profile = profileProject(root);
        expect(profile.devServer?.command).toBe('npm --prefix client run dev');
        expect(profile.ecosystem).toBe('node');
      },
    );
  });

  it('prefers the root script over a sub-project one', () => {
    withProject(
      {
        'package.json': json({ scripts: { dev: 'concurrently "npm:server" "npm:client"' } }),
        'client/package.json': json({ scripts: { dev: 'vite' } }),
      },
      (root) => expect(profileProject(root).devServer?.command).toBe('npm run dev'),
    );
  });

  it('runs Flask, FastAPI and Django', () => {
    withProject(
      { 'requirements.txt': 'flask', 'app.py': 'from flask import Flask\napp = Flask(__name__)' },
      (root) => expect(profileProject(root).devServer?.command).toBe('python app.py'),
    );

    withProject(
      { 'requirements.txt': 'fastapi', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()' },
      (root) => expect(profileProject(root).devServer?.command).toContain('uvicorn main:app'),
    );

    withProject({ 'requirements.txt': 'django', 'manage.py': '' }, (root) =>
      expect(profileProject(root).devServer?.command).toBe('python manage.py runserver'),
    );
  });

  it('runs a Go program', () => {
    withProject({ 'go.mod': 'module x', 'main.go': 'package main' }, (root) =>
      expect(profileProject(root).devServer?.command).toBe('go run .'),
    );
  });

  it('leaves a folder of HTML to the file server', () => {
    // No dev server is the right answer here: this is the Live Server case.
    withProject({ 'index.html': '<h1>hi</h1>' }, (root) =>
      expect(profileProject(root).devServer).toBeUndefined(),
    );
  });
});

describe('looksLikeBundlerShell', () => {
  it('recognises a Vite or CRA entry, which renders nothing as a file', () => {
    expect(
      looksLikeBundlerShell(
        '<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
      ),
    ).toBe(true);

    expect(
      looksLikeBundlerShell(
        '<html><body><div id="app"></div><script type="module" src="./src/main.ts"></script></body></html>',
      ),
    ).toBe(true);
  });

  it('leaves a real page alone, root div and all', () => {
    // The false positive that matters: a server-rendered page can have a
    // `#root` too, and skipping it would quietly halve the visual check.
    expect(looksLikeBundlerShell('<html><body><h1>Hello</h1><p>Real content here.</p></body></html>')).toBe(
      false,
    );

    expect(
      looksLikeBundlerShell(
        '<html><body><div id="root"><h1>Server rendered</h1><p>Plenty of real content.</p></div></body></html>',
      ),
    ).toBe(false);
  });
});
