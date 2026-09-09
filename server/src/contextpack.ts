import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionProfile, Plan, SkillDef, Task } from '@agentic/core';
import { ARTIFACT_FORMAT_INSTRUCTIONS, ancestorsOf, estimateTokens } from '@agentic/core';
import { buildCodeMap, relevantFiles, renderCodeMap } from './codemap.js';
import type { CodeMap } from './codemap.js';
import { bindingMemory, searchMemory } from './memory.js';
import { profileProject } from './projects.js';
import { projectState, tasksOfPlan } from './store.js';
import { resolveInProject } from './paths.js';

/**
 * Context packing.
 *
 * A task gets what it needs and nothing else. The brief calls this out
 * directly, and it is the difference between a plan that costs $0.40 and one
 * that costs $12 for the same output.
 *
 * The pack is built in two halves, and the split is the whole point:
 *
 *   STABLE PREFIX — role prompt, project profile, binding decisions, code map,
 *   skills. Identical across every task in a plan, so providers that support
 *   prompt caching get a hit on it, and the cost of the second task is a
 *   fraction of the first.
 *
 *   VOLATILE SUFFIX — this task's brief, its dependencies' contracts, the
 *   files it needs, prior failed attempts. Changes per task and per attempt,
 *   so it goes last, after the cache breakpoint.
 *
 * Put the volatile part first and the cache never hits. That is the single
 * most expensive mistake available here, so the two halves are separate return
 * values rather than one string a caller might concatenate in either order.
 */

export interface ContextPack {
  /** Cacheable. Send as the system prompt. */
  stable: string;
  /** Per-task. Send as the user message. */
  volatile: string;
  /** Files whose full contents were included. */
  includedFiles: string[];
  /** Section-by-section token spend, shown in the UI. */
  budget: { section: string; tokens: number }[];
  totalTokens: number;
  /** Tokens the code map saved versus including those files whole. */
  savedTokens: number;
}

export interface PackOptions {
  projectId: string;
  task: Task;
  plan: Plan;
  /** Role or generic worker system prompt. */
  rolePrompt: string;
  /** Skills to inject. Already filtered for relevance by the caller. */
  skills?: SkillDef[];
  /** Total token ceiling for the pack. */
  maxTokens?: number;
  /** Feedback from a failed verification, for a repair attempt. */
  repairFeedback?: string;
  /** Cached code map, so a plan does not rebuild it per task. */
  codeMap?: CodeMap;
  /**
   * The task's execution profile. Its `maxContextTokens` becomes the pack
   * budget and its `richContext` decides whether the repository map and
   * neighbouring file contents are worth including at all — a greenfield
   * single-file task is slowed down, not helped, by being handed a tour of a
   * codebase it is not going to touch.
   */
  profile?: ExecutionProfile;
}

/** Per-section ceilings. They sum to less than the default budget on purpose. */
const SECTION_BUDGETS = {
  memory: 1_500,
  codeMap: 2_000,
  skills: 2_000,
  contracts: 3_000,
  files: 12_000,
  attempts: 1_500,
};

export async function packContext(opts: PackOptions): Promise<ContextPack> {
  const ps = projectState(opts.projectId);
  if (!ps) throw new Error(`No such project: ${opts.projectId}`);

  const maxTokens = opts.maxTokens ?? opts.profile?.maxContextTokens ?? 60_000;

  /**
   * Whether this task gets the tour of the codebase.
   *
   * The repository map and the relevance-ranked file contents are the two
   * biggest sections here, and for a task creating a file that does not exist
   * yet, in a project that has nothing in it, they are worse than useless:
   * thousands of tokens to read before starting, on exactly the tasks that are
   * meant to be quick. `profileFor` only turns this off for greenfield work,
   * so a task that has to fit an existing codebase always gets to see it.
   */
  const rich = opts.profile?.richContext ?? true;

  // Scale the per-section ceilings to the pack's own budget. Without this a
  // 12k pack would still try to spend 12k on file contents alone.
  const scale = Math.min(1, maxTokens / 60_000);
  const budgetFor = (section: keyof typeof SECTION_BUDGETS) =>
    Math.max(200, Math.round(SECTION_BUDGETS[section] * scale));
  const budget: { section: string; tokens: number }[] = [];
  const track = (section: string, text: string) => {
    const tokens = estimateTokens(text);
    if (tokens > 0) budget.push({ section, tokens });
    return text;
  };

  const codeMap = opts.codeMap ?? (await buildCodeMap(ps.root));
  const profile = profileProject(ps.root);

  // ---------------------------------------------------------------------
  // Stable prefix
  // ---------------------------------------------------------------------

  const stableParts: string[] = [];
  stableParts.push(track('role', opts.rolePrompt));

  const projectSection = [
    '',
    '## This project',
    '',
    `Root: ${ps.root}`,
    `Ecosystem: ${profile.ecosystem}${profile.packageManager ? ` (${profile.packageManager})` : ''}`,
    profile.frameworks.length ? `Frameworks in use: ${profile.frameworks.join(', ')}` : '',
    // Telling the agent which gate will judge it changes what it writes: it
    // writes to pass the typecheck it knows is coming.
    Object.entries(profile.checks).filter(([, v]) => v).length
      ? `Your output will be checked with: ${Object.entries(profile.checks)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k} (\`${v}\`)`)
          .join(', ')}`
      : 'This project defines no automated checks, so your output is verified by syntax parsing only. Be correspondingly careful.',
  ]
    .filter(Boolean)
    .join('\n');
  stableParts.push(track('project profile', projectSection));

  const memory = bindingMemory(opts.projectId, budgetFor('memory'));
  if (memory) stableParts.push(track('binding memory', `\n${memory}`));

  const mapText = rich ? renderCodeMap(codeMap, budgetFor('codeMap')) : '';
  if (mapText) stableParts.push(track('code map', `\n${mapText}`));

  if (opts.skills?.length) {
    // Skills get a floor rather than a share. On a lean pack the code map and
    // the file contents are skipped entirely, so the space they would have
    // taken is free — and spending it on "here is what finished UI looks like"
    // is a far better use than leaving it unused. Scaling this budget down with
    // everything else meant the fast profile, which is exactly where a
    // single-page app lands, got no craft guidance at all.
    const skillBudget = rich ? budgetFor('skills') : 1_800;
    const skillText = renderSkills(opts.skills, skillBudget);
    if (skillText) stableParts.push(track('skills', `\n${skillText}`));
  }

  stableParts.push(track('output format', `\n${ARTIFACT_FORMAT_INSTRUCTIONS}`));

  // ---------------------------------------------------------------------
  // Volatile suffix
  // ---------------------------------------------------------------------

  const volatileParts: string[] = [];

  volatileParts.push(
    track(
      'goal',
      [
        '## The overall goal',
        '',
        opts.plan.goal,
        '',
        'You are doing ONE task towards it, described below.',
      ].join('\n'),
    ),
  );

  const taskSection = [
    '',
    `## Your task: ${opts.task.title}`,
    '',
    opts.task.description,
    opts.task.contract ? `\n### The interface your output MUST expose\n\n${opts.task.contract}` : '',
    opts.task.acceptance.length
      ? `\n### Done when\n\n${opts.task.acceptance.map((a) => `- ${a.text}`).join('\n')}`
      : '',
    opts.task.expectedFiles?.length
      ? `\n### Files you own\n\n${opts.task.expectedFiles.map((f) => `- ${f}`).join('\n')}\n\nOther tasks own the rest. Do not edit files outside this list.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  volatileParts.push(track('task brief', taskSection));

  // Dependencies' contracts. This is what keeps parallel work consistent: a
  // task sees exactly what its ancestors promised, verbatim.
  const allTasks = tasksOfPlan(ps, opts.plan.id);
  const ancestors = ancestorsOf(opts.task.id, allTasks).filter((t) => t.contract || t.status === 'done');
  if (ancestors.length) {
    const lines = ['', '## What earlier tasks have already established', '', 'Obey these exactly.', ''];
    let used = 0;
    for (const ancestor of ancestors) {
      const block = [
        `### ${ancestor.title}`,
        ancestor.contract ? `\nContract:\n${ancestor.contract}` : '',
        ancestor.producedFiles?.length ? `\nFiles it produced: ${ancestor.producedFiles.join(', ')}` : '',
        '',
      ]
        .filter(Boolean)
        .join('\n');
      const cost = estimateTokens(block);
      if (used + cost > budgetFor('contracts')) break;
      lines.push(block);
      used += cost;
    }
    volatileParts.push(track('dependency contracts', lines.join('\n')));
  }

  // Relevant memory beyond the always-binding set.
  const hits = searchMemory(opts.projectId, `${opts.task.title} ${opts.task.description}`, 5, [
    'requirement',
    'bug',
    'task-note',
  ]);
  if (hits.length) {
    const text = [
      '',
      '## Relevant project notes',
      '',
      ...hits.map((h) => `### ${h.note.title}\n${h.note.body}\n`),
    ].join('\n');
    volatileParts.push(track('relevant notes', text));
  }

  // File contents. Explicitly-owned files first, then relevance-ranked ones.
  //
  // On a lean pack the relevance search is skipped but the task's OWN files
  // are still read: if the task says it owns `src/app.ts` and that file
  // already exists, rewriting it blind would destroy whatever is in it.
  const wanted = new Set<string>(opts.task.expectedFiles ?? []);
  if (rich) {
    for (const file of relevantFiles(codeMap, `${opts.task.title} ${opts.task.description}`, 10)) {
      wanted.add(file.path);
    }
  }

  const {
    text: filesText,
    included,
    skippedTokens,
  } = await readFilesWithin(ps.root, [...wanted], budgetFor('files'));
  if (filesText) volatileParts.push(track('file contents', filesText));

  if (opts.task.attempts.length) {
    const failures = opts.task.attempts
      .filter((a) => a.outcome !== 'success')
      .slice(-3)
      .map(
        (a) =>
          `- Attempt ${a.n} on ${a.providerId}/${a.model}: ${a.outcome}${a.error ? ` — ${a.error.message}` : ''}`,
      );
    if (failures.length) {
      volatileParts.push(
        track(
          'prior attempts',
          [
            '',
            '## Previous attempts at this task failed',
            '',
            ...failures,
            '',
            'Do not repeat the same approach.',
          ].join('\n'),
        ),
      );
    }
  }

  // Repair feedback goes last, closest to the model's output, because it is
  // the single most important instruction on a repair attempt.
  if (opts.repairFeedback) {
    volatileParts.push(
      track(
        'repair feedback',
        `\n## Automated verification rejected your last output\n\n${opts.repairFeedback}`,
      ),
    );
  }

  const stable = stableParts.join('\n');
  let volatile = volatileParts.join('\n');

  // Last-resort trim. Sections are dropped from the middle of the volatile
  // half (file contents are the biggest and the most replaceable — the agent
  // can read a file it needs), never from the task brief.
  const total = estimateTokens(stable) + estimateTokens(volatile);
  if (total > maxTokens) {
    volatile = volatileParts.filter((p) => !p.startsWith('\n## Files included')).join('\n');
    budget.push({
      section: 'trimmed to fit budget',
      tokens: -(total - estimateTokens(stable) - estimateTokens(volatile)),
    });
  }

  return {
    stable,
    volatile,
    includedFiles: included,
    budget,
    totalTokens: estimateTokens(stable) + estimateTokens(volatile),
    // What the code map bought: the tokens of the files we described but did
    // not include. This is the number the UI shows as "context saved".
    savedTokens: skippedTokens,
  };
}

function renderSkills(skills: SkillDef[], tokenBudget: number): string {
  const lines = ['## Skills you must apply', ''];
  let used = 40;
  for (const skill of skills.filter((s) => s.enabled)) {
    const block = `### ${skill.name}\n${skill.body.trim()}\n`;
    const cost = estimateTokens(block);
    if (used + cost > tokenBudget) break;
    lines.push(block);
    used += cost;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

async function readFilesWithin(
  root: string,
  relatives: string[],
  tokenBudget: number,
): Promise<{ text: string; included: string[]; skippedTokens: number }> {
  const parts = ['', '## Files included in full', ''];
  const included: string[] = [];
  let used = 20;
  let skippedTokens = 0;

  for (const rel of relatives) {
    const abs = resolveInProject(root, rel);
    if (!abs) continue;

    let content: string;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      // A file the planner expected but that does not exist yet is normal —
      // that is often precisely what the task is for.
      continue;
    }

    const cost = estimateTokens(content);
    if (used + cost > tokenBudget) {
      skippedTokens += cost;
      continue;
    }
    const language = path.extname(rel).slice(1) || 'text';
    parts.push(`### ${rel}\n\`\`\`${language}\n${content}\n\`\`\`\n`);
    included.push(rel);
    used += cost;
  }

  return { text: included.length ? parts.join('\n') : '', included, skippedTokens };
}
