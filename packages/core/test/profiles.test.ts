import { describe, expect, it } from 'vitest';
import {
  BALANCED_PROFILE,
  FAST_PROFILE,
  THOROUGH_PROFILE,
  applyOverrides,
  plannerProfile,
  profileFor,
} from '../src/profiles.js';
import type { Capability, TeamRole } from '../src/types.js';

/**
 * These tests are about minutes, not types.
 *
 * Every assertion here corresponds to a measured cost: `tools: false` is the
 * difference between 25 seconds and 227 on the task that motivated profiles,
 * and `projectChecks` is an npm install. So the cases worth pinning are the
 * ones where a plausible-looking change would quietly make everything slow
 * again, or — worse — quietly make hard work cheap.
 */

const task = (over: Partial<Parameters<typeof profileFor>[0]> = {}) => ({
  complexity: 2,
  capability: 'code' as Capability,
  expectedFiles: ['index.html'],
  role: undefined as TeamRole | undefined,
  ...over,
});

describe('profileFor', () => {
  it('puts a simple greenfield task on the fast path', () => {
    expect(profileFor(task({ complexity: 2 }), { projectHasFiles: false })).toEqual(FAST_PROFILE);
  });

  it('does not give a lean context to work that must fit an existing codebase', () => {
    const chosen = profileFor(task({ complexity: 2 }), { projectHasFiles: true });
    expect(chosen.richContext).toBe(true);
    expect(chosen.name).toBe('balanced');
  });

  it('keeps the effort low for a small change to an existing project', () => {
    // The point of this case: it needs to SEE the codebase, but it does not
    // need a frontier model to change one thing in it.
    expect(profileFor(task({ complexity: 2 }), { projectHasFiles: true }).effort).toBe('low');
  });

  it('sends genuinely hard work to the thorough profile', () => {
    expect(profileFor(task({ complexity: 5 }), { projectHasFiles: false })).toEqual(THOROUGH_PROFILE);
    expect(profileFor(task({ complexity: 4 }), { projectHasFiles: true })).toEqual(THOROUGH_PROFILE);
  });

  it('never fast-paths work whose whole job is judgement', () => {
    // Complexity 1 and greenfield would otherwise be the fastest possible path.
    const reasoning = profileFor(
      task({ complexity: 1, capability: 'strong-reasoning' }),
      { projectHasFiles: false },
    );
    expect(reasoning).toEqual(THOROUGH_PROFILE);

    for (const role of ['architect', 'security-reviewer'] as TeamRole[]) {
      expect(profileFor(task({ complexity: 1, role }), { projectHasFiles: false })).toEqual(
        THOROUGH_PROFILE,
      );
    }
  });

  it('uses the balanced profile for integrative work', () => {
    expect(profileFor(task({ complexity: 3 }), { projectHasFiles: true })).toEqual(BALANCED_PROFILE);
  });
});

describe('the profiles themselves', () => {
  it('only turns the tool loop off on the fast profile', () => {
    expect(FAST_PROFILE.tools).toBe(false);
    expect(BALANCED_PROFILE.tools).toBe(true);
    expect(THOROUGH_PROFILE.tools).toBe(true);
  });

  it('only skips the project checks on the fast profile', () => {
    expect(FAST_PROFILE.projectChecks).toBe(false);
    expect(BALANCED_PROFILE.projectChecks).toBe(true);
    expect(THOROUGH_PROFILE.projectChecks).toBe(true);
  });

  it('gives every profile at least one repair attempt after its first try', () => {
    for (const p of [FAST_PROFILE, BALANCED_PROFILE, THOROUGH_PROFILE]) {
      expect(p.maxAttempts).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('plannerProfile', () => {
  it('never gives the planner a tool loop', () => {
    // The planner returns one JSON object. A loop has nothing to do but explore
    // the repository at the user's expense before the first task even starts.
    expect(plannerProfile('instant').tools).toBe(false);
    expect(plannerProfile('professional').tools).toBe(false);
  });

  it('thinks harder for a professional plan than an instant one', () => {
    expect(plannerProfile('professional').tier).toBe('large');
    expect(plannerProfile('instant').tier).toBe('mid');
  });
});

describe('applyOverrides', () => {
  it('leaves the per-task decision alone when there are no overrides', () => {
    expect(applyOverrides(FAST_PROFILE)).toEqual(FAST_PROFILE);
    expect(applyOverrides(FAST_PROFILE, {})).toEqual(FAST_PROFILE);
  });

  it('lets a user force one profile for everything', () => {
    expect(applyOverrides(THOROUGH_PROFILE, { force: 'fast' })).toEqual(FAST_PROFILE);
    expect(applyOverrides(FAST_PROFILE, { force: 'thorough' })).toEqual(THOROUGH_PROFILE);
  });

  it('can add the project checks back to a fast task without slowing anything else', () => {
    const forced = applyOverrides(FAST_PROFILE, { alwaysRunProjectChecks: true });
    expect(forced.projectChecks).toBe(true);
    expect(forced.tools).toBe(false);
    expect(forced.name).toBe('fast');
  });
});
