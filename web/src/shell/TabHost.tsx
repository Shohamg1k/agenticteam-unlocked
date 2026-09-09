import React, { Suspense, lazy } from 'react';
import { useTabs } from './tabs.js';
import { WelcomeTab } from '../tabs/WelcomeTab.js';
import { ChatTab } from '../tabs/ChatTab.js';

/**
 * Renders the active tab.
 *
 * Every tab stays mounted once opened, hidden with `hidden` rather than
 * unmounted. That is deliberate: a terminal that unmounts loses its xterm
 * buffer and scroll position, and an editor that unmounts loses undo history
 * and cursor. Users switch tabs constantly and expect none of that to reset.
 *
 * Monaco and xterm are lazy-loaded — together they are most of the bundle, and
 * a user who only reads the task graph should not pay for either.
 */

const EditorTab = lazy(() => import('../tabs/EditorTab.js').then((m) => ({ default: m.EditorTab })));
const DiffTab = lazy(() => import('../tabs/DiffTab.js').then((m) => ({ default: m.DiffTab })));
const TerminalTab = lazy(() => import('../tabs/TerminalTab.js').then((m) => ({ default: m.TerminalTab })));
const PreviewTab = lazy(() => import('../tabs/PreviewTab.js').then((m) => ({ default: m.PreviewTab })));
const TasksTab = lazy(() => import('../tabs/TasksTab.js').then((m) => ({ default: m.TasksTab })));
const InboxTab = lazy(() => import('../tabs/InboxTab.js').then((m) => ({ default: m.InboxTab })));
const SettingsTab = lazy(() => import('../tabs/SettingsTab.js').then((m) => ({ default: m.SettingsTab })));
const RoutingTab = lazy(() => import('../tabs/RoutingTab.js').then((m) => ({ default: m.RoutingTab })));
const CostTab = lazy(() => import('../tabs/CostTab.js').then((m) => ({ default: m.CostTab })));
const MemoryTab = lazy(() => import('../tabs/MemoryTab.js').then((m) => ({ default: m.MemoryTab })));
const SkillsTab = lazy(() => import('../tabs/SkillsTab.js').then((m) => ({ default: m.SkillsTab })));

function Loading() {
  return (
    <div className="empty">
      <div className="spinner" />
      <span className="muted">Loading…</span>
    </div>
  );
}

export function TabHost() {
  const { tabs, activeId } = useTabs();

  // The welcome screen fills the same box a tab would, so it needs the same
  // flex growth — otherwise it collapses to its content height in the column.
  if (!tabs.length) {
    return (
      <div className="tabhost" style={{ overflow: 'auto' }}>
        <WelcomeTab />
      </div>
    );
  }

  return (
    <div className="tabhost">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            hidden={!active}
            style={{
              position: 'absolute',
              inset: 0,
              display: active ? 'flex' : 'none',
              flexDirection: 'column',
            }}
            role="tabpanel"
            aria-label={tab.title}
          >
            <Suspense fallback={<Loading />}>
              {tab.kind === 'welcome' && <WelcomeTab />}
              {tab.kind === 'chat' && <ChatTab />}
              {tab.kind === 'editor' && tab.target && (
                <EditorTab tabId={tab.id} path={tab.target} active={active} />
              )}
              {tab.kind === 'diff' && tab.target && <DiffTab taskId={tab.target} />}
              {tab.kind === 'terminal' && <TerminalTab tabId={tab.id} active={active} />}
              {tab.kind === 'preview' && <PreviewTab active={active} />}
              {tab.kind === 'tasks' && <TasksTab planId={tab.target} />}
              {tab.kind === 'inbox' && <InboxTab />}
              {tab.kind === 'settings' && <SettingsTab />}
              {tab.kind === 'routing' && <RoutingTab />}
              {tab.kind === 'cost' && <CostTab />}
              {tab.kind === 'memory' && <MemoryTab />}
              {tab.kind === 'skills' && <SkillsTab />}
              {tab.kind === 'providers' && <SettingsTab initialSection="providers" />}
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
