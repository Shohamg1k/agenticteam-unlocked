import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { useTabs } from './tabs.js';
import type { TabKind } from './tabs.js';
import { TabStrip } from './TabStrip.js';
import { TabHost } from './TabHost.js';
import { StatusBar } from './StatusBar.js';
import { Toasts } from './Toasts.js';
import { OpenFolderHost } from '../views/OpenFolderDialog.js';
import { FileTree } from '../views/FileTree.js';
import { TaskPanel } from '../views/TaskPanel.js';
import { InboxPanel } from '../views/InboxPanel.js';
import { ProviderPanel } from '../views/ProviderPanel.js';
import { SearchPanel } from '../views/SearchPanel.js';
import {
  IconChat,
  IconFiles,
  IconInbox,
  IconProviders,
  IconSearch,
  IconSettings,
  IconTasks,
} from './Icons.js';

/**
 * The shell: rail, sidebar, tabs, status bar.
 *
 * The rail selects which sidebar panel is showing; clicking the active one
 * collapses the sidebar, which is the behaviour people already have in their
 * fingers from VS Code.
 */

type PanelId = 'files' | 'search' | 'tasks' | 'inbox' | 'providers';

const PANELS: { id: PanelId; label: string; Icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'files', label: 'Explorer', Icon: IconFiles },
  { id: 'search', label: 'Search', Icon: IconSearch },
  { id: 'tasks', label: 'Tasks', Icon: IconTasks },
  { id: 'inbox', label: 'Inbox', Icon: IconInbox },
  { id: 'providers', label: 'Providers', Icon: IconProviders },
];

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 560;

export function AppShell() {
  const { snapshot } = useApp();
  const tabs = useTabs();

  const [panel, setPanel] = useState<PanelId>('files');
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem('agentic.sidebarWidth'));
    return Number.isFinite(stored) && stored >= MIN_SIDEBAR ? stored : 280;
  });

  const openReviews = snapshot.reviewQueue.filter((i) => i.status === 'open').length;

  const selectPanel = useCallback(
    (id: PanelId) => {
      if (panel === id && !collapsed) setCollapsed(true);
      else {
        setPanel(id);
        setCollapsed(false);
      }
    },
    [panel, collapsed],
  );

  // ---- Sidebar resize ----------------------------------------------------
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, event.clientX - 48));
      setSidebarWidth(width);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('agentic.sidebarWidth', String(sidebarWidth));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarWidth]);

  const startDrag = () => {
    dragging.current = true;
    // Set on the body, not the handle: the pointer leaves the 4px handle
    // immediately and the cursor would flicker otherwise.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ---- Keyboard shortcuts ------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;

      // Ctrl/Cmd+B toggles the sidebar; Ctrl+Tab cycles tabs; Ctrl+W closes.
      if (event.key === 'b') {
        event.preventDefault();
        setCollapsed((c) => !c);
      } else if (event.key === 'w' && tabs.activeId) {
        event.preventDefault();
        tabs.close(tabs.activeId);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        tabs.nextTab(event.shiftKey ? -1 : 1);
      } else if (event.key === 'p' && event.shiftKey) {
        event.preventDefault();
        setPanel('search');
        setCollapsed(false);
      } else if (event.key === '`') {
        event.preventDefault();
        openTab(tabs, 'terminal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs]);

  const Panel = {
    files: FileTree,
    search: SearchPanel,
    tasks: TaskPanel,
    inbox: InboxPanel,
    providers: ProviderPanel,
  }[panel];

  return (
    <div className="shell">
      <nav className="shell__rail" aria-label="Main">
        {PANELS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="rail__button"
            aria-pressed={panel === id && !collapsed}
            title={label}
            aria-label={label}
            onClick={() => selectPanel(id)}
          >
            <Icon size={20} />
            {id === 'inbox' && openReviews > 0 && (
              <span className="rail__badge" aria-label={`${openReviews} items need your decision`}>
                {openReviews > 99 ? '99+' : openReviews}
              </span>
            )}
          </button>
        ))}

        <div className="rail__spacer" />

        <button
          type="button"
          className="rail__button"
          title="New chat"
          aria-label="New chat"
          onClick={() => tabs.open({ kind: 'chat', title: 'Chat' })}
        >
          <IconChat size={20} />
        </button>
        <button
          type="button"
          className="rail__button"
          title="Settings"
          aria-label="Settings"
          onClick={() => tabs.open({ kind: 'settings', title: 'Settings' })}
        >
          <IconSettings size={20} />
        </button>
      </nav>

      <div className="shell__body">
        <aside
          className="shell__sidebar"
          data-collapsed={collapsed}
          style={{ width: sidebarWidth }}
          aria-label={PANELS.find((p) => p.id === panel)?.label}
        >
          <Panel />
        </aside>

        {!collapsed && (
          <div
            className="shell__resizer"
            data-dragging={dragging.current}
            onMouseDown={startDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
          />
        )}

        <main className="shell__main">
          <TabStrip />
          <TabHost />
        </main>
      </div>

      <StatusBar onOpenPanel={(id) => selectPanel(id as PanelId)} />
      <Toasts />
      {/* Mounted once, so the File menu and every button share one flow. */}
      <OpenFolderHost />
    </div>
  );
}

/** Open a tab of a given kind from anywhere, with a sensible default title. */
export function openTab(
  tabs: ReturnType<typeof useTabs>,
  kind: TabKind,
  target?: string,
  title?: string,
): string {
  const titles: Record<TabKind, string> = {
    chat: 'Chat',
    editor: target ?? 'Editor',
    diff: 'Review',
    terminal: 'Terminal',
    preview: 'Preview',
    tasks: 'Tasks',
    inbox: 'Inbox',
    providers: 'Providers',
    routing: 'Routing',
    cost: 'Cost',
    memory: 'Memory',
    skills: 'Skills',
    settings: 'Settings',
    welcome: 'Welcome',
  };
  // A terminal is always a new tab; everything else is identified by target.
  const id = kind === 'terminal' ? `terminal:${Date.now().toString(36)}` : undefined;
  return tabs.open({ kind, target, title: title ?? titles[kind], id });
}
