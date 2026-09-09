import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describeError, log } from './log.js';
import { ensureDir, projectPaths } from './paths.js';

/**
 * Git service.
 *
 * Everything runs through `git()` — one place that spawns the binary, so
 * timeouts, cwd handling and error shape are uniform. Arguments are always an
 * array (never a shell string), so a branch name with a semicolon in it is a
 * bad branch name and not a command injection.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function git(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        // Never let git open an editor, a pager, or a credential prompt in a
        // non-interactive run — all three hang forever instead of failing.
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new GitError(`git ${args[0]} timed out after ${timeoutMs}ms`, args, stderr, null));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'git is not installed or not on PATH. Install git and restart Agentic Team.'
          : describeError(err);
      reject(new GitError(hint, args, stderr, null));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/** Run git, throwing on a non-zero exit. Use when failure is genuinely an error. */
export async function gitOrThrow(
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const r = await git(args, cwd, opts);
  if (r.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`,
      args,
      r.stderr,
      r.exitCode,
    );
  }
  return r.stdout;
}

export async function isRepo(root: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], root, { timeoutMs: 10_000 });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Make sure the project is a git repo, initialising one if it is not.
 *
 * This is not optional politeness: checkpoints, worktree-isolated verification
 * and per-hunk rollback are all git features. A project without a repo would
 * silently lose all three, so we create one and say that we did.
 */
export async function ensureRepo(root: string): Promise<{ created: boolean }> {
  if (await isRepo(root)) return { created: false };

  await gitOrThrow(['init', '-b', 'main'], root);
  const gitignore = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, 'node_modules/\ndist/\n.env\n', 'utf8');
  }
  // An empty repo has no HEAD, and almost every git command needs one.
  await git(['add', '-A'], root);
  await commitAll(root, 'chore: initial commit (created by Agentic Team)');
  log(`Initialised a git repository in ${root} so changes can be checkpointed and rolled back`);
  return { created: true };
}

/**
 * Commit everything currently staged plus the working tree. Returns the sha, or
 * null when there was nothing to commit — which is a normal outcome, not an
 * error, and callers treat it as such.
 */
export async function commitAll(root: string, message: string): Promise<string | null> {
  await git(['add', '-A'], root);
  const status = await git(['status', '--porcelain'], root);
  if (!status.stdout.trim()) return null;

  const r = await git(
    [
      '-c',
      'user.name=Agentic Team',
      '-c',
      'user.email=agentic-team@localhost',
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      message,
    ],
    root,
  );
  if (r.exitCode !== 0) {
    throw new GitError(`Could not commit: ${r.stderr.trim()}`, ['commit'], r.stderr, r.exitCode);
  }
  return (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
}

export async function headSha(root: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], root);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(root: string): Promise<string | null> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export interface StatusEntry {
  path: string;
  /** Two-letter porcelain code, e.g. ' M', '??', 'A '. */
  code: string;
  staged: boolean;
  untracked: boolean;
}

export async function status(root: string): Promise<StatusEntry[]> {
  const r = await git(['status', '--porcelain=v1', '-z'], root);
  if (r.exitCode !== 0) return [];
  // -z is NUL-separated, which is the only way to survive filenames with
  // spaces, quotes or newlines in them.
  const parts = r.stdout.split('\0').filter(Boolean);
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const code = entry.slice(0, 2);
    let file = entry.slice(3);
    // A rename's old path is the following NUL-separated token.
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (!file) continue;
    file = file.replaceAll('\\', '/');
    out.push({
      path: file,
      code,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
    });
  }
  return out;
}

/** Unified diff of the working tree against HEAD, including untracked files. */
export async function workingDiff(root: string, paths?: string[]): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--'];
  const r = await git(paths?.length ? [...args, ...paths] : args.slice(0, -1), root);
  let out = r.exitCode === 0 ? r.stdout : '';

  // `git diff HEAD` does not show untracked files at all, which would hide
  // every newly created file from review — the most common thing an agent does.
  for (const entry of await status(root)) {
    if (!entry.untracked) continue;
    if (paths?.length && !paths.includes(entry.path)) continue;
    const added = await git(['diff', '--no-color', '--no-index', '--', devNull(), entry.path], root);
    out += added.stdout;
  }
  return out;
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/** File contents at a ref, or null when the file did not exist there. */
export async function showFile(root: string, ref: string, file: string): Promise<string | null> {
  const r = await git(['show', `${ref}:${file}`], root);
  return r.exitCode === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------------------
// Worktrees — isolation for parallel workers and tier-2 verification
// ---------------------------------------------------------------------------

export interface Worktree {
  /** Absolute path to the worktree directory. */
  dir: string;
  branch: string;
  /** Removes the worktree and its branch. Safe to call twice. */
  dispose: () => Promise<void>;
}

/**
 * Create a throwaway worktree off the project's current HEAD.
 *
 * This is how a task's output gets typechecked and tested without touching the
 * user's working tree: the files are written here, the project's own checks run
 * here, and the directory is deleted afterwards whatever the outcome.
 */
export async function createWorktree(root: string, label: string): Promise<Worktree> {
  const p = projectPaths(root);
  ensureDir(p.worktrees);

  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  const name = `agentic/${safe}-${Date.now().toString(36)}`;
  const dir = path.join(p.worktrees, `${safe}-${Date.now().toString(36)}`);

  await gitOrThrow(['worktree', 'add', '--detach', dir, 'HEAD'], root, { timeoutMs: 120_000 });
  await git(['checkout', '-b', name], dir);

  let disposed = false;
  return {
    dir,
    branch: name,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await git(['worktree', 'remove', '--force', dir], root, { timeoutMs: 60_000 });
      } catch {
        // The directory may already be gone, or locked by a virus scanner on
        // Windows. Fall through to the filesystem removal.
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort. `git worktree prune` cleans up the metadata later.
      }
      await git(['branch', '-D', name], root).catch(() => undefined);
      await git(['worktree', 'prune'], root).catch(() => undefined);
    },
  };
}

/** Delete worktree directories left behind by a crash. Run at startup. */
export async function pruneWorktrees(root: string): Promise<void> {
  try {
    await git(['worktree', 'prune'], root);
    const dir = projectPaths(root).worktrees;
    if (!fs.existsSync(dir)) return;
    const live = new Set(
      (await git(['worktree', 'list', '--porcelain'], root)).stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => path.resolve(l.slice('worktree '.length).trim())),
    );
    for (const name of fs.readdirSync(dir)) {
      const abs = path.resolve(dir, name);
      if (live.has(abs)) continue;
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch (err) {
    log(`Could not prune stale worktrees: ${describeError(err)}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * A checkpoint is a real commit on a hidden ref, not a copy of the files.
 *
 * Using `refs/agentic/checkpoints/*` rather than a branch or a tag keeps them
 * out of the user's branch list, out of `git log`, and out of a push — while
 * still being genuine objects git will not garbage-collect.
 */
export async function createCheckpoint(
  root: string,
  label: string,
): Promise<{ ref: string; sha: string } | null> {
  const sha = await commitAll(root, `checkpoint: ${label}`);
  if (!sha) return null;
  const ref = `refs/agentic/checkpoints/${Date.now().toString(36)}`;
  await gitOrThrow(['update-ref', ref, sha], root);
  return { ref, sha };
}

/**
 * Restore the working tree to a checkpoint.
 *
 * The current state is committed to its own checkpoint FIRST, so "undo the
 * rollback" is always possible. A rollback that loses work is worse than the
 * work it was rolling back.
 */
export async function restoreCheckpoint(root: string, ref: string): Promise<void> {
  await createCheckpoint(root, 'before rollback');
  const sha = (await git(['rev-parse', ref], root)).stdout.trim();
  if (!sha) throw new GitError(`Checkpoint ${ref} no longer exists`, ['rev-parse'], '', null);
  await gitOrThrow(['restore', '--source', sha, '--worktree', '--staged', '--', '.'], root, {
    timeoutMs: 120_000,
  });
  // `git restore` leaves files that did not exist at the checkpoint in place;
  // remove them so the tree genuinely matches.
  await git(['clean', '-fd', '--exclude=.agentic-team'], root);
}

/** Files that changed between two refs. */
export async function changedFiles(root: string, fromRef: string, toRef = 'HEAD'): Promise<string[]> {
  const r = await git(['diff', '--name-only', `${fromRef}..${toRef}`], root);
  return r.exitCode === 0
    ? r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
