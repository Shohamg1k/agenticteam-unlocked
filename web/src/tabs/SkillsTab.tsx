import React, { useState } from 'react';
import type { SkillDef } from '@agentic/core';
import { api } from '../api.js';
import { useAction, useApp } from '../state.js';
import { IconPlus, IconTrash } from '../shell/Icons.js';

/**
 * Skills and agent profiles.
 *
 * A skill is a Markdown instruction pack injected into the context of agents it
 * is relevant to. An agent profile is a role with a system prompt and preferred
 * providers.
 *
 * Both are files on disk, so a skill is shared by copying a folder or
 * committing one — no registry, no account, no export step.
 */
export function SkillsTab() {
  const { snapshot, activeProject } = useApp();
  const run = useAction();

  const [tab, setTab] = useState<'skills' | 'agents'>('skills');

  /**
   * Which specialists this project may draw on.
   *
   * Absent means all of them, which is what almost everyone wants and what the
   * checkboxes therefore show as ticked. The list only starts existing once
   * somebody unticks something — storing "all fourteen" the moment the screen
   * opens would silently freeze the roster, so a built-in added in a later
   * version would never reach a project that had merely been looked at.
   */
  const enabledAgents = activeProject?.settings.enabledAgents;

  const setAgents = (next: string[] | undefined) => {
    if (!activeProject) return;
    void api.updateProjectSettings(activeProject.id, { enabledAgents: next ?? (null as never) });
  };

  const toggleAgent = (name: string, on: boolean) => {
    const current = enabledAgents ?? snapshot.agents.map((a) => a.name);
    const next = on ? [...new Set([...current, name])] : current.filter((n) => n !== name);
    // Back to everything ticked is the same state as never having chosen, and
    // storing it as a list would pin the roster to today's built-ins.
    setAgents(next.length === snapshot.agents.length ? undefined : next);
  };
  const [editing, setEditing] = useState<SkillDef | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', whenToUse: '', body: '' });

  if (!activeProject) {
    return (
      <div className="empty">
        <div className="empty__title">Open a project</div>
        <p className="empty__body">Skills and agent profiles live in the project folder.</p>
      </div>
    );
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.body.trim()) return;
    const saved = await run(() => api.saveSkill(activeProject.id, draft), 'Skill saved');
    if (saved) {
      setDraft({ name: '', description: '', whenToUse: '', body: '' });
      setEditing(null);
    }
  };

  return (
    <div className="scroll pad-lg" style={{ height: '100%' }}>
      <div style={{ maxWidth: 780 }}>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className={`btn btn--sm ${tab === 'skills' ? 'btn--primary' : ''}`}
            onClick={() => setTab('skills')}
          >
            Skills ({snapshot.skills.length})
          </button>
          <button
            type="button"
            className={`btn btn--sm ${tab === 'agents' ? 'btn--primary' : ''}`}
            onClick={() => setTab('agents')}
          >
            Agents ({snapshot.agents.length})
          </button>
          <span className="grow" />
          {tab === 'skills' && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                setEditing({} as SkillDef);
                setDraft({ name: '', description: '', whenToUse: '', body: '' });
              }}
            >
              <IconPlus size={12} /> New skill
            </button>
          )}
        </div>

        {tab === 'skills' ? (
          <>
            <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
              A skill is an instruction pack injected into the context of the agents it applies to — “our
              migration style”, “this project’s API conventions”. Only relevant skills are injected, because
              every one costs context on every task it touches.
            </p>

            {editing && (
              <div className="card" style={{ margin: '16px 0' }}>
                <div className="card__body col" style={{ gap: 'var(--space-3)' }}>
                  <div className="field">
                    <label className="field__label" htmlFor="skill-name">
                      Name
                    </label>
                    <input
                      id="skill-name"
                      className="input"
                      value={draft.name}
                      placeholder="postgres-migrations"
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="skill-when">
                      When should an agent use it?
                    </label>
                    <input
                      id="skill-when"
                      className="input"
                      value={draft.whenToUse}
                      placeholder="Any task that adds or changes a database table"
                      onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="skill-body">
                      Instructions
                    </label>
                    <textarea
                      id="skill-body"
                      className="textarea"
                      rows={10}
                      value={draft.body}
                      placeholder="Markdown. Written as instructions to the agent, in the imperative."
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    />
                    <span className="field__hint">
                      Be concrete. “Write good SQL” changes nothing; “every migration must be reversible and
                      live in db/migrations/NNNN-name.sql” changes everything.
                    </span>
                  </div>
                </div>
                <div className="card__footer">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={!draft.name.trim() || !draft.body.trim()}
                    onClick={() => void save()}
                  >
                    Save
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="col" style={{ gap: 'var(--space-2)' }}>
              {snapshot.skills.map((skill) => (
                <div key={skill.name} className="card">
                  <div className="card__body">
                    <div className="row" style={{ gap: 8 }}>
                      <strong className="grow truncate">{skill.name}</strong>
                      <span className={`badge badge--${skill.source === 'builtin' ? 'neutral' : 'accent'}`}>
                        {skill.source}
                      </span>
                      {skill.source !== 'builtin' && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon"
                          aria-label={`Delete ${skill.name}`}
                          onClick={() =>
                            void run(() => api.deleteSkill(activeProject.id, skill.name), 'Skill deleted')
                          }
                        >
                          <IconTrash size={12} />
                        </button>
                      )}
                    </div>
                    {skill.description && (
                      <p className="muted" style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
                        {skill.description}
                      </p>
                    )}
                    {skill.whenToUse && (
                      <p className="subtle" style={{ margin: '2px 0 0', fontSize: 'var(--text-xs)' }}>
                        Used when: {skill.whenToUse}
                      </p>
                    )}
                    {(skill.appliesTo.length > 0 || skill.roles.length > 0) && (
                      <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                        {skill.appliesTo.map((c) => (
                          <span key={c} className="badge badge--neutral">
                            {c}
                          </span>
                        ))}
                        {skill.roles.map((r) => (
                          <span key={r} className="badge badge--neutral">
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
              Agent profiles define the team. Each has a role, a system prompt describing what it must
              produce, and preferred providers — advisory, since the ladder still backs them up. A task is
              handed to a specialist only when one clearly fits; untick any you would rather it never
              reached for.
            </p>

            <div className="row" style={{ gap: 8, marginBottom: 'var(--space-2)' }}>
              <span className="subtle grow" style={{ fontSize: 'var(--text-xs)' }}>
                {enabledAgents
                  ? `${enabledAgents.length} of ${snapshot.agents.length} available to this project`
                  : `All ${snapshot.agents.length} available to this project`}
              </span>
              {enabledAgents && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAgents(undefined)}>
                  Use all of them
                </button>
              )}
            </div>

            <div className="col" style={{ gap: 'var(--space-2)' }}>
              {snapshot.agents.map((agent) => (
                <div key={agent.name} className="card">
                  <div className="card__body">
                    <div className="row" style={{ gap: 8 }}>
                      <label className="row grow" style={{ gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!enabledAgents || enabledAgents.includes(agent.name)}
                          onChange={(e) => toggleAgent(agent.name, e.target.checked)}
                        />
                        <strong>{agent.description || agent.name}</strong>
                      </label>
                      <span className="badge badge--neutral">{agent.capability}</span>
                      <span className={`badge badge--${agent.source === 'builtin' ? 'neutral' : 'accent'}`}>
                        {agent.source}
                      </span>
                    </div>
                    <p className="muted" style={{ margin: '4px 0 0', fontSize: 'var(--text-sm)' }}>
                      {agent.whenToUse}
                    </p>
                    {agent.preferredProviders.length > 0 && (
                      <p className="subtle" style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)' }}>
                        Prefers: {agent.preferredProviders.join(' → ')}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
