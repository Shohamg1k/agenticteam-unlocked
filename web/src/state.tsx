import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRunEvent, Plan, Snapshot, Task } from '@agentic/core';
import { LiveConnection, api } from './api.js';
import type { ConnectionState } from './api.js';

/**
 * One snapshot in, everything out.
 *
 * The whole UI reads from a single `Snapshot` object pushed by the server, so
 * no two panels can disagree about the state of a task. The only client-side
 * state that is not in the snapshot is the streaming model output, which is
 * kept here in a ref-backed map because it changes per token and re-rendering
 * the tree on every token would make the app unusable.
 */

const EMPTY_SNAPSHOT: Snapshot = {
  protocolVersion: 1,
  seq: 0,
  at: 0,
  projects: [],
  plans: [],
  tasks: [],
  providers: [],
  reviewQueue: [],
  activity: [],
  checkpoints: [],
  memory: [],
  skills: [],
  agents: [],
  plugins: [],
  connectors: [],
  policies: [],
  config: {
    executionMode: 'approval',
    maxParallel: 3,
    routingPolicyId: 'default',
    disabledProviders: [],
    allowedCommands: [],
    deniedCommands: [],
    theme: 'system',
    onboarded: false,
  },
  usage: { byProvider: [], daily: [], totalCostUsd: 0, baselineCostUsd: 0 },
  previews: [],
  terminals: [],
};

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  hint?: string;
}

interface AppState {
  snapshot: Snapshot;
  connection: ConnectionState;
  live: LiveConnection | undefined;

  activeProject: Snapshot['projects'][number] | undefined;
  tasksOfPlan: (planId: string) => Task[];
  planOfTask: (taskId: string) => Plan | undefined;

  /** Streamed model output per task. Updated outside React's render cycle. */
  runOutput: (taskId: string) => string;
  watchTask: (taskId: string) => () => void;
  /** Bumped when streamed output changes, so a watching component re-renders. */
  runTick: number;

  toasts: Toast[];
  toast: (level: Toast['level'], message: string, hint?: string) => void;
  dismissToast: (id: number) => void;

  /** Files that changed on disk since the last time a consumer cleared them. */
  changedFiles: Set<string>;
  clearChangedFile: (path: string) => void;

  refresh: () => Promise<void>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

let toastSeq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runTick, setRunTick] = useState(0);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());

  // Streamed output lives in a ref: appending a token must not re-render the
  // component tree. Consumers read it through `runOutput` and re-render on the
  // throttled `runTick`.
  const runOutputRef = useRef(new Map<string, string>());
  const liveRef = useRef<LiveConnection>();
  const tickTimer = useRef<number>();

  const toast = useCallback((level: Toast['level'], message: string, hint?: string) => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, level, message, hint }]);
    // Errors stay until dismissed; everything else clears itself.
    if (level !== 'error') {
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5_000);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleTick = useCallback(() => {
    if (tickTimer.current) return;
    // ~15fps for streamed text. Fast enough to read as live, slow enough that
    // a fast provider cannot saturate the main thread.
    tickTimer.current = window.setTimeout(() => {
      tickTimer.current = undefined;
      setRunTick((n) => n + 1);
    }, 66);
  }, []);

  useEffect(() => {
    const live = new LiveConnection({
      onSnapshot: setSnapshot,
      onConnectionChange: setConnection,
      onError: (message) => toast('error', message),
      onRunEvent: (taskId, event: AgentRunEvent) => {
        if (event.type === 'delta' || event.type === 'thinking') {
          const current = runOutputRef.current.get(taskId) ?? '';
          // Bounded: a long agent run can emit megabytes, and keeping all of it
          // in a React-adjacent structure is how a UI ends up swapping.
          const next = (current + event.text).slice(-200_000);
          runOutputRef.current.set(taskId, next);
          scheduleTick();
        } else if (event.type === 'done') {
          runOutputRef.current.set(taskId, event.text.slice(-200_000));
          scheduleTick();
        } else if (event.type === 'error') {
          const current = runOutputRef.current.get(taskId) ?? '';
          runOutputRef.current.set(taskId, `${current}\n\n[error] ${event.error.message}`);
          scheduleTick();
        }
      },
      onFsChanged: (_projectId, paths) => {
        setChangedFiles((prev) => {
          const next = new Set(prev);
          for (const p of paths) next.add(p);
          return next;
        });
      },
      // Terminal bytes are re-broadcast as DOM events rather than pushed into
      // React state. Several terminals can be open at once, each writing
      // thousands of chunks a second into its own xterm instance — routing that
      // through a context value would re-render the whole tree per chunk.
      onTerminalData: (terminalId, data) => {
        window.dispatchEvent(new CustomEvent('agentic:terminal-data', { detail: { terminalId, data } }));
      },
      onTerminalExit: (terminalId, code) => {
        window.dispatchEvent(new CustomEvent('agentic:terminal-exit', { detail: { terminalId, code } }));
      },
    });

    liveRef.current = live;
    live.connect();

    // The WebSocket delivers a snapshot on connect, but fetching one straight
    // away means the UI paints from real data even if the socket is slow.
    void api
      .snapshot()
      .then(setSnapshot)
      .catch(() => undefined);

    return () => live.close();
  }, [scheduleTick, toast]);

  const activeProject = useMemo(
    () => snapshot.projects.find((p) => p.id === snapshot.activeProjectId),
    [snapshot.projects, snapshot.activeProjectId],
  );

  const tasksOfPlan = useCallback(
    (planId: string) => snapshot.tasks.filter((t) => t.planId === planId),
    [snapshot.tasks],
  );

  const planOfTask = useCallback(
    (taskId: string) => {
      const task = snapshot.tasks.find((t) => t.id === taskId);
      return task ? snapshot.plans.find((p) => p.id === task.planId) : undefined;
    },
    [snapshot.tasks, snapshot.plans],
  );

  const runOutput = useCallback((taskId: string) => runOutputRef.current.get(taskId) ?? '', []);

  const watchTask = useCallback((taskId: string) => {
    liveRef.current?.watchTask(taskId);
    return () => liveRef.current?.unwatchTask(taskId);
  }, []);

  const clearChangedFile = useCallback((path: string) => {
    setChangedFiles((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setSnapshot(await api.snapshot(snapshot.activeProjectId));
  }, [snapshot.activeProjectId]);

  // Theme follows config; 'system' defers to the OS.
  useEffect(() => {
    const apply = () => {
      const theme = snapshot.config.theme;
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [snapshot.config.theme]);

  const value = useMemo<AppState>(
    () => ({
      snapshot,
      connection,
      live: liveRef.current,
      activeProject,
      tasksOfPlan,
      planOfTask,
      runOutput,
      watchTask,
      runTick,
      toasts,
      toast,
      dismissToast,
      changedFiles,
      clearChangedFile,
      refresh,
    }),
    [
      snapshot,
      connection,
      activeProject,
      tasksOfPlan,
      planOfTask,
      runOutput,
      watchTask,
      runTick,
      toasts,
      toast,
      dismissToast,
      changedFiles,
      clearChangedFile,
      refresh,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/**
 * Wrap an async action so a thrown ApiError becomes a toast instead of an
 * unhandled rejection. Every button in the app calls through this.
 */
export function useAction() {
  const { toast } = useApp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, successMessage?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (successMessage) toast('success', successMessage);
        return result;
      } catch (err) {
        const e = err as { message?: string; hint?: string };
        toast('error', e.message ?? 'Something went wrong', e.hint);
        return undefined;
      }
    },
    [toast],
  );
}
