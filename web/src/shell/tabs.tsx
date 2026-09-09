import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The tab model.
 *
 * Editor files, diffs, terminals and the preview all live in one strip, the
 * way a browser or VS Code does it. That is the brief's requirement, and it is
 * the right shape: a preview tab next to the file that renders it is how the
 * element-picker workflow actually reads.
 *
 * Every tab is serialisable, so the strip is restored on reload. Restoring is
 * best-effort — a terminal that has exited or a file that was deleted is
 * dropped rather than reopened as an error.
 */

export type TabKind =
  | 'chat'
  | 'editor'
  | 'diff'
  | 'terminal'
  | 'preview'
  | 'tasks'
  | 'inbox'
  | 'providers'
  | 'routing'
  | 'cost'
  | 'memory'
  | 'skills'
  | 'settings'
  | 'welcome';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  /** File path, task id, terminal id — whatever the tab is *of*. */
  target?: string;
  /**
   * A preview tab opened by clicking a file is transient: opening another file
   * replaces it. Double-clicking, or editing, makes it permanent. Same rule as
   * VS Code, and it stops the strip filling up while you browse.
   */
  transient?: boolean;
  /** Set when the tab holds unsaved changes. */
  dirty?: boolean;
}

interface TabState {
  tabs: Tab[];
  activeId?: string;
  open: (tab: Omit<Tab, 'id'> & { id?: string }) => string;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  activate: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  makePermanent: (id: string) => void;
  move: (from: number, to: number) => void;
  nextTab: (delta: number) => void;
}

const TabContext = createContext<TabState | undefined>(undefined);

export function useTabs(): TabState {
  const ctx = useContext(TabContext);
  if (!ctx) throw new Error('useTabs must be used inside <TabProvider>');
  return ctx;
}

const STORAGE_KEY = 'agentic.tabs.v1';

/** A tab's identity is its kind plus its target, so opening a file twice focuses it. */
function tabId(kind: TabKind, target?: string): string {
  return target ? `${kind}:${target}` : kind;
}

function restore(): { tabs: Tab[]; activeId?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [] };
    const parsed = JSON.parse(raw) as { tabs: Tab[]; activeId?: string };
    // Terminals do not survive a reload: the pty may be gone, and a tab that
    // reconnects to nothing is worse than one that was not restored.
    const tabs = (parsed.tabs ?? [])
      .filter((t) => t.kind !== 'terminal')
      .map((t) => ({ ...t, dirty: false }));
    return { tabs, activeId: tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : tabs[0]?.id };
  } catch {
    return { tabs: [] };
  }
}

export function TabProvider({ children }: { children: React.ReactNode }) {
  const [{ tabs, activeId }, setState] = useState<{ tabs: Tab[]; activeId?: string }>(restore);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId }));
    } catch {
      // Private browsing or a full quota. Tab restore is a convenience.
    }
  }, [tabs, activeId]);

  const open = useCallback((tab: Omit<Tab, 'id'> & { id?: string }) => {
    const id = tab.id ?? tabId(tab.kind, tab.target);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      if (existing) {
        // Reopening a transient tab non-transiently pins it.
        const tabsNext = tab.transient
          ? prev.tabs
          : prev.tabs.map((t) => (t.id === id ? { ...t, transient: false } : t));
        return { tabs: tabsNext, activeId: id };
      }

      // A transient tab replaces the previous transient one rather than adding.
      const withoutTransient = tab.transient ? prev.tabs.filter((t) => !t.transient) : prev.tabs;
      return { tabs: [...withoutTransient, { ...tab, id }], activeId: id };
    });
    return id;
  }, []);

  const close = useCallback((id: string) => {
    setState((prev) => {
      const index = prev.tabs.findIndex((t) => t.id === id);
      if (index < 0) return prev;
      const tabsNext = prev.tabs.filter((t) => t.id !== id);
      const nextActive =
        prev.activeId !== id
          ? prev.activeId
          : // Focus the tab to the right, or the last one if this was the end.
            (tabsNext[index]?.id ?? tabsNext[index - 1]?.id);
      return { tabs: tabsNext, activeId: nextActive };
    });
  }, []);

  const closeOthers = useCallback((id: string) => {
    setState((prev) => ({ tabs: prev.tabs.filter((t) => t.id === id), activeId: id }));
  }, []);

  const closeAll = useCallback(() => setState({ tabs: [], activeId: undefined }), []);

  const activate = useCallback((id: string) => {
    setState((prev) => (prev.tabs.some((t) => t.id === id) ? { ...prev, activeId: id } : prev));
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setState((prev) => ({
      ...prev,
      // A file being edited is never a transient tab.
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, dirty, transient: dirty ? false : t.transient } : t)),
    }));
  }, []);

  const makePermanent = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, transient: false } : t)),
    }));
  }, []);

  const move = useCallback((from: number, to: number) => {
    setState((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.tabs.length || to >= prev.tabs.length)
        return prev;
      const tabsNext = [...prev.tabs];
      const [moved] = tabsNext.splice(from, 1);
      tabsNext.splice(to, 0, moved!);
      return { ...prev, tabs: tabsNext };
    });
  }, []);

  const nextTab = useCallback((delta: number) => {
    setState((prev) => {
      if (!prev.tabs.length) return prev;
      const index = prev.tabs.findIndex((t) => t.id === prev.activeId);
      const next = (index + delta + prev.tabs.length) % prev.tabs.length;
      return { ...prev, activeId: prev.tabs[next]!.id };
    });
  }, []);

  const value = useMemo<TabState>(
    () => ({
      tabs,
      activeId,
      open,
      close,
      closeOthers,
      closeAll,
      activate,
      setDirty,
      makePermanent,
      move,
      nextTab,
    }),
    [tabs, activeId, open, close, closeOthers, closeAll, activate, setDirty, makePermanent, move, nextTab],
  );

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}
