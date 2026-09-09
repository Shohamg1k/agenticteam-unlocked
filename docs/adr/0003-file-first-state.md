# 0003 — Canonical state is files; any database is a rebuildable index

- Status: Accepted
- Date: 2026-09-09

## Context

The app holds plans, task graphs, worklogs, memory notes, checkpoints, agent
profiles, skills and config. The conventional choice is SQLite as the source of
truth.

## Decision

Canonical state is plain files under `.agentic-team/` in the project:

```
.agentic-team/
  config.json           project settings
  plans/<planId>.json   plan and its tasks, written atomically
  memory/*.md           project memory, human-readable
  agents/*.md           agent profiles
  skills/*/SKILL.md     skills
  checkpoints.json      checkpoint refs
  policies/*.json       routing policies
```

Any database is used only as a search index over that content, and can be
deleted at any time and rebuilt from the files.

The test: **if deleting a JSON file kills a feature rather than losing that
file's data, the feature is built wrong.**

## Consequences

- Everything is greppable, diffable, and survivable. A user can read their task
  board in a text editor, and `git diff` shows what an agent changed about it.
- A corrupt or version-mismatched index costs a rebuild, never a plan.
- Teams that want a shared board can commit the folder; by default the app
  writes a `.gitignore` that excludes the index and checkpoints.
- Cost: more file I/O, and no transactions across entities. Mitigated by writing
  each plan as a single file — so a plan and its tasks are atomic together — and
  by writing through a temp file plus rename.
- Native `better-sqlite3` becomes optional rather than required, which removes a
  hard native-build dependency from the install path.

## Alternatives considered

- **SQLite as the source of truth.** Rejected: it makes the user's own data
  opaque to them, makes team sharing require an export, and turns a native
  module load failure into a fatal error instead of a degradation.
- **In-memory only, persisted on exit.** Rejected: a crash loses a plan, which
  is precisely the failure this product exists to prevent.
