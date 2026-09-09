import type { Capability, Task } from './types.js';

/**
 * Execution profiles.
 *
 * The single biggest cost in this product is that every task was run as if it
 * were hard. A one-file web calculator was given the same treatment as a
 * database migration: a frontier model, maximum reasoning effort, a full
 * agentic tool loop, the whole repository map, and the project's entire test
 * suite afterwards.
 *
 * Measured on that exact task with Claude Code:
 *
 *   full agentic loop, default model and effort ....... 227s
 *   no tools, low effort, mid-tier model ..............  25s
 *
 * Both produced a complete, working calculator with every requested feature.
 * The 202 extra seconds bought nothing, because there was nothing in the task
 * that needed them.
 *
 * A profile is how a task's complexity turns into that decision. It is applied
 * on top of routing, not instead of it: routing picks WHO runs the task, the
 * profile decides HOW HARD they try.
 */
export interface ExecutionProfile {
  /** Shown in the UI so the choice is visible rather than mysterious. */
  name: 'fast' | 'balanced' | 'thorough';

  /**
   * Model tier to ask a provider for, when it exposes a choice. An alias, not
   * a model id: every provider maps it to its own catalogue.
   */
  tier: 'small' | 'mid' | 'large';

  /** Reasoning effort, for providers that expose it. */
  effort: 'low' | 'medium' | 'high' | 'xhigh';

  /**
   * Whether the agent gets a tool loop.
   *
   * This is the expensive one. With tools, a CLI agent explores the repository,
   * reads files, writes them, re-reads them and verifies — minutes of work.
   * Without, it answers once with the file contents, which the orchestrator
   * writes and verifies itself. For a task that creates one or two files from
   * a clear brief, the loop is pure overhead.
   */
  tools: boolean;

  /** Ceiling for the packed context. */
  maxContextTokens: number;

  /** Ceiling for the model's own output. */
  maxOutputTokens: number;

  /**
   * Whether to include the repository map and relevance-ranked file contents.
   * A greenfield single file needs neither.
   */
  richContext: boolean;

  /**
   * Whether to run the project's own typecheck/lint/test/build.
   *
   * The syntax gate ALWAYS runs — that is what catches a truncated file, and
   * it costs milliseconds. Tier 2 costs an install and a test run, which for a
   * trivial task can exceed the task itself.
   */
  projectChecks: boolean;

  /** Attempts before the task is given up on. */
  maxAttempts: number;
}

export const FAST_PROFILE: ExecutionProfile = {
  name: 'fast',
  tier: 'mid',
  effort: 'low',
  tools: false,
  maxContextTokens: 12_000,
  maxOutputTokens: 16_000,
  richContext: false,
  projectChecks: false,
  maxAttempts: 3,
};

export const BALANCED_PROFILE: ExecutionProfile = {
  name: 'balanced',
  tier: 'mid',
  effort: 'medium',
  tools: true,
  maxContextTokens: 40_000,
  maxOutputTokens: 24_000,
  richContext: true,
  projectChecks: true,
  maxAttempts: 3,
};

export const THOROUGH_PROFILE: ExecutionProfile = {
  name: 'thorough',
  tier: 'large',
  effort: 'high',
  tools: true,
  maxContextTokens: 80_000,
  maxOutputTokens: 32_000,
  richContext: true,
  projectChecks: true,
  maxAttempts: 4,
};

/**
 * Which profile a task gets.
 *
 * Complexity is the main signal, but two things override it upward, because
 * both are cases where being fast and wrong is much worse than being slow:
 *
 *  - Work that must fit an existing codebase needs to see that codebase. A
 *    task editing files that already exist cannot be given a lean context.
 *  - Architecture, security and anything the planner called hard gets the full
 *    treatment regardless of how few files it touches.
 */
export function profileFor(
  task: Pick<Task, 'complexity' | 'capability' | 'expectedFiles' | 'role'>,
  opts: { projectHasFiles: boolean },
): ExecutionProfile {
  const capability: Capability = task.capability;

  // Never fast-path work whose whole job is judgement.
  if (capability === 'strong-reasoning' || task.role === 'architect' || task.role === 'security-reviewer') {
    return THOROUGH_PROFILE;
  }
  if (task.complexity >= 4) return THOROUGH_PROFILE;

  // Editing an existing codebase means reading it first.
  const touchesExistingProject = opts.projectHasFiles;
  if (task.complexity <= 2 && !touchesExistingProject) return FAST_PROFILE;

  // A small, well-scoped change to an existing project: lean context is wrong,
  // but a full agentic loop and the whole test suite are still overkill.
  if (task.complexity <= 2) return { ...BALANCED_PROFILE, name: 'balanced', effort: 'low' };

  return BALANCED_PROFILE;
}

/**
 * The profile for the planning call itself.
 *
 * Always `tools: false`, and that is not a speed compromise — the planner's job
 * is to return one JSON object. It has no files to write, so an agentic loop
 * has nothing to do except explore the repository at the user's expense, which
 * is exactly the several minutes that used to pass before the first task even
 * started. The repository summary it actually needs is already packed into its
 * prompt by `projectContext`.
 *
 * Effort stays high for Professional mode: a bad decomposition wastes every
 * task after it, which is the one place where thinking longer genuinely pays.
 */
export function plannerProfile(mode: 'instant' | 'professional'): ExecutionProfile {
  return {
    name: mode === 'professional' ? 'thorough' : 'balanced',
    tier: mode === 'professional' ? 'large' : 'mid',
    effort: mode === 'professional' ? 'high' : 'medium',
    tools: false,
    maxContextTokens: 30_000,
    maxOutputTokens: 16_000,
    richContext: true,
    projectChecks: false,
    maxAttempts: 2,
  };
}

/** Profile overrides a user can set per project. */
export interface ProfileOverrides {
  /** Force every task to this profile. Useful for "just be quick" or "be careful". */
  force?: ExecutionProfile['name'];
  /** Run the project's checks even on fast tasks. */
  alwaysRunProjectChecks?: boolean;
}

export function applyOverrides(profile: ExecutionProfile, overrides?: ProfileOverrides): ExecutionProfile {
  if (!overrides) return profile;

  const base =
    overrides.force === 'fast'
      ? FAST_PROFILE
      : overrides.force === 'balanced'
        ? BALANCED_PROFILE
        : overrides.force === 'thorough'
          ? THOROUGH_PROFILE
          : profile;

  return overrides.alwaysRunProjectChecks ? { ...base, projectChecks: true } : base;
}
