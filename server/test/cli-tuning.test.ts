import { describe, expect, it } from 'vitest';
import { FAST_PROFILE, THOROUGH_PROFILE } from '@agentic/core';
import { CLI_AGENTS, CliAgentAdapter } from '../src/providers/cli-agents.js';

/**
 * The flags ARE the feature.
 *
 * These CLIs exit non-zero on an unrecognised flag, so a typo here does not
 * degrade a task — it fails every task on that provider, several minutes in,
 * with an error that looks like the model's fault. And the values are the only
 * thing standing between "the user picked Opus" and "the user was quietly
 * given Sonnet", which is a lie the UI would tell confidently.
 */

const adapterFor = (id: string) => new CliAgentAdapter(CLI_AGENTS.find((c) => c.id === id)!);

describe('choosing a model inside a CLI agent', () => {
  it('offers the real models, not one entry named after the binary', () => {
    // "Claude Code" was a single opaque choice, which made the model picker
    // look broken to anyone who knew Haiku and Opus are not the same thing.
    const claude = adapterFor('claude-code');
    expect(claude.models.map((m) => m.id)).toEqual([
      'claude-code/haiku',
      'claude-code/sonnet',
      'claude-code/opus',
    ]);
    expect(claude.defaultModel).toBe('claude-code/sonnet');
  });

  it('passes the alias the binary actually understands', () => {
    const claude = adapterFor('claude-code');
    expect(claude.tuningArgs(FAST_PROFILE, 'claude-code/opus')).toContain('opus');
    expect(claude.tuningArgs(FAST_PROFILE, 'claude-code/haiku')).toContain('haiku');
  });

  it('lets a chosen model beat the profile tier', () => {
    // The entire point of the control. The fast profile asks for the mid
    // model; a user asking for Opus is overriding exactly that judgement.
    const args = adapterFor('claude-code').tuningArgs(FAST_PROFILE, 'claude-code/opus');
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).not.toContain('sonnet');
  });

  it('falls back to the profile tier when no model was chosen', () => {
    const args = adapterFor('claude-code').tuningArgs(THOROUGH_PROFILE);
    expect(args[args.indexOf('--model') + 1]).toBe(
      { small: 'haiku', mid: 'sonnet', large: 'opus' }[THOROUGH_PROFILE.tier],
    );
  });

  it('ignores a model id belonging to a different provider', () => {
    // A stale pin after switching provider must not silently produce a flag
    // value the binary rejects.
    const args = adapterFor('claude-code').tuningArgs(FAST_PROFILE, 'gemini-cli/pro');
    expect(args).not.toContain('gemini-2.5-pro');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('keeps effort separate from the model', () => {
    // "Opus on low" and "Haiku on high" are both sensible and mean different
    // things; collapsing them into one control would lose that.
    const args = adapterFor('claude-code').tuningArgs(
      { ...FAST_PROFILE, effort: 'xhigh' },
      'claude-code/haiku',
    );
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });
});

describe('Gemini CLI', () => {
  it('always passes --skip-trust', () => {
    // Measured on 0.59.0: without it, a folder the CLI has not seen prints
    // "Approval mode overridden to default because the current folder is not
    // trusted" and silently downgrades --yolo. The run then blocks on an
    // approval prompt nothing is there to answer, and the task times out
    // looking like a hang.
    const gemini = adapterFor('gemini-cli');
    expect(gemini.tuningArgs(FAST_PROFILE)).toContain('--skip-trust');
    expect(gemini.tuningArgs(undefined)).toContain('--skip-trust');
    expect(gemini.tuningArgs(THOROUGH_PROFILE, 'gemini-cli/pro')).toContain('--skip-trust');
  });

  it('does not point the fast profile at the slow model', () => {
    // Gemini has two real rungs, so `mid` — which the fast profile carries —
    // must map to Flash. Pointing it at Pro would make the profile whose whole
    // purpose is speed pick the slow model.
    const args = adapterFor('gemini-cli').tuningArgs(FAST_PROFILE);
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-2.5-flash');
  });
});

describe('a provider that is installed but not signed in', () => {
  it('says so, instead of reporting itself ready', () => {
    // Gemini CLI prints its version happily with no credentials and then fails
    // every task with "Please set an Auth method" — minutes into a run, having
    // looked available the whole time.
    const gemini = CLI_AGENTS.find((c) => c.id === 'gemini-cli')!;
    expect(gemini.authCheck).toBeDefined();
    expect(gemini.authCheck!.hint).toMatch(/sign|GEMINI_API_KEY/i);
    expect(gemini.authCheck!.files?.length).toBeGreaterThan(0);
  });
});
