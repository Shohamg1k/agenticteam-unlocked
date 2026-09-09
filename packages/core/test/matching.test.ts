import { describe, expect, it } from 'vitest';
import { overlapScore, rankSkills, selectAgent, selectSkills, terms } from '../src/matching.js';
import type { AgentProfile, Capability, SkillDef, TeamRole } from '../src/types.js';

const skill = (over: Partial<SkillDef> & { name: string }): SkillDef => ({
  description: '',
  whenToUse: '',
  body: 'guidance',
  appliesTo: [],
  roles: [],
  enabled: true,
  source: 'builtin',
  ...over,
});

const agent = (over: Partial<AgentProfile> & { name: string }): AgentProfile => ({
  description: '',
  whenToUse: '',
  capability: 'code' as Capability,
  systemPrompt: 'prompt',
  preferredProviders: [],
  allowedTools: [],
  skills: [],
  enabled: true,
  source: 'builtin',
  ...over,
});

const task = (title: string, over: Partial<{ description: string; capability: Capability; role: TeamRole }> = {}) => ({
  title,
  description: over.description ?? '',
  capability: over.capability ?? ('code' as Capability),
  role: over.role,
});

describe('terms', () => {
  it('splits identifiers so a task about UserProfileCard matches "profile"', () => {
    expect(terms('Refactor UserProfileCard')).toContain('profile');
    expect(terms('Refactor UserProfileCard')).toContain('card');
  });

  it('drops words that say nothing about what a task is', () => {
    // Without this, every task matches every skill on "create", "file", "code".
    expect(terms('create the new file for this code')).toEqual([]);
  });
});

describe('overlapScore', () => {
  it('scores a direct hit above a prefix one', () => {
    const direct = overlapScore(['migration'], 'database migration guidance');
    const prefix = overlapScore(['migration'], 'migrations are hard');
    expect(direct).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(0);
  });

  it('does not match a short word inside an unrelated one', () => {
    // "api" inside "rapid" would otherwise send every task to the API agent.
    expect(overlapScore(['api'], 'rapid prototyping')).toBe(0);
  });
});

describe('rankSkills', () => {
  const skills = [
    skill({ name: 'universal', body: 'always' }),
    skill({
      name: 'sql-and-schema-care',
      whenToUse: 'Writing SQL, designing tables, adding an index, or a migration',
      appliesTo: ['code'],
    }),
    skill({
      name: 'ui-that-looks-designed',
      whenToUse: 'Building any screen, page, component or layout',
      appliesTo: ['frontend'],
    }),
    skill({ name: 'for-qa', whenToUse: 'Writing tests', appliesTo: [], roles: ['qa-engineer'] }),
    skill({ name: 'errors-worth-reading', whenToUse: 'Any code that can fail', appliesTo: ['code'] }),
  ];

  it('always includes a universal skill, first', () => {
    const ranked = rankSkills(skills, task('Add a database migration'));
    expect(ranked[0]!.skill.name).toBe('universal');
  });

  it('ranks the skill that matches what the task is about above one that merely shares a tag', () => {
    const ranked = rankSkills(skills, task('Add a migration for the orders table'));
    const named = ranked.map((r) => r.skill.name);
    // Both are tagged `code`; only one is about migrations.
    expect(named).toContain('errors-worth-reading');
    expect(named.indexOf('sql-and-schema-care')).toBeLessThan(named.indexOf('errors-worth-reading'));
  });

  it('does not offer a frontend skill to a backend-tagged task', () => {
    const ranked = rankSkills(skills, task('Add a migration', { capability: 'code' }));
    expect(ranked.map((r) => r.skill.name)).not.toContain('ui-that-looks-designed');
  });

  it('includes a role-written skill for that role', () => {
    const ranked = rankSkills(skills, task('Cover the checkout flow', { role: 'qa-engineer' }));
    expect(ranked.map((r) => r.skill.name)).toContain('for-qa');
  });

  it('skips a disabled skill entirely', () => {
    const ranked = rankSkills([skill({ name: 'off', enabled: false })], task('anything'));
    expect(ranked).toEqual([]);
  });
});

describe('selectSkills', () => {
  it('caps how many a task receives, so a big library cannot flood the prompt', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      skill({ name: `s${i}`, whenToUse: 'migration table index', appliesTo: ['code'] }),
    );
    expect(selectSkills(many, task('Add a migration'), { maxSkills: 4 })).toHaveLength(4);
  });

  it('keeps a universal skill even when the budget is spent', () => {
    // Dropping "do not emit a stub" to fit an optional skill in would be
    // exactly backwards.
    const chosen = selectSkills(
      [
        skill({ name: 'verbose', body: 'x'.repeat(9_000), whenToUse: 'migration', appliesTo: ['code'] }),
        skill({ name: 'complete-work-only', body: 'no stubs' }),
      ],
      task('Add a migration'),
      { maxChars: 500 },
    );
    expect(chosen.map((s) => s.name)).toContain('complete-work-only');
    expect(chosen.map((s) => s.name)).not.toContain('verbose');
  });
});

describe('selectAgent', () => {
  const agents = [
    agent({
      name: 'database-engineer',
      description: 'Schemas, queries, indexes and migrations',
      whenToUse: 'Database, schema, table, SQL, query, migration, index, Postgres',
      capability: 'strong-reasoning',
    }),
    agent({
      name: 'ui-engineer',
      description: 'Builds interfaces that look and feel designed',
      whenToUse: 'Screens, pages, components, layouts, styling, CSS, responsive',
      capability: 'frontend',
    }),
    agent({
      name: 'test-engineer',
      description: 'Test suites that would catch the regression',
      whenToUse: 'Tests, testing, coverage, unit test, e2e, Playwright, vitest',
      capability: 'code',
      role: 'qa-engineer',
    }),
  ];

  it('picks the specialist a task is actually about', () => {
    const chosen = selectAgent(agents, task('Add an index to the orders table in Postgres'));
    expect(chosen?.agent.name).toBe('database-engineer');
  });

  it('picks the frontend specialist for layout work', () => {
    const chosen = selectAgent(agents, task('Fix the responsive layout of the pricing page', { capability: 'frontend' }));
    expect(chosen?.agent.name).toBe('ui-engineer');
  });

  it('returns nothing when no profile is a clear fit', () => {
    // The common and correct case. A nearly-right specialist makes the model
    // confident about the wrong domain, which is worse than a generic prompt.
    expect(selectAgent(agents, task('Update the copyright year in the footer text'))).toBeUndefined();
  });

  it('refuses to pick between two equally good matches', () => {
    const tied = [
      agent({ name: 'a', whenToUse: 'migration schema table', capability: 'code' }),
      agent({ name: 'b', whenToUse: 'migration schema table', capability: 'code' }),
    ];
    expect(selectAgent(tied, task('Write a migration for the schema table'))).toBeUndefined();
  });

  it('ignores a disabled profile', () => {
    const off = agents.map((a) => ({ ...a, enabled: false }));
    expect(selectAgent(off, task('Add an index to the orders table in Postgres'))).toBeUndefined();
  });
});
