import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsInstall, packageManagerFor } from '../src/install.js';

/**
 * Whether a generated project needs installing before it can run.
 *
 * This is the check between "the app was built" and "the app starts". Without
 * it a freshly-generated Express or MERN project has a package.json, no
 * node_modules, and a dev server that dies on its first `require` — which the
 * preview reported as "the dev server exited with code 1", a message that is
 * true and useless.
 */

function withProject<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-install-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const pkg = (deps: Record<string, string> = {}, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev });

describe('needsInstall', () => {
  it('says yes for a generated project that has never been installed', () => {
    withProject({ 'package.json': pkg({ express: '^4.19.2' }), 'server.js': '' }, (root) => {
      const result = needsInstall(root);
      expect(result.needed).toBe(true);
      expect(result.reason).toMatch(/node_modules is missing/);
    });
  });

  it('says no once the dependencies are there', () => {
    withProject(
      { 'package.json': pkg({ express: '^4.19.2' }), 'node_modules/express/index.js': '' },
      (root) => expect(needsInstall(root).needed).toBe(false),
    );
  });

  it('says yes when node_modules is an empty shell', () => {
    // What a cancelled or failed install leaves behind. Treating its presence
    // as proof of an install is how a project stays permanently broken.
    withProject({ 'package.json': pkg({ express: '^4.19.2' }) }, (root) => {
      fs.mkdirSync(path.join(root, 'node_modules'));
      expect(needsInstall(root).needed).toBe(true);
    });
  });

  it('does not install a project that declares no dependencies', () => {
    withProject({ 'package.json': pkg() }, (root) => {
      expect(needsInstall(root).needed).toBe(false);
      expect(needsInstall(root).reason).toMatch(/no dependencies/);
    });
  });

  it('counts devDependencies too, because a dev server usually is one', () => {
    withProject({ 'package.json': pkg({}, { vite: '^6.0.0' }) }, (root) => {
      expect(needsInstall(root).needed).toBe(true);
    });
  });

  it('has nothing to do without a package.json', () => {
    withProject({ 'index.html': '<h1>hi</h1>' }, (root) => {
      expect(needsInstall(root).needed).toBe(false);
    });
  });

  it('does not throw on a package.json that is not valid JSON', () => {
    // An agent's half-written file must not take the preview down with it.
    withProject({ 'package.json': '{ oops' }, (root) => {
      expect(() => needsInstall(root)).not.toThrow();
      expect(needsInstall(root).needed).toBe(false);
    });
  });
});

describe('packageManagerFor', () => {
  it('follows the lockfile, not a preference', () => {
    // Running npm in a pnpm project builds a different tree than the author
    // has, and the bugs that follow are miserable to track down.
    withProject({ 'pnpm-lock.yaml': '' }, (root) => expect(packageManagerFor(root)).toBe('pnpm'));
    withProject({ 'yarn.lock': '' }, (root) => expect(packageManagerFor(root)).toBe('yarn'));
    withProject({ 'bun.lockb': '' }, (root) => expect(packageManagerFor(root)).toBe('bun'));
  });

  it('defaults to npm when there is no lockfile at all', () => {
    withProject({ 'package.json': pkg() }, (root) => expect(packageManagerFor(root)).toBe('npm'));
  });
});
