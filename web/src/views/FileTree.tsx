import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import type { TreeEntry } from '../api.js';
import { useApp, useAction } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPreview,
  IconRefresh,
} from '../shell/Icons.js';
import { OpenFolderButton } from './OpenFolderDialog.js';

/**
 * The file explorer.
 *
 * Lazy: each folder loads its children when it is expanded. A monorepo's full
 * tree is tens of thousands of entries and nobody looks at more than a handful,
 * so walking it eagerly would cost seconds for nothing.
 *
 * Files open in a transient tab on single click and a permanent one on double
 * click, matching VS Code — which stops the tab strip filling up while you look
 * around.
 */

interface NodeProps {
  entry: TreeEntry;
  depth: number;
  projectId: string;
}

function TreeNode({ entry, depth, projectId }: NodeProps) {
  const tabs = useTabs();
  const { changedFiles } = useApp();
  const run = useAction();

  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | undefined>();
  const [loading, setLoading] = useState(false);

  const isDir = entry.kind === 'directory';
  const changed = changedFiles.has(entry.path);
  // The Live Server gesture, in the place people already right-click for it.
  const isPage = !isDir && /\.html?$/i.test(entry.name);

  const toggle = useCallback(async () => {
    if (!isDir) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children) return;
    setLoading(true);
    const loaded = await run(() => api.tree(projectId, entry.path));
    setChildren(loaded ?? []);
    setLoading(false);
  }, [isDir, expanded, children, run, projectId, entry.path]);

  const openFile = (permanent: boolean) => {
    tabs.open({
      kind: 'editor',
      target: entry.path,
      title: entry.name,
      transient: !permanent,
    });
  };

  return (
    <>
      <div
        className="list__item"
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        aria-level={depth + 1}
        tabIndex={0}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={entry.path}
        onClick={() => (isDir ? void toggle() : openFile(false))}
        onDoubleClick={() => !isDir && openFile(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (isDir) void toggle();
            else openFile(true);
          } else if (event.key === 'ArrowRight' && isDir && !expanded) {
            void toggle();
          } else if (event.key === 'ArrowLeft' && isDir && expanded) {
            setExpanded(false);
          }
        }}
      >
        <span style={{ width: 12, display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>
          {isDir &&
            (loading ? (
              <span className="spinner" style={{ width: 10, height: 10 }} />
            ) : expanded ? (
              <IconChevronDown size={12} />
            ) : (
              <IconChevronRight size={12} />
            ))}
        </span>
        <span className={isDir ? 'muted' : ''} style={{ display: 'flex', flex: '0 0 auto' }}>
          {isDir ? <IconFolder size={13} /> : <IconFile size={13} />}
        </span>
        <span className="truncate grow">{entry.name}</span>
        {isPage && (
          <button
            type="button"
            className="btn btn--ghost btn--icon list__action"
            title={`Open ${entry.name} in the preview`}
            aria-label={`Open ${entry.name} in the preview`}
            onClick={(event) => {
              // Without this the row's own click opens the file in the editor
              // as well, and you get two tabs for one gesture.
              event.stopPropagation();
              void run(() => api.startPreview(projectId, entry.path));
              tabs.open({ kind: 'preview', title: 'Preview' });
            }}
          >
            <IconPreview size={12} />
          </button>
        )}
        {changed && (
          <span className="badge badge--info" title="Changed on disk since you opened it">
            M
          </span>
        )}
      </div>

      {expanded &&
        children?.map((child) => (
          <TreeNode key={child.path} entry={child} depth={depth + 1} projectId={projectId} />
        ))}
      {expanded && children?.length === 0 && (
        <div
          className="subtle"
          style={{ paddingLeft: 20 + depth * 12, fontSize: 'var(--text-xs)', padding: '2px 0' }}
        >
          empty
        </div>
      )}
    </>
  );
}

export function FileTree() {
  const { snapshot, activeProject, changedFiles } = useApp();
  const run = useAction();
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!activeProject) {
      setEntries([]);
      return;
    }
    setLoading(true);
    const loaded = await run(() => api.tree(activeProject.id));
    setEntries(loaded ?? []);
    setLoading(false);
  }, [activeProject, run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A file appearing or disappearing changes the tree; a file being edited
  // does not. Reloading on every change event would fight the user's scroll,
  // so the root only reloads when the set of changed paths grows.
  useEffect(() => {
    if (!changedFiles.size) return;
    const timer = window.setTimeout(() => void reload(), 400);
    return () => window.clearTimeout(timer);
  }, [changedFiles.size, reload]);

  if (!activeProject) {
    return (
      <>
        <header className="sidebar__header">Explorer</header>
        <div className="empty">
          <div className="empty__title">No folder open</div>
          <p className="empty__body">
            Agentic Team works against a real folder on your machine. Everything the agents produce is written
            there — there is no hidden sandbox.
          </p>
          <OpenFolderButton />
        </div>
      </>
    );
  }

  return (
    <>
      <header className="sidebar__header">
        <span className="truncate" title={activeProject.root}>
          {activeProject.name}
        </span>
        <div className="row">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title="Refresh"
            onClick={() => void reload()}
          >
            <IconRefresh size={13} />
          </button>
          <OpenFolderButton icon />
        </div>
      </header>

      <div className="sidebar__body" role="tree" aria-label="Files">
        {loading && !entries.length ? (
          <div className="row pad">
            <span className="spinner" /> <span className="muted">Reading folder…</span>
          </div>
        ) : entries.length ? (
          entries.map((entry) => (
            <TreeNode key={entry.path} entry={entry} depth={0} projectId={activeProject.id} />
          ))
        ) : (
          <div className="pad muted">
            This folder is empty. Ask for something in the chat and the team will fill it.
          </div>
        )}
      </div>

      {snapshot.projects.length > 1 && (
        <div className="section" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <div className="section__header" style={{ cursor: 'default' }}>
            Other projects
          </div>
          <div className="list">
            {snapshot.projects
              .filter((p) => p.id !== activeProject.id)
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="list__item"
                  title={project.root}
                  onClick={() => void run(() => api.activateProject(project.id))}
                >
                  <IconFolder size={13} />
                  <span className="truncate">{project.name}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

// `OpenFolderButton` moved to its own file when it grew a dialog; re-exported
// here so the several call sites that already import it from the explorer keep
// working.
export { OpenFolderButton } from './OpenFolderDialog.js';
