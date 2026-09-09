import type fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { isInside, resolveInProject, toRelative } from './paths.js';
import { describeError, log } from './log.js';

/**
 * Filesystem access for the editor and the file explorer.
 *
 * Every path from a client passes through `resolveInProject`, which refuses
 * anything outside the project root. That check is not a nicety: the renderer
 * is a browser context, and a path parameter is attacker-controlled the moment
 * a model or a connector can influence it.
 */

export class FsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'FsError';
  }
}

/** Editing a file this large is not a thing the editor should attempt. */
export const MAX_EDITABLE_BYTES = 5_000_000;

export interface TreeEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  /** Directories only, and only when they were expanded. */
  children?: TreeEntry[];
  /** True when the entry is ignored by git but shown anyway. */
  ignored?: boolean;
}

/**
 * Directories never worth walking. Kept separate from `.gitignore` handling
 * because these are expensive to traverse and are noise in every project,
 * including ones with no git repo at all.
 */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
]);

/** Cap so a pathological directory cannot hang the explorer. */
const MAX_ENTRIES_PER_DIR = 2_000;

/**
 * Read one directory level. The explorer expands lazily rather than walking
 * the whole tree: a monorepo's full tree is tens of thousands of entries, and
 * nobody looks at more than a handful of them.
 */
export async function readDirectory(root: string, relative = ''): Promise<TreeEntry[]> {
  const abs = relative ? resolveInProject(root, relative) : root;
  if (!abs) throw new FsError(`Path escapes the project: ${relative}`, 400);

  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FsError(`No such folder: ${relative || '.'}`, 404);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsError(`Cannot read ${relative || '.'} — permission denied`, 403);
    }
    throw new FsError(`Cannot read ${relative || '.'}: ${describeError(err)}`, 500);
  }

  const entries: TreeEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES_PER_DIR)) {
    if (ALWAYS_SKIP.has(dirent.name)) continue;

    const rel = relative ? `${relative}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: rel, kind: 'directory' });
    } else if (dirent.isFile()) {
      let size: number | undefined;
      try {
        size = (await fsp.stat(path.join(abs, dirent.name))).size;
      } catch {
        // A file that vanished between readdir and stat is not an error worth
        // failing the listing over.
      }
      entries.push({ name: dirent.name, path: rel, kind: 'file', size });
    }
    // Symlinks are deliberately skipped: following one is the easiest way to
    // walk out of the project root, and the editor has no use for them.
  }

  // Folders first, then alphabetical — what every file explorer does, and what
  // people's hands expect.
  return entries.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === 'directory'
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  /** True when the file is not text; content is empty in that case. */
  binary: boolean;
  mtimeMs: number;
}

export async function readFile(root: string, relative: string): Promise<FileContent> {
  const abs = resolveInProject(root, relative);
  if (!abs) throw new FsError(`Path escapes the project: ${relative}`, 400);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsError(`No such file: ${relative}`, 404);
    throw new FsError(`Cannot read ${relative}: ${describeError(err)}`, 500);
  }
  if (stat.isDirectory()) throw new FsError(`${relative} is a folder`, 400);
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new FsError(
      `${relative} is ${(stat.size / 1_000_000).toFixed(1)}MB, over the ${MAX_EDITABLE_BYTES / 1_000_000}MB editor limit`,
      413,
      'Open it in an external editor.',
    );
  }

  const buffer = await fsp.readFile(abs);
  if (isBinary(buffer)) {
    return { path: relative, content: '', size: stat.size, binary: true, mtimeMs: stat.mtimeMs };
  }
  return {
    path: relative,
    content: buffer.toString('utf8'),
    size: stat.size,
    binary: false,
    mtimeMs: stat.mtimeMs,
  };
}

export async function writeFile(
  root: string,
  relative: string,
  content: string,
): Promise<{ mtimeMs: number }> {
  const abs = resolveInProject(root, relative);
  if (!abs) throw new FsError(`Path escapes the project: ${relative}`, 400);

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  const stat = await fsp.stat(abs);
  return { mtimeMs: stat.mtimeMs };
}

export async function deleteFile(root: string, relative: string): Promise<void> {
  const abs = resolveInProject(root, relative);
  if (!abs) throw new FsError(`Path escapes the project: ${relative}`, 400);
  // Refuse to delete the project root itself, however the path was spelled.
  if (path.resolve(abs) === path.resolve(root)) throw new FsError('Refusing to delete the project root', 400);
  await fsp.rm(abs, { recursive: true, force: true });
}

export async function createDirectory(root: string, relative: string): Promise<void> {
  const abs = resolveInProject(root, relative);
  if (!abs) throw new FsError(`Path escapes the project: ${relative}`, 400);
  await fsp.mkdir(abs, { recursive: true });
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  const absFrom = resolveInProject(root, from);
  const absTo = resolveInProject(root, to);
  if (!absFrom || !absTo) throw new FsError('Path escapes the project', 400);
  await fsp.mkdir(path.dirname(absTo), { recursive: true });
  await fsp.rename(absFrom, absTo);
}

/**
 * A NUL byte in the first 8KB. Same heuristic git uses; good enough to keep
 * the editor from rendering a PNG as mojibake.
 */
function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_000);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  /** Column of the match within `text`. */
  column: number;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Restrict to files matching this glob-ish suffix list, e.g. ['.ts', '.tsx']. */
  extensions?: string[];
  maxResults?: number;
  maxFiles?: number;
}

/**
 * Project-wide text search.
 *
 * Implemented in-process rather than by shelling out to ripgrep: ripgrep is
 * not guaranteed present, and a search that silently returns nothing because a
 * binary is missing is worse than one that is slightly slower.
 */
export async function searchProject(root: string, opts: SearchOptions): Promise<SearchHit[]> {
  const maxResults = opts.maxResults ?? 500;
  const maxFiles = opts.maxFiles ?? 5_000;

  let matcher: RegExp;
  try {
    matcher = opts.regex
      ? new RegExp(opts.query, opts.caseSensitive ? 'g' : 'gi')
      : new RegExp(escapeRegex(opts.query), opts.caseSensitive ? 'g' : 'gi');
  } catch (err) {
    throw new FsError(`Invalid search pattern: ${describeError(err)}`, 400);
  }

  const hits: SearchHit[] = [];
  let filesScanned = 0;

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= maxResults || filesScanned >= maxFiles) return;

    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (hits.length >= maxResults || filesScanned >= maxFiles) return;
      if (ALWAYS_SKIP.has(dirent.name)) continue;

      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (opts.extensions?.length && !opts.extensions.some((ext) => dirent.name.endsWith(ext))) continue;

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > 2_000_000) continue;

      filesScanned++;
      let buffer: Buffer;
      try {
        buffer = await fsp.readFile(abs);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;

      const rel = toRelative(root, abs);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        matcher.lastIndex = 0;
        const match = matcher.exec(lines[i]!);
        if (match) {
          hits.push({ path: rel, line: i + 1, column: match.index + 1, text: lines[i]!.slice(0, 400) });
        }
      }
    }
  };

  await walk(root);
  return hits;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

const watchers = new Map<string, FSWatcher>();

/**
 * Watch a project for external changes, so an open editor tab reloads when an
 * agent, a git operation, or the user's other editor writes the file.
 *
 * Events are batched: a build touching 400 files should produce one message,
 * not 400.
 */
export function watchProject(
  projectId: string,
  root: string,
  onChange: (paths: string[]) => void,
  debounceMs = 150,
): void {
  stopWatching(projectId);

  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const batch = [...pending];
    pending = new Set();
    onChange(batch);
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // `.agentic-team/` changes constantly while a plan runs; watching it would
    // make the editor think the project changed on every streamed token.
    ignored: (candidate: string) => {
      const rel = path.relative(root, candidate);
      if (!rel || rel.startsWith('..')) return false;
      return rel.split(path.sep).some((seg) => ALWAYS_SKIP.has(seg) || seg === '.agentic-team');
    },
    // Polling is off: it burns CPU on large trees. Native events miss some
    // network-drive cases, which is an acceptable trade for a local IDE.
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  const record = (file: string) => {
    if (!isInside(root, file)) return;
    pending.add(toRelative(root, file));
    if (!timer) {
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    }
  };

  watcher.on('add', record);
  watcher.on('change', record);
  watcher.on('unlink', record);
  watcher.on('error', (err) =>
    log(`File watcher error in ${root}: ${describeError(err)}`, 'warn', { projectId }),
  );

  watchers.set(projectId, watcher);
}

export function stopWatching(projectId: string): void {
  const watcher = watchers.get(projectId);
  if (!watcher) return;
  void watcher.close();
  watchers.delete(projectId);
}

export function stopAllWatchers(): void {
  for (const id of [...watchers.keys()]) stopWatching(id);
}
