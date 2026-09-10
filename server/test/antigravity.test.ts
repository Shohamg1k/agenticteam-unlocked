import { describe, expect, it } from 'vitest';
import { FAST_PROFILE, THOROUGH_PROFILE } from '@agentic/core';
import { CLI_AGENTS, CliAgentAdapter } from '../src/providers/cli-agents.js';

/**
 * Antigravity, through its own CLI.
 *
 * For a long time this provider was reported as undrivable, and at the time
 * that was true of what was installed: an Electron IDE and a language server
 * with a private protobuf API. Then `agy` 1.2.0 turned up in
 * %LOCALAPPDATA%/agy/bin — a real headless agent, not on PATH — and Google
 * retired Gemini CLI's personal sign-in in favour of it.
 *
 * Every value pinned here was run against that binary rather than read off a
 * help page. `agy` exits non-zero on anything it does not recognise, so a
 * typo in this config does not degrade a task; it fails every task on the
 * provider, minutes in, looking like the model's fault.
 */

const config = CLI_AGENTS.find((c) => c.id === 'antigravity')!;
const adapter = () => new CliAgentAdapter(config);

describe('the Antigravity CLI', () => {
  it('drives agy, and knows where its installer puts it', () => {
    expect(config.bin).toBe('agy');
    // Not on PATH until `agy install` — and an app launched before that never
    // sees the change. Installed and signed in must not read as missing.
    expect(config.binCandidates).toContain('%LOCALAPPDATA%/agy/bin/agy.exe');
    expect(config.guiInstallPaths).toBeUndefined();
  });

  it('attaches the prompt to --print rather than sending it on stdin', () => {
    // Measured: a bare `--print` takes the NEXT argument as the prompt, an
    // empty `--print=` is refused, and `--print=-` is answered as the literal
    // prompt "-". There is no stdin form, so this is the only delivery.
    expect(config.promptVia).toBe('print-flag');
    expect(config.args).toEqual([]);
  });

  it('skips permission prompts in a non-interactive run', () => {
    expect(config.skipPermissionsFlag).toBe('--dangerously-skip-permissions');
  });

  it('offers models by the exact ids `agy models` lists', () => {
    const aliases = config.models!.map((m) => m.alias);
    expect(aliases).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.1-pro-high']);
    expect(adapter().defaultModel).toBe('antigravity/flash');
  });

  it('raises the print timeout past its 5-minute default', () => {
    // agy stops itself at 5m by default; the orchestrator waits 20. Left at
    // the default, a long task would be killed by the agent while the
    // orchestrator was still happy to wait for it.
    const args = adapter().tuningArgs(FAST_PROFILE);
    expect(args.slice(0, 2)).toEqual(['--print-timeout', '20m']);
  });

  it('never sends --effort, which conflicts with the effort in the model id', () => {
    // Found on the first live two-agent run: agy refused the task with
    // `--model gemini-3.8-flash-medium conflicts with --effort=low`. Its model
    // ids carry their own effort level, so any profile whose effort differs
    // from the model's suffix failed outright — every fast-profile task, since
    // the fast profile is low effort on the medium model.
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const args = adapter().tuningArgs({ ...THOROUGH_PROFILE, effort }, 'antigravity/pro');
      expect(args).not.toContain('--effort');
      expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-pro-high');
    }
  });

  it('points the fast profile at Flash, not Pro', () => {
    const args = adapter().tuningArgs(FAST_PROFILE);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-medium');
  });
});
