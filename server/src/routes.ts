import express from 'express';
import type { Request, Response, Router } from 'express';
import type {
  ApplyDiffRequest,
  ExecutionMode,
  CreatePlanRequest,
  FileDiff,
  ScopedEditRequest,
  TaskDiff,
} from '@agentic/core';
import { applySelectedHunks, fileDiff, looksBinary } from './diff.js';
import { checkGate, closeReviewsFor, enqueueReview, resolveReview } from './review.js';
import {
  applyFiles,
  cancelPlan,
  cancelTask,
  clearPendingFiles,
  pausePlan,
  pendingFilesFor,
  raiseBudgetAndResume,
  resumePlan,
  startPlan,
} from './orchestrator.js';
import { createPlan, PlannerError } from './planner.js';
import {
  closeProject,
  openProject,
  ProjectError,
  profileProject,
  saveProjectSettings,
  setActiveProject,
} from './projects.js';
import {
  createDirectory,
  deleteFile,
  FsError,
  readDirectory,
  readFile,
  renameEntry,
  searchProject,
  writeFile,
} from './fsapi.js';
import { deletePolicy, listPolicies, savePolicy } from './router.js';
import { deleteAgent, deleteSkill, loadAgents, loadSkills, saveAgent, saveSkill } from './skills.js';
import { addMemory, deleteMemory, loadMemory, searchMemory, updateMemory } from './memory.js';
import { listCheckpoints, rollbackTo } from './checkpoints.js';
import {
  clearPreviewTelemetry,
  recordConsole,
  recordNetworkError,
  startPreview,
  stopPreview,
} from './preview.js';
import { closeTerminal, createTerminal } from './pty.js';
import { deleteSecret, hasSecret, listAccounts, setSecret, vaultBackend } from './vault.js';
import { probeAll, providerStatuses, setAgentPermissions, setProviderAccount } from './providers/index.js';
import { resetLedger, setActiveAccount } from './quota.js';
import { evaluateCommand } from './sandbox.js';
import { buildSnapshot } from './snapshot.js';
import { changed, findPlan, findTask, projectState, saveNodeConfig, state } from './store.js';
import { workingDiff } from './git.js';
import { describeError, log } from './log.js';
import { installPlugin, listPlugins, uninstallPlugin } from './plugins.js';
import { callConnectorTool, listConnectorTools, refreshConnectors } from './connectors/index.js';

/**
 * HTTP routes.
 *
 * Two conventions hold throughout:
 *
 *  1. **Every write-class route calls `checkGate` explicitly.** ADR 0004
 *     explains why this is repeated rather than factored into a middleware:
 *     a middleware needs a list of which routes are write-class, that list
 *     goes stale as routes are added, and a stale list fails open.
 *
 *  2. **Errors carry a hint.** A 400 that says what to do next is the
 *     difference between a bug report and a fixed problem.
 */

function ok<T>(res: Response, body: T): void {
  res.json(body);
}

function fail(res: Response, status: number, error: string, hint?: string, code?: string): void {
  res.status(status).json({ error, hint, code });
}

/** Wrap an async handler so a rejected promise becomes a 500, not a hang. */
function handler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof FsError) return fail(res, err.status, err.message, err.hint);
      if (err instanceof ProjectError) return fail(res, 400, err.message, err.hint);
      if (err instanceof PlannerError) return fail(res, 502, err.message, err.hint);
      log(`${req.method} ${req.path} failed: ${describeError(err)}`, 'error');
      fail(res, 500, describeError(err));
    });
  };
}

/** Resolve `projectId` from the query/body, defaulting to the active project. */
function requireProjectId(req: Request): string {
  const id = String(req.query.projectId ?? req.body?.projectId ?? state.activeProjectId ?? '');
  if (!id) throw new ProjectError('No project is open', 'Open a folder first.');
  if (!projectState(id)) throw new ProjectError(`No such project: ${id}`);
  return id;
}

export function buildRouter(): Router {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // Snapshot and config
  // -------------------------------------------------------------------------

  router.get(
    '/snapshot',
    handler((req, res) => {
      ok(res, buildSnapshot(req.query.projectId ? String(req.query.projectId) : undefined));
    }),
  );

  router.get('/health', (_req, res) => {
    res.json({ ok: true, protocolVersion: 1, vault: vaultBackend() });
  });

  router.patch(
    '/config',
    handler((req, res) => {
      const patch = req.body ?? {};
      // Explicit per-key assignment, not a spread: a client must not be able to
      // introduce config keys the server never declared.
      if (
        patch.executionMode === 'approval' ||
        patch.executionMode === 'hybrid' ||
        patch.executionMode === 'auto'
      ) {
        // The gate is the product's central safety property, so a change to it
        // is audited. Relaxing it is logged as a warning: a user who finds
        // their work auto-applying must be able to see, in the activity feed,
        // when that stopped requiring them and never have to guess.
        const previous = state.config.executionMode;
        const next: ExecutionMode = patch.executionMode;
        if (previous !== next) {
          const strictness: Record<ExecutionMode, number> = { approval: 0, hybrid: 1, auto: 2 };
          const relaxed = strictness[next] > strictness[previous];
          log(
            `Human gate changed from "${previous}" to "${next}"` +
              (relaxed
                ? ' — verified work will now be applied to your project with less review.'
                : ' — more work will now wait for you.'),
            relaxed ? 'warn' : 'info',
          );
        }
        state.config.executionMode = next;
      }
      if (typeof patch.maxParallel === 'number') {
        state.config.maxParallel = Math.min(12, Math.max(1, Math.round(patch.maxParallel)));
      }
      if (typeof patch.routingPolicyId === 'string') state.config.routingPolicyId = patch.routingPolicyId;
      if (['system', 'light', 'dark', 'high-contrast'].includes(patch.theme))
        state.config.theme = patch.theme;
      if (typeof patch.onboarded === 'boolean') state.config.onboarded = patch.onboarded;
      if (Array.isArray(patch.disabledProviders))
        state.config.disabledProviders = patch.disabledProviders.map(String);
      if (Array.isArray(patch.allowedCommands))
        state.config.allowedCommands = patch.allowedCommands.map(String);
      if (Array.isArray(patch.deniedCommands)) state.config.deniedCommands = patch.deniedCommands.map(String);
      if (patch.agentPermissions === 'yolo' || patch.agentPermissions === 'manual') {
        setAgentPermissions(patch.agentPermissions);
      }
      saveNodeConfig();
      ok(res, state.config);
    }),
  );

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  router.post(
    '/projects/open',
    handler(async (req, res) => {
      const root = String(req.body?.root ?? '');
      if (!root) return fail(res, 400, 'A folder path is required', 'Pick a folder to open as a project.');
      ok(res, await openProject(root, req.body?.name));
    }),
  );

  router.post(
    '/projects/:id/activate',
    handler((req, res) => {
      setActiveProject(req.params.id!);
      ok(res, { activeProjectId: state.activeProjectId });
    }),
  );

  router.delete(
    '/projects/:id',
    handler((req, res) => {
      closeProject(req.params.id!);
      ok(res, { closed: true });
    }),
  );

  router.patch(
    '/projects/:id/settings',
    handler((req, res) => {
      ok(res, saveProjectSettings(req.params.id!, req.body ?? {}));
    }),
  );

  router.get(
    '/projects/:id/profile',
    handler((req, res) => {
      const ps = projectState(req.params.id!);
      if (!ps) return fail(res, 404, 'No such project');
      ok(res, profileProject(ps.root));
    }),
  );

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  router.get(
    '/files/tree',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      ok(res, await readDirectory(ps.root, String(req.query.path ?? '')));
    }),
  );

  router.get(
    '/files/read',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      const path = String(req.query.path ?? '');
      if (!path) return fail(res, 400, 'A file path is required');
      ok(res, await readFile(ps.root, path));
    }),
  );

  router.put(
    '/files/write',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      const { path, content } = req.body ?? {};
      if (typeof path !== 'string' || typeof content !== 'string') {
        return fail(res, 400, 'path and content are required');
      }
      ok(res, await writeFile(ps.root, path, content));
    }),
  );

  router.post(
    '/files/mkdir',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      await createDirectory(ps.root, String(req.body?.path ?? ''));
      ok(res, { created: true });
    }),
  );

  router.post(
    '/files/rename',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      await renameEntry(ps.root, String(req.body?.from ?? ''), String(req.body?.to ?? ''));
      ok(res, { renamed: true });
    }),
  );

  router.delete(
    '/files',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      await deleteFile(ps.root, String(req.query.path ?? ''));
      ok(res, { deleted: true });
    }),
  );

  router.get(
    '/files/search',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      const query = String(req.query.q ?? '');
      if (!query) return fail(res, 400, 'A search query is required');
      ok(
        res,
        await searchProject(ps.root, {
          query,
          regex: req.query.regex === 'true',
          caseSensitive: req.query.case === 'true',
          extensions: req.query.ext ? String(req.query.ext).split(',') : undefined,
        }),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  router.post(
    '/plans',
    handler(async (req, res) => {
      const body = req.body as CreatePlanRequest;
      const projectId = requireProjectId(req);
      const mode = body.mode === 'professional' ? 'professional' : 'instant';

      const result = await createPlan({ projectId, goal: String(body.goal ?? ''), mode });
      if (body.executionMode) result.plan.executionMode = body.executionMode;

      if (body.autoStart) await startPlan(projectId, result.plan.id);
      ok(res, { plan: result.plan, tasks: result.tasks, plannedBy: result.plannedBy });
    }),
  );

  router.post(
    '/plans/:id/start',
    handler(async (req, res) => {
      const found = findPlan(req.params.id!);
      if (!found) return fail(res, 404, 'No such plan');
      await startPlan(found.ps.projectId, found.plan.id);
      ok(res, { started: true });
    }),
  );

  router.post(
    '/plans/:id/pause',
    handler((req, res) => {
      ok(res, { paused: pausePlan(req.params.id!) });
    }),
  );

  router.post(
    '/plans/:id/resume',
    handler(async (req, res) => {
      const found = findPlan(req.params.id!);
      if (!found) return fail(res, 404, 'No such plan');
      await resumePlan(found.ps.projectId, found.plan.id);
      ok(res, { resumed: true });
    }),
  );

  router.post(
    '/plans/:id/cancel',
    handler((req, res) => {
      ok(res, { cancelled: cancelPlan(req.params.id!) });
    }),
  );

  router.patch(
    '/plans/:id/budget',
    handler((req, res) => {
      const found = findPlan(req.params.id!);
      if (!found) return fail(res, 404, 'No such plan');
      Object.assign(found.plan.budget, req.body ?? {});
      changed();
      ok(res, found.plan.budget);
    }),
  );

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  router.post(
    '/tasks/:id/cancel',
    handler((req, res) => {
      ok(res, { cancelled: cancelTask(req.params.id!) });
    }),
  );

  router.patch(
    '/tasks/:id',
    handler((req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');
      const { pinnedProviderId, complexity, description, title } = req.body ?? {};
      if (pinnedProviderId !== undefined) found.task.pinnedProviderId = pinnedProviderId || undefined;
      if (typeof complexity === 'number')
        found.task.complexity = Math.min(5, Math.max(1, Math.round(complexity)));
      if (typeof description === 'string') found.task.description = description;
      if (typeof title === 'string') found.task.title = title;
      found.task.updatedAt = Date.now();
      changed();
      ok(res, found.task);
    }),
  );

  /** The diff a task is proposing, before anything is written. */
  router.get(
    '/tasks/:id/diff',
    handler(async (req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');

      const pending = pendingFilesFor(found.task.id);
      if (!pending) return ok(res, { taskId: found.task.id, files: [] } satisfies TaskDiff);

      const files: FileDiff[] = [];
      for (const artifact of pending) {
        let before: string | null = null;
        try {
          before = (await readFile(found.ps.root, artifact.path)).content;
        } catch {
          // The file does not exist yet: this is an addition.
        }
        if (looksBinary(artifact.content)) {
          files.push({
            path: artifact.path,
            status: before === null ? 'added' : 'modified',
            hunks: [],
            binary: true,
          });
        } else {
          files.push(fileDiff(artifact.path, before, artifact.content));
        }
      }
      ok(res, { taskId: found.task.id, files } satisfies TaskDiff);
    }),
  );

  /**
   * Accept a task's output, optionally hunk by hunk.
   *
   * The human gate is checked here even though the user is the one calling it:
   * a tainted task needs an explicit acknowledgement first, and this route is
   * where that is enforced rather than assumed.
   */
  router.post(
    '/tasks/:id/apply',
    handler(async (req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');

      const pending = pendingFilesFor(found.task.id);
      if (!pending)
        return fail(res, 409, 'This task has no pending files', 'It may already have been applied.');

      if (found.task.tainted && !found.task.taintAcknowledgedAt) {
        return fail(
          res,
          403,
          'This task carries content from outside your project and has not been acknowledged.',
          `Acknowledge the external content first (source: ${found.task.taintSource ?? 'unknown'}).`,
          'taint-unacknowledged',
        );
      }

      const body = req.body as ApplyDiffRequest;
      let files = pending;

      // Partial acceptance: rebuild each file from the hunks the user kept.
      if (body?.selection?.length) {
        const selection = new Map(body.selection.map((s) => [s.path, new Set(s.hunkIds)]));
        files = [];
        for (const artifact of pending) {
          const hunkIds = selection.get(artifact.path);
          if (!hunkIds) continue;
          let before = '';
          try {
            before = (await readFile(found.ps.root, artifact.path)).content;
          } catch {
            before = '';
          }
          files.push({
            path: artifact.path,
            content: applySelectedHunks(before, artifact.content, [...hunkIds]),
          });
        }
      }

      const written = await applyFiles(found.ps.projectId, found.task, files);
      found.task.status = 'done';
      found.task.updatedAt = Date.now();
      closeReviewsFor(found.ps.projectId, found.task.id);
      changed();
      ok(res, { applied: written });
    }),
  );

  router.post(
    '/tasks/:id/reject',
    handler((req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');
      clearPendingFiles(found.task.id);
      found.task.status = 'failed';
      found.task.error = String(req.body?.reason ?? 'Rejected by you');
      found.task.updatedAt = Date.now();
      closeReviewsFor(found.ps.projectId, found.task.id);
      changed();
      // Nothing to roll back: rejected files never reached the working tree.
      ok(res, { rejected: true });
    }),
  );

  /** Send a task back for another attempt, with the user's feedback. */
  router.post(
    '/tasks/:id/send-back',
    handler((req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');
      const feedback = String(req.body?.feedback ?? '').trim();
      if (!feedback) return fail(res, 400, 'Feedback is required', 'Say what needs to change.');

      clearPendingFiles(found.task.id);
      found.task.description = `${found.task.description}\n\n## Revision requested by the user\n\n${feedback}`;
      found.task.status = 'queued';
      found.task.worklog.push({
        ts: Date.now(),
        actor: 'human',
        text: `Sent back: ${feedback}`,
        level: 'info',
      });
      found.task.updatedAt = Date.now();
      closeReviewsFor(found.ps.projectId, found.task.id);
      changed();
      ok(res, { sentBack: true });
    }),
  );

  /** Acknowledge external content on a tainted task. Deliberately separate from approval. */
  router.post(
    '/tasks/:id/acknowledge-taint',
    handler((req, res) => {
      const found = findTask(req.params.id!);
      if (!found) return fail(res, 404, 'No such task');
      if (!found.task.tainted) return fail(res, 400, 'This task is not tainted');
      found.task.taintAcknowledgedAt = Date.now();
      found.task.updatedAt = Date.now();
      log(`External content acknowledged on "${found.task.title}"`, 'warn', {
        projectId: found.ps.projectId,
        taskId: found.task.id,
      });
      changed();
      ok(res, { acknowledged: true });
    }),
  );

  // -------------------------------------------------------------------------
  // Review queue
  // -------------------------------------------------------------------------

  router.post(
    '/review/:id/resolve',
    handler(async (req, res) => {
      const projectId = requireProjectId(req);
      const status = String(req.body?.status ?? 'approved') as
        'approved' | 'rejected' | 'sent-back' | 'answered';
      const item = resolveReview(projectId, req.params.id!, status, req.body?.answer);
      if (!item) return fail(res, 404, 'No such review item');

      // A budget card's answer decides whether the plan continues.
      if (item.kind === 'budget' && item.planId) {
        if (status === 'approved') await raiseBudgetAndResume(projectId, item.planId);
        else cancelPlan(item.planId);
      }

      // A phase gate's approval opens the next phase.
      if (item.kind === 'phase-gate' && item.planId) {
        const found = findPlan(item.planId);
        const gate = found?.plan.phases.find((g) => g.status === 'awaiting_approval');
        if (found && gate) {
          if (status === 'approved') {
            gate.status = 'passed';
            gate.approvedAt = Date.now();
            gate.approvedBy = 'you';
            await resumePlan(projectId, item.planId);
          } else {
            gate.status = 'failed';
            cancelPlan(item.planId);
          }
        }
      }

      ok(res, item);
    }),
  );

  // -------------------------------------------------------------------------
  // Git and checkpoints
  // -------------------------------------------------------------------------

  router.get(
    '/git/diff',
    handler(async (req, res) => {
      const ps = projectState(requireProjectId(req))!;
      ok(res, { diff: await workingDiff(ps.root) });
    }),
  );

  router.get(
    '/checkpoints',
    handler((req, res) => {
      ok(res, listCheckpoints(requireProjectId(req)));
    }),
  );

  router.post(
    '/checkpoints/:id/rollback',
    handler(async (req, res) => {
      const projectId = requireProjectId(req);
      ok(res, await rollbackTo(projectId, req.params.id!));
    }),
  );

  // -------------------------------------------------------------------------
  // Providers, accounts and secrets
  // -------------------------------------------------------------------------

  router.get(
    '/providers',
    handler((_req, res) => {
      ok(res, providerStatuses());
    }),
  );

  router.post(
    '/providers/probe',
    handler(async (_req, res) => {
      await probeAll();
      ok(res, providerStatuses());
    }),
  );

  /**
   * Store a credential. The value never comes back out: the response says only
   * whether a key is now present.
   */
  router.put(
    '/providers/:id/key',
    handler(async (req, res) => {
      const value = String(req.body?.key ?? '');
      const account = String(req.body?.account ?? 'default');
      if (!value.trim()) return fail(res, 400, 'A key is required');
      setSecret(req.params.id!, value, account);
      await probeAll();
      ok(res, { providerId: req.params.id, account, present: hasSecret(req.params.id!, account) });
    }),
  );

  router.delete(
    '/providers/:id/key',
    handler(async (req, res) => {
      deleteSecret(req.params.id!, String(req.query.account ?? 'default'));
      await probeAll();
      ok(res, { removed: true });
    }),
  );

  router.get(
    '/providers/:id/accounts',
    handler((req, res) => {
      ok(res, { accounts: listAccounts(req.params.id!) });
    }),
  );

  router.post(
    '/providers/:id/account',
    handler((req, res) => {
      const account = String(req.body?.account ?? 'default');
      setActiveAccount(req.params.id!, account);
      setProviderAccount(req.params.id!, account);
      ok(res, { account });
    }),
  );

  router.post(
    '/usage/reset',
    handler((_req, res) => {
      resetLedger();
      ok(res, { reset: true });
    }),
  );

  // -------------------------------------------------------------------------
  // Routing policies
  // -------------------------------------------------------------------------

  router.get(
    '/policies',
    handler((req, res) => {
      ok(res, listPolicies(requireProjectId(req)));
    }),
  );

  router.put(
    '/policies',
    handler((req, res) => {
      ok(res, savePolicy(requireProjectId(req), req.body));
    }),
  );

  router.delete(
    '/policies/:id',
    handler((req, res) => {
      ok(res, { deleted: deletePolicy(requireProjectId(req), req.params.id!) });
    }),
  );

  // -------------------------------------------------------------------------
  // Skills, agents, plugins
  // -------------------------------------------------------------------------

  router.get(
    '/skills',
    handler((req, res) => ok(res, loadSkills(requireProjectId(req)))),
  );
  router.put(
    '/skills',
    handler((req, res) => ok(res, saveSkill(requireProjectId(req), req.body))),
  );
  router.delete(
    '/skills/:name',
    handler((req, res) => ok(res, { deleted: deleteSkill(requireProjectId(req), req.params.name!) })),
  );

  router.get(
    '/agents',
    handler((req, res) => ok(res, loadAgents(requireProjectId(req)))),
  );
  router.put(
    '/agents',
    handler((req, res) => ok(res, saveAgent(requireProjectId(req), req.body))),
  );
  router.delete(
    '/agents/:name',
    handler((req, res) => ok(res, { deleted: deleteAgent(requireProjectId(req), req.params.name!) })),
  );

  router.get(
    '/plugins',
    handler((_req, res) => ok(res, listPlugins())),
  );

  router.post(
    '/plugins/install',
    handler(async (req, res) => {
      const source = String(req.body?.source ?? '');
      if (!source) return fail(res, 400, 'A folder path or git URL is required');
      ok(res, await installPlugin(source));
    }),
  );

  router.delete(
    '/plugins/:name',
    handler((req, res) => ok(res, { removed: uninstallPlugin(req.params.name!) })),
  );

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  router.get(
    '/memory',
    handler((req, res) => {
      const projectId = requireProjectId(req);
      const query = req.query.q ? String(req.query.q) : '';
      ok(res, query ? searchMemory(projectId, query, 20).map((h) => h.note) : loadMemory(projectId));
    }),
  );

  router.post(
    '/memory',
    handler((req, res) => ok(res, addMemory(requireProjectId(req), req.body))),
  );
  router.patch(
    '/memory/:id',
    handler((req, res) => ok(res, updateMemory(requireProjectId(req), req.params.id!, req.body))),
  );
  router.delete(
    '/memory/:id',
    handler((req, res) => ok(res, { deleted: deleteMemory(requireProjectId(req), req.params.id!) })),
  );

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  router.post(
    '/terminals',
    handler(async (req, res) => {
      const projectId = requireProjectId(req);
      const ps = projectState(projectId)!;

      // A command supplied by the client goes through the sandbox first.
      const command = req.body?.command ? String(req.body.command) : undefined;
      if (command) {
        const verdict = evaluateCommand(command);
        if (!verdict.allowed)
          return fail(
            res,
            403,
            verdict.reason,
            'Approve it, or add the binary to your allow-list in Settings.',
          );
      }

      ok(res, await createTerminal({ cwd: ps.root, projectId, command, title: req.body?.title }));
    }),
  );

  router.delete(
    '/terminals/:id',
    handler((req, res) => ok(res, { closed: closeTerminal(req.params.id!) })),
  );

  router.post(
    '/commands/evaluate',
    handler((req, res) => {
      ok(res, evaluateCommand(String(req.body?.command ?? '')));
    }),
  );

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  router.post(
    '/preview/start',
    handler(async (req, res) => {
      ok(res, await startPreview(requireProjectId(req)));
    }),
  );

  router.post(
    '/preview/stop',
    handler(async (req, res) => {
      await stopPreview(requireProjectId(req));
      ok(res, { stopped: true });
    }),
  );

  router.post(
    '/preview/clear',
    handler((req, res) => {
      clearPreviewTelemetry(requireProjectId(req));
      ok(res, { cleared: true });
    }),
  );

  /**
   * Telemetry from the previewed page, relayed by the app.
   *
   * The page is untrusted, so this route stores and displays but never
   * interprets. It cannot start work, change config, or reach any other route.
   */
  router.post(
    '/preview/telemetry',
    handler((req, res) => {
      const projectId = requireProjectId(req);
      const { kind, payload } = req.body ?? {};
      if (kind === 'console' && payload) {
        recordConsole(projectId, {
          level: ['log', 'info', 'warn', 'error', 'debug'].includes(payload.level) ? payload.level : 'log',
          text: String(payload.text ?? '').slice(0, 2_000),
          ts: Number(payload.ts) || Date.now(),
          source: payload.source ? String(payload.source).slice(0, 300) : undefined,
        });
      } else if (kind === 'network-error' && payload) {
        recordNetworkError(projectId, {
          url: String(payload.url ?? '').slice(0, 500),
          method: String(payload.method ?? 'GET').slice(0, 10),
          status: Number(payload.status) || 0,
          ts: Number(payload.ts) || Date.now(),
        });
      }
      res.json({ received: true });
    }),
  );

  /**
   * A scoped edit from the element picker: the user clicked something and said
   * what should change. It becomes a normal single-task plan, so it gets the
   * same routing, verification and review as anything else.
   */
  router.post(
    '/preview/scoped-edit',
    handler(async (req, res) => {
      const body = req.body as ScopedEditRequest;
      const projectId = requireProjectId(req);
      if (!body?.instruction?.trim()) return fail(res, 400, 'Say what should change about the element');

      const target = body.target ?? { selector: '', tagName: 'unknown' };
      const goal = [
        body.instruction.trim(),
        '',
        'This change is scoped to one element the user clicked in the live preview:',
        target.file ? `- Source: ${target.file}${target.line ? `:${target.line}` : ''}` : '',
        target.componentName ? `- Component: <${target.componentName}>` : '',
        `- Element: <${target.tagName}>${target.className ? ` class="${target.className}"` : ''}`,
        target.selector ? `- CSS path: ${target.selector}` : '',
        target.text ? `- Its text: ${JSON.stringify(target.text.slice(0, 200))}` : '',
        '',
        target.file
          ? 'Change that element in that file. Do not restructure anything else.'
          : 'The source file was not resolved automatically. Find the element from the selector and text above, then change only it.',
      ]
        .filter(Boolean)
        .join('\n');

      const result = await createPlan({ projectId, goal, mode: 'instant' });
      await startPlan(projectId, result.plan.id);
      ok(res, { planId: result.plan.id, tasks: result.tasks.length });
    }),
  );

  // -------------------------------------------------------------------------
  // Connectors (MCP)
  // -------------------------------------------------------------------------

  router.get(
    '/connectors',
    handler(async (_req, res) => ok(res, await listConnectorTools())),
  );

  router.post(
    '/connectors/refresh',
    handler(async (_req, res) => {
      await refreshConnectors();
      ok(res, state.connectors);
    }),
  );

  /**
   * Invoke a connector tool.
   *
   * Anything that writes outward — a PR, an issue, a message, a deploy — goes
   * through the human gate here, not in the connector. A connector that decided
   * for itself would be a connector that could be written to bypass it.
   */
  router.post(
    '/connectors/:id/call',
    handler(async (req, res) => {
      const projectId = requireProjectId(req);
      const { tool, args, isWrite } = req.body ?? {};
      if (!tool) return fail(res, 400, 'A tool name is required');

      if (isWrite) {
        const decision = checkGate({ projectId, kind: 'command' });
        if (!decision.allowed) {
          enqueueReview({
            projectId,
            kind: 'command',
            title: `Connector write: ${req.params.id}/${tool}`,
            detail: [
              decision.reason,
              '',
              'Arguments:',
              JSON.stringify(args ?? {}, null, 2).slice(0, 2_000),
            ].join('\n'),
            options: ['Approve', 'Reject'],
          });
          return fail(
            res,
            202,
            'This write needs your approval and has been queued for review.',
            decision.reason,
            'needs-approval',
          );
        }
      }

      ok(res, await callConnectorTool(req.params.id!, String(tool), args ?? {}));
    }),
  );

  return router;
}
