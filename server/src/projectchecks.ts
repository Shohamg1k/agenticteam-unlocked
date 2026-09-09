import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileArtifact, VerificationCheck, VerificationIssue } from '@agentic/core';
import { sanitizeRelPath } from '@agentic/core';
import { createWorktree } from './git.js';
import { profileProject } from './projects.js';
import { describeError, log } from './log.js';

/**
 * Tier 2 verification: run the project's own checks against the agent's output.
 *
 * The key property is isolation. The agent's files are written into a throwaway
 * git worktree, the project's real typecheck/lint/test/build run *there*, and
 * the worktree is destroyed whatever happens. The user's working tree is never
 * touched by a run that has not been accepted — which is what makes it safe to
 * let several agents work at once.
 *
 * Two rules keep this honest:
 *
 *  1. A check the project does not define is reported as SKIPPED with the
 *     reason, never as passed. "Tests passed" when there are no tests is a lie
 *     that a person will act on.
 *  2. A check that times out is reported as failed with its output, not
 *     silently dropped.
 */

/** Per-check ceiling. Installs and cold typechecks are genuinely slow. */
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
/** Total ceiling across every check, so one plan cannot stall forever. */
const TOTAL_TIMEOUT_MS = 20 * 60_000;

export interface Tier2Options {
  root: string;
  files: FileArtifact[];
  /** Label for the worktree directory. */
  label: string;
  /** Skip the dependency install step (already installed, or offline). */
  skipInstall?: boolean;
  onProgress?: (message: string) => void;
}

export interface Tier2Result {
  checks: VerificationCheck[];
  ok: boolean;
  /** Set when tier 2 could not run at all, with the reason. */
  unavailable?: string;
}

export async function runProjectChecks(opts: Tier2Options): Promise<Tier2Result> {
  const profile = profileProject(opts.root);
  const configured = Object.entries(profile.checks).filter(([, cmd]) => Boolean(cmd)) as [string, string][];

  if (!configured.length) {
    return {
      ok: true,
      checks: [
        {
          name: 'Project checks',
          ok: true,
          skipped:
            'This project defines no typecheck, lint, test or build command, so only the syntax gate ran. ' +
            'Add them in Project settings to get real verification.',
          durationMs: 0,
          issues: [],
        },
      ],
    };
  }

  let worktree;
  try {
    worktree = await createWorktree(opts.root, opts.label);
  } catch (err) {
    // No git means no isolation, and running the checks in the user's tree
    // against unaccepted files is exactly what this design refuses to do.
    return {
      ok: true,
      checks: [],
      unavailable: `Could not create an isolated worktree (${describeError(err)}), so project checks were skipped. Only the syntax gate ran.`,
    };
  }

  const checks: VerificationCheck[] = [];
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  try {
    // Write the agent's files into the worktree. Paths are re-sanitised here
    // even though the parser already did it: this is the last point before
    // bytes hit a disk, and defence in depth is cheap.
    for (const file of opts.files) {
      const safe = sanitizeRelPath(file.path);
      if (!safe) continue;
      const abs = path.join(worktree.dir, safe);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, file.content, 'utf8');
    }

    if (!opts.skipInstall && profile.ecosystem === 'node') {
      // A fresh worktree has no node_modules, so every check would fail on a
      // missing binary. Link the existing one rather than installing: it is
      // seconds instead of minutes, and the dependency set is by definition
      // the one the project already resolved.
      const linked = await linkNodeModules(opts.root, worktree.dir);
      if (!linked) {
        opts.onProgress?.('Installing dependencies in the verification worktree...');
        const install = await runCommand('npm install --no-audit --no-fund', worktree.dir, deadline);
        checks.push(toCheck('Install', 'npm install', install));
        if (!install.ok) {
          return { ok: false, checks };
        }
      }
    }

    for (const [name, command] of configured) {
      if (Date.now() > deadline) {
        checks.push({
          name: label(name),
          command,
          ok: false,
          durationMs: 0,
          issues: [
            {
              file: '',
              message: `Skipped: the ${Math.round(TOTAL_TIMEOUT_MS / 60_000)}-minute verification budget was exhausted by earlier checks.`,
              source: sourceOf(name),
              severity: 'error',
            },
          ],
        });
        continue;
      }

      opts.onProgress?.(`Running ${label(name).toLowerCase()}: ${command}`);
      const result = await runCommand(command, worktree.dir, deadline);
      checks.push(toCheck(label(name), command, result, sourceOf(name)));
    }

    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    await worktree.dispose();
  }
}

function label(key: string): string {
  return { typecheck: 'Typecheck', lint: 'Lint', test: 'Tests', build: 'Build' }[key] ?? key;
}

function sourceOf(key: string): VerificationIssue['source'] {
  return (['typecheck', 'lint', 'test', 'build'] as const).includes(key as never)
    ? (key as VerificationIssue['source'])
    : 'build';
}

interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

function toCheck(
  name: string,
  command: string,
  result: CommandResult,
  source: VerificationIssue['source'] = 'build',
): VerificationCheck {
  return {
    name,
    command,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    issues: result.ok ? [] : parseIssues(result.output, source, result.timedOut, command),
  };
}

/**
 * Pull file:line:message out of tool output.
 *
 * Handles the two shapes that cover almost everything: `path(line,col): msg`
 * (tsc) and `path:line:col: msg` (eslint, vitest, cargo, go). Anything that
 * matches neither is kept as a raw tail, because an unparsed error is still
 * far more useful to the repair prompt than "the build failed".
 */
function parseIssues(
  output: string,
  source: VerificationIssue['source'],
  timedOut: boolean,
  command: string,
): VerificationIssue[] {
  if (timedOut) {
    return [
      {
        file: '',
        message: `\`${command}\` did not finish within ${Math.round(DEFAULT_TIMEOUT_MS / 60_000)} minutes and was stopped. Last output:\n${tail(output)}`,
        source,
        severity: 'error',
      },
    ];
  }

  const issues: VerificationIssue[] = [];
  const patterns = [
    /^(?<file>[^\s(:][^(]*?)\((?<line>\d+),(?<col>\d+)\):\s*(?<msg>.+)$/,
    /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+):?\s*(?<msg>.+)$/,
  ];

  for (const raw of output.split('\n')) {
    if (issues.length >= 25) break;
    const line = raw.trim();
    if (!line) continue;
    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (!m?.groups) continue;
      issues.push({
        file: m.groups.file!.replaceAll('\\', '/'),
        line: Number(m.groups.line),
        column: Number(m.groups.col),
        message: m.groups.msg!.slice(0, 300),
        source,
        severity: /warning/i.test(m.groups.msg!) ? 'warning' : 'error',
      });
      break;
    }
  }

  if (!issues.length) {
    issues.push({
      file: '',
      message: tail(output) || 'The command failed with no output.',
      source,
      severity: 'error',
    });
  }
  return issues;
}

function tail(output: string, chars = 1_500): string {
  const trimmed = output.trim();
  return trimmed.length > chars ? `...\n${trimmed.slice(-chars)}` : trimmed;
}

/**
 * Run one check command.
 *
 * The command comes from the project's own package.json (or the user's
 * settings), so it is trusted by the same standard as `npm test` — but it is
 * still spawned with `shell: true` only because npm scripts genuinely need a
 * shell. A model never supplies this string; the sandbox module handles
 * model-supplied commands with an allow-list.
 */
function runCommand(command: string, cwd: string, deadline: number): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = Math.max(5_000, Math.min(DEFAULT_TIMEOUT_MS, deadline - started));

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let output = '';
    let settled = false;
    let timedOut = false;

    const cap = (chunk: Buffer) => {
      output += chunk.toString();
      // A watch-mode test runner can emit output forever. Cap what we keep.
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        output,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    child.on('error', (err) => {
      output += `\n${describeError(err)}`;
      finish(null);
    });
    child.on('close', finish);
  });
}

/**
 * Point the worktree at the project's existing `node_modules`.
 *
 * A junction/symlink is seconds where an install is minutes, and it verifies
 * against exactly the dependency tree the project actually has. Returns false
 * when it cannot be done, and the caller falls back to a real install.
 */
async function linkNodeModules(root: string, worktreeDir: string): Promise<boolean> {
  const source = path.join(root, 'node_modules');
  const target = path.join(worktreeDir, 'node_modules');
  try {
    await fsp.access(source);
  } catch {
    return false;
  }
  try {
    // 'junction' is the type that works on Windows without elevated rights;
    // it is ignored on other platforms.
    await fsp.symlink(source, target, 'junction');
    return true;
  } catch (err) {
    log(`Could not link node_modules into the verification worktree: ${describeError(err)}`, 'warn');
    return false;
  }
}

/** The repair brief for a tier-2 failure. */
export function projectCheckFeedback(checks: VerificationCheck[]): string {
  const failed = checks.filter((c) => !c.ok);
  const lines: string[] = [
    `The project's own checks REJECTED your output: ${failed.length} of ${checks.length} failed.`,
    '',
  ];

  for (const check of failed) {
    lines.push(`### ${check.name}${check.command ? ` (\`${check.command}\`)` : ''}`);
    for (const issue of check.issues.slice(0, 12)) {
      lines.push(
        issue.file
          ? `- ${issue.file}${issue.line ? `:${issue.line}` : ''} — ${issue.message}`
          : `- ${issue.message}`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Fix the causes and re-emit the COMPLETE corrected file(s) in the FILE: + fenced-block format.',
    'Do not disable the check, do not add an ignore comment, and do not delete the failing test to make it pass.',
  );
  return lines.join('\n');
}
