# Agentic Team

A desktop IDE that runs a **team** of AI coding agents on one codebase, instead
of one agent in one session.

You give it a prompt. A planning model breaks the work into a dependency graph.
Each task is routed to the best-fit model — the strongest reasoner for
architecture, something fast and free for boilerplate — and the tasks run in
parallel against your real project folder. When a provider hits its quota
mid-task, the work moves to the next provider carrying the same context and
worklog: continued, not restarted. Everything is verified before it reaches you,
and nothing touches your working tree until you accept it.

> Status: in active development. See [Build status](#build-status) for exactly
> what runs today.

## Why

One agent session, one model, hits four walls:

- **Serial.** One session builds one thing at a time. Parallelising means
  another session and re-explaining everything.
- **Quota.** The cap arrives mid-task and the work stops with context lost.
- **Wrong model for the job.** Frontier models on trivial edits, cheap models on
  architecture.
- **Fragmented tooling.** Skills, connectors and preview live in different
  products, so you do the glue by hand.

## What it does

|                           |                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Plans**                 | A planning model turns your prompt into a task DAG with dependencies, acceptance criteria and interface contracts                     |
| **Routes**                | Each task goes to the best-fit provider by capability, cost, latency, context and remaining quota — and shows you the score breakdown |
| **Runs in parallel**      | A worker pool with file-level locks, so two agents never write the same file                                                          |
| **Fails over losslessly** | A 429 moves the task to the next provider with the same context pack and worklog                                                      |
| **Verifies**              | Tier 1 parses every produced file; tier 2 runs your project's own typecheck, lint, test and build in a throwaway worktree             |
| **Reviews**               | Per-hunk accept/reject against your real folder, with a git checkpoint per acceptance and one-click rollback                          |
| **Previews**              | A built-in browser running your dev server; click an element and describe the change                                                  |
| **Extends**               | Skills, agent profiles, plugins, and MCP connectors for GitHub, Miro and Figma                                                        |

Two modes, chosen per prompt:

- **Instant** — one planning call, generic workers, optimised for speed and
  token spend.
- **Full Professional** — a role-based team (PM, Architect, UX, Backend,
  Frontend, QA, Security, DevOps, Tech Writer) with phase gates and real
  artefacts: PRD, ADRs, UX spec, tests, security review, release notes.

## Documentation

|                                          |                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)     | Component diagram, and the data flow for one prompt in Instant mode |
| [Routing](docs/ROUTING.md)               | The policy schema, how candidates are scored, worked examples       |
| [Open questions](docs/OPEN-QUESTIONS.md) | Every assumption made, and what it costs to change                  |
| [ADRs](docs/adr/)                        | One record per contested decision                                   |

## Repository layout

```
packages/core/     contracts, DAG algorithms, routing, artifact parsing — no I/O
server/            orchestrator, providers, git, terminals, preview, connectors
  src/providers/   one file per provider; nothing else imports a vendor SDK
web/               React shell: Monaco, tabs, terminal, preview, chat
desktop/           Electron main process and packaging
cli/               headless access to the same local server
docs/adr/          architecture decision records
```

## Build status

Delivered in phases; the app is runnable at the end of each.

| Phase                                                    | Status |
| -------------------------------------------------------- | ------ |
| 0 · Foundation contracts, docs, ADRs                     | Done   |
| 1 · Desktop shell, explorer, Monaco, tabs, terminal, git | —      |
| 2 · Provider adapters, secrets, usage tracking           | —      |
| 3 · Orchestrator v1 (Instant), verification, diff review | —      |
| 4 · Shared memory, context packing, quota failover       | —      |
| 5 · Browser preview and element picker                   | —      |
| 6 · Professional mode, roles, phase gates                | —      |
| 7 · Skills, agents, plugins, MCP connectors              | —      |
| 8 · Onboarding, cost dashboard, policy editor, packaging | —      |

## Development

Requires Node 20.11+.

```bash
npm install
npm test          # unit tests
npm run typecheck
npm run lint
```

## Licence

MIT
