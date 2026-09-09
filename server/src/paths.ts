import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where things live on disk.
 *
 * Two roots, deliberately separate:
 *
 * - PROJECT state lives in `<project>/.agentic-team/`. It belongs to the
 *   project, travels with it, and is readable by a human with a text editor.
 * - NODE state (which projects exist, node config, the secret vault fallback)
 *   lives in the OS app-data directory, because it is about this machine.
 *
 * Secrets never live in either as plaintext when a keychain is available.
 */

export const PROJECT_DIR_NAME = '.agentic-team';

/** Per-machine data directory, honouring the platform convention. */
export function nodeDataDir(): string {
  const override = process.env.AGENTIC_DATA_DIR;
  if (override) return path.resolve(override);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'AgenticTeam');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'AgenticTeam');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agentic-team');
  }
}

export function projectDir(root: string): string {
  return path.join(root, PROJECT_DIR_NAME);
}

export const projectPaths = (root: string) => {
  const base = projectDir(root);
  return {
    base,
    config: path.join(base, 'config.json'),
    plans: path.join(base, 'plans'),
    memory: path.join(base, 'memory'),
    agents: path.join(base, 'agents'),
    skills: path.join(base, 'skills'),
    policies: path.join(base, 'policies'),
    checkpoints: path.join(base, 'checkpoints.json'),
    reviewQueue: path.join(base, 'review-queue.json'),
    worktrees: path.join(base, 'worktrees'),
    index: path.join(base, 'index.json'),
    gitignore: path.join(base, '.gitignore'),
  };
};

export const nodePaths = () => {
  const base = nodeDataDir();
  return {
    base,
    config: path.join(base, 'config.json'),
    projects: path.join(base, 'projects.json'),
    usage: path.join(base, 'usage.json'),
    quota: path.join(base, 'quota.json'),
    /** Only used when no OS keychain is available. Mode 0600. */
    vaultFallback: path.join(base, 'vault.json'),
    plugins: path.join(base, 'plugins'),
    logs: path.join(base, 'logs'),
  };
};

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write JSON atomically: temp file in the same directory, then rename. A crash
 * mid-write leaves the previous version intact rather than a truncated file,
 * which matters because these files ARE the state (ADR 0003).
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Read JSON, returning `fallback` when the file is missing or unreadable.
 * A corrupt file is renamed aside rather than deleted — the user may want it,
 * and silently discarding their data is never the right default.
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    try {
      const aside = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, aside);
      console.error(`[agentic] ${file} was unreadable (${err?.message}); moved to ${aside}`);
    } catch {
      console.error(`[agentic] ${file} was unreadable and could not be moved aside: ${err?.message}`);
    }
    return fallback;
  }
}

/**
 * Is `child` inside `parent`? Used everywhere a user- or model-supplied path
 * reaches the filesystem. Resolves both sides first, so symlink-free traversal
 * cannot slip past a string comparison.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a project-relative path to an absolute one, refusing anything that
 * escapes the project root. Returns null rather than throwing, because every
 * caller needs to turn this into a 400, not a 500.
 */
export function resolveInProject(root: string, relative: string): string | null {
  if (typeof relative !== 'string' || !relative.length) return null;
  if (path.isAbsolute(relative)) return null;
  const abs = path.resolve(root, relative);
  return isInside(root, abs) ? abs : null;
}

/** Forward-slashed, project-relative. The form used everywhere in the protocol. */
export function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).replaceAll('\\', '/');
}
