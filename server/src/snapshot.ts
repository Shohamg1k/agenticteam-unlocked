import type { Snapshot } from '@agentic/core';
import { PROTOCOL_VERSION } from '@agentic/core';
import { activity } from './log.js';
import { listCheckpoints } from './checkpoints.js';
import { previewStates } from './preview.js';
import { listTerminals } from './pty.js';
import { mostExpensiveRates, providerStatuses } from './providers/index.js';
import { usageRollup } from './quota.js';
import { listPolicies } from './router.js';
import { listProjects } from './projects.js';
import { projectState, state } from './store.js';

/**
 * Build the snapshot pushed to clients.
 *
 * One frame carries everything the UI needs, so no panel can disagree with
 * another (see docs/ARCHITECTURE.md). It is scoped to the active project:
 * sending every project's tasks would grow without bound for a user who has
 * opened twenty folders, and no view shows more than one project at a time.
 */
export function buildSnapshot(projectId?: string): Snapshot {
  const activeProjectId = projectId ?? state.activeProjectId;
  const ps = activeProjectId ? projectState(activeProjectId) : undefined;
  const providers = providerStatuses();

  return {
    protocolVersion: PROTOCOL_VERSION,
    seq: state.seq,
    at: Date.now(),
    projects: listProjects(),
    activeProjectId,
    plans: ps?.plans ?? [],
    tasks: ps?.tasks ?? [],
    providers,
    reviewQueue: ps?.reviewQueue ?? [],
    activity: activity.slice(-200).reverse(),
    checkpoints: activeProjectId ? listCheckpoints(activeProjectId) : [],
    memory: ps?.memory ?? [],
    skills: ps?.skills ?? [],
    agents: ps?.agents ?? [],
    plugins: state.plugins,
    connectors: state.connectors,
    policies: activeProjectId ? listPolicies(activeProjectId) : [],
    config: state.config,
    usage: usageRollup(
      providers.map((p) => ({ providerId: p.id, name: p.name })),
      mostExpensiveRates(),
    ),
    previews: previewStates(),
    terminals: listTerminals(),
  };
}
