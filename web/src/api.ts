import type {
  AgentProfile,
  ClientMessage,
  ServerMessage,
  AgentRunEvent,
  ApplyDiffRequest,
  Checkpoint,
  ClarifyRequest,
  ClarifyResponse,
  CreatePlanRequest,
  ElementTarget,
  MemoryNote,
  NodeConfig,
  Plan,
  PageAuditResult,
  PageAuditUnavailable,
  PreviewAnnotation,
  PreviewState,
  Project,
  ProjectSettings,
  ProviderStatus,
  RoutingPolicy,
  SkillDef,
  Snapshot,
  Task,
  TaskDiff,
  TerminalInfo,
} from '@agentic/core';

/**
 * The client half of the protocol.
 *
 * Two channels, for the reason in docs/ARCHITECTURE.md:
 *  - HTTP for commands ("start this plan", "write this file");
 *  - one WebSocket carrying whole-state snapshots, plus the high-frequency
 *    streams (model output, terminal bytes) that would make a snapshot useless.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (err) {
    // A failed fetch here means the core service is not answering, which is a
    // different problem from a 500 and needs a different message.
    throw new ApiError(
      'Cannot reach the Agentic Team core service.',
      0,
      'It may still be starting. If this persists, restart the app.',
      'offline',
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(
      body.error ?? `Request failed (${response.status})`,
      response.status,
      body.hint,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

const qs = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const str = search.toString();
  return str ? `?${str}` : '';
};

export interface FileContent {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  mtimeMs: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface ProjectProfile {
  ecosystem: string;
  packageManager?: string;
  scripts: Record<string, string>;
  checks: { typecheck?: string; lint?: string; test?: string; build?: string };
  devServer?: { command: string; port: number };
  frameworks: string[];
}

export interface CommandVerdict {
  allowed: boolean;
  reason: string;
  requiresApproval?: boolean;
  risk?: string;
}

export const api = {
  health: () => get<{ ok: boolean; vault: string }>('/health'),
  snapshot: (projectId?: string) => get<Snapshot>(`/snapshot${qs({ projectId })}`),
  updateConfig: (config: Partial<NodeConfig> & { agentPermissions?: 'yolo' | 'manual' }) =>
    patch<NodeConfig>('/config', config),

  // Projects
  openProject: (root: string, name?: string) => post<Project>('/projects/open', { root, name }),
  activateProject: (id: string) => post<{ activeProjectId: string }>(`/projects/${id}/activate`),
  closeProject: (id: string) => del<{ closed: boolean }>(`/projects/${id}`),
  updateProjectSettings: (id: string, settings: Partial<ProjectSettings>) =>
    patch<ProjectSettings>(`/projects/${id}/settings`, settings),
  projectProfile: (id: string) => get<ProjectProfile>(`/projects/${id}/profile`),

  // Files
  tree: (projectId: string, path = '') => get<TreeEntry[]>(`/files/tree${qs({ projectId, path })}`),
  readFile: (projectId: string, path: string) => get<FileContent>(`/files/read${qs({ projectId, path })}`),
  writeFile: (projectId: string, path: string, content: string) =>
    put<{ mtimeMs: number }>('/files/write', { projectId, path, content }),
  mkdir: (projectId: string, path: string) => post('/files/mkdir', { projectId, path }),
  renameEntry: (projectId: string, from: string, to: string) =>
    post('/files/rename', { projectId, from, to }),
  deleteEntry: (projectId: string, path: string) => del(`/files${qs({ projectId, path })}`),
  search: (projectId: string, q: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}) =>
    get<SearchHit[]>(
      `/files/search${qs({
        projectId,
        q,
        regex: opts.regex ? 'true' : undefined,
        case: opts.caseSensitive ? 'true' : undefined,
      })}`,
    ),

  // Plans and tasks
  createPlan: (body: CreatePlanRequest) =>
    post<{ plan: Plan; tasks: Task[]; plannedBy: string }>('/plans', body),
  clarify: (body: ClarifyRequest) => post<ClarifyResponse>('/plans/clarify', body),
  startPlan: (id: string) => post(`/plans/${id}/start`),
  pausePlan: (id: string) => post(`/plans/${id}/pause`),
  resumePlan: (id: string) => post(`/plans/${id}/resume`),
  cancelPlan: (id: string) => post(`/plans/${id}/cancel`),
  updateBudget: (id: string, budget: Partial<Plan['budget']>) => patch(`/plans/${id}/budget`, budget),

  cancelTask: (id: string) => post(`/tasks/${id}/cancel`),
  updateTask: (
    id: string,
    patchBody: Partial<Pick<Task, 'pinnedProviderId' | 'complexity' | 'title' | 'description'>>,
  ) => patch<Task>(`/tasks/${id}`, patchBody),
  taskDiff: (id: string) => get<TaskDiff>(`/tasks/${id}/diff`),
  applyTask: (id: string, body: Omit<ApplyDiffRequest, 'taskId'> = {}) =>
    post<{ applied: string[] }>(`/tasks/${id}/apply`, body),
  rejectTask: (id: string, reason?: string) => post(`/tasks/${id}/reject`, { reason }),
  sendBackTask: (id: string, feedback: string) => post(`/tasks/${id}/send-back`, { feedback }),
  acknowledgeTaint: (id: string) => post(`/tasks/${id}/acknowledge-taint`),

  // Review
  resolveReview: (projectId: string, id: string, status: string, answer?: string) =>
    post(`/review/${id}/resolve`, { projectId, status, answer }),

  // Git
  gitDiff: (projectId: string) => get<{ diff: string }>(`/git/diff${qs({ projectId })}`),
  checkpoints: (projectId: string) => get<Checkpoint[]>(`/checkpoints${qs({ projectId })}`),
  rollback: (projectId: string, checkpointId: string) =>
    post<{ restored: string }>(`/checkpoints/${checkpointId}/rollback`, { projectId }),

  // Providers
  providers: () => get<ProviderStatus[]>('/providers'),
  probeProviders: () => post<ProviderStatus[]>('/providers/probe'),
  setProviderKey: (id: string, key: string, account = 'default') =>
    put<{ present: boolean }>(`/providers/${id}/key`, { key, account }),
  removeProviderKey: (id: string, account = 'default') => del(`/providers/${id}/key${qs({ account })}`),
  providerAccounts: (id: string) => get<{ accounts: string[] }>(`/providers/${id}/accounts`),
  setProviderAccount: (id: string, account: string) => post(`/providers/${id}/account`, { account }),
  resetUsage: () => post('/usage/reset'),

  // Policies
  policies: (projectId: string) => get<RoutingPolicy[]>(`/policies${qs({ projectId })}`),
  savePolicy: (projectId: string, policy: RoutingPolicy) =>
    put<RoutingPolicy>('/policies', { ...policy, projectId }),
  deletePolicy: (projectId: string, id: string) => del(`/policies/${id}${qs({ projectId })}`),

  // Skills, agents, plugins
  skills: (projectId: string) => get<SkillDef[]>(`/skills${qs({ projectId })}`),
  saveSkill: (projectId: string, skill: Partial<SkillDef>) =>
    put<SkillDef>('/skills', { ...skill, projectId }),
  deleteSkill: (projectId: string, name: string) =>
    del(`/skills/${encodeURIComponent(name)}${qs({ projectId })}`),
  agents: (projectId: string) => get<AgentProfile[]>(`/agents${qs({ projectId })}`),
  saveAgent: (projectId: string, agent: AgentProfile) =>
    put<AgentProfile>('/agents', { ...agent, projectId }),
  deleteAgent: (projectId: string, name: string) =>
    del(`/agents/${encodeURIComponent(name)}${qs({ projectId })}`),
  plugins: () => get('/plugins'),
  installPlugin: (source: string) => post('/plugins/install', { source }),
  uninstallPlugin: (name: string) => del(`/plugins/${encodeURIComponent(name)}`),

  // Memory
  memory: (projectId: string, q?: string) => get<MemoryNote[]>(`/memory${qs({ projectId, q })}`),
  addMemory: (projectId: string, note: Partial<MemoryNote>) =>
    post<MemoryNote>('/memory', { ...note, projectId }),
  updateMemory: (projectId: string, id: string, note: Partial<MemoryNote>) =>
    patch<MemoryNote>(`/memory/${id}`, { ...note, projectId }),
  deleteMemory: (projectId: string, id: string) => del(`/memory/${id}${qs({ projectId })}`),

  // Terminals
  createTerminal: (projectId: string, opts: { command?: string; title?: string } = {}) =>
    post<TerminalInfo>('/terminals', { projectId, ...opts }),
  closeTerminal: (id: string) => del(`/terminals/${id}`),
  evaluateCommand: (command: string) => post<CommandVerdict>('/commands/evaluate', { command }),

  // Preview
  startPreview: (projectId: string, entryFile?: string) =>
    post<PreviewState>('/preview/start', { projectId, entryFile }),
  stopPreview: (projectId: string) => post('/preview/stop', { projectId }),
  clearPreview: (projectId: string) => post('/preview/clear', { projectId }),
  previewTelemetry: (projectId: string, kind: string, payload: unknown) =>
    post('/preview/telemetry', { projectId, kind, payload }),
  scopedEdit: (
    projectId: string,
    instruction: string,
    target?: ElementTarget,
    annotations?: PreviewAnnotation[],
  ) =>
    post<{ planId: string; tasks: number }>('/preview/scoped-edit', {
      projectId,
      instruction,
      target,
      annotations,
    }),
  addAnnotation: (projectId: string, annotation: PreviewAnnotation) =>
    post<{ annotations: PreviewAnnotation[] }>('/preview/annotations', { projectId, ...annotation }),
  removeAnnotation: (projectId: string, id: string) =>
    del<{ annotations: PreviewAnnotation[] }>(`/preview/annotations/${id}?projectId=${projectId}`),
  auditPreview: (projectId: string, width?: number, height?: number) =>
    post<PageAuditResult | PageAuditUnavailable>('/preview/audit', { projectId, width, height }),
  clearAnnotations: (projectId: string) =>
    post<{ annotations: PreviewAnnotation[] }>('/preview/annotations/clear', { projectId }),

  // Connectors
  connectors: () => get('/connectors'),
  refreshConnectors: () => post('/connectors/refresh'),
  callConnector: (id: string, tool: string, args: unknown, isWrite = false) =>
    post(`/connectors/${id}/call`, { tool, args, isWrite }),
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onRunEvent?: (taskId: string, event: AgentRunEvent) => void;
  onTerminalData?: (terminalId: string, data: string) => void;
  onTerminalExit?: (terminalId: string, code: number | null) => void;
  onFsChanged?: (projectId: string, paths: string[]) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  onError?: (message: string) => void;
}

/**
 * The live connection.
 *
 * Reconnects with backoff, because the core service restarts during
 * development and a UI that needs a manual refresh after every restart is a UI
 * nobody develops against. On reconnect the server sends a fresh snapshot, so
 * no client-side reconciliation is needed — that is the payoff of the
 * whole-state design.
 */
export class LiveConnection {
  private socket?: WebSocket;
  private handlers: LiveHandlers;
  private reconnectAttempt = 0;
  private reconnectTimer?: number;
  private closedByUs = false;
  private projectId?: string;
  private watching = new Set<string>();

  constructor(handlers: LiveHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUs = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    this.handlers.onConnectionChange?.(this.reconnectAttempt ? 'reconnecting' : 'connecting');

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onConnectionChange?.('open');
      this.send({ type: 'hello', protocolVersion: 1 });
      if (this.projectId) this.send({ type: 'subscribe', projectId: this.projectId });
      // Re-subscribe to anything we were following before the drop.
      for (const taskId of this.watching) this.send({ type: 'run:subscribe', taskId });
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (message.type) {
        case 'snapshot':
          this.handlers.onSnapshot(message.snapshot);
          break;
        case 'run:event':
          this.handlers.onRunEvent?.(message.taskId, message.event);
          break;
        case 'terminal:data':
          this.handlers.onTerminalData?.(message.terminalId, message.data);
          break;
        case 'terminal:exit':
          this.handlers.onTerminalExit?.(message.terminalId, message.code);
          break;
        case 'fs:changed':
          this.handlers.onFsChanged?.(message.projectId, message.paths);
          break;
        case 'error':
          this.handlers.onError?.(message.message);
          break;
      }
    };

    socket.onclose = () => {
      if (this.closedByUs) {
        this.handlers.onConnectionChange?.('closed');
        return;
      }
      // Exponential backoff, capped: a service that is down stays down, and
      // hammering it makes the log unreadable.
      const delay = Math.min(500 * 2 ** this.reconnectAttempt++, 10_000);
      this.handlers.onConnectionChange?.('reconnecting');
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => {
      // `onclose` always follows, and it owns the reconnect.
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  subscribeProject(projectId: string): void {
    this.projectId = projectId;
    this.send({ type: 'subscribe', projectId });
  }

  watchTask(taskId: string): void {
    this.watching.add(taskId);
    this.send({ type: 'run:subscribe', taskId });
  }

  unwatchTask(taskId: string): void {
    this.watching.delete(taskId);
    this.send({ type: 'run:unsubscribe', taskId });
  }

  terminalInput(terminalId: string, data: string): void {
    this.send({ type: 'terminal:input', terminalId, data });
  }

  terminalResize(terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal:resize', terminalId, cols, rows });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
