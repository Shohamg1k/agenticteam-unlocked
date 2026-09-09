import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describeError, log } from './log.js';

/**
 * Install a project's dependencies before trying to run it.
 *
 * A generated project is a `package.json` and some source. It has never had
 * `npm install` run on it, so its dev server dies on the first `require` and
 * the preview reports "the dev server exited with code 1" — which is true,
 * useless, and the reason a freshly-built Express or MERN app looked broken.
 *
 * Nothing here is clever. It runs the project's own package manager, in the
 * project, once, and says what it is doing while it happens. The value is
 * entirely in it happening at all, and in the failure being legible when the
 * install is what failed rather than the app.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface InstallResult {
  ok: boolean;
  /** Why it was not needed, when it was not. */
  skipped?: string;
  /** Combined output, kept for the failure message. */
  output: string;
  durationMs: number;
}

/** How long to wait. A cold install of a React toolchain is genuinely slow. */
const INSTALL_TIMEOUT_MS = 6 * 60_000;

/**
 * Which package manager this project uses.
 *
 * The lockfile decides. Running `npm install` in a pnpm workspace produces a
 * different tree than the author has, and the bugs that follow are miserable.
 */
export function packageManagerFor(root: string): PackageManager {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Does this project need an install before it can run?
 *
 * Deliberately shallow: `node_modules` present is taken as good enough. A real
 * integrity check means reading the lockfile and comparing trees, which is what
 * the package manager itself does, far better, in the install we would then be
 * running anyway. This decides whether to bother, not whether it is perfect.
 */
export function needsInstall(root: string): { needed: boolean; reason: string } {
  const manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) {
    return { needed: false, reason: 'no package.json, so there is nothing to install' };
  }

  let pkg: { dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as typeof pkg;
  } catch (err) {
    return { needed: false, reason: `package.json could not be read (${describeError(err)})` };
  }

  const declared = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
  if (declared === 0) return { needed: false, reason: 'the project declares no dependencies' };

  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules)) {
    return { needed: true, reason: `${declared} dependencies declared and node_modules is missing` };
  }

  // A node_modules with nothing in it is what a cancelled install leaves.
  try {
    const entries = fs.readdirSync(modules).filter((name) => !name.startsWith('.'));
    if (entries.length === 0) {
      return { needed: true, reason: 'node_modules exists but is empty' };
    }
  } catch {
    return { needed: true, reason: 'node_modules could not be read' };
  }

  return { needed: false, reason: 'dependencies are already installed' };
}

/**
 * Every package in this project that has to be installed separately.
 *
 * A MERN app is almost never one package. It is a `client/` and a `server/`,
 * each with its own package.json, and installing only the root leaves both
 * halves of the application without their dependencies — which fails exactly
 * like not installing at all, while looking like it worked.
 *
 * npm workspaces are the exception, handled by not being one: a root
 * `workspaces` field means a single root install covers every member, so
 * looking for sub-packages would run the same install several times over.
 */
export function packagesIn(root: string): string[] {
  const rootManifest = path.join(root, 'package.json');
  if (!fs.existsSync(rootManifest)) return findSubPackages(root);

  try {
    const pkg = JSON.parse(fs.readFileSync(rootManifest, 'utf8')) as { workspaces?: unknown };
    if (pkg.workspaces) return [root];
  } catch {
    // A manifest we cannot read is one we cannot trust to be a workspace root.
  }

  return [root, ...findSubPackages(root)];
}

/** Conventional sub-project folders, one level down. Not a recursive walk. */
const SUBPROJECT_DIRS = ['client', 'server', 'api', 'frontend', 'backend', 'web', 'app', 'ui'];

function findSubPackages(root: string): string[] {
  const found: string[] = [];
  for (const name of SUBPROJECT_DIRS) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) found.push(dir);
  }
  return found;
}

export interface InstallOptions {
  root: string;
  /** Called with each chunk of output, for the UI. */
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Install every package in the project that needs it.
 *
 * One failure fails the whole start, because half an installed MERN app is not
 * a runnable one.
 */
export async function installDependencies(opts: InstallOptions): Promise<InstallResult> {
  const started = Date.now();
  const packages = packagesIn(opts.root).filter((dir) => needsInstall(dir).needed);

  if (!packages.length) {
    return {
      ok: true,
      skipped: needsInstall(opts.root).reason,
      output: '',
      durationMs: Date.now() - started,
    };
  }

  let output = '';
  for (const dir of packages) {
    const label = dir === opts.root ? '' : `${path.relative(opts.root, dir)}: `;
    const result = await installOne({ ...opts, root: dir, label });
    output += result.output;
    if (!result.ok) return { ok: false, output, durationMs: Date.now() - started };
  }

  return { ok: true, output, durationMs: Date.now() - started };
}

/**
 * Run one install.
 *
 * `--no-audit --no-fund` on npm because both write paragraphs to stdout that
 * have nothing to do with whether the install worked, and this output is shown
 * to a person waiting for their app to start.
 */
async function installOne(opts: InstallOptions & { label: string }): Promise<InstallResult> {
  const started = Date.now();
  const check = needsInstall(opts.root);
  if (!check.needed) {
    return { ok: true, skipped: check.reason, output: '', durationMs: Date.now() - started };
  }

  const manager = packageManagerFor(opts.root);
  const args =
    manager === 'npm'
      ? ['install', '--no-audit', '--no-fund']
      : manager === 'yarn'
        ? ['install']
        : ['install'];

  log(`Installing dependencies in ${opts.root} with ${manager} — ${check.reason}`, 'info');
  opts.onOutput?.(`${opts.label}installing with ${manager}…\n`);

  return new Promise<InstallResult>((resolve) => {
    let output = '';
    let settled = false;

    const finish = (result: Omit<InstallResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - started });
    };

    const child = spawn(manager, args, {
      cwd: opts.root,
      // The package managers are `.cmd` shims on Windows, and unlike the CLI
      // agents these take no user text as arguments, so the shell is safe here.
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ADBLOCK: '1' },
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        output: `${output}\n\nThe install was still running after ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes and was stopped.`,
      });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ ok: false, output: `${output}\n\nCancelled.` });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      // Bounded: a big install prints a lot and none of it matters once it has
      // scrolled past. The tail is what a failure needs.
      if (output.length > 40_000) output = output.slice(-40_000);
      opts.onOutput?.(text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    child.on('error', (err) => {
      finish({
        ok: false,
        output: `${output}\nCould not run ${manager}: ${describeError(err)}`,
      });
    });

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        log(`Dependencies installed in ${Math.round((Date.now() - started) / 1000)}s`, 'info');
        finish({ ok: true, output });
      } else {
        finish({ ok: false, output: `${output}\n\n${manager} install exited with code ${code}.` });
      }
    });
  });
}
