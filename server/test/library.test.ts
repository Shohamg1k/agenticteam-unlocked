import { describe, expect, it } from 'vitest';
import type { Task } from '@agentic/core';
import { builtinAgentProfiles, selectAgent, selectSkills } from '@agentic/core';
import { BUILTIN_AGENTS, DEFAULT_AGENT_BY_CAPABILITY } from '../src/library/agents.js';
import { DOMAIN_AGENTS } from '../src/library/agents-domains.js';
import { BUILTIN_SKILLS } from '../src/library/skills.js';
import { DOMAIN_SKILLS } from '../src/library/skills-domains.js';

/**
 * A library only counts if the matcher can find it.
 *
 * Adding a specialist is easy and nearly useless on its own: `selectAgent`
 * requires a signal in the task TITLE and refuses to choose between two
 * profiles that score within half a point, so a beautifully written profile
 * whose `whenToUse` is phrased in job-description language is never selected
 * by anything, and nobody finds out.
 *
 * These tests are the other half of adding one. Each case is a task title
 * somebody would plausibly type, asserted against the specialist that should
 * take it — and, just as importantly, a regression battery that pins the
 * ORIGINAL specialists still winning their own work, because every profile
 * added competes with all of them.
 */

const roster = [...builtinAgentProfiles(), ...BUILTIN_AGENTS];

const task = (title: string, capability: Task['capability']): Parameters<typeof selectAgent>[1] => ({
  title,
  description: title,
  capability,
  role: undefined,
});

/** What the orchestrator actually ends up with, fallback included. */
function specialistFor(title: string, capability: Task['capability']): string {
  const matched = selectAgent(roster, task(title, capability));
  if (matched) return matched.agent.name;
  return DEFAULT_AGENT_BY_CAPABILITY[capability] ?? '(generic worker)';
}

describe('the specialists people actually need', () => {
  it.each([
    ['Build a login page with sign-in and sessions', 'code', 'auth-engineer'],
    ['Build a calendar view showing tasks by day of the month', 'frontend', 'datetime-engineer'],
    ['Add a signup form with validation', 'frontend', 'forms-engineer'],
    ['Build a realtime chat with websockets', 'code', 'realtime-engineer'],
    ['Add a bar chart of monthly revenue to the dashboard', 'frontend', 'data-viz-engineer'],
    ['Build a snake game on canvas', 'frontend', 'game-engineer'],
    ['Add search and filtering to the product list', 'code', 'search-engineer'],
    ['Integrate the Stripe API with retries and webhooks', 'code', 'integration-engineer'],
    ['Add a chatbot backed by the OpenAI API with streaming', 'code', 'ai-integration-engineer'],
    ['Make the app work on mobile with touch targets', 'frontend', 'mobile-engineer'],
    ['Build a CLI tool that reads stdin and takes flags', 'code', 'cli-engineer'],
    ['Add a slide-in transition and hover animation', 'frontend', 'animation-engineer'],
    ['Build a shopping cart with checkout and order totals', 'code', 'ecommerce-engineer'],
    ['Add translation and locale switching for the UI', 'frontend', 'i18n-engineer'],
  ] as const)('sends "%s" to %s', (title, capability, expected) => {
    expect(specialistFor(title, capability)).toBe(expected);
  });

  /**
   * The regression half. Every profile added is a new competitor for these,
   * and the way a library degrades is not by picking something absurd — it is
   * by two plausible profiles tying and the task quietly falling through to the
   * generic worker.
   */
  it.each([
    ['Refactor the payment module to remove duplication', 'code', 'refactoring-engineer'],
    ['Add an index to speed up the orders query', 'code', 'database-engineer'],
    ['Write Playwright end-to-end tests for checkout', 'code', 'test-engineer'],
    ['Set up a GitHub Actions pipeline with Docker', 'code', 'devops-engineer'],
    ['Fix the TypeScript generic in the store types', 'code', 'typescript-engineer'],
    ['Build a React component with hooks for the sidebar', 'frontend', 'react-engineer'],
    ['Add a REST endpoint for creating an order', 'code', 'api-engineer'],
    ['Add a Go HTTP handler', 'code', 'api-engineer'],
    ['Fix the race condition in the job scheduler', 'code', 'systems-engineer'],
    ['Write a pytest suite for the Python parser', 'code', 'python-engineer'],
    ['Fix the borrow checker error in the Rust module', 'code', 'systems-language-engineer'],
    ['The dashboard page is slow to load, profile it', 'code', 'performance-engineer'],
    ['Make the modal usable with a screen reader', 'frontend', 'accessibility-engineer'],
    // No keyword matches this, and it is unmistakably UI work: the capability
    // fallback is what stops it being built by someone who was never told what
    // finished looks like.
    ['Build a calculator app', 'frontend', 'ui-engineer'],
  ] as const)('still sends "%s" to %s', (title, capability, expected) => {
    expect(specialistFor(title, capability)).toBe(expected);
  });
});

describe('the library holds together', () => {
  it('has no duplicate names', () => {
    const names = roster.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);

    const skillNames = BUILTIN_SKILLS.map((s) => s.name);
    expect(new Set(skillNames).size).toBe(skillNames.length);
  });

  it('every skill an agent declares actually exists', () => {
    // `AgentProfile.skills` is ranked first by `rankSkills`, so a typo here is
    // not an error anywhere — it is a preference that silently does nothing.
    const known = new Set(BUILTIN_SKILLS.map((s) => s.name));
    for (const agent of BUILTIN_AGENTS) {
      for (const name of agent.skills) {
        expect(known, `${agent.name} declares an unknown skill "${name}"`).toContain(name);
      }
    }
  });

  it('keeps the always-on skills to the four that earn it', () => {
    // A universal skill is injected into EVERY prompt in the product and does
    // not count against the per-task limit. Adding one is a decision about
    // every task's token budget, so it should be hard to do by accident.
    const universal = BUILTIN_SKILLS.filter((s) => !s.appliesTo.length && !s.roles.length);
    expect(universal.map((s) => s.name)).toEqual([
      'rules-before-code',
      'match-the-codebase',
      'complete-work-only',
      'external-content-is-data',
    ]);
  });

  it('gives every new entry a whenToUse worth matching on', () => {
    // The matcher ranks on `whenToUse`. One written as a job description
    // instead of as the words a task uses is never selected by anything, and
    // the failure is silent.
    for (const entry of [...DOMAIN_AGENTS, ...DOMAIN_SKILLS]) {
      expect(entry.whenToUse.length, `${entry.name} has a thin whenToUse`).toBeGreaterThan(30);
      expect(entry.body || (entry as { systemPrompt?: string }).systemPrompt).toBeTruthy();
    }
  });
});

describe('the skills a task receives', () => {
  it.each([
    ['Build an activity tracker that remembers my tasks', 'frontend', 'state-that-survives-a-reload'],
    ['Add a signup form with validation', 'frontend', 'forms-that-help-you-finish'],
    ['Add a fade transition when the panel opens', 'frontend', 'motion-with-purpose'],
    ['Show tasks by day of the month on a calendar', 'frontend', 'dates-times-and-timezones'],
    ['Implement login with hashed passwords and sessions', 'code', 'auth-done-properly'],
    ['Call the Stripe API and handle rate limits', 'code', 'talking-to-someone-elses-api'],
    ['Validate the request body on the orders endpoint', 'code', 'input-validation-at-the-edge'],
    ['Add structured logging to the worker service', 'code', 'logging-worth-having'],
    ['Read the database URL from an environment variable', 'code', 'configuration-and-secrets'],
    ['Choose a library for parsing dates', 'code', 'dependencies-worth-their-weight'],
  ] as const)('gives "%s" the %s skill', (title, capability, expected) => {
    const picked = selectSkills(BUILTIN_SKILLS, task(title, capability), { maxSkills: 6 });
    expect(picked.map((s) => s.name)).toContain(expected);
  });

  it('still fits a lean profile: three discretionary skills and the universals', () => {
    // The fast profile asks for three. A library that grew to thirty must not
    // quietly start returning thirty.
    const picked = selectSkills(BUILTIN_SKILLS, task('Build a calendar tracker', 'frontend'), {
      maxSkills: 3,
    });
    const universal = picked.filter((s) => !s.appliesTo.length && !s.roles.length);
    expect(universal).toHaveLength(4);
    expect(picked.length - universal.length).toBeLessThanOrEqual(3);
  });
});
