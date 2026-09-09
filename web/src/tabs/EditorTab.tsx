import React, { useCallback, useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { defineEditorTheme, languageForPath } from './monaco.js';

/**
 * A file open in Monaco.
 *
 * The behaviour that matters is what happens when an agent writes the file you
 * have open:
 *
 *  - if you have no unsaved changes, the tab silently reloads, because that is
 *    what you want to see;
 *  - if you do, it does NOT overwrite you. It shows a bar offering to reload or
 *    keep yours, because silently discarding someone's edits is unforgivable
 *    and this app writes files behind you by design.
 */
export function EditorTab({ tabId, path, active }: { tabId: string; path: string; active: boolean }) {
  const { activeProject, changedFiles, clearChangedFile, snapshot } = useApp();
  const { setDirty, makePermanent } = useTabs();
  const run = useAction();

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [binary, setBinary] = useState(false);
  const [conflict, setConflict] = useState(false);
  const editorRef = useRef<editor.IStandaloneCodeEditor>();

  const dirty = content !== savedContent;
  const projectId = activeProject?.id;

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(undefined);
    try {
      const file = await api.readFile(projectId, path);
      setBinary(file.binary);
      setContent(file.content);
      setSavedContent(file.content);
      setConflict(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // An agent (or git, or another editor) wrote this file.
  useEffect(() => {
    if (!changedFiles.has(path)) return;
    clearChangedFile(path);
    if (dirty) setConflict(true);
    else void load();
  }, [changedFiles, path, dirty, load, clearChangedFile]);

  useEffect(() => {
    setDirty(tabId, dirty);
  }, [dirty, tabId, setDirty]);

  // Re-theme when the app theme changes.
  useEffect(() => {
    if (editorRef.current) defineEditorTheme();
  }, [snapshot.config.theme]);

  // Monaco does not resize itself when its container changes; a tab becoming
  // visible is exactly that case.
  useEffect(() => {
    if (active) editorRef.current?.layout();
  }, [active]);

  const save = useCallback(async () => {
    if (!projectId || !dirty) return;
    const result = await run(() => api.writeFile(projectId, path, content));
    if (result) {
      setSavedContent(content);
      setConflict(false);
    }
  }, [projectId, path, content, dirty, run]);

  if (!projectId) return <div className="empty">No project open.</div>;

  if (error) {
    return (
      <div className="empty">
        <div className="empty__title">Could not open {path}</div>
        <p className="empty__body">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (binary) {
    return (
      <div className="empty">
        <div className="empty__title">{path}</div>
        <p className="empty__body">
          This is a binary file, so there is nothing useful to show in a text editor.
        </p>
      </div>
    );
  }

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      {conflict && (
        <div
          role="alert"
          className="row"
          style={{
            gap: 8,
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--warning-bg)',
            borderBottom: '1px solid var(--border)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <strong style={{ color: 'var(--warning)' }}>This file changed on disk</strong>
          <span className="muted grow">You have unsaved edits, so nothing was overwritten.</span>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            Discard mine and reload
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setConflict(false)}>
            Keep mine
          </button>
        </div>
      )}

      <div
        className="row"
        style={{
          gap: 8,
          padding: '4px var(--space-3)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <span className="mono truncate grow subtle" title={path}>
          {path}
        </span>
        {dirty && <span className="badge badge--warning">Unsaved</span>}
        <button type="button" className="btn btn--sm" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>

      <div className="grow" style={{ minHeight: 0 }}>
        {loading ? (
          <div className="empty">
            <span className="spinner" />
          </div>
        ) : (
          <Editor
            height="100%"
            path={path}
            language={languageForPath(path)}
            value={content}
            onChange={(value) => {
              setContent(value ?? '');
              makePermanent(tabId);
            }}
            onMount={(instance, monacoInstance) => {
              editorRef.current = instance;
              defineEditorTheme();
              // Ctrl/Cmd+S saves, as it does everywhere else.
              instance.addCommand(
                monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
                () => void save(),
              );
            }}
            options={{
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              minimap: { enabled: true, maxColumn: 80 },
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              smoothScrolling: true,
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8 },
              // Bracket colouring genuinely helps in deeply nested JSX, which is
              // most of what this app is used to write.
              bracketPairColorization: { enabled: true },
            }}
          />
        )}
      </div>
    </div>
  );
}
