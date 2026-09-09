import type {
  Capability,
  DevelopmentMode,
  PhaseGate,
  PhaseId,
  Plan,
  PlannerRosterEntry,
  Task,
  TeamRole,
} from '@agentic/core';
import {
  ALL_CAPABILITIES,
  ALL_TEAM_ROLES,
  DEFAULT_PLAN_BUDGET,
  PROFESSIONAL_PHASES,
  ROLE_DEFINITIONS,
  newPlanId,
  newTaskId,
  validateGraph,
} from '@agentic/core';
import { buildCodeMap, renderCodeMap } from './codemap.js';
import { bindingMemory } from './memory.js';
import { profileProject } from './projects.js';
import { routePlanner } from './router.js';
import { availableProviders, getProvider } from './providers/index.js';
import { projectState, savePlan } from './store.js';
import { describeError, log } from './log.js';

/**
 * The planner: one goal in, a validated task DAG out.
 *
 * The planning call is the highest-leverage model call in the product. A bad
 * decomposition wastes every task after it, so it gets the strongest available
 * reasoner regardless of the user's cost policy elsewhere.
 *
 * Everything the model returns is treated as untrusted input. It is parsed,
 * every field is validated against an allow-list, dependencies are checked for
 * cycles, and anything unusable is repaired or dropped — never trusted into
 * the scheduler, which would deadlock the plan.
 */

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}

/** The planner's own contract with the model. Shape is validated on the way back. */
interface TaskSpec {
  id?: string | number;
  title?: string;
  description?: string;
  capability?: string;
  role?: string;
  phase?: string;
  complexity?: number;
  dependsOn?: (string | number)[];
  acceptance?: string[];
  contract?: string;
  files?: string[];
  provider?: string;
  model?: string;
  providerReason?: string;
}

interface PlannerResponse {
  summary?: string;
  tasks?: TaskSpec[];
}

export interface PlanRequestOptions {
  projectId: string;
  goal: string;
  mode: DevelopmentMode;
  signal?: AbortSignal;
  onEvent?: (text: string) => void;
}

export interface PlanResult {
  plan: Plan;
  tasks: Task[];
  /** Provider that produced the graph. */
  plannedBy: string;
  usdSpent: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const INSTANT_RULES = `## How to decompose (Instant mode)

Optimise for wall-clock and token spend. This is the fast lane.

- Size the plan to the goal. A one-line change is ONE task. A small feature is
  2-4. A whole application is 8-14. Never pad a small job into a big plan.
- If the goal touches more than one component, the FIRST task must pin the
  shared structure — stack, folder layout, data model, and the interfaces the
  others implement — and every other task must depend on it. Parallel agents
  that each invent a folder structure produce work that cannot be merged.
- After that, split along seams that let tasks run AT THE SAME TIME: per layer,
  per module, per feature. Two tasks that touch the same file must be ordered
  with dependsOn, never run in parallel.
- Set "files" on every task: the paths that task will create or change. This is
  what the scheduler uses to stop two agents editing one file. Be accurate;
  under-declaring causes conflicts and over-declaring causes false serialisation.`;

const PROFESSIONAL_RULES = `## How to decompose (Full Professional mode)

This is the thorough lane. The user asked for a real SDLC with artefacts and
gates, so produce one — but size it to the goal, not to the ceremony.

- Assign every task a "phase": discovery, design, implementation, verification,
  or release. Phases run in that order and each must complete before the next
  begins, so a task in "implementation" may not depend on one in "verification".
- Assign every task a "role" from the roster. The role determines who writes it
  and what artefact it produces.
- Discovery produces the PRD. Design produces the architecture document and the
  UX spec, and pins every interface. Implementation builds against those.
  Verification writes tests and audits security. Release produces docs, CI and
  the changelog.
- Every implementation task must depend on the design task that pins its
  interfaces. This is what lets several engineers work at once without
  colliding.
- Set "files" on every task so the scheduler can lock them.`;

function plannerPrompt(opts: {
  goal: string;
  mode: DevelopmentMode;
  projectContext: string;
  roster: PlannerRosterEntry[];
}): string {
  const roles = ROLE_DEFINITIONS.map((r) => `- "${r.role}" — ${r.whenToUse}`).join('\n');
  const providers = opts.roster.length
    ? opts.roster
        .map(
          (p) =>
            `- "${p.providerId}" — ${p.label}; good at: ${p.capabilities.join(', ')}; cost: ${p.costNote}`,
        )
        .join('\n')
    : '(none connected — leave "provider" empty)';

  return `You are the lead planning engine of Agentic Team. You turn one request into a
dependency-ordered graph of tasks that a team of AI agents executes IN PARALLEL
against a real codebase, then merges.

Your plan is executed literally. Vagueness becomes a merge conflict.

${opts.mode === 'professional' ? PROFESSIONAL_RULES : INSTANT_RULES}

## Choosing a model for each task

This is the core of the product: the right model for THAT task, not one model
for everything. Assign a "provider" to every task from this list:

${providers}

- Send genuinely hard work — architecture, data modelling, security, tricky
  logic, final synthesis — to the strongest reasoner, whatever it costs.
- Send boilerplate, renames, mechanical refactors and scaffolding to the
  cheapest fast option.
- Send UI and visual work to a provider whose capabilities include "frontend".
- Your choice is a recommendation. If that provider is out of quota when the
  task runs, the router moves the work elsewhere and nothing is lost — so
  choose the best fit rather than hedging.

${opts.mode === 'professional' ? `## Roles\n\n${roles}\n` : ''}
## The project you are working in

${opts.projectContext}

## The goal

${opts.goal}

## Output

Return ONE JSON object and nothing else — no prose before it, no code fence
around it:

{
  "summary": "one or two sentences on the approach you chose and why",
  "tasks": [
    {
      "id": "t1",
      "title": "short imperative title",
      "description": "the full brief for the agent doing this task: what to build, where, and what 'correct' means. Be specific enough that an agent with no other context can do it.",
      "capability": "one of: ${ALL_CAPABILITIES.join(' | ')}",
      "complexity": 1,
      "dependsOn": [],
      "acceptance": ["objectively checkable statement", "another one"],
      "contract": "the exact interface this task's output exposes — signatures, endpoints, file paths — that dependent tasks must code against. Omit only if nothing depends on this task.",
      "files": ["src/path/it/will/write.ts"],
      "provider": "provider id from the list above",
      "providerReason": "one line: why that provider for this task"${
        opts.mode === 'professional'
          ? ',\n      "role": "role from the roster",\n      "phase": "discovery | design | implementation | verification | release"'
          : ''
      }
    }
  ]
}

Rules for the JSON:
- "id" is any unique string; "dependsOn" references those ids.
- "complexity" is 1-5. 5 means "this is the hard part of the whole job".
- The graph must be acyclic. A task may not depend on itself.
- Return between 1 and 20 tasks.`;
}

async function projectContext(projectId: string): Promise<string> {
  const ps = projectState(projectId);
  if (!ps) return 'A new, empty project.';

  const profile = profileProject(ps.root);
  const map = await buildCodeMap(ps.root);
  const memory = bindingMemory(projectId, 800);

  return [
    `Ecosystem: ${profile.ecosystem}${profile.packageManager ? ` (${profile.packageManager})` : ''}`,
    profile.frameworks.length ? `Frameworks: ${profile.frameworks.join(', ')}` : '',
    Object.entries(profile.checks)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: \`${v}\``)
      .join(', ') || 'No automated checks are configured.',
    '',
    map.files.length ? renderCodeMap(map, 1_200) : 'The project is empty — this is a greenfield build.',
    memory ? `\n${memory}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRoster(): PlannerRosterEntry[] {
  return availableProviders().flatMap((adapter) => {
    const model = adapter.models.find((m) => m.id === adapter.defaultModel) ?? adapter.models[0];
    if (!model) return [];
    const free = model.pricing.inputPerMTok === 0 && model.pricing.outputPerMTok === 0;
    return [
      {
        providerId: adapter.id,
        model: model.id,
        label: `${adapter.name} (${model.label})`,
        kind: adapter.kind,
        capabilities: model.capabilities,
        costNote: free
          ? adapter.kind === 'subscription'
            ? 'covered by a subscription you already pay for'
            : 'free'
          : `$${model.pricing.inputPerMTok}/M in, $${model.pricing.outputPerMTok}/M out`,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function createPlan(opts: PlanRequestOptions): Promise<PlanResult> {
  const ps = projectState(opts.projectId);
  if (!ps) throw new PlannerError(`No such project: ${opts.projectId}`);
  if (!opts.goal.trim()) throw new PlannerError('The prompt is empty');

  const context = await projectContext(opts.projectId);
  const roster = buildRoster();
  const prompt = plannerPrompt({ goal: opts.goal, mode: opts.mode, projectContext: context, roster });

  const decision = routePlanner(opts.projectId, opts.goal, Math.ceil(prompt.length / 3.7), opts.mode);
  if (!decision.chosen) {
    throw new PlannerError(
      'No provider is available to plan this work.',
      'Connect a provider in Settings — a free Groq key or a local Ollama model is enough to get started.',
    );
  }

  const adapter = getProvider(decision.chosen.providerId);
  if (!adapter) throw new PlannerError(`Provider ${decision.chosen.providerId} disappeared while planning`);

  log(`Planning with ${decision.chosen.providerName} — ${decision.explanation}`, 'info', {
    projectId: opts.projectId,
  });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let text = '';
  let usdSpent = 0;
  try {
    for await (const event of adapter.stream(
      {
        runId: `plan_${Date.now().toString(36)}`,
        model: decision.chosen.model.id,
        system:
          'You are a senior engineering lead who decomposes work for a team of parallel AI agents. ' +
          'You always reply with a single valid JSON object and nothing else.',
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 16_000,
        cwd: ps.root,
      },
      controller.signal,
    )) {
      if (event.type === 'delta') {
        text += event.text;
        opts.onEvent?.(event.text);
      } else if (event.type === 'done') {
        text = event.text || text;
        usdSpent = event.usage.costUsd;
        adapter.recordUsage(event.usage);
      } else if (event.type === 'error') {
        throw new PlannerError(
          `Planning failed on ${adapter.name}: ${event.error.message}`,
          event.error.kind === 'quota'
            ? 'That provider is out of quota. Connect another, or wait for the window to reset.'
            : undefined,
        );
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  const parsed = parsePlannerResponse(text);
  const { plan, tasks } = materialise({
    projectId: opts.projectId,
    goal: opts.goal,
    mode: opts.mode,
    response: parsed,
    plannedProviderFallback: decision.chosen.providerId,
  });

  ps.plans.push(plan);
  ps.tasks.push(...tasks);
  savePlan(opts.projectId, plan.id);

  log(`Planned "${opts.goal.slice(0, 60)}" into ${tasks.length} task(s) in ${opts.mode} mode`, 'info', {
    projectId: opts.projectId,
    planId: plan.id,
  });

  return { plan, tasks, plannedBy: decision.chosen.providerName, usdSpent };
}

/**
 * Extract JSON from a model response.
 *
 * Models wrap JSON in prose and fences no matter how firmly they are asked not
 * to, so this tries the whole string, then a fenced block, then the outermost
 * brace-balanced span. Failing all three is a real error with the raw text
 * attached — a planner that silently produced no tasks would look like a hang.
 */
export function parsePlannerResponse(text: string): PlannerResponse {
  const attempts: string[] = [text.trim()];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        attempts.push(text.slice(start, i + 1));
        break;
      }
    }
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as PlannerResponse;
      if (Array.isArray(parsed.tasks)) return parsed;
    } catch {
      // Try the next extraction strategy.
    }
  }

  throw new PlannerError(
    'The planner did not return a usable task graph.',
    `It replied with ${text.length} characters that were not valid JSON. Try again, or switch the planning provider in Settings. First 300 characters: ${text.slice(0, 300)}`,
  );
}

// ---------------------------------------------------------------------------
// Validation and materialisation
// ---------------------------------------------------------------------------

function materialise(opts: {
  projectId: string;
  goal: string;
  mode: DevelopmentMode;
  response: PlannerResponse;
  plannedProviderFallback: string;
}): { plan: Plan; tasks: Task[] } {
  const specs = (opts.response.tasks ?? []).slice(0, 20);
  if (!specs.length) {
    throw new PlannerError(
      'The planner returned an empty task list.',
      'Try rephrasing the prompt with more detail.',
    );
  }

  const planId = newPlanId();
  const now = Date.now();

  // Map the planner's arbitrary ids onto real task ids first, so dependencies
  // can be resolved in a second pass.
  const idMap = new Map<string, string>();
  specs.forEach((spec, i) => {
    const key = String(spec.id ?? i + 1);
    idMap.set(key, newTaskId());
    // Models frequently reference tasks by index as well as by id.
    idMap.set(String(i + 1), idMap.get(key)!);
  });

  const validProviders = new Set(availableProviders().map((p) => p.id));

  const tasks: Task[] = specs.map((spec, i) => {
    const id = idMap.get(String(spec.id ?? i + 1))!;

    const dependsOn = [
      ...new Set(
        (spec.dependsOn ?? [])
          .map((dep) => idMap.get(String(dep)))
          .filter((dep): dep is string => Boolean(dep) && dep !== id),
      ),
    ];

    const capability = ALL_CAPABILITIES.includes(spec.capability as Capability)
      ? (spec.capability as Capability)
      : 'code';
    const role =
      opts.mode === 'professional' && ALL_TEAM_ROLES.includes(spec.role as TeamRole)
        ? (spec.role as TeamRole)
        : undefined;
    const phase =
      opts.mode === 'professional'
        ? PROFESSIONAL_PHASES.includes(spec.phase as PhaseId)
          ? (spec.phase as PhaseId)
          : (ROLE_DEFINITIONS.find((r) => r.role === role)?.phase ?? 'implementation')
        : undefined;

    // A planner naming a provider we do not have is not an error — the router
    // will pick one. Dropping the hint is the right handling.
    const plannedProviderId = spec.provider && validProviders.has(spec.provider) ? spec.provider : undefined;

    const complexity = Math.min(5, Math.max(1, Math.round(Number(spec.complexity) || 3)));

    return {
      id,
      planId,
      title: String(spec.title ?? `Task ${i + 1}`).slice(0, 200),
      description: String(spec.description ?? spec.title ?? '').slice(0, 20_000),
      capability,
      role,
      phase,
      dependsOn,
      status: 'planned',
      complexity,
      acceptance: (spec.acceptance ?? []).slice(0, 12).map((text) => ({ text: String(text).slice(0, 500) })),
      contract: spec.contract ? String(spec.contract).slice(0, 8_000) : undefined,
      expectedFiles: (spec.files ?? []).slice(0, 40).map((f) => String(f)),
      plannedProviderId,
      plannedModel: spec.model ? String(spec.model) : undefined,
      plannedReason: spec.providerReason ? String(spec.providerReason).slice(0, 300) : undefined,
      attempts: [],
      // Harder tasks get more retries — they are worth more attempts, and they
      // are the ones a cheap model is most likely to fail first.
      maxAttempts: complexity >= 4 ? 4 : 3,
      worklog: [],
      createdAt: now,
      updatedAt: now,
    };
  });

  repairGraph(tasks, opts.mode);

  const plan: Plan = {
    id: planId,
    projectId: opts.projectId,
    goal: opts.goal,
    mode: opts.mode,
    status: 'awaiting_approval',
    taskIds: tasks.map((t) => t.id),
    phases: opts.mode === 'professional' ? buildPhases(tasks) : [],
    budget: { ...DEFAULT_PLAN_BUDGET },
    spend: { calls: 1, costUsd: 0, tokensIn: 0, tokensOut: 0 },
    summary: opts.response.summary ? String(opts.response.summary).slice(0, 2_000) : undefined,
    createdAt: now,
    updatedAt: now,
  };

  return { plan, tasks };
}

/**
 * Make a model-produced graph safe to schedule.
 *
 * Two failure modes are common and both deadlock a plan, so both are repaired
 * rather than rejected — a plan the user has to re-prompt for is a worse
 * outcome than one whose worst edge was dropped:
 *
 *  1. Cycles. Broken by dropping the back-edge that closes them.
 *  2. Phase inversions (Professional mode) — an implementation task depending
 *     on a verification task. The offending dependency is dropped.
 */
function repairGraph(tasks: Task[], mode: DevelopmentMode): void {
  if (mode === 'professional') {
    const order = new Map(PROFESSIONAL_PHASES.map((p, i) => [p, i]));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const task of tasks) {
      const own = order.get(task.phase ?? 'implementation') ?? 2;
      task.dependsOn = task.dependsOn.filter((depId) => {
        const dep = byId.get(depId);
        const depPhase = order.get(dep?.phase ?? 'implementation') ?? 2;
        if (depPhase > own) {
          log(
            `Planner had "${task.title}" (${task.phase}) depend on a later phase (${dep?.phase}); dropped that dependency`,
            'warn',
          );
          return false;
        }
        return true;
      });
    }
  }

  // Break cycles by dropping the edge that closes each one.
  for (let guard = 0; guard < 50; guard++) {
    try {
      validateGraph(tasks);
      return;
    } catch (err) {
      const cycle = (err as { detail?: { cycle?: string[] } }).detail?.cycle;
      if (!cycle?.length) {
        // A non-cycle validation failure means a dangling dependency slipped
        // through; drop every unknown reference and try again.
        const known = new Set(tasks.map((t) => t.id));
        for (const task of tasks)
          task.dependsOn = task.dependsOn.filter((d) => known.has(d) && d !== task.id);
        continue;
      }
      const from = cycle[cycle.length - 2];
      const to = cycle[cycle.length - 1];
      const task = tasks.find((t) => t.id === from);
      if (task) {
        task.dependsOn = task.dependsOn.filter((d) => d !== to);
        log(
          `Planner produced a dependency cycle; dropped the edge ${from} -> ${to} to make the plan runnable`,
          'warn',
        );
      } else {
        break;
      }
    }
  }

  // Last resort: a graph that still will not validate runs flat rather than
  // not at all. Sequential-by-accident beats deadlocked.
  try {
    validateGraph(tasks);
  } catch (err) {
    log(
      `Could not repair the planner's graph (${describeError(err)}); running all tasks without dependencies`,
      'warn',
    );
    for (const task of tasks) task.dependsOn = [];
  }
}

function buildPhases(tasks: Task[]): PhaseGate[] {
  return PROFESSIONAL_PHASES.map((phase, i) => {
    const taskIds = tasks.filter((t) => t.phase === phase).map((t) => t.id);
    return {
      phase,
      taskIds,
      // The first phase that actually has work is the one that opens.
      status: taskIds.length === 0 ? 'passed' : i === 0 ? 'open' : 'pending',
    };
  });
}
