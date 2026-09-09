import { spawn } from 'node:child_process';
import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ExecuteRequest,
  ModelDescriptor,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens, looksLikeQuotaError } from '@agentic/core';
import { BaseAdapter, errorMessage, guardStream, isAbortError } from './base.js';
import { ARTIFACT_FORMAT_INSTRUCTIONS } from '@agentic/core';

/**
 * CLI coding agents as provider adapters.
 *
 * A subscription the user already pays for is the cheapest capable capacity
 * available, so Claude Code, Codex and friends belong on the same ladder as an
 * API key rather than in a separate feature. That only works if they implement
 * the same interface, which is ADR 0002.
 *
 * Everything that differs between these agents is a field in `CliAgentConfig`:
 * the binary, its arguments, and how the prompt is delivered. Adding Cursor or
 * Copilot is an entry in `CLI_AGENTS`, not a new file.
 *
 * Two honest limitations, surfaced in the UI rather than hidden:
 *
 *  - **Token usage is estimated.** These CLIs do not report token counts, so
 *    `measured` is false and the cost dashboard says so. Cost is zero because
 *    a subscription is not billed per token, which is also why the router
 *    prefers them.
 *  - **Remaining subscription allowance cannot be read.** No CLI exposes it.
 *    The ledger is reactive: it learns the cap exists when a call is refused,
 *    then cools that rung down. See docs/OPEN-QUESTIONS.md Q2.
 */

export interface CliAgentConfig {
  id: string;
  name: string;
  /** Executable to look for on PATH. */
  bin: string;
  /** Arguments for a one-shot, non-interactive completion. */
  args: string[];
  /** How the prompt reaches the process. */
  promptVia: 'stdin' | 'argv';
  /** Appended only when permissions are set to `yolo`. */
  skipPermissionsFlag?: string;
  /** Args that make the binary print its version, for the probe. */
  versionArgs: string[];
  /** What this agent is good at, for routing. */
  capabilities: ModelDescriptor['capabilities'];
  /** Advertised context window of the model behind the CLI. */
  contextWindow: number;
  /** Rough tokens/sec, for latency ranking. CLIs are slow to start. */
  throughputTps: number;
  /** Ceiling for one run. CLI agents can loop for a long time legitimately. */
  timeoutMs: number;
  /** Where to get it, shown when it is not installed. */
  installHint: string;
}

export const CLI_AGENTS: CliAgentConfig[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    args: ['--print'],
    promptVia: 'stdin',
    skipPermissionsFlag: '--dangerously-skip-permissions',
    versionArgs: ['--version'],
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
    contextWindow: 1_000_000,
    throughputTps: 40,
    timeoutMs: 20 * 60_000,
    installHint: 'Install with: npm i -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    bin: 'codex',
    args: ['exec'],
    promptVia: 'argv',
    skipPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
    versionArgs: ['--version'],
    capabilities: ['code', 'strong-reasoning', 'tool-use'],
    contextWindow: 400_000,
    throughputTps: 35,
    timeoutMs: 20 * 60_000,
    installHint: 'Install with: npm i -g @openai/codex, then run `codex` once to sign in',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    bin: 'antigravity',
    args: [],
    promptVia: 'stdin',
    versionArgs: ['--version'],
    capabilities: ['code', 'long-context', 'frontend'],
    contextWindow: 1_000_000,
    throughputTps: 40,
    timeoutMs: 20 * 60_000,
    installHint: 'Install Google Antigravity and make sure `antigravity` is on your PATH',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    bin: 'gemini',
    args: ['--prompt'],
    promptVia: 'argv',
    skipPermissionsFlag: '--yolo',
    versionArgs: ['--version'],
    capabilities: ['code', 'long-context', 'cheap-ok'],
    contextWindow: 1_000_000,
    throughputTps: 50,
    timeoutMs: 15 * 60_000,
    installHint: 'Install with: npm i -g @google/gemini-cli, then run `gemini` once to sign in',
  },
];

export type AgentPermissions = 'yolo' | 'manual';

export class CliAgentAdapter extends BaseAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind = 'subscription' as const;
  readonly transport = 'cli' as const;

  private readonly config: CliAgentConfig;
  private permissions: AgentPermissions = 'yolo';
  private installedVersion?: string;

  constructor(config: CliAgentConfig) {
    super();
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.defaultModel = config.id;
    this.models = [
      {
        id: config.id,
        label: config.name,
        capabilities: config.capabilities,
        contextWindow: config.contextWindow,
        maxOutputTokens: 64_000,
        // A subscription is not billed per token. Zero is correct, and it is
        // what makes the router spend a seat before spending money.
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        throughputTps: config.throughputTps,
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
      },
    ];
  }

  setPermissions(mode: AgentPermissions): void {
    this.permissions = mode;
  }

  async probe(): Promise<ProviderProbeResult> {
    try {
      const { stdout, code } = await runOnce(this.config.bin, this.config.versionArgs, { timeoutMs: 8_000 });
      if (code === null) {
        // `runOnce` reports a timeout as a null exit code. On Windows this is
        // usually the shell resolving a name that does not exist and hanging.
        return {
          available: false,
          detail: `\`${this.config.bin} --version\` did not respond within 8s. ${this.config.installHint}`,
        };
      }
      if (code !== 0) {
        return {
          available: false,
          detail: `\`${this.config.bin}\` exited with code ${code}. ${this.config.installHint}`,
        };
      }
      this.installedVersion = stdout.trim().split('\n')[0]?.slice(0, 60);
      return { available: true, detail: this.installedVersion ?? 'installed' };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      return {
        available: false,
        detail: missing
          ? `Not installed. ${this.config.installHint}`
          : `Could not run it: ${errorMessage(err)}`,
      };
    }
  }

  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    return guardStream(this, request.runId, () => this.run(request, signal));
  }

  /**
   * CLI agents have their own agentic loop and their own filesystem access, so
   * `execute` runs them in the task's working directory and lets them edit
   * files directly. The prompt still asks for FILE: blocks, because a task
   * whose agent wrote files AND described them is reviewable either way, and
   * some of these CLIs only describe.
   */
  execute(request: ExecuteRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    return this.stream(
      {
        runId: request.runId,
        model: request.model,
        system: request.system,
        messages: [{ role: 'user', content: `${request.context}\n\n${ARTIFACT_FORMAT_INSTRUCTIONS}` }],
        cwd: request.cwd,
      },
      signal,
    );
  }

  private async *run(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    yield { type: 'start', runId: request.runId, providerId: this.id, model: this.id, at: Date.now() };
    this.countRequest();

    const prompt = [request.system, ...request.messages.map((m) => m.content)].join('\n\n');
    const args = [...this.config.args];
    if (this.permissions === 'yolo' && this.config.skipPermissionsFlag) {
      args.push(this.config.skipPermissionsFlag);
    }
    if (this.config.promptVia === 'argv') args.push(prompt);

    if (this.permissions === 'manual') {
      yield {
        type: 'log',
        runId: request.runId,
        level: 'warn',
        text:
          `${this.name} is running with permission prompts enabled. A non-interactive run that hits one ` +
          `will wait until the ${Math.round(this.config.timeoutMs / 60_000)}-minute timeout.`,
      };
    }

    const child = spawn(this.config.bin, args, {
      cwd: request.cwd ?? process.cwd(),
      windowsHide: true,
      // Windows resolves .cmd/.ps1 shims for npm-installed binaries only
      // through the shell; without this every npm-global CLI is "not found".
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, this.config.timeoutMs);
    timer.unref?.();

    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    // Stream stdout to the UI as it arrives; a 20-minute agent run with no
    // visible output is indistinguishable from a hang.
    const queue: AgentRunEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: AgentRunEvent) => {
      queue.push(event);
      notify?.();
    };

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      push({ type: 'delta', runId: request.runId, text });
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      push({ type: 'log', runId: request.runId, level: 'warn', text: text.trimEnd() });
    });

    const finished = new Promise<number | null>((resolve, reject) => {
      child.on('error', (err) => {
        settled = true;
        reject(err);
      });
      child.on('close', (code) => {
        settled = true;
        resolve(code);
        notify?.();
      });
    });

    if (this.config.promptVia === 'stdin') {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }

    // Drain the queue while the process runs.
    let exitCode: number | null = null;
    let failure: unknown;
    const done = finished.then(
      (code) => {
        exitCode = code;
      },
      (err) => {
        failure = err;
      },
    );

    while (!settled || queue.length) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      await Promise.race([done, new Promise<void>((r) => (notify = r))]);
      notify = undefined;
    }
    await done;

    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);

    if (failure) {
      yield { type: 'error', runId: request.runId, error: this.classifyError(failure), at: Date.now() };
      return;
    }
    if (signal.aborted) {
      yield {
        type: 'error',
        runId: request.runId,
        error: { kind: 'cancelled', message: 'Cancelled' },
        at: Date.now(),
      };
      return;
    }
    if (timedOut) {
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: 'transient',
          message:
            `${this.name} did not finish within ${Math.round(this.config.timeoutMs / 60_000)} minutes and was ` +
            `stopped.${this.permissions === 'manual' ? ' It may have been waiting on a permission prompt.' : ''}`,
        },
        at: Date.now(),
      };
      return;
    }
    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim().slice(-600);
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: looksLikeQuotaError(detail) ? 'quota' : 'unknown',
          message: `${this.name} exited with code ${exitCode}: ${detail || 'no output'}`,
        },
        at: Date.now(),
      };
      return;
    }

    // A zero exit with a quota complaint on stderr happens: some CLIs report a
    // usage limit as a normal message. Classify on content, not just on code.
    if (looksLikeQuotaError(stderr) && !stdout.trim()) {
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: 'quota',
          message: `${this.name} reported a usage limit: ${stderr.trim().slice(-300)}`,
        },
        at: Date.now(),
      };
      return;
    }

    const usage = this.usageOf(this.id, estimateTokens(prompt), estimateTokens(stdout), undefined, false);
    yield { type: 'usage', runId: request.runId, usage };
    yield { type: 'done', runId: request.runId, text: stdout, usage, at: Date.now() };
  }

  override classifyError(err: unknown): AgentRunError {
    if (isAbortError(err)) return { kind: 'cancelled', message: 'Cancelled' };
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        kind: 'unavailable',
        message: `${this.config.bin} is not installed or not on PATH. ${this.config.installHint}`,
        code: 'ENOENT',
      };
    }
    return super.classifyError(err);
  }
}

/** Run a command once and collect its output. Used by probes only. */
function runOnce(
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, stderr, code: null });
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
