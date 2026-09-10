import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ExecuteRequest,
  ExecutionProfile,
  ModelDescriptor,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens, looksLikeQuotaError } from '@agentic/core';
import { BaseAdapter, errorMessage, guardStream, isAbortError } from './base.js';
import { ARTIFACT_FORMAT_INSTRUCTIONS, NO_TOOLS_INSTRUCTIONS } from '@agentic/core';

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
  /**
   * Known install locations, tried before PATH.
   *
   * Antigravity's installer puts `agy.exe` in %LOCALAPPDATA%/agy/bin and adds
   * nothing to PATH until `agy install` is run — and an app launched before
   * that never sees the change anyway. Installed and signed in should not read
   * as missing because of where an installer chose to put a file.
   */
  binCandidates?: string[];
  /** Arguments for a one-shot, non-interactive completion. */
  args: string[];
  /** How the prompt reaches the process. */
  promptVia: 'stdin' | 'argv' | 'print-flag';
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
  /**
   * Places the product lives when it is installed but has no CLI.
   *
   * "Not installed" and "installed, but there is nothing here to drive" are
   * completely different problems with completely different fixes, and telling
   * someone to install what they already have is the least useful message a
   * provider panel can show. Where we can tell the two apart, we should.
   */
  guiInstallPaths?: string[];
  /**
   * The models this CLI can actually be told to use.
   *
   * Every CLI provider used to advertise exactly one synthetic model named
   * after itself, which made "Claude Code" a single opaque choice. It is not
   * one choice: Haiku, Sonnet and Opus differ by more than an order of
   * magnitude in both cost and capability, and a user who wants Opus for the
   * hard task and Haiku for the boilerplate was being told the provider had
   * nothing to choose between.
   *
   * `alias` is what goes after the tuning `model` flag, and it is the field
   * that must match the binary exactly — an unrecognised value makes these
   * CLIs exit non-zero, so every alias here has been run against a real
   * install rather than guessed.
   */
  models?: CliModel[];
  /**
   * How to tell "installed" from "signed in", when they differ.
   *
   * `--version` answers a question nobody was asking. Gemini CLI 0.59 prints
   * its version happily with no credentials at all, and then every task fails
   * with "Please set an Auth method" — several minutes into a run, having
   * looked available the whole time. A provider that reports itself ready and
   * then refuses every request is worse than one that says it is not ready.
   *
   * `files` are paths that exist once the CLI has been signed in; `env` are
   * variables that authenticate it instead. Either satisfies the check.
   */
  authCheck?: { files?: string[]; env?: string[]; hint: string };
  /**
   * How this CLI exposes speed/quality controls, when it exposes any.
   *
   * Only filled in for agents whose flags have actually been run against the
   * installed binary. An unrecognised flag makes these CLIs exit non-zero, so
   * a guessed entry here would turn every task on that provider into a hard
   * failure — leaving it undefined just means the profile has no lever to pull
   * and the agent runs at its default, which is what happened before profiles
   * existed. Fill one in after checking `--help` on a real install.
   */
  tuning?: CliTuning;
}

export interface CliModel {
  /** Stable id, namespaced by provider so two CLIs can both offer "sonnet". */
  id: string;
  label: string;
  /** Exact value passed after the tuning model flag. */
  alias: string;
  /** Which profile tier picks this model when the user has not chosen one. */
  tier: ExecutionProfile['tier'];
  capabilities?: ModelDescriptor['capabilities'];
  contextWindow?: number;
  throughputTps?: number;
}

export interface CliTuning {
  /** Flag that picks a model, and the alias for each profile tier. */
  model?: { flag: string; tiers: Record<ExecutionProfile['tier'], string> };
  /** Flag that picks reasoning effort, and the value for each level. */
  effort?: { flag: string; values: Partial<Record<ExecutionProfile['effort'], string>> };
  /**
   * Args that turn the agentic loop off, leaving a single completion.
   *
   * This is the flag that matters. Measured on `make a calculator` with Claude
   * Code: 227s with the loop, 25s without, both producing a complete working
   * calculator. With the loop off the agent cannot write files itself, so it
   * answers with FILE: blocks and the orchestrator writes them — which is the
   * reviewable path anyway.
   */
  noTools?: string[];
  /** Args worth adding to any one-shot run, profile or not. */
  oneShot?: string[];
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
    models: [
      {
        id: 'claude-code/haiku',
        label: 'Haiku 4.5 — fastest',
        alias: 'haiku',
        tier: 'small',
        capabilities: ['code', 'cheap-ok', 'tool-use'],
        throughputTps: 90,
      },
      {
        id: 'claude-code/sonnet',
        label: 'Sonnet 5 — balanced',
        alias: 'sonnet',
        tier: 'mid',
        capabilities: ['code', 'strong-reasoning', 'frontend', 'long-context', 'tool-use'],
        throughputTps: 55,
      },
      {
        id: 'claude-code/opus',
        label: 'Opus 5 — most capable',
        alias: 'opus',
        tier: 'large',
        capabilities: ['code', 'strong-reasoning', 'frontend', 'long-context', 'tool-use'],
        throughputTps: 30,
      },
    ],
    // Verified against the installed binary's --help. Note the deliberate
    // absence of `--bare`: it forces ANTHROPIC_API_KEY-only auth, which would
    // break the subscription sign-in that makes this provider free.
    tuning: {
      model: { flag: '--model', tiers: { small: 'haiku', mid: 'sonnet', large: 'opus' } },
      effort: { flag: '--effort', values: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } },
      noTools: ['--tools', ''],
      oneShot: ['--no-session-persistence'],
    },
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
    bin: 'agy',
    binCandidates: ['%LOCALAPPDATA%/agy/bin/agy.exe', '%HOME%/.local/bin/agy'],
    args: [],
    promptVia: 'print-flag',
    skipPermissionsFlag: '--dangerously-skip-permissions',
    versionArgs: ['--version'],
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
    contextWindow: 1_000_000,
    throughputTps: 45,
    timeoutMs: 20 * 60_000,
    installHint: 'Install the Antigravity CLI (agy), then run `agy` once to sign in',
    // Verified against agy 1.2.0 with `agy --help` and `agy models`, and run
    // end to end: `--model` takes the ids `agy models` lists, `--effort` is
    // low|medium|high, and `--print-timeout` defaults to 5m — which would kill
    // a task the orchestrator is still prepared to wait twenty minutes for.
    models: [
      {
        id: 'antigravity/flash-low',
        label: 'Gemini 3.8 Flash (Low) — fastest',
        alias: 'gemini-3.8-flash-low',
        tier: 'small',
        capabilities: ['code', 'cheap-ok', 'long-context'],
        throughputTps: 70,
      },
      {
        id: 'antigravity/flash',
        label: 'Gemini 3.8 Flash — balanced',
        alias: 'gemini-3.8-flash-medium',
        tier: 'mid',
        capabilities: ['code', 'frontend', 'long-context', 'tool-use'],
        throughputTps: 45,
      },
      {
        id: 'antigravity/pro',
        label: 'Gemini 3.1 Pro (High) — most capable',
        alias: 'gemini-3.1-pro-high',
        tier: 'large',
        capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
        throughputTps: 30,
      },
    ],
    tuning: {
      model: {
        flag: '--model',
        tiers: { small: 'gemini-3.8-flash-low', mid: 'gemini-3.8-flash-medium', large: 'gemini-3.1-pro-high' },
      },
      // No effort flag: agy encodes effort in the model id and refuses a mismatch
      // (measured: "--model gemini-3.8-flash-medium conflicts with --effort=low").
      oneShot: ['--print-timeout', '20m'],
    },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    bin: 'gemini',
    args: ['--prompt'],
    promptVia: 'argv',
    skipPermissionsFlag: '--yolo',
    versionArgs: ['--version'],
    capabilities: ['code', 'long-context', 'cheap-ok', 'frontend', 'tool-use'],
    contextWindow: 1_000_000,
    throughputTps: 50,
    timeoutMs: 15 * 60_000,
    installHint: 'Install with: npm i -g @google/gemini-cli, then run `gemini` once to sign in',
    authCheck: {
      files: ['%HOME%/.gemini/oauth_creds.json', '%HOME%/.gemini/google_accounts.json'],
      env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
      hint: 'Installed, but not signed in. Run `gemini` once in a terminal and complete the browser sign-in, or set GEMINI_API_KEY.',
    },
    models: [
      {
        id: 'gemini-cli/flash',
        label: 'Gemini 2.5 Flash — fastest',
        alias: 'gemini-2.5-flash',
        tier: 'small',
        capabilities: ['code', 'cheap-ok', 'long-context'],
        throughputTps: 110,
      },
      {
        id: 'gemini-cli/pro',
        label: 'Gemini 2.5 Pro — most capable',
        alias: 'gemini-2.5-pro',
        tier: 'large',
        capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
        throughputTps: 45,
      },
    ],
    tuning: {
      model: {
        flag: '--model',
        // Only two real rungs, so `mid` maps to Flash: the fast profile carries
        // tier `mid`, and pointing it at Pro would make the profile whose entire
        // purpose is speed pick the slow model.
        tiers: { small: 'gemini-2.5-flash', mid: 'gemini-2.5-flash', large: 'gemini-2.5-pro' },
      },
      // Measured on 0.59.0: without `--skip-trust`, running in a folder the
      // CLI has not seen before prints "Approval mode overridden to default
      // because the current folder is not trusted" and silently downgrades
      // `--yolo`. The run then blocks on an approval prompt that nothing is
      // there to answer, and the task times out looking like a hang.
      oneShot: ['--skip-trust'],
    },
  },
];

export type AgentPermissions = 'yolo' | 'manual';

export class CliAgentAdapter extends BaseAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind = 'subscription' as const;
  readonly transport = 'cli' as const;

  private readonly config: CliAgentConfig;
  /** What actually gets spawned: a known install path when one exists. */
  private readonly bin: string;
  private permissions: AgentPermissions = 'yolo';
  private installedVersion?: string;

  constructor(config: CliAgentConfig) {
    super();
    this.config = config;
    this.bin = resolveConfiguredBin(config);
    this.id = config.id;
    this.name = config.name;
    // A CLI that names its models gets one entry each, so a user can ask for
    // Opus rather than for "Claude Code" and hope. One that does not keeps the
    // old single synthetic model, which is still the honest description of a
    // binary with no model flag.
    const declared = config.models ?? [];
    this.models = declared.length
      ? declared.map((m) => ({
          id: m.id,
          label: m.label,
          capabilities: m.capabilities ?? config.capabilities,
          contextWindow: m.contextWindow ?? config.contextWindow,
          maxOutputTokens: 64_000,
          // A subscription is not billed per token. Zero is correct, and it is
          // what makes the router spend a seat before spending money.
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
          throughputTps: m.throughputTps ?? config.throughputTps,
          tier: m.tier,
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: false,
        }))
      : [
          {
            id: config.id,
            label: config.name,
            capabilities: config.capabilities,
            contextWindow: config.contextWindow,
            maxOutputTokens: 64_000,
            pricing: { inputPerMTok: 0, outputPerMTok: 0 },
            throughputTps: config.throughputTps,
            supportsStreaming: true,
            supportsTools: true,
            supportsVision: false,
          },
        ];

    // The mid-tier model is the sane default: the router still moves work up
    // and down from there per task, and a provider whose default was its most
    // expensive model would make "just run it" an expensive instruction.
    this.defaultModel = declared.find((m) => m.tier === 'mid')?.id ?? declared[0]?.id ?? config.id;
  }

  /** The config entry behind a model id, if this CLI names its models. */
  private modelFor(id: string | undefined): CliModel | undefined {
    return this.config.models?.find((m) => m.id === id);
  }

  setPermissions(mode: AgentPermissions): void {
    this.permissions = mode;
  }

  /**
   * The reason this agent is unavailable, as precisely as we can put it.
   *
   * "Install it" is the wrong advice for someone who has installed it. The
   * case that prompted this: Antigravity 2.12.2 installs a full IDE and no
   * command-line entry point, so the product is present, correct and
   * completely undrivable from here — and the panel was telling its owner to
   * go and install it.
   */
  private unavailableBecause(reason: string): ProviderProbeResult {
    const installedAt = (this.config.guiInstallPaths ?? [])
      .map(expandPath)
      .find((candidate) => candidate && fs.existsSync(candidate));

    if (installedAt) {
      return {
        available: false,
        detail:
          `${this.config.name} is installed at ${installedAt}, but it does not ship a ` +
          `command-line interface, so tasks cannot be sent to it from here. It is a desktop ` +
          `application rather than a headless agent. Nothing to fix — this provider stays off ` +
          `until it offers a CLI.`,
      };
    }

    return { available: false, detail: reason };
  }

  async probe(): Promise<ProviderProbeResult> {
    try {
      const { stdout, code } = await runOnce(this.bin, this.config.versionArgs, { timeoutMs: 8_000 });
      if (code === null) {
        // `runOnce` reports a timeout as a null exit code. On Windows this is
        // usually the shell resolving a name that does not exist and hanging.
        return this.unavailableBecause(
          `\`${this.config.bin} --version\` did not respond within 8s. ${this.config.installHint}`,
        );
      }
      if (code !== 0) {
        // On Windows a missing command goes through the shell and comes back as
        // exit code 1 rather than ENOENT, so "not on PATH" and "ran and failed"
        // are told apart by asking where the binary is, not by the exit code.
        const resolved = resolveBin(this.bin);
        return this.unavailableBecause(
          resolved.kind === 'unresolved'
            ? `Not installed. ${this.config.installHint}`
            : `\`${this.config.bin}\` exited with code ${code}. ${this.config.installHint}`,
        );
      }
      this.installedVersion = stdout.trim().split('\n')[0]?.slice(0, 60);
      const auth = this.config.authCheck;
      if (auth) {
        const signedIn =
          (auth.files ?? []).some((f) => {
            const resolved = expandPath(f);
            return typeof resolved === 'string' && fs.existsSync(resolved);
          }) || (auth.env ?? []).some((name) => Boolean(process.env[name]));

        if (!signedIn) {
          return { available: false, detail: `${this.installedVersion ?? 'installed'} — ${auth.hint}` };
        }
      }

      return { available: true, detail: this.installedVersion ?? 'installed' };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      return this.unavailableBecause(
        missing ? `Not installed. ${this.config.installHint}` : `Could not run it: ${errorMessage(err)}`,
      );
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
        // The profile has to be forwarded explicitly. It was not, once, and the
        // symptom was silent: every flag except the always-on ones vanished,
        // the agent ran its full loop, and the only visible evidence was that
        // tasks took four minutes while the worklog said "fast profile".
        profile: request.profile,
        messages: [
          {
            role: 'user',
            content: [
              request.context,
              // Only when the loop is off. With tools available the agent can
              // and should write files itself, and telling it otherwise would
              // throw away the thing it is good at.
              request.profile && !request.profile.tools ? NO_TOOLS_INSTRUCTIONS : '',
              ARTIFACT_FORMAT_INSTRUCTIONS,
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        cwd: request.cwd,
      },
      signal,
    );
  }

  /**
   * Translate a profile into this agent's own flags.
   *
   * Public and pure so the speed decision is testable without spawning
   * anything. The flags ARE the feature here, and a silent typo in one would
   * cost minutes per task while still looking like it worked.
   */
  tuningArgs(profile: ExecutionProfile | undefined, modelId?: string): string[] {
    const t = this.config.tuning;
    if (!t) return [];

    const args: string[] = [...(t.oneShot ?? [])];

    // A model the caller named beats the profile's tier, and beats it even
    // with no profile at all. This is the whole point of letting someone pick
    // Opus: the router's opinion about what this task deserves is exactly what
    // they are overriding.
    const chosen = this.modelFor(modelId);
    if (t.model && chosen) args.push(t.model.flag, chosen.alias);
    if (!profile) return args;
    if (t.model && !chosen) args.push(t.model.flag, t.model.tiers[profile.tier]);

    const effort = t.effort?.values[profile.effort];
    if (t.effort && effort) args.push(t.effort.flag, effort);

    // Only ever turns the loop OFF. There is no "force tools on": that is the
    // agent's own default, and overriding it would fight its own judgement.
    if (!profile.tools && t.noTools) args.push(...t.noTools);

    return args;
  }

  private async *run(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    yield {
      type: 'start',
      runId: request.runId,
      providerId: this.id,
      model: this.modelFor(request.model)?.id ?? this.id,
      at: Date.now(),
    };
    this.countRequest();

    const prompt = [request.system, ...request.messages.map((m) => m.content)].join('\n\n');
    const args = [...this.config.args, ...this.tuningArgs(request.profile, request.model)];
    if (this.permissions === 'yolo' && this.config.skipPermissionsFlag) {
      args.push(this.config.skipPermissionsFlag);
    }
    if (this.config.promptVia === 'argv') args.push(prompt);
    if (this.config.promptVia === 'print-flag') args.push(...printFlagArgs(prompt));

    if (request.profile) {
      const tuned = this.tuningArgs(request.profile, request.model);
      yield {
        type: 'log',
        runId: request.runId,
        level: 'info',
        text:
          `${this.name}: "${request.profile.name}" profile` +
          (tuned.length ? ` (${tuned.join(' ')})` : ' — no tunable flags, using its own defaults'),
      };
    }

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

    const child = spawnCli(this.bin, args, {
      cwd: request.cwd ?? process.cwd(),
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

    // Measured on Gemini CLI 0.59 with a personal Google account: the run exits
    // 0 and prints "IneligibleTierError: This client is no longer supported for
    // Gemini Code Assist for individuals". Exit code alone would have called
    // that a successful, empty answer.
    if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(`${stdout} ${stderr}`)) {
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: 'auth',
          message: `${this.name}: Google no longer supports this client for individual accounts. Use Antigravity instead.`,
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

/**
 * Spawn a CLI agent with its arguments intact.
 *
 * The obvious implementation — `spawn(bin, args, { shell: process.platform ===
 * 'win32' })` — is what this replaces, and it was quietly wrong in two ways.
 * With `shell: true` Node does not quote anything: it joins the file and its
 * arguments with single spaces and hands the string to cmd.exe. So
 *
 *   - an empty argument disappears. `['--tools', '']` becomes `--tools ` and
 *     the flag arrives without its value, which is exactly the flag that makes
 *     a task nine times faster;
 *   - an argument containing spaces, quotes or newlines is re-split by cmd.exe
 *     into several arguments. Every `promptVia: 'argv'` agent passes the whole
 *     prompt that way, so on Windows those agents were being handed a prompt
 *     chopped at every space.
 *
 * The shell was only ever there because npm installs its global binaries on
 * Windows as `.cmd` shims, which cannot be executed directly. So: resolve the
 * name first, and take the shell only when the resolved target actually needs
 * it. A real `.exe` — which is how Claude Code installs — goes straight to
 * CreateProcess with its arguments passed as arguments.
 */
export function spawnCli(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const resolved = resolveBin(bin);
  // A path we could not resolve still goes through the shell: it is the only
  // thing that might find it, and a clear "not found" from the shell beats a
  // spawn error from us.
  const needsShell = resolved.kind === 'shim' || resolved.kind === 'unresolved';

  return spawn(resolved.path, needsShell ? args.map(quoteForCmd) : args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    shell: needsShell,
  });
}

/**
 * cmd.exe quoting, used only on the shim path.
 *
 * Enough for flags and short values. A newline cannot be represented as an
 * argument to cmd.exe at all, which is why `spawnCli` works hard to avoid the
 * shell rather than trying to escape its way out.
 */
function quoteForCmd(arg: string): string {
  if (arg !== '' && !/[\s"^&|<>()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Expand the handful of placeholders `guiInstallPaths` uses. */
function expandPath(template: string): string | undefined {
  const value = template
    .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA ?? '')
    .replace('%PROGRAMFILES%', process.env.PROGRAMFILES ?? '')
    .replace('%HOME%', os.homedir());
  // An unset variable leaves a path rooted at nothing, which would then match
  // something unrelated. Better to skip the candidate.
  if (value.startsWith('/') && template.startsWith('%')) return undefined;
  return path.normalize(value);
}

type ResolvedBin = { path: string; kind: 'exe' | 'shim' | 'unresolved' };

/** The binary to run, preferring a known install location over PATH. */
function resolveConfiguredBin(config: CliAgentConfig): string {
  for (const candidate of config.binCandidates ?? []) {
    const expanded = expandPath(candidate);
    if (expanded && fs.existsSync(expanded)) return expanded;
  }
  return config.bin;
}

/**
 * Deliver a prompt as the value of `--print`, the only form `agy` accepts.
 *
 * Measured on agy 1.2.0: the argument after a bare `--print` is taken as the
 * prompt (so a following flag becomes the prompt), an empty `--print=` is
 * refused, and stdin is not read — `--print=-` is answered as the literal
 * prompt "-". A context pack can exceed Windows' 32,767-character command
 * line, so a long prompt goes to a file the agent is told to read: it has file
 * tools, and `--add-dir` puts the file inside what it may open.
 */
const PRINT_FLAG_MAX_CHARS = 24_000;

function printFlagArgs(prompt: string): string[] {
  if (prompt.length <= PRINT_FLAG_MAX_CHARS) return [`--print=${prompt}`];

  const dir = path.join(os.tmpdir(), 'agentic-prompts');
  fs.mkdirSync(dir, { recursive: true });
  // Tidied on the next write rather than after this run: deleting a file the
  // agent may still be reading would break the task it belongs to.
  const hourAgo = Date.now() - 60 * 60_000;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < hourAgo) fs.rmSync(full, { force: true });
    } catch {
      // Already gone; nothing to do.
    }
  }

  const file = path.join(dir, `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(file, prompt, 'utf8');
  return [
    '--add-dir',
    dir,
    `--print=Your complete instructions for this task are in the file ${file}. Read the whole file first, then do exactly what it says and reply in the format it asks for.`,
  ];
}

const binCache = new Map<string, ResolvedBin>();

/**
 * Find what `bin` actually is on this machine.
 *
 * Cached for the process lifetime: it shells out, it is called on every run,
 * and a CLI does not usually change shape while the app is open. A failure to
 * resolve is cached too — as `unresolved`, which keeps the old shell behaviour
 * so a PATH layout this does not understand still works rather than breaking.
 */
export function resolveBin(bin: string): ResolvedBin {
  const cached = binCache.get(bin);
  if (cached) return cached;

  // An absolute path that exists needs no lookup — and `where` cannot take one.
  if (path.isAbsolute(bin) && fs.existsSync(bin)) {
    const lower = bin.toLowerCase();
    const direct: ResolvedBin = {
      path: bin,
      kind: lower.endsWith('.cmd') || lower.endsWith('.bat') ? 'shim' : 'exe',
    };
    binCache.set(bin, direct);
    return direct;
  }

  // Unresolved until something says otherwise. The old default was 'shim',
  // which meant `unresolved` was declared in the type and never produced — so
  // "not on PATH" was indistinguishable from "ran and failed", and every
  // uninstalled agent reported the shell's exit code 1 instead of saying it was
  // not installed.
  let result: ResolvedBin = { path: bin, kind: 'unresolved' };
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = spawnSync(finder, [bin], { encoding: 'utf8', windowsHide: true });
    const found = out.stdout?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) ?? [];

    /**
     * On Windows, take the first RUNNABLE match rather than the first match.
     *
     * npm installs a global CLI three times over: `gemini` (a shell script for
     * Git Bash), `gemini.cmd` and `gemini.ps1`. `where` lists the extensionless
     * one first, and Windows cannot execute it — so the probe spawned a bash
     * script through cmd.exe, got a non-zero exit, and reported a CLI that was
     * installed and working as "Not installed. Install with: npm i -g ...".
     */
    const first =
      process.platform === 'win32'
        ? (found.find((f) => /\.(cmd|bat|exe)$/i.test(f)) ?? found[0])
        : found[0];

    if (first) {
      // `.cmd` and `.bat` are batch files: only cmd.exe can run them. Anything
      // else is a real executable and can be spawned directly.
      const isBatch = /\.(cmd|bat)$/i.test(first);
      result = { path: first, kind: isBatch ? 'shim' : 'exe' };
    }
  } catch {
    // Keep the conservative default.
  }

  binCache.set(bin, result);
  return result;
}

/** Testing seam: forget what was resolved so a test can change PATH. */
export function clearBinCache(): void {
  binCache.clear();
}

/** Run a command once and collect its output. Used by probes only. */
function runOnce(
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, { env: { ...process.env, NO_COLOR: '1' } });
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
