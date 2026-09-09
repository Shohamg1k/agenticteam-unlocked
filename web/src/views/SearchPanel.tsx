import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import type { SearchHit } from '../api.js';
import { useAction, useApp } from '../state.js';
import { useTabs } from '../shell/tabs.js';
import { IconSearch } from '../shell/Icons.js';

/**
 * Project-wide search, grouped by file.
 *
 * Debounced rather than search-as-you-type-per-keystroke: the server walks the
 * tree in-process, and firing that on every character makes a large repo
 * unresponsive for no gain — nobody reads results for a two-character query.
 */
export function SearchPanel() {
  const { activeProject } = useApp();
  const tabs = useTabs();
  const run = useAction();

  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async () => {
    if (!activeProject || query.trim().length < 2) {
      setHits([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const results = await run(() => api.search(activeProject.id, query, { regex, caseSensitive }));
    setHits(results ?? []);
    setSearched(true);
    setSearching(false);
  }, [activeProject, query, regex, caseSensitive, run]);

  useEffect(() => {
    const timer = window.setTimeout(() => void search(), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const byFile = hits.reduce<Record<string, SearchHit[]>>((acc, hit) => {
    (acc[hit.path] ??= []).push(hit);
    return acc;
  }, {});

  return (
    <>
      <header className="sidebar__header">Search</header>

      <div style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border)' }}>
        <input
          ref={inputRef}
          className="input"
          value={query}
          placeholder="Search this project…"
          aria-label="Search this project"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="row" style={{ gap: 12, marginTop: 6, fontSize: 'var(--text-xs)' }}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            Match case
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            Regex
          </label>
        </div>
      </div>

      <div className="sidebar__body">
        {searching && (
          <div className="row pad">
            <span className="spinner" /> <span className="muted">Searching…</span>
          </div>
        )}

        {!searching && searched && hits.length === 0 && (
          <div className="pad muted">No matches for “{query}”.</div>
        )}

        {!searching && !searched && (
          <div className="empty">
            <IconSearch size={26} />
            <p className="empty__body">Type at least two characters to search every file in this project.</p>
          </div>
        )}

        {Object.entries(byFile).map(([path, fileHits]) => (
          <div key={path} className="section">
            <div className="section__header" style={{ cursor: 'default' }}>
              <span className="truncate grow" title={path}>
                {path}
              </span>
              <span className="badge badge--neutral">{fileHits.length}</span>
            </div>
            <div className="list">
              {fileHits.slice(0, 40).map((hit, index) => (
                <button
                  key={`${hit.line}-${index}`}
                  type="button"
                  className="list__item mono"
                  style={{ fontSize: 'var(--text-xs)' }}
                  onClick={() =>
                    tabs.open({
                      kind: 'editor',
                      target: path,
                      title: path.split('/').pop() ?? path,
                      transient: true,
                    })
                  }
                >
                  <span className="subtle" style={{ minWidth: 34, textAlign: 'right', flex: '0 0 auto' }}>
                    {hit.line}
                  </span>
                  <span className="truncate">{hit.text.trim()}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {hits.length >= 500 && (
          <div className="pad subtle" style={{ fontSize: 'var(--text-xs)' }}>
            Showing the first 500 matches. Narrow the query to see the rest.
          </div>
        )}
      </div>
    </>
  );
}
