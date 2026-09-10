import type { RoutingDecision, RoutingPolicy, Task } from '@agentic/core';
import {
  BUILTIN_POLICIES,
  DEFAULT_ROUTING_POLICY,
  normalizePolicy,
  scoreCandidates,
  validatePolicy,
} from '@agentic/core';
import fs from 'node:fs';
import path from 'node:path';
import { availableProviders } from './providers/index.js';
import { ensureDir, projectPaths, readJson, writeJsonAtomic } from './paths.js';
import { getProject } from './projects.js';
import { projectState, state } from './store.js';
import { log } from './log.js';

/**
 * The server-side router.
 *
 * `@agentic/core` owns the scoring — it is pure and unit-tested. This module
 * owns the parts that need the world: which policy is active, which providers
 * are up, and how well each provider has actually performed on this project.
 */

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

interface ReliabilityRecord {
  successes: number;
  attempts: number;
}

/** Keyed `providerId:capability`, per project. */
const reliability = new Map<string, Map<string, ReliabilityRecord>>();

function reliabilityFile(root: string): string {
  return path.join(projectPaths(root).base, 'reliability.json');
}

export function loadReliability(projectId: string): void {
  const ps = projectState(projectId);
  if (!ps) return;
  const stored = readJson<Record<string, ReliabilityRecord>>(reliabilityFile(ps.root), {});
  reliability.set(projectId, new Map(Object.entries(stored)));
}

/**
 * Record how an attempt went.
 *
 * This is what turns the router from a static scorer into something that
 * learns: a provider that keeps failing the typecheck on `code` tasks in this
 * project drifts down the ladder without the user having to notice and write a
 * rule about it.
 */
export function recordOutcome(
  projectId: string,
  providerId: string,
  capability: string,
  success: boolean,
): void {
  const ps = projectState(projectId);
  if (!ps) return;

  const map = reliability.get(projectId) ?? new Map<string, ReliabilityRecord>();
  const key = `${providerId}:${capability}`;
  const record = map.get(key) ?? { successes: 0, attempts: 0 };
  record.attempts++;
  if (success) record.successes++;
  map.set(key, record);
  reliability.set(projectId, map);

  ensureDir(projectPaths(ps.root).base);
  writeJsonAtomic(reliabilityFile(ps.root), Object.fromEntries(map));
}

/**
 * Success rates for the scorer.
 *
 * A provider with fewer than three attempts is left out entirely, so the
 * scorer's neutral 0.5 applies. One bad first run should not exile a provider —
 * that is noise, not evidence.
 */
export function reliabilityScores(projectId: string): Record<string, number> {
  const map = reliability.get(projectId);
  if (!map) return {};
  const out: Record<string, number> = {};
  for (const [key, record] of map) {
    if (record.attempts < 3) continue;
    out[key] = record.successes / record.attempts;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export function listPolicies(projectId: string): RoutingPolicy[] {
  const ps = projectState(projectId);
  if (!ps) return [...BUILTIN_POLICIES];

  const dir = projectPaths(ps.root).policies;
  const custom: RoutingPolicy[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const parsed = readJson<Partial<RoutingPolicy> | null>(path.join(dir, name), null);
      if (!parsed) continue;
      const problems = validatePolicy(parsed);
      if (problems.length) {
        log(
          `Routing policy ${name} has ${problems.length} problem(s) and was skipped: ` +
            problems.map((p) => `${p.path} ${p.message}`).join('; '),
          'warn',
          { projectId },
        );
        continue;
      }
      custom.push(normalizePolicy(parsed));
    }
  } catch {
    // No custom policies is the normal case.
  }

  // A custom policy may shadow a built-in by reusing its id — that is how a
  // user edits "Balanced" without losing the ability to reset to it.
  const byId = new Map(BUILTIN_POLICIES.map((p) => [p.id, p]));
  for (const policy of custom) byId.set(policy.id, policy);
  ps.policies = [...byId.values()];
  return ps.policies;
}

export function activePolicy(projectId: string): RoutingPolicy {
  const project = getProject(projectId);
  const wanted = project?.settings.routingPolicyId ?? state.config.routingPolicyId;
  const found = listPolicies(projectId).find((p) => p.id === wanted);
  if (!found) {
    log(`Routing policy "${wanted}" not found — falling back to the default`, 'warn', { projectId });
    return DEFAULT_ROUTING_POLICY;
  }
  return found;
}

export function savePolicy(projectId: string, policy: RoutingPolicy): RoutingPolicy {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  const problems = validatePolicy(policy);
  if (problems.length) {
    throw new Error(
      `Policy is invalid: ${problems.map((p) => `${p.path || 'root'} ${p.message}`).join('; ')}`,
    );
  }

  const dir = projectPaths(ps.root).policies;
  ensureDir(dir);
  const normalized = normalizePolicy(policy);
  writeJsonAtomic(path.join(dir, `${normalized.id}.json`), normalized);
  listPolicies(projectId);
  log(`Saved routing policy "${normalized.name}"`, 'info', { projectId });
  return normalized;
}

export function deletePolicy(projectId: string, policyId: string): boolean {
  const ps = projectState(projectId);
  if (!ps) return false;
  // Built-ins are the reset target; deleting a shadowing file restores them.
  const file = path.join(projectPaths(ps.root).policies, `${policyId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  listPolicies(projectId);
  return true;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RouteTaskOptions {
  projectId: string;
  task: Task;
  contextTokens: number;
  mode: 'instant' | 'professional';
  /** Providers already tried and failed for this task; excluded from the ladder. */
  exclude?: string[];
  expectedOutputTokens?: number;
}

/**
 * Choose a provider for a task, and produce the failover ladder behind it.
 *
 * `exclude` is how failover works: the orchestrator re-routes with the failed
 * provider excluded rather than keeping a stale ladder, so a provider that
 * recovered mid-plan is available again to later tasks, and one that just
 * refused us is not retried for this one.
 */
/**
 * The user's standing choice of who does the work, if they made one.
 *
 * Routing exists because the right model for a migration is not the right
 * model for a rename, and most of the time nobody should have to think about
 * it. But "most of the time" is not "always": someone comparing two models on
 * the same prompt, or spending a budget that is not theirs, or who simply
 * trusts one, has a reason we do not get to weigh against a cost score.
 *
 * A task's own pin still wins, because it is the more specific statement.
 */
function userPreference(projectId: string, task: Task): { providerId?: string; modelId?: string } {
  if (task.pinnedProviderId) {
    return { providerId: task.pinnedProviderId, modelId: task.pinnedModelId };
  }
  const preferred = getProject(projectId)?.settings.preferredProvider;
  if (!preferred?.providerId) return {};

  // A preference for something that is not connected is not an error and not
  // worth a warning every task: the boost simply matches nothing and the
  // ladder routes normally, which is the behaviour someone would want after
  // unplugging a key mid-project.
  return { providerId: preferred.providerId, modelId: preferred.modelId };
}

export function routeTask(opts: RouteTaskOptions): RoutingDecision {
  const policy = activePolicy(opts.projectId);
  const excluded = new Set(opts.exclude ?? []);
  const preference = userPreference(opts.projectId, opts.task);
  const providers = availableProviders().filter((p) => !excluded.has(p.id));

  return scoreCandidates(providers, policy, {
    task: {
      capability: opts.task.capability,
      complexity: opts.task.complexity,
      title: opts.task.title,
      description: opts.task.description,
      role: opts.task.role,
      pinnedProviderId: preference.providerId,
      pinnedModelId: preference.modelId,
      plannedProviderId: opts.task.plannedProviderId,
      plannedModel: opts.task.plannedModel,
    },
    mode: opts.mode,
    contextTokens: opts.contextTokens,
    expectedOutputTokens: opts.expectedOutputTokens,
    reliability: reliabilityScores(opts.projectId),
  });
}

/**
 * Choose a provider for the planning call itself.
 *
 * Planning is the highest-leverage call in a run — a bad decomposition wastes
 * every task after it — so it is routed as a maximum-complexity
 * strong-reasoning task regardless of what the user's policy does elsewhere.
 */
export function routePlanner(
  projectId: string,
  goal: string,
  contextTokens: number,
  mode: 'instant' | 'professional',
): RoutingDecision {
  const policy = activePolicy(projectId);
  // Planning honours the same choice the tasks do. Someone who pinned a model
  // and then watched a different one write their plan would reasonably call
  // the setting broken.
  const preferred = getProject(projectId)?.settings.preferredProvider;
  return scoreCandidates(availableProviders(), policy, {
    task: {
      capability: 'strong-reasoning',
      complexity: 5,
      title: 'Plan the work',
      description: goal,
      role: 'lead',
      pinnedProviderId: preferred?.providerId,
      pinnedModelId: preferred?.modelId,
    },
    mode,
    contextTokens,
    expectedOutputTokens: 8_000,
    reliability: reliabilityScores(projectId),
  });
}
