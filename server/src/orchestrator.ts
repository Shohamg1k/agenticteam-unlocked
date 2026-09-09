import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentProfile,
  AgentRunEvent,
  Capability,
  FileArtifact,
  PhaseId,
  Plan,
  ProviderAdapter,
  RoutingCandidate,
  Task,
  TaskAttempt,
  TokenUsage,
  VerificationReport,
} from '@agentic/core';
import {
  INSTANT_WORKER_PROMPT,
  PROFESSIONAL_PHASES,
  ROLES_BY_ID,
  extractFiles,
  isPlanSettled,
  newRunId,
  normalizeFilePath,
  readyTasks,
  sanitizeRelPath,
  undeclaredFiles,
  unreachableTasks,
} from '@agentic/core';
import { buildCodeMap } from './codemap.js';
import type { CodeMap } from './codemap.js';
import { packContext } from './contextpack.js';
import type { ExecutionProfile } from '@agentic/core';
import { applyOverrides, profileFor, selectAgent } from '@agentic/core';
import { getProvider } from './providers/index.js';
import { recordOutcome, routeTask, activePolicy } from './router.js';
import { projectCheckFeedback, runProjectChecks } from './projectchecks.js';
import { repairFeedback, scanForSecrets, verifyArtifacts } from './verify.js';
import { findPlaceholders, placeholderFeedback, placeholderIssues } from './placeholders.js';
import { runVisualCheck, visualFeedback } from './visual/check.js';
import { auditAutoAccept, checkGate, enqueueReview } from './review.js';
import { takeCheckpoint } from './checkpoints.js';
import { collectWorktreeChanges, createWorktree } from './git.js';
import type { Worktree } from './git.js';
import { startCooldown } from './quota.js';
import { addMemory } from './memory.js';
import { activeSkillsFor, loadAgents } from './skills.js';
import { DEFAULT_AGENT_BY_CAPABILITY } from './library/agents.js';
import { getProject } from './projects.js';
import { changed, projectState, savePlan, tasksOfPlan } from './store.js';
import { describeError, log } from './log.js';
import { resolveInProject } from './paths.js';

/**
 * The orchestrator.
 *
 * One tick loop per running plan. Each tick asks the graph what can start,
 * subject to dependencies, the worker-pool size, phase gates and file locks,
 * then starts those tasks. Workers are independent async functions; the loop
 * itself does no waiting.
 *
 * The properties this module exists to guarantee:
 *
 *  - **Two agents never write the same file.** Enforced by a lock set held
 *    across the whole worker lifetime, not by trusting the planner.
 *  - **A quota death is a hand-off, not a restart.** On a `quota` error the
 *    task keeps its context pack, its worklog and its partial output, and
 *    continues on the next rung of the ladder.
 *  - **Nothing reaches the working tree unverified.** Files are held in memory,
 *    verified in a throwaway worktree, and only written after the gate.
 *  - **A budget ceiling pauses and asks.** It never silently overspends and
 *    never silently stops.
 */

export interface RunHandle {
  planId: string;
  projectId: string;
  cancel: () => void;
}

interface RunState {
  plan: Plan;
  projectId: string;
  /** Task ids currently held by a worker. */
  running: Set<string>;
  /** Normalised file paths held by running tasks. */
  lockedFiles: Set<string>;
  /** Per-task abort controllers, so one lane can be killed without the rest. */
  controllers: Map<string, AbortController>;
  controller: AbortController;
  codeMap?: CodeMap;
  /** Set while the loop is inside a tick, to keep ticks from overlapping. */
  ticking: boolean;
  /** Set when a budget prompt is outstanding. */
  awaitingBudget: boolean;
  timer?: NodeJS.Timeout;
}

const runs = new Map<string, RunState>();

/** Live model output, for the WebSocket stream. Not persisted. */
type RunListener = (taskId: string, event: AgentRunEvent) => void;
const runListeners = new Set<RunListener>();

export function onRunEvent(fn: RunListener): () => void {
  runListeners.add(fn);
  return () => runListeners.delete(fn);
}

function emit(taskId: string, event: AgentRunEvent): void {
  for (const fn of runListeners) {
    try {
      fn(taskId, event);
    } catch {
      // A broken subscriber must not affect the run it is watching.
    }
  }
}

const TICK_MS = 750;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function isRunning(planId: string): boolean {
  return runs.has(planId);
}

export function runningPlans(): string[] {
  return [...runs.keys()];
}

export async function startPlan(projectId: string, planId: string): Promise<RunHandle> {
  const ps = projectState(projectId);
  const plan = ps?.plans.find((p) => p.id === planId);
  if (!ps || !plan) throw new Error(`No such plan: ${planId}`);
  if (runs.has(planId)) throw new Error('That plan is already running');

  plan.status = 'running';
  plan.spend.startedAt ??= Date.now();
  plan.updatedAt = Date.now();

  const run: RunState = {
    plan,
    projectId,
    running: new Set(),
    lockedFiles: new Set(),
    controllers: new Map(),
    controller: new AbortController(),
    ticking: false,
    awaitingBudget: false,
  };
  runs.set(planId, run);

  // One code map per run, not per task: it is the single most expensive thing
  // the context packer does, and it does not change while tasks are queued.
  run.codeMap = await buildCodeMap(ps.root).catch(() => undefined);

  await takeCheckpoint(projectId, `before plan: ${plan.goal.slice(0, 60)}`, { planId });

  log(`Started plan "${plan.goal.slice(0, 60)}" (${plan.mode} mode)`, 'info', { projectId, planId });
  savePlan(projectId, planId);

  run.timer = setInterval(() => void tick(run), TICK_MS);
  run.timer.unref?.();
  void tick(run);

  return { planId, projectId, cancel: () => cancelPlan(planId) };
}

export function pausePlan(planId: string): boolean {
  const run = runs.get(planId);
  if (!run) return false;
  run.plan.status = 'paused';
  stopLoop(run);
  // Running workers are allowed to finish: killing a task mid-flight would
  // throw away tokens already spent for no benefit.
  log(`Paused "${run.plan.goal.slice(0, 60)}" — tasks already running will finish`, 'info', {
    projectId: run.projectId,
    planId,
  });
  savePlan(run.projectId, planId);
  return true;
}

export async function resumePlan(projectId: string, planId: string): Promise<RunHandle> {
  const ps = projectState(projectId);
  const plan = ps?.plans.find((p) => p.id === planId);
  if (!ps || !plan) throw new Error(`No such plan: ${planId}`);
  if (runs.has(planId)) return { planId, projectId, cancel: () => cancelPlan(planId) };
  return startPlan(projectId, planId);
}

export function cancelPlan(planId: string): boolean {
  const run = runs.get(planId);
  if (!run) return false;

  run.controller.abort();
  for (const controller of run.controllers.values()) controller.abort();

  const ps = projectState(run.projectId);
  if (ps) {
    for (const task of tasksOfPlan(ps, planId)) {
      if (task.status === 'running' || task.status === 'verifying' || task.status === 'queued') {
        task.status = 'cancelled';
        task.updatedAt = Date.now();
      }
    }
  }

  run.plan.status = 'cancelled';
  stopLoop(run);
  savePlan(run.projectId, planId);
  log(`Cancelled "${run.plan.goal.slice(0, 60)}"`, 'warn', { projectId: run.projectId, planId });
  return true;
}

/** Kill one task without touching the rest of the plan. */
export function cancelTask(taskId: string): boolean {
  for (const run of runs.values()) {
    const controller = run.controllers.get(taskId);
    if (!controller) continue;
    controller.abort();
    return true;
  }
  return false;
}

function stopLoop(run: RunState): void {
  if (run.timer) clearInterval(run.timer);
  run.timer = undefined;
  runs.delete(run.plan.id);
  changed();
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function tick(run: RunState): Promise<void> {
  if (run.ticking || run.controller.signal.aborted) return;
  run.ticking = true;

  try {
    const ps = projectState(run.projectId);
    if (!ps) return stopLoop(run);
    if (run.plan.status !== 'running') return;

    const tasks = tasksOfPlan(ps, run.plan.id);

    // Fail everything downstream of a failure in one pass, rather than leaving
    // the plan "running" with nothing runnable.
    const stranded = unreachableTasks(tasks);
    for (const task of stranded) {
      task.status = 'failed';
      task.error = 'A task this depends on failed, so this can never run.';
      task.updatedAt = Date.now();
      log(`"${task.title}" can never run — a dependency failed`, 'warn', {
        projectId: run.projectId,
        planId: run.plan.id,
        taskId: task.id,
      });
    }
    if (stranded.length) savePlan(run.projectId, run.plan.id);

    if (run.awaitingBudget) return;
    if (checkBudget(run, tasks)) return;

    const phase = run.plan.mode === 'professional' ? currentPhase(run, tasks) : undefined;
    if (run.plan.mode === 'professional' && !phase) return; // Waiting on a gate.

    const project = getProject(run.projectId);
    const capacity = (project?.settings.maxParallel ?? 3) - run.running.size;
    if (capacity > 0) {
      const ready = readyTasks(tasks, {
        phase,
        running: run.running,
        lockedFiles: run.lockedFiles,
        limit: capacity,
      });
      for (const task of ready) void startWorker(run, task);
    }

    if (!run.running.size && isPlanSettled(tasks)) finishPlan(run, tasks);
  } catch (err) {
    log(`Orchestrator tick failed: ${describeError(err)}`, 'error', {
      projectId: run.projectId,
      planId: run.plan.id,
    });
  } finally {
    run.ticking = false;
  }
}

/**
 * Which phase is open (Professional mode).
 *
 * Returns undefined while a completed phase waits on its gate — that is the
 * gate doing its job, and the tick simply does nothing until a person (or the
 * auto policy) passes it.
 */
function currentPhase(run: RunState, tasks: Task[]): PhaseId | undefined {
  for (const phase of PROFESSIONAL_PHASES) {
    const gate = run.plan.phases.find((g) => g.phase === phase);
    if (!gate || gate.status === 'passed') continue;

    const phaseTasks = tasks.filter((t) => t.phase === phase);
    if (!phaseTasks.length) {
      gate.status = 'passed';
      continue;
    }

    const settled = phaseTasks.every(
      (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled',
    );
    if (!settled) {
      if (gate.status === 'pending') gate.status = 'open';
      return phase;
    }

    // Phase finished. Ask for the gate unless the policy passes it.
    if (gate.status !== 'awaiting_approval') {
      const decision = checkGate({ projectId: run.projectId, kind: 'phase-gate', plan: run.plan });
      const failed = phaseTasks.filter((t) => t.status === 'failed');

      if (decision.allowed && !failed.length) {
        gate.status = 'passed';
        gate.approvedAt = Date.now();
        gate.approvedBy = 'policy';
        log(`Phase "${phase}" passed automatically — ${decision.reason}`, 'info', {
          projectId: run.projectId,
          planId: run.plan.id,
        });
        savePlan(run.projectId, run.plan.id);
        continue;
      }

      gate.status = 'awaiting_approval';
      enqueueReview({
        projectId: run.projectId,
        kind: 'phase-gate',
        planId: run.plan.id,
        title: `Phase gate: ${phase}`,
        detail: [
          `${phaseTasks.length} task(s) in the ${phase} phase have finished.`,
          failed.length
            ? `${failed.length} failed: ${failed.map((t) => t.title).join(', ')}.`
            : 'All succeeded.',
          '',
          'Deliverables:',
          ...phaseTasks.map(
            (t) =>
              `- ${t.title} (${t.status})${t.producedFiles?.length ? ` — ${t.producedFiles.join(', ')}` : ''}`,
          ),
          '',
          'Approve to open the next phase.',
        ].join('\n'),
        options: ['Approve', 'Send back'],
      });
      savePlan(run.projectId, run.plan.id);
    }
    return undefined;
  }
  return undefined;
}

/**
 * Budget guard. Returns true when the plan was paused.
 *
 * "Ask before exceeding" is the default because the alternative — failing at
 * the ceiling — throws away a half-finished plan over a number the user would
 * usually have raised.
 */
function checkBudget(run: RunState, tasks: Task[]): boolean {
  const { budget, spend } = run.plan;
  const elapsedMin = spend.startedAt ? (Date.now() - spend.startedAt) / 60_000 : 0;

  const breach =
    spend.calls >= budget.maxCalls
      ? `${spend.calls} model calls (ceiling ${budget.maxCalls})`
      : spend.costUsd >= budget.maxCostUsd
        ? `$${spend.costUsd.toFixed(2)} spent (ceiling $${budget.maxCostUsd.toFixed(2)})`
        : elapsedMin >= budget.maxWallClockMin
          ? `${Math.round(elapsedMin)} minutes elapsed (ceiling ${budget.maxWallClockMin})`
          : undefined;

  if (!breach) return false;

  const remaining = tasks.filter((t) => t.status === 'planned' || t.status === 'queued').length;
  run.plan.status = 'paused';
  run.awaitingBudget = true;

  if (budget.askBeforeExceeding) {
    enqueueReview({
      projectId: run.projectId,
      kind: 'budget',
      planId: run.plan.id,
      title: 'Budget ceiling reached',
      detail: [
        `This plan has used ${breach}.`,
        `${remaining} task(s) have not started, and ${run.running.size} are still running.`,
        '',
        `Spend so far: $${spend.costUsd.toFixed(4)} across ${spend.calls} calls (${spend.tokensIn.toLocaleString()} in, ${spend.tokensOut.toLocaleString()} out).`,
        '',
        'Raise the ceiling to continue, or stop here.',
      ].join('\n'),
      options: ['Continue (double the ceiling)', 'Stop the plan'],
    });
    log(`Paused "${run.plan.goal.slice(0, 50)}" — ${breach}. Waiting for your decision.`, 'warn', {
      projectId: run.projectId,
      planId: run.plan.id,
    });
  } else {
    run.plan.status = 'failed';
    run.plan.error = `Budget ceiling reached: ${breach}`;
    log(`Stopped "${run.plan.goal.slice(0, 50)}" — ${breach}`, 'warn', {
      projectId: run.projectId,
      planId: run.plan.id,
    });
  }

  stopLoop(run);
  savePlan(run.projectId, run.plan.id);
  return true;
}

/** Raise a plan's ceilings and resume. Called when the user answers the budget card. */
export async function raiseBudgetAndResume(projectId: string, planId: string, factor = 2): Promise<void> {
  const ps = projectState(projectId);
  const plan = ps?.plans.find((p) => p.id === planId);
  if (!ps || !plan) throw new Error(`No such plan: ${planId}`);

  plan.budget.maxCalls = Math.ceil(plan.budget.maxCalls * factor);
  plan.budget.maxCostUsd = Number((plan.budget.maxCostUsd * factor).toFixed(2));
  plan.budget.maxWallClockMin = Math.ceil(plan.budget.maxWallClockMin * factor);
  plan.spend.startedAt = Date.now();

  log(
    `Budget raised to ${plan.budget.maxCalls} calls / $${plan.budget.maxCostUsd} / ${plan.budget.maxWallClockMin} min`,
    'info',
    { projectId, planId },
  );
  savePlan(projectId, planId);
  await resumePlan(projectId, planId);
}

function finishPlan(run: RunState, tasks: Task[]): void {
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const inReview = tasks.filter((t) => t.status === 'review').length;

  run.plan.status = failed && !inReview ? 'failed' : 'completed';
  run.plan.completedAt = Date.now();
  run.plan.updatedAt = Date.now();

  const minutes = run.plan.spend.startedAt ? Math.round((Date.now() - run.plan.spend.startedAt) / 60_000) : 0;
  log(
    `Plan finished: ${tasks.filter((t) => t.status === 'done').length} done, ${inReview} awaiting your review, ` +
      `${failed} failed. ${minutes} min, ${run.plan.spend.calls} calls, $${run.plan.spend.costUsd.toFixed(4)}.`,
    failed ? 'warn' : 'info',
    { projectId: run.projectId, planId: run.plan.id },
  );

  stopLoop(run);
  savePlan(run.projectId, run.plan.id);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/**
 * Run one task to a terminal state.
 *
 * Structure: route -> pack -> execute -> parse -> verify -> gate. A failure at
 * any step either fails over to the next provider (quota, transient) or feeds a
 * repair back to the same one (verification), bounded by `maxAttempts`.
 */
async function startWorker(run: RunState, task: Task): Promise<void> {
  const ps = projectState(run.projectId);
  if (!ps) return;

  run.running.add(task.id);
  const locks = (task.expectedFiles ?? []).map(normalizeFilePath);
  for (const lock of locks) run.lockedFiles.add(lock);

  const controller = new AbortController();
  run.controllers.set(task.id, controller);
  const onPlanAbort = () => controller.abort();
  run.controller.signal.addEventListener('abort', onPlanAbort, { once: true });

  task.status = 'running';
  task.updatedAt = Date.now();
  changed();

  try {
    await executeTask(run, task, controller.signal);
  } catch (err) {
    task.status = 'failed';
    task.error = describeError(err);
    worklog(task, 'orchestrator', `Failed: ${task.error}`, 'error');
    log(`"${task.title}" failed: ${task.error}`, 'error', {
      projectId: run.projectId,
      planId: run.plan.id,
      taskId: task.id,
    });
  } finally {
    run.controller.signal.removeEventListener('abort', onPlanAbort);
    run.controllers.delete(task.id);
    run.running.delete(task.id);
    for (const lock of locks) run.lockedFiles.delete(lock);
    task.updatedAt = Date.now();
    savePlan(run.projectId, run.plan.id);
    void tick(run);
  }
}

async function executeTask(run: RunState, task: Task, signal: AbortSignal): Promise<void> {
  const ps = projectState(run.projectId);
  if (!ps) return;

  /**
   * Who does this task.
   *
   * Three sources, most specific first. A matched specialist beats the role
   * prompt, which beats the generic worker — because "you are a database
   * engineer, and here is what usually goes wrong in a migration" changes the
   * output in a way that "you are a senior engineer" does not.
   *
   * `selectAgent` returns nothing unless a profile clearly fits, and that is
   * the common case rather than a failure: most tasks are not specialist work,
   * and a nearly-right specialist is worse than none, because it makes the
   * model confident about the wrong domain.
   */
  const roster = loadAgents(run.projectId);
  const specialist =
    selectAgent(roster, task) ??
    fallbackSpecialist(roster, task.capability);
  const rolePrompt =
    specialist?.agent.systemPrompt ??
    (task.role
      ? (ROLES_BY_ID.get(task.role)?.systemPrompt ?? INSTANT_WORKER_PROMPT)
      : INSTANT_WORKER_PROMPT);

  if (specialist) {
    worklog(task, 'orchestrator', `Handing this to the ${specialist.agent.name} — ${specialist.reason}.`);
  }

  /**
   * How hard to try, decided once per task.
   *
   * Routing picks who runs the task; this picks how hard they try. It is
   * chosen from the task itself rather than the plan, because a plan almost
   * always mixes a hard piece with several easy ones and charging every one of
   * them frontier-model rates in both money and minutes is where the time went.
   *
   * `projectHasFiles` is the one input that is not the task's own: work that
   * has to fit an existing codebase needs to see it, so a brownfield task never
   * gets the lean-context treatment however simple it looks.
   */
  const profile = applyOverrides(
    profileFor(task, { projectHasFiles: (run.codeMap?.totalFiles ?? 0) > 0 }),
    getProject(run.projectId)?.settings.profileOverrides,
  );
  worklog(
    task,
    'orchestrator',
    `Running this on the "${profile.name}" profile` +
      (profile.tools ? '' : ' — one shot, no tool loop') +
      (profile.projectChecks ? '' : '; project checks are skipped for a task this small'),
  );

  // A lean profile gets fewer skills, not smaller ones. Truncating guidance
  // mid-sentence produces advice that is worse than absent; taking the best
  // three instead of the best six keeps each one intact.
  const skills = activeSkillsFor(
    run.projectId,
    task,
    profile.richContext ? 6 : 3,
    specialist?.agent.skills,
  );

  /** Providers already tried for this task; excluded from re-routing. */
  const triedProviders = new Set<string>();
  let repairBrief: string | undefined;

  while (task.attempts.length < task.maxAttempts) {
    if (signal.aborted) {
      task.status = 'cancelled';
      return;
    }

    // Pack fresh each attempt: a repair brief and prior-attempt notes are part
    // of the pack, so a stale one would repeat the mistake it is repairing.
    const pack = await packContext({
      projectId: run.projectId,
      task,
      plan: run.plan,
      rolePrompt,
      skills,
      repairFeedback: repairBrief,
      codeMap: run.codeMap,
      profile,
    });

    let decision = routeTask({
      projectId: run.projectId,
      task,
      contextTokens: pack.totalTokens,
      mode: run.plan.mode,
      exclude: [...triedProviders],
    });

    if (!decision.chosen) {
      // Nothing left after excluding what has already been tried. If the task
      // still has attempts, fall back to re-routing WITHOUT the exclusions
      // rather than giving up — most people have one provider connected, and
      // retiring it after two failures would strand every task that needed a
      // third attempt. A provider that is genuinely out of quota is still
      // skipped, because its cooldown makes it ineligible on its own.
      const retry =
        triedProviders.size > 0
          ? routeTask({
              projectId: run.projectId,
              task,
              contextTokens: pack.totalTokens,
              mode: run.plan.mode,
            })
          : undefined;

      if (retry?.chosen) {
        worklog(
          task,
          'orchestrator',
          `No untried provider is available, so this retries on ${retry.chosen.providerName} with the feedback from the last attempt.`,
          'warn',
        );
        triedProviders.clear();
        decision = retry;
      } else {
        task.status = 'failed';
        task.error =
          triedProviders.size > 0
            ? `Every available provider failed or is out of quota. Tried: ${[...triedProviders].join(', ')}.`
            : `No provider can run this task. ${decision.rejected[0]?.excluded ?? 'None are connected.'}`;
        worklog(task, 'orchestrator', task.error, 'error');
        return;
      }
    }

    // Narrowed by hand: `decision` may have been reassigned by the fallback
    // above, so TypeScript cannot carry the earlier `chosen` check through.
    const candidate = decision.chosen;
    if (!candidate) {
      task.status = 'failed';
      task.error = 'No provider could be selected for this task.';
      worklog(task, 'orchestrator', task.error, 'error');
      return;
    }

    const adapter = getProvider(candidate.providerId);
    if (!adapter) {
      triedProviders.add(candidate.providerId);
      continue;
    }

    const attemptNumber = task.attempts.length + 1;
    task.providerId = candidate.providerId;
    task.model = candidate.model.id;
    worklog(
      task,
      candidate.providerId,
      attemptNumber === 1
        ? `Attempt ${attemptNumber} on ${candidate.providerName} — ${decision.explanation}`
        : `Attempt ${attemptNumber} on ${candidate.providerName} (continuing from the previous attempt's state)`,
    );
    changed();

    const outcome = await runAttempt({ run, task, pack, adapter, candidate, signal, attemptNumber, profile });

    if (outcome.kind === 'cancelled') {
      task.status = 'cancelled';
      return;
    }

    if (outcome.kind === 'provider-error') {
      triedProviders.add(candidate.providerId);

      if (outcome.error.kind === 'quota') {
        // The hand-off. The pack, the worklog and any partial output stay on
        // the task, so the next rung continues rather than restarts.
        startCooldown(
          candidate.providerId,
          activePolicy(run.projectId).cooldownMs,
          outcome.error.retryAfterMs,
        );
        worklog(
          task,
          candidate.providerId,
          `Hit its usage limit. Handing off to the next provider with the full context pack and worklog — nothing is lost.`,
          'warn',
        );
      } else if (outcome.error.kind === 'auth' || outcome.error.kind === 'unavailable') {
        worklog(
          task,
          candidate.providerId,
          `Unavailable: ${outcome.error.message}. Trying the next provider.`,
          'warn',
        );
      } else {
        worklog(task, candidate.providerId, `Failed: ${outcome.error.message}`, 'error');
      }

      recordOutcome(run.projectId, candidate.providerId, task.capability, false);
      continue;
    }

    if (outcome.kind === 'verification-failed') {
      recordOutcome(run.projectId, candidate.providerId, task.capability, false);
      repairBrief = outcome.feedback;

      // One repair on the same provider, then a different model. See
      // `hasHadItsRepairAttempt` for why this is counted from the attempt log.
      if (hasHadItsRepairAttempt(task, candidate.providerId)) {
        triedProviders.add(candidate.providerId);
        worklog(
          task,
          'orchestrator',
          `Two attempts on ${candidate.providerName} failed verification; routing the repair to a different model.`,
          'warn',
        );
      } else {
        worklog(
          task,
          'orchestrator',
          'Verification failed. Feeding the real errors back for one repair attempt.',
          'warn',
        );
      }
      continue;
    }

    // Success.
    recordOutcome(run.projectId, candidate.providerId, task.capability, true);
    return;
  }

  task.status = 'failed';
  task.error = `Gave up after ${task.attempts.length} attempts across ${triedProviders.size || 1} provider(s).`;
  worklog(task, 'orchestrator', task.error, 'error');
}

/**
 * The specialist for a capability when no profile matched by keyword.
 *
 * See `DEFAULT_AGENT_BY_CAPABILITY` for why this is frontend-only.
 */
function fallbackSpecialist(roster: AgentProfile[], capability: Capability) {
  const name = DEFAULT_AGENT_BY_CAPABILITY[capability];
  if (!name) return undefined;
  const agent = roster.find((a) => a.name === name && a.enabled);
  return agent ? { agent, score: 0, reason: `the default for ${capability} work` } : undefined;
}

/**
 * Has this provider had its one repair attempt on this task?
 *
 * The rule: a provider gets two goes — the original and one repair, because it
 * has the context and produced the near-miss. A second failure means a
 * different model rather than a third try at the same one.
 *
 * Counted from the task's own attempt history, deliberately. The obvious
 * source, `verification.repairs`, is incremented by the verification step
 * *before* this is read, so using it retired the provider on its first failure
 * and the repair attempt never happened at all.
 */
export function hasHadItsRepairAttempt(task: Task, providerId: string): boolean {
  return task.attempts.filter((a) => a.providerId === providerId).length >= 2;
}

type AttemptOutcome =
  | { kind: 'success' }
  | { kind: 'cancelled' }
  | { kind: 'provider-error'; error: { kind: string; message: string; retryAfterMs?: number } }
  | { kind: 'verification-failed'; feedback: string };

async function runAttempt(args: {
  run: RunState;
  task: Task;
  pack: Awaited<ReturnType<typeof packContext>>;
  adapter: ProviderAdapter;
  candidate: RoutingCandidate;
  signal: AbortSignal;
  attemptNumber: number;
  profile: ExecutionProfile;
}): Promise<AttemptOutcome> {
  const { run, task, pack, adapter, candidate, signal, attemptNumber, profile } = args;
  const ps = projectState(run.projectId);
  if (!ps) return { kind: 'cancelled' };

  const runId = newRunId();
  const attempt: TaskAttempt = {
    n: attemptNumber,
    providerId: adapter.id,
    model: candidate.model.id,
    startedAt: Date.now(),
    usage: { input: 0, output: 0, costUsd: 0, measured: false },
    outcome: 'error',
  };
  task.attempts.push(attempt);

  let text = '';
  let usage: TokenUsage | undefined;
  let failure: AttemptOutcome | undefined;
  /** Files a CLI agent wrote into its worktree, collected before disposal. */
  let worktreeFiles: FileArtifact[] = [];

  /**
   * CLI agents edit files directly — that is what they are, and it is why they
   * are worth having. So they get a throwaway worktree as their working
   * directory rather than the user's real folder.
   *
   * Without this, "nothing touches your working tree until you accept it" is
   * true for HTTP adapters and quietly false for CLI ones, which is worse than
   * not promising it at all. HTTP adapters never write files themselves, so
   * they run against the real root and read from it directly.
   */
  let worktree: Worktree | undefined;
  let cwd = ps.root;

  // An agent with no tool loop cannot write a file, so there is nothing to
  // isolate it from. Creating and tearing down a worktree it never touches is
  // a couple of seconds of pure overhead on exactly the tasks that are supposed
  // to be quick.
  const canWriteFiles = adapter.transport === 'cli' && profile.tools;
  if (canWriteFiles) {
    try {
      worktree = await createWorktree(ps.root, `agent-${task.id}`);
      cwd = worktree.dir;
    } catch (err) {
      // Without isolation we will not run a file-editing agent against the
      // user's tree. Failing the attempt is the safe outcome, and the ladder
      // moves the task to a provider that does not need one.
      attempt.outcome = 'error';
      attempt.endedAt = Date.now();
      return {
        kind: 'provider-error',
        error: {
          kind: 'unavailable',
          message:
            `${adapter.name} edits files directly and needs an isolated git worktree, which could not be ` +
            `created (${describeError(err)}). Refusing to run it against your working tree.`,
        },
      };
    }
  }

  const request = {
    runId,
    model: candidate.model.id,
    system: pack.stable,
    messages: [{ role: 'user' as const, content: pack.volatile }],
    cwd,
    cachePrefix: true,
    maxOutputTokens: Math.min(profile.maxOutputTokens, candidate.model.maxOutputTokens),
    profile,
  };

  try {
    const iterator = adapter.execute
      ? adapter.execute(
          {
            runId,
            model: candidate.model.id,
            task,
            context: pack.volatile,
            system: pack.stable,
            cwd,
            profile,
          },
          signal,
        )
      : adapter.stream(request, signal);

    for await (const event of iterator) {
      emit(task.id, event);
      if (event.type === 'delta') text += event.text;
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'done') {
        text = event.text || text;
        usage = event.usage;
      } else if (event.type === 'error') {
        failure =
          event.error.kind === 'cancelled'
            ? { kind: 'cancelled' }
            : { kind: 'provider-error', error: event.error };
      } else if (event.type === 'log' && event.level !== 'info') {
        worklog(task, adapter.id, event.text.slice(0, 500), event.level);
      }
    }

    // Collect what the agent actually wrote, before the worktree is destroyed.
    if (worktree) {
      const changes = await collectWorktreeChanges(worktree.dir);
      worktreeFiles = changes.files;
      if (changes.deleted.length) {
        worklog(
          task,
          adapter.id,
          `It deleted ${changes.deleted.length} file(s) (${changes.deleted.slice(0, 5).join(', ')}). ` +
            'Deletions are not applied automatically — remove them yourself if that was intended.',
          'warn',
        );
      }
      if (changes.truncated) {
        worklog(
          task,
          adapter.id,
          'It changed more files than one task should; only the first 60 are reviewable.',
          'warn',
        );
      }
    }
  } finally {
    await worktree?.dispose();
  }

  // Account for the call whether it succeeded or not — a failed call still
  // spent tokens, and a budget that only counts successes is not a budget.
  if (usage) {
    attempt.usage = usage;
    adapter.recordUsage(usage);
    run.plan.spend.calls++;
    run.plan.spend.costUsd += usage.costUsd;
    run.plan.spend.tokensIn += usage.input;
    run.plan.spend.tokensOut += usage.output;
  } else {
    run.plan.spend.calls++;
  }
  attempt.endedAt = Date.now();

  if (failure) {
    attempt.outcome = failure.kind === 'cancelled' ? 'cancelled' : 'error';
    if (failure.kind === 'provider-error') attempt.error = failure.error as never;
    return failure;
  }

  task.output = text;

  // ---- Parse ----------------------------------------------------------
  // A CLI agent's real output is the files it wrote, not its prose. FILE:
  // blocks are merged in for anything it described but did not write, with the
  // written version winning a conflict — that is the one its own tools saw.
  const described = extractFiles(text);
  const byPath = new Map<string, FileArtifact>();
  for (const file of described) byPath.set(file.path, file);
  for (const file of worktreeFiles) byPath.set(file.path, file);
  const files = [...byPath.values()];

  if (!files.length) {
    attempt.outcome = 'verification-failed';
    return {
      kind: 'verification-failed',
      feedback: [
        'Your response contained no file blocks, so nothing could be applied.',
        '',
        'Emit every file you create or change as:',
        '',
        'FILE: relative/path.ext',
        '```language',
        '<the complete file>',
        '```',
        '',
        'If this task genuinely produces no files, say why in one sentence and emit nothing else.',
      ].join('\n'),
    };
  }

  const strayFiles = undeclaredFiles(files, task.expectedFiles);
  if (strayFiles.length) {
    worklog(
      task,
      adapter.id,
      `Wrote ${strayFiles.length} file(s) it did not declare: ${strayFiles.slice(0, 5).join(', ')}. They are included in the review.`,
      'warn',
    );
  }

  // ---- Tier 1: syntax + secrets ---------------------------------------
  task.status = 'verifying';
  changed();

  const tier1 = await verifyArtifacts(files);
  const secrets = scanForSecrets(files);
  if (secrets.length) {
    tier1.ok = false;
    tier1.issues.push(...secrets);
  }

  // Files the model described instead of writing. Runs here, with the syntax
  // gate, because a placeholder passes a parser: `[content as written above]`
  // is legal enough as HTML, and one really did reach disk as a whole app.
  const placeholders = findPlaceholders(files);
  if (placeholders.length) {
    tier1.ok = false;
    tier1.issues.push(...placeholderIssues(placeholders));
  }

  const previousRepairs = task.verification?.repairs ?? 0;

  if (!tier1.ok) {
    task.verification = { ok: false, tier1, tier2: [], repairs: previousRepairs + 1, at: Date.now() };
    attempt.outcome = 'verification-failed';
    // Placeholder feedback goes first when there is any: it explains the whole
    // failure, whereas a parser error on a placeholder file explains a symptom.
    const feedback = [
      placeholders.length ? placeholderFeedback(placeholders) : repairFeedback(tier1),
      secrets.length
        ? 'Also: remove the credentials found in these files and read them from environment variables instead.'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { kind: 'verification-failed', feedback };
  }

  // ---- Visual: does it actually render? --------------------------------
  //
  // Between the two tiers, and the reason it exists is a run that got all the
  // way through them. A calculator was produced whose CSS grid had a hole in
  // it: one key had a span, every key after it had shifted, and the last sat
  // alone on a row of its own. It parsed. It had no secrets. The project had no
  // test suite to fail. It was accepted as verified, and it was visibly wrong.
  //
  // Nothing had looked at the page. Now something does — rendered from the
  // task's own output, served from memory, so the working tree is still
  // untouched when a human sees the result.
  //
  // It runs on every profile, including the fast one. It is the check that
  // most needs to run there: the fast profile is where single-page apps land,
  // it skips the project's own suite, and a greenfield project has no suite to
  // skip in the first place.
  const visual = await runVisualCheck({
    projectId: run.projectId,
    root: ps.root,
    files,
  });

  if (visual.unavailable) {
    worklog(task, 'verification', visual.unavailable, 'info');
  } else if (!visual.ok) {
    task.verification = {
      ok: false,
      tier1,
      tier2: [visual.check],
      repairs: previousRepairs + 1,
      at: Date.now(),
    };
    attempt.outcome = 'verification-failed';
    worklog(
      task,
      'verification',
      `The page renders wrong: ${visual.check.issues.filter((i) => i.severity === 'error').length} problem(s) found in a real browser.`,
      'warn',
    );
    return { kind: 'verification-failed', feedback: visualFeedback(visual.check) };
  } else {
    worklog(task, 'verification', `Rendered and checked ${visual.check.checked ?? 0} page view(s) — no layout problems.`);
  }

  // ---- Tier 2: the project's own checks --------------------------------
  //
  // Skipped on the fast profile, and recorded as skipped rather than passed.
  // The distinction is the whole point: tier 1 has already parsed every file
  // and scanned it for secrets, so nothing broken is being waved through — but
  // an install plus a test run can take longer than the task did, and a task
  // that creates one greenfield file has no project checks worth running yet.
  const tier2 = profile.projectChecks
    ? await runProjectChecks({
        root: ps.root,
        files,
        label: task.id,
        onProgress: (message) => worklog(task, 'verification', message),
      })
    : {
        ok: true,
        checks: [
          {
            name: 'project checks',
            ok: false,
            skipped: `Not run: this task is on the "${profile.name}" profile, where only the syntax and secret gates apply.`,
            durationMs: 0,
            issues: [],
          },
        ],
        unavailable: undefined,
      };

  if (tier2.unavailable) worklog(task, 'verification', tier2.unavailable, 'warn');

  const report: VerificationReport = {
    ok: tier1.ok && tier2.ok,
    tier1,
    // The visual check is listed alongside the project checks so the review
    // summary says what was looked at. It passed to get here, but "rendered
    // two viewports and found nothing" and "nobody looked" must not read the
    // same in the report — which is why a skipped one is carried too.
    tier2: [visual.check, ...tier2.checks],
    repairs: previousRepairs,
    at: Date.now(),
  };
  task.verification = report;

  if (!tier2.ok) {
    task.verification.repairs = previousRepairs + 1;
    attempt.outcome = 'verification-failed';
    return { kind: 'verification-failed', feedback: projectCheckFeedback(tier2.checks) };
  }

  // ---- The gate --------------------------------------------------------
  attempt.outcome = 'success';
  task.producedFiles = files.map((f) => f.path);

  const decision = checkGate({ projectId: run.projectId, kind: 'task', task, plan: run.plan });

  if (decision.allowed) {
    await applyFiles(run.projectId, task, files);
    task.status = 'done';
    auditAutoAccept(run.projectId, task, decision.reason);
    recordTaskMemory(run.projectId, run.plan, task);
  } else {
    // Hold the files until a person accepts them. Storing them on the task is
    // what makes the review meaningful — the working tree is untouched, so
    // "reject" costs nothing and needs no rollback.
    pendingFiles.set(task.id, files);
    task.status = 'review';
    enqueueReview({
      projectId: run.projectId,
      kind: task.tainted && !task.taintAcknowledgedAt ? 'taint' : 'task',
      planId: run.plan.id,
      taskId: task.id,
      title: task.title,
      detail: [
        decision.reason,
        '',
        `${files.length} file(s): ${files.map((f) => f.path).join(', ')}`,
        '',
        summariseVerification(report),
      ].join('\n'),
      options: ['Accept', 'Reject', 'Send back'],
    });
  }

  return { kind: 'success' };
}

/** Files produced by a task and waiting for a human. Deliberately in memory. */
const pendingFiles = new Map<string, FileArtifact[]>();

export function pendingFilesFor(taskId: string): FileArtifact[] | undefined {
  return pendingFiles.get(taskId);
}

export function clearPendingFiles(taskId: string): void {
  pendingFiles.delete(taskId);
}

/**
 * Write accepted files into the user's real project folder.
 *
 * A checkpoint is taken first, so the acceptance is reversible in one click.
 */
export async function applyFiles(projectId: string, task: Task, files: FileArtifact[]): Promise<string[]> {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  await takeCheckpoint(projectId, `before applying: ${task.title}`, { planId: task.planId, taskId: task.id });

  const written: string[] = [];
  for (const file of files) {
    const safe = sanitizeRelPath(file.path);
    if (!safe) {
      worklog(task, 'orchestrator', `Refused an unsafe path from the model: ${file.path}`, 'warn');
      continue;
    }
    const abs = resolveInProject(ps.root, safe);
    if (!abs) continue;

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, file.content, 'utf8');
    written.push(safe);
  }

  task.producedFiles = written;
  await takeCheckpoint(projectId, `applied: ${task.title}`, { planId: task.planId, taskId: task.id });
  pendingFiles.delete(task.id);

  log(`Applied ${written.length} file(s) from "${task.title}"`, 'info', {
    projectId,
    planId: task.planId,
    taskId: task.id,
  });
  return written;
}

/**
 * Record what a task established, so later tasks and later plans inherit it.
 * A task with a contract is recording a decision other work must obey, which is
 * exactly what belongs in shared memory.
 */
function recordTaskMemory(projectId: string, plan: Plan, task: Task): void {
  if (!task.contract) return;
  try {
    addMemory(projectId, {
      kind: task.role === 'architect' ? 'architecture' : 'decision',
      title: task.title,
      body: [task.contract, '', `Files: ${(task.producedFiles ?? []).join(', ') || 'none'}`].join('\n'),
      tags: [plan.mode, task.capability, ...(task.role ? [task.role] : [])],
      sourceTaskId: task.id,
      sourcePlanId: plan.id,
    });
  } catch (err) {
    log(`Could not record memory for "${task.title}": ${describeError(err)}`, 'warn', { projectId });
  }
}

function summariseVerification(report: VerificationReport): string {
  const lines = [`Syntax: ${report.tier1.ok ? 'passed' : 'FAILED'} (${report.tier1.checked} file(s) parsed)`];
  for (const check of report.tier2) {
    lines.push(
      check.skipped
        ? `${check.name}: skipped — ${check.skipped}`
        : `${check.name}: ${check.ok ? 'passed' : 'FAILED'}`,
    );
  }
  if (report.repairs) lines.push(`Repaired itself ${report.repairs} time(s) before passing.`);
  return lines.join('\n');
}

function worklog(task: Task, actor: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  task.worklog.push({ ts: Date.now(), actor, text, level });
  // The worklog travels with the task across providers on failover, so it is
  // bounded — an unbounded one would grow the context pack every hand-off.
  if (task.worklog.length > 200) task.worklog.splice(0, task.worklog.length - 200);
  task.updatedAt = Date.now();
}

export { worklog as appendWorklog };
