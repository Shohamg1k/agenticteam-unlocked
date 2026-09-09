import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import type { TerminalInfo } from '@agentic/core';
import { rid } from '@agentic/core';
import { describeError, log } from './log.js';

/**
 * Integrated terminals.
 *
 * `node-pty` gives a real pseudo-terminal — colours, cursor addressing, an
 * interactive REPL, Ctrl-C reaching the process. It is a native module, so it
 * can fail to load after an Electron version bump or on an unusual platform.
 *
 * When it does, the terminal falls back to a piped `child_process` shell rather
 * than disappearing. The fallback is honestly worse (no TTY, so no colour and
 * no interactive prompts) and the UI says so, because a terminal that silently
 * behaves differently is a worse outcome than one that tells you why.
 */

import type * as NodePty from 'node-pty';

type PtyModule = typeof NodePty;

let ptyModule: PtyModule | null = null;
let ptyChecked = false;
let ptyError: string | undefined;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyChecked) return ptyModule;
  ptyChecked = true;
  try {
    ptyModule = await import('node-pty');
  } catch (err) {
    ptyModule = null;
    ptyError = describeError(err);
    log(
      `node-pty could not be loaded (${ptyError}). Terminals will run without a TTY: ` +
        'no colour, and interactive prompts will not work.',
      'warn',
    );
  }
  return ptyModule;
}

export function ptyAvailable(): boolean {
  return ptyModule !== null;
}

export function ptyUnavailableReason(): string | undefined {
  return ptyModule === null ? ptyError : undefined;
}

interface Terminal {
  info: TerminalInfo;
  /** Ring buffer of recent output, so a reconnecting client sees scrollback. */
  buffer: string[];
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: Set<(data: string) => void>;
  onExit: Set<(code: number | null) => void>;
}

const terminals = new Map<string, Terminal>();

/** Bounded scrollback. Roughly a few hundred KB per terminal. */
const MAX_BUFFER_CHUNKS = 800;

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // PowerShell is the better default on Windows, but it is not guaranteed to
    // be on PATH in every image; cmd always is.
    return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

export interface CreateTerminalOptions {
  cwd: string;
  projectId?: string;
  title?: string;
  cols?: number;
  rows?: number;
  /** Command to run instead of an interactive shell. */
  command?: string;
}

export async function createTerminal(opts: CreateTerminalOptions): Promise<TerminalInfo> {
  const id = rid('term');
  const pty = await loadPty();
  const shell = defaultShell();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const info: TerminalInfo = {
    id,
    projectId: opts.projectId,
    title: opts.title ?? (opts.command ? opts.command.slice(0, 40) : 'Terminal'),
    cwd: opts.cwd,
    alive: true,
    createdAt: Date.now(),
  };

  const onData = new Set<(data: string) => void>();
  const onExit = new Set<(code: number | null) => void>();
  const buffer: string[] = [];

  const record = (data: string) => {
    buffer.push(data);
    if (buffer.length > MAX_BUFFER_CHUNKS) buffer.splice(0, buffer.length - MAX_BUFFER_CHUNKS);
    for (const fn of onData) {
      try {
        fn(data);
      } catch {
        // A dead listener must not kill the terminal feeding it.
      }
    }
  };

  const finish = (code: number | null) => {
    info.alive = false;
    for (const fn of onExit) {
      try {
        fn(code);
      } catch {
        // Same.
      }
    }
  };

  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

  if (pty) {
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: env as Record<string, string>,
    });

    proc.onData(record);
    proc.onExit(({ exitCode }) => finish(exitCode));

    terminals.set(id, {
      info,
      buffer,
      onData,
      onExit,
      write: (data) => proc.write(data),
      resize: (c, r) => {
        try {
          proc.resize(Math.max(1, c), Math.max(1, r));
        } catch {
          // A resize on a dying pty throws on some platforms; harmless.
        }
      },
      kill: () => {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
      },
    });

    if (opts.command) proc.write(`${opts.command}${os.EOL}`);
  } else {
    // Fallback: a piped shell. No TTY, so no colour and no interactive prompts.
    const child: ChildProcessWithoutNullStreams = spawn(shell.file, shell.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.on('data', (d: Buffer) => record(d.toString()));
    child.stderr.on('data', (d: Buffer) => record(d.toString()));
    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      record(`\r\n[agentic] Could not start a shell: ${describeError(err)}\r\n`);
      finish(null);
    });

    record(
      `\r\n[agentic] Running without a TTY (${ptyError ?? 'node-pty unavailable'}).\r\n` +
        `Colours and interactive prompts will not work. Non-interactive commands are fine.\r\n\r\n`,
    );

    terminals.set(id, {
      info,
      buffer,
      onData,
      onExit,
      write: (data) => child.stdin.write(data),
      // A piped shell has no window size to set; accepting the call and doing
      // nothing keeps the client code identical across both paths.
      resize: () => undefined,
      kill: () => child.kill(),
    });

    if (opts.command) child.stdin.write(`${opts.command}${os.EOL}`);
  }

  log(`Opened terminal in ${opts.cwd}`, 'info', { projectId: opts.projectId });
  return info;
}

export function listTerminals(): TerminalInfo[] {
  return [...terminals.values()].map((t) => t.info);
}

export function writeTerminal(id: string, data: string): boolean {
  const term = terminals.get(id);
  if (!term?.info.alive) return false;
  term.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const term = terminals.get(id);
  if (!term?.info.alive) return false;
  term.resize(cols, rows);
  return true;
}

/**
 * Subscribe to a terminal's output. The existing scrollback is replayed first,
 * so a client that reconnects after a page reload sees the session it left.
 */
export function subscribeTerminal(
  id: string,
  onData: (data: string) => void,
  onExit?: (code: number | null) => void,
): (() => void) | undefined {
  const term = terminals.get(id);
  if (!term) return undefined;

  if (term.buffer.length) onData(term.buffer.join(''));
  term.onData.add(onData);
  if (onExit) term.onExit.add(onExit);

  return () => {
    term.onData.delete(onData);
    if (onExit) term.onExit.delete(onExit);
  };
}

export function closeTerminal(id: string): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  term.kill();
  terminals.delete(id);
  return true;
}

export function closeAllTerminals(): void {
  for (const id of [...terminals.keys()]) closeTerminal(id);
}
