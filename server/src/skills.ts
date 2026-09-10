import fs from 'node:fs';
import path from 'node:path';
import type { AgentProfile, Capability, SkillDef, Task, TeamRole } from '@agentic/core';
import { ALL_CAPABILITIES, ALL_TEAM_ROLES, builtinAgentProfiles } from '@agentic/core';
import { selectSkills } from '@agentic/core';
import { BUILTIN_SKILLS } from './library/skills.js';
import { BUILTIN_AGENTS } from './library/agents.js';
import { ensureDir, nodePaths, projectPaths } from './paths.js';
import { changed, projectState } from './store.js';
import { getProject } from './projects.js';
import { describeError, log } from './log.js';

/**
 * Skills and agent profiles.
 *
 * A skill is a Markdown instruction pack injected into the context of agents it
 * is relevant to: "Next.js app router conventions", "our PostgreSQL migration
 * style". An agent profile is a role, a system prompt, preferred providers and
 * a skill list.
 *
 * Both are files (ADR 0003), so they are shareable by copying a folder or
 * committing one, and editable without the app.
 *
 * Format (`SKILL.md`), matching the convention users already know:
 *
 *     ---
 *     name: postgres-migrations
 *     description: How we write database migrations
 *     whenToUse: Any task that adds or changes a database table
 *     appliesTo: code, strong-reasoning
 *     roles: backend-engineer
 *     ---
 *
 *     <the instructions>
 */

interface FrontMatter {
  body: string;
  fields: Map<string, string>;
}

function parseFrontMatter(content: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { body: content.trim(), fields: new Map() };

  const fields = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return { body: (match[2] ?? '').trim(), fields };
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function loadSkills(projectId: string): SkillDef[] {
  const ps = projectState(projectId);
  if (!ps) return [...BUILTIN_SKILLS];

  const skills: SkillDef[] = [...BUILTIN_SKILLS];
  for (const dir of [projectPaths(ps.root).skills, path.join(nodePaths().base, 'skills')]) {
    skills.push(...readSkillsFrom(dir, dir.includes(ps.root) ? 'project' : 'plugin'));
  }

  // A project skill may shadow a built-in by name — that is how a user
  // overrides shipped guidance rather than fighting it.
  const byName = new Map<string, SkillDef>();
  for (const skill of skills) byName.set(skill.name, skill);

  ps.skills = [...byName.values()];
  return ps.skills;
}

function readSkillsFrom(dir: string, source: SkillDef['source']): SkillDef[] {
  const out: SkillDef[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    // Both layouts are accepted: `skills/name/SKILL.md` and `skills/name.md`.
    const file = entry.isDirectory()
      ? path.join(dir, entry.name, 'SKILL.md')
      : entry.name.endsWith('.md')
        ? path.join(dir, entry.name)
        : undefined;
    if (!file || !fs.existsSync(file)) continue;

    try {
      const { body, fields } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
      const name = fields.get('name') || path.basename(entry.name, '.md');
      if (!body.trim()) continue;

      out.push({
        name,
        description: fields.get('description') ?? '',
        whenToUse: fields.get('whentouse') ?? fields.get('when_to_use') ?? '',
        body,
        appliesTo: csv(fields.get('appliesto')).filter((c): c is Capability =>
          ALL_CAPABILITIES.includes(c as Capability),
        ),
        roles: csv(fields.get('roles')).filter((r): r is TeamRole => ALL_TEAM_ROLES.includes(r as TeamRole)),
        enabled: fields.get('enabled') !== 'false',
        source,
        path: file,
      });
    } catch (err) {
      log(`Skipped unreadable skill ${file}: ${describeError(err)}`, 'warn');
    }
  }
  return out;
}

/**
 * Which skills a task should receive.
 *
 * Relevance, and only the best few of it. The obvious rule — every skill whose
 * capability tag matches — is fine for three skills and ruinous for forty: a
 * task about a stylesheet would receive the database guidance, the API
 * guidance and the migration guidance, and on the fast profile the whole
 * context budget would be gone before the brief was read.
 *
 * A skill with no `appliesTo` and no `roles` is universal by declaration and
 * always included; anything narrower is ranked and capped. See `rankSkills`.
 */
export function activeSkillsFor(
  projectId: string,
  task: Task,
  limit?: number,
  preferred?: string[],
): SkillDef[] {
  const project = getProject(projectId);
  const all = projectState(projectId)?.skills ?? loadSkills(projectId);
  const allowList = project?.settings.skills ?? [];

  // An explicit per-project allow-list, when set, wins over relevance — the
  // user has said which skills they want, and ranking is not a second opinion.
  const eligible = allowList.length ? all.filter((s) => allowList.includes(s.name)) : all;

  return selectSkills(eligible, task, { maxSkills: limit ?? 6, preferred });
}

export function saveSkill(
  projectId: string,
  skill: Pick<SkillDef, 'name' | 'description' | 'whenToUse' | 'body'> & Partial<SkillDef>,
): SkillDef {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  const safeName = skill.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  if (!safeName) throw new Error('A skill needs a name');

  const dir = path.join(projectPaths(ps.root).skills, safeName);
  ensureDir(dir);

  const content = [
    '---',
    `name: ${safeName}`,
    `description: ${skill.description ?? ''}`,
    `whenToUse: ${skill.whenToUse ?? ''}`,
    `appliesTo: ${(skill.appliesTo ?? []).join(', ')}`,
    `roles: ${(skill.roles ?? []).join(', ')}`,
    `enabled: ${skill.enabled !== false}`,
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  loadSkills(projectId);
  changed();
  log(`Saved skill "${safeName}"`, 'info', { projectId });
  return ps.skills.find((s) => s.name === safeName)!;
}

export function deleteSkill(projectId: string, name: string): boolean {
  const ps = projectState(projectId);
  const skill = ps?.skills.find((s) => s.name === name);
  if (!ps || !skill?.path) return false;
  if (skill.source === 'builtin') throw new Error('Built-in skills cannot be deleted. Disable it instead.');

  fs.rmSync(path.dirname(skill.path), { recursive: true, force: true });
  loadSkills(projectId);
  changed();
  return true;
}

// ---------------------------------------------------------------------------
// Agent profiles
// ---------------------------------------------------------------------------

/**
 * Every agent profile available, built-in and user-defined.
 *
 * Two built-in sets, and they answer different questions. `builtinAgentProfiles`
 * derives one profile per SDLC role — that is the TEAM, and Professional mode
 * assigns from it. `BUILTIN_AGENTS` is the specialist library — that is
 * EXPERTISE, matched to a task by what the task is about. A task can draw on
 * both: the QA engineer role and the test-engineer specialist are not rivals.
 */
export function loadAgents(projectId: string): AgentProfile[] {
  const ps = projectState(projectId);
  if (!ps) return [...builtinAgentProfiles(), ...BUILTIN_AGENTS];

  const agents: AgentProfile[] = [...builtinAgentProfiles(), ...BUILTIN_AGENTS];
  for (const dir of [projectPaths(ps.root).agents, path.join(nodePaths().base, 'agents')]) {
    agents.push(...readAgentsFrom(dir, dir.includes(ps.root) ? 'project' : 'plugin'));
  }

  const byName = new Map<string, AgentProfile>();
  for (const agent of agents) byName.set(agent.name, agent);
  ps.agents = [...byName.values()];
  return ps.agents;
}

/**
 * The roster a run may actually draw on.
 *
 * `loadAgents` answers "what exists", which is what the settings screen wants
 * to list. This answers "what may run", which is what the orchestrator wants —
 * and they differ only when a user has gone into the roster and turned things
 * off, which is rare and deliberate.
 *
 * An empty or absent list means everything, not nothing. Someone who unticks
 * the last agent has expressed a preference about specialists, not a wish for
 * the run to have nobody to give the work to, and the generic worker prompt
 * they would fall back to is the same one they get with no roster at all.
 */
export function activeAgents(projectId: string): AgentProfile[] {
  const all = loadAgents(projectId);
  const enabled = getProject(projectId)?.settings.enabledAgents;
  if (!enabled?.length) return all;

  const allowed = new Set(enabled);
  const chosen = all.filter((a) => allowed.has(a.name));
  return chosen.length ? chosen : all;
}

function readAgentsFrom(dir: string, source: AgentProfile['source']): AgentProfile[] {
  const out: AgentProfile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const file = entry.isDirectory()
      ? path.join(dir, entry.name, 'AGENT.md')
      : entry.name.endsWith('.md')
        ? path.join(dir, entry.name)
        : undefined;
    if (!file || !fs.existsSync(file)) continue;

    try {
      const { body, fields } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
      const name = fields.get('name') || path.basename(entry.name, '.md');
      if (!body.trim()) continue;

      const capability = fields.get('capability') as Capability | undefined;
      const role = fields.get('role') as TeamRole | undefined;

      out.push({
        name,
        role: role && ALL_TEAM_ROLES.includes(role) ? role : undefined,
        description: fields.get('description') ?? '',
        whenToUse: fields.get('whentouse') ?? fields.get('when_to_use') ?? '',
        capability: capability && ALL_CAPABILITIES.includes(capability) ? capability : 'code',
        systemPrompt: body,
        preferredProviders: csv(fields.get('providers') ?? fields.get('models')),
        allowedTools: csv(fields.get('tools')),
        skills: csv(fields.get('skills')),
        enabled: fields.get('enabled') !== 'false',
        source,
      });
    } catch (err) {
      log(`Skipped unreadable agent profile ${file}: ${describeError(err)}`, 'warn');
    }
  }
  return out;
}

export function saveAgent(projectId: string, agent: AgentProfile): AgentProfile {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  const safeName = agent.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  if (!safeName) throw new Error('An agent needs a name');

  const dir = path.join(projectPaths(ps.root).agents, safeName);
  ensureDir(dir);

  const content = [
    '---',
    `name: ${safeName}`,
    `description: ${agent.description}`,
    `whenToUse: ${agent.whenToUse}`,
    `capability: ${agent.capability}`,
    agent.role ? `role: ${agent.role}` : '',
    `providers: ${agent.preferredProviders.join(', ')}`,
    `tools: ${agent.allowedTools.join(', ')}`,
    `skills: ${agent.skills.join(', ')}`,
    `enabled: ${agent.enabled}`,
    '---',
    '',
    agent.systemPrompt.trim(),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  fs.writeFileSync(path.join(dir, 'AGENT.md'), content, 'utf8');
  loadAgents(projectId);
  changed();
  log(`Saved agent profile "${safeName}"`, 'info', { projectId });
  return ps.agents.find((a) => a.name === safeName)!;
}

export function deleteAgent(projectId: string, name: string): boolean {
  const ps = projectState(projectId);
  const agent = ps?.agents.find((a) => a.name === name);
  if (!ps || !agent) return false;
  if (agent.source === 'builtin') throw new Error('Built-in agents cannot be deleted. Disable it instead.');

  fs.rmSync(path.join(projectPaths(ps.root).agents, name), { recursive: true, force: true });
  loadAgents(projectId);
  changed();
  return true;
}
