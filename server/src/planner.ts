import type {
  Capability,
  ClarifyingAnswer,
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
  plannerProfile,
  validateGraph,
} from '@agentic/core';
import { applyAnswers } from './clarify.js';
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
  /** What the user said when asked about the ambiguous parts of the prompt. */
  answers?: ClarifyingAnswer[];
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

/**
 * The complexity rubric.
 *
 * Shared by both modes because it is not a matter of taste: `complexity` is now
 * load-bearing. It selects the execution profile, which selects the model tier,
 * the reasoning effort, whether the agent gets a tool loop, and whether the
 * project's own test suite runs afterwards. A calculator scored 3 instead of 2
 * once, and the difference was two extra minutes of an agent exploring an empty
 * repository for a file it was about to create.
 *
 * So the rubric is concrete and anchored on examples rather than adjectives.
 * "Moderate" means nothing to a model; "one file, no dependencies, no existing
 * code to fit into" means one thing.
 */
const COMPLEXITY_RUBRIC = `## Scoring complexity

"complexity" is 1-5 and it is not a label — it decides how much model, how much
reasoning effort, and how much verification the task gets. Over-scoring wastes
minutes per task; under-scoring hands hard work to a weak configuration. Score
the work in front of you, not the impressiveness of the goal.

1 — Mechanical. A rename, a config value, a constant, a copy change. No
    judgement required; a careful person does it without thinking.
2 — Self-contained. One or two files written from a clear brief, no existing
    code to fit into, no shared interfaces. A single-page app, a utility module,
    a component with obvious props, a CRUD endpoint over a defined schema.
3 — Integrative. Must fit existing code, or implement a contract another task
    depends on, or touch several files that have to agree with each other.
4 — Design-bearing. Data modelling, a non-obvious algorithm, concurrency, state
    machines, migrations, auth flows. Getting it wrong is expensive to unwind.
5 — The hard part of the whole job. If more than one task in your plan is a 5,
    at most one of them really is.

Most tasks in a small plan are 2. A greenfield single-file deliverable is a 2
even when the finished thing looks impressive.`;

/**
 * The section that decides whether the plan produces something usable or
 * something that merely runs.
 *
 * A calendar tracker built from this planner let a user mark a day in the PAST
 * as "waiting". Nothing in the pipeline was wrong: the plan was sensible, the
 * task ran, the code compiled, the page rendered, verification passed. The
 * brief simply never said what "waiting" means relative to today, so the agent
 * never decided, and an app that looks finished shipped with a rule missing.
 *
 * Acceptance criteria are where that gets fixed, because they are the one part
 * of the plan the executing agent is graded against.
 */
const DOMAIN_RULES = `## The rules of the thing being built

Work out what is TRUE about the domain and put it in the plan. This is the
difference between a project someone can use and a project that merely runs,
and it is the step that is always skipped.

For the goal in front of you, decide:

- **What can each thing BE, and what follows what.** "Waiting", "done" and
  "overdue" are three states with legal moves between them. If the plan does not
  name them, the interface will let a user reach a combination nobody
  considered — and that is exactly what they will call a bug.
- **What is impossible.** A task waiting on a day that has already passed. A
  quantity below one. An end before its start. A negative total. Every rule you
  leave out is a defect you have already shipped.
- **What moves on its own.** Anything derived from the current date has to still
  be true tomorrow: "today" is computed at runtime, never hard-coded, and
  something scheduled in the past is overdue rather than upcoming.
- **What the first run looks like.** No data, nothing saved, no history. It is
  the first thing a new user sees and the state most often left unhandled.
- **What has to survive a reload.** If a person typed it in, they expect it back
  after a refresh. With no backend that means localStorage, and it is three
  lines — but only if the plan asks for it.

Then write those into the "acceptance" array of the task that owns them, as
statements a reviewer could check by using the app: "a date before today cannot
be saved as waiting, and the app says why", not "handles dates correctly".

Every deliverable a person will open also carries these, whether or not the
request mentioned them: it works on a phone and on a desktop, every action gives
visible feedback, and nothing it can be asked to do leaves it in a broken state.`;

const INSTANT_RULES = `## How to decompose (Instant mode)

Optimise for wall-clock and token spend. This is the fast lane, and the user
chose it because they want a working result in a minute, not a process.

- Size the plan to the goal. A one-line change is ONE task. A small feature is
  2-4. A whole application is 8-14. Never pad a small job into a big plan: each
  task costs a model call, a verification pass and a hand-off, so a plan with
  four tasks where one would do is four times slower for the same output.
- ONE task is the right answer more often than it feels. If a single agent could
  produce the whole deliverable in one pass — a single-page app, a script, a
  component and its test — that is one task, not four.
- If the goal genuinely touches more than one component, the FIRST task must pin
  the shared structure — stack, folder layout, data model, and the interfaces
  the others implement — and every other task must depend on it. Parallel agents
  that each invent a folder structure produce work that cannot be merged.
- After that, split along seams that let tasks run AT THE SAME TIME: per layer,
  per module, per feature. Two tasks that touch the same file must be ordered
  with dependsOn, never run in parallel.
- Set "files" on every task: the paths that task will create or change. This is
  what the scheduler uses to stop two agents editing one file. Be accurate;
  under-declaring causes conflicts and over-declaring causes false
  serialisation, which quietly turns a parallel plan into a sequential one.`;

const PROFESSIONAL_RULES = `## How to decompose (Full Professional mode)

This is the thorough lane. The user asked for a real SDLC with artefacts and
gates, so produce one — but size it to the goal, not to the ceremony. A plan
whose documentation outweighs its software has failed at being professional.

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
  colliding, and it is the single most important edge in the graph.
- Give the design task a real contract to produce: the folder tree, the data
  model, and the exact signatures the implementation tasks will code against.
  "Design the architecture" produces prose; "produce docs/ARCHITECTURE.md
  pinning the file tree, the entity fields, and every endpoint's request and
  response shape" produces something the next agent can obey.
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

${DOMAIN_RULES}

${COMPLEXITY_RUBRIC}

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
      "acceptance": ["objectively checkable statement — include the domain rules from the section above, e.g. 'a task cannot be saved as waiting on a date that has already passed, and the message says why'", "another one"],
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
- "complexity" is 1-5, scored by the rubric above. It is load-bearing, not decorative.
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
  // The answers go into the goal the PLANNER reads, not the one the plan
  // stores: the decomposition has to know what was settled, while the card in
  // the UI should still say the sentence the user typed.
  const goal = applyAnswers(opts.goal, opts.answers ?? []);
  const prompt = plannerPrompt({ goal, mode: opts.mode, projectContext: context, roster });

  const decision = routePlanner(opts.projectId, goal, Math.ceil(prompt.length / 3.7), opts.mode);
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
          'You know that the cost of a plan is paid by every task in it, so you produce the smallest ' +
          'graph that genuinely does the job, and you score each task honestly rather than generously. ' +
          'You always reply with a single valid JSON object and nothing else.',
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 16_000,
        cwd: ps.root,
        profile: plannerProfile(opts.mode),
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
