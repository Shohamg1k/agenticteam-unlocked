import React, { useState } from 'react';
import type { MemoryKind, MemoryNote } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { IconPlus, IconTrash } from '../shell/Icons.js';

/**
 * Project memory.
 *
 * The store every agent reads from and writes to. Decisions, architecture and
 * conventions are *binding* — they go into every task's context, which is what
 * keeps a task run by a cheap model consistent with one run by a frontier model
 * twenty minutes earlier.
 *
 * It is editable here because the most valuable entries are usually the ones a
 * person writes: "we do not use an ORM", "the API is versioned in the path".
 */

const KINDS: { id: MemoryKind; label: string; binding: boolean; blurb: string }[] = [
  {
    id: 'decision',
    label: 'Decision',
    binding: true,
    blurb: 'A choice that later work must not contradict.',
  },
  { id: 'architecture', label: 'Architecture', binding: true, blurb: 'Structure, contracts, data model.' },
  { id: 'convention', label: 'Convention', binding: true, blurb: 'How this codebase does things.' },
  { id: 'requirement', label: 'Requirement', binding: false, blurb: 'Something the product must do.' },
  { id: 'bug', label: 'Bug', binding: false, blurb: 'A known defect worth remembering.' },
  { id: 'task-note', label: 'Note', binding: false, blurb: 'Anything else worth carrying forward.' },
  { id: 'artifact', label: 'Artifact', binding: false, blurb: 'A produced document or asset.' },
];

export function MemoryTab() {
  const { snapshot, activeProject } = useApp();
  const run = useAction();

  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ kind: 'decision' as MemoryKind, title: '', body: '' });

  if (!activeProject) {
    return (
      <div className="empty">
        <div className="empty__title">Open a project</div>
        <p className="empty__body">
          Memory is per-project and lives in its folder as Markdown you can read and edit.
        </p>
      </div>
    );
  }

  const notes = snapshot.memory.filter(
    (n) =>
      !query.trim() ||
      n.title.toLowerCase().includes(query.toLowerCase()) ||
      n.body.toLowerCase().includes(query.toLowerCase()),
  );

  const binding = notes.filter((n) => ['decision', 'architecture', 'convention'].includes(n.kind));
  const other = notes.filter((n) => !['decision', 'architecture', 'convention'].includes(n.kind));

  const save = async () => {
    if (!draft.title.trim() || !draft.body.trim()) return;
    const created = await run(() => api.addMemory(activeProject.id, draft), 'Saved to project memory');
    if (created) {
      setDraft({ kind: 'decision', title: '', body: '' });
      setAdding(false);
    }
  };

  return (
    <div className="scroll pad-lg" style={{ height: '100%' }}>
      <div style={{ maxWidth: 760 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }} className="grow">
            Project memory
          </h2>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding((a) => !a)}>
            <IconPlus size={12} /> Add
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
          Every agent reads this before it works. Decisions, architecture and conventions go into{' '}
          <em>every</em> task’s context — they are what keep parallel agents consistent with each other. It is
          stored as Markdown in <span className="mono">.agentic-team/memory/</span>, so you can read and edit
          it outside this app too.
        </p>

        {adding && (
          <div className="card" style={{ margin: '16px 0' }}>
            <div className="card__body col" style={{ gap: 'var(--space-3)' }}>
              <div className="field">
                <label className="field__label" htmlFor="mem-kind">
                  Kind
                </label>
                <select
                  id="mem-kind"
                  className="select"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                      {k.binding ? ' — binding on every task' : ''}
                    </option>
                  ))}
                </select>
                <span className="field__hint">{KINDS.find((k) => k.id === draft.kind)?.blurb}</span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="mem-title">
                  Title
                </label>
                <input
                  id="mem-title"
                  className="input"
                  value={draft.title}
                  placeholder="e.g. We use Postgres, not an ORM"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="mem-body">
                  What agents need to know
                </label>
                <textarea
                  id="mem-body"
                  className="textarea"
                  rows={5}
                  value={draft.body}
                  placeholder="Be specific and imperative. This text is injected verbatim into agent prompts."
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </div>
            </div>
            <div className="card__footer">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!draft.title.trim() || !draft.body.trim()}
                onClick={() => void save()}
              >
                Save
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <input
          className="input"
          style={{ margin: '16px 0' }}
          value={query}
          placeholder="Filter memory…"
          aria-label="Filter memory"
          onChange={(e) => setQuery(e.target.value)}
        />

        {snapshot.memory.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Nothing remembered yet</div>
            <p className="empty__body">
              Agents write here as they work — a task that pins an interface records it as a decision. You can
              add entries yourself, and the ones you write are usually the most valuable.
            </p>
          </div>
        ) : (
          <>
            {binding.length > 0 && (
              <section style={{ marginBottom: 'var(--space-5)' }}>
                <h3
                  className="subtle"
                  style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
                >
                  Binding on every task
                </h3>
                <div className="col" style={{ gap: 'var(--space-2)' }}>
                  {binding.map((note) => (
                    <MemoryCard key={note.id} note={note} projectId={activeProject.id} />
                  ))}
                </div>
              </section>
            )}

            {other.length > 0 && (
              <section>
                <h3
                  className="subtle"
                  style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
                >
                  Retrieved when relevant
                </h3>
                <div className="col" style={{ gap: 'var(--space-2)' }}>
                  {other.map((note) => (
                    <MemoryCard key={note.id} note={note} projectId={activeProject.id} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MemoryCard({ note, projectId }: { note: MemoryNote; projectId: string }) {
  const run = useAction();
  const [expanded, setExpanded] = useState(false);
  const kind = KINDS.find((k) => k.id === note.kind);

  return (
    <div className="card">
      <div className="card__body">
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge badge--${kind?.binding ? 'accent' : 'neutral'}`}>
            {kind?.label ?? note.kind}
          </span>
          <button
            type="button"
            className="grow truncate"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            onClick={() => setExpanded((e) => !e)}
          >
            {note.title}
          </button>
          <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
            {new Date(note.updatedAt).toLocaleDateString()}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={`Delete ${note.title}`}
            onClick={() => void run(() => api.deleteMemory(projectId, note.id), 'Removed from memory')}
          >
            <IconTrash size={12} />
          </button>
        </div>

        {expanded && (
          <pre
            className="muted"
            style={{
              margin: '8px 0 0',
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              fontSize: 'var(--text-sm)',
              lineHeight: 1.6,
            }}
          >
            {note.body}
          </pre>
        )}
      </div>
    </div>
  );
}
