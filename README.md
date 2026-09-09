# Agentic Team

A desktop IDE that runs a **team** of AI coding agents on one codebase, instead
of one agent in one session.

You give it a prompt. A planning model breaks the work into a dependency graph.
Each task is routed to the best-fit model — the strongest reasoner for
architecture, something fast and free for boilerplate — and the tasks run in
parallel against your real project folder. When a provider hits its quota
mid-task, the work moves to the next provider carrying the same context and
worklog: continued, not restarted. Everything is verified before it reaches
you, and nothing touches your working tree until you accept it.

Everything runs on your machine. No account, no hosted service, no telemetry.

---

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

| | |
|---|---|
| **Plans** | A planning model turns your prompt into a task DAG with dependencies, acceptance criteria and interface contracts |
| **Routes** | Each task goes to the best-fit provider by capability, cost, latency, context and remaining quota — and shows you the score breakdown |
| **Runs in parallel** | A worker pool with file-level locks, so two agents never write the same file |
| **Fails over losslessly** | A 429 cools that provider down and continues the task on the next one with the same context pack and worklog |
| **Verifies** | Tier 1 parses every produced file; tier 2 runs your project's own typecheck, lint, test and build in a throwaway git worktree |
| **Reviews** | Per-hunk accept/reject against your real folder, with a git checkpoint per acceptance and one-click rollback |
| **Previews** | A built-in browser running your dev server; click an element and describe the change |
| **Extends** | Skills, agent profiles, plugins, and MCP connectors for GitHub, Miro, Figma, Linear and Slack |

Two modes, chosen per prompt:

- **Instant** — one planning call, generic workers, optimised for speed and
  token spend. Right for most work.
- **Full Professional** — a role-based team (PM, Architect, UX, Backend,
  Frontend, QA, Security, DevOps, Tech Writer) with phase gates and real
  artefacts: PRD, ADRs, UX spec, tests, security review, release notes.

## Providers

Ten adapters, one file each. Nothing outside `server/src/providers/` knows a
vendor exists, so adding one is a single file.

| Tier | Providers |
|---|---|
| 0 · Local | Ollama |
| 1 · Free tier | Groq |
| 2 · Subscription | Claude Code, Codex CLI, Antigravity, Gemini CLI |
| 3 · Your API key | Anthropic, OpenAI, Google, OpenRouter, any OpenAI-compatible endpoint |

The ladder is the failover order. Capacity you have already paid for — a local
model, a free tier, a subscription seat — is spent before money is.

## Getting started

Requires Node 20.11+ and git.

```bash
npm install
npm run build -w @agentic/core
npm run dev
```

Then open <http://localhost:5273>, or run it as the desktop app:

```bash
npm run dev:desktop
```

Nothing runs until a model is connected. The two free options are a **Groq**
key (<https://console.groq.com>) or **Ollama** running locally. If you already
have Claude Code, Codex, Antigravity or Gemini CLI installed, they are detected
on your PATH with nothing to paste.

Full instructions, environment variables and troubleshooting:
[docs/BUILDING.md](docs/BUILDING.md).

## From the command line

```bash
npm run at -- status          # what is connected, running and waiting
npm run at -- plan "add dark mode to the settings page"
npm run at -- watch           # follow it
npm run at -- inbox           # decisions waiting for you
npm run at -- accept <taskId>
```

The CLI uses the same routes as the app, so it inherits the same human gate
rather than being a way around it.

## How the safety works

Four properties, each enforced in one place rather than hoped for:

1. **Nothing reaches your working tree unreviewed.** Files are held in memory,
   verified in a throwaway worktree, and written only after the gate. Rejecting
   costs nothing because nothing was written.
2. **The gate is enforced on the server**, in every write-class route — not in
   the UI. A UI bug, the CLI, or a future automation cannot route around it.
3. **External content is data, never instructions.** Anything from an issue, a
   web page or a connector marks its task tainted, and tainted work never
   auto-accepts in any execution mode, including `auto`.
4. **Every acceptance is a git checkpoint** on a hidden ref, so any change is
   one click from being undone — and rolling back checkpoints the current state
   first, so undoing the undo is also possible.

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Component diagram, and the data flow for one prompt in Instant mode |
| [Building](docs/BUILDING.md) | Running it, environment, packaging, troubleshooting |
| [Routing](docs/ROUTING.md) | The policy schema, how candidates are scored, worked examples |
| [Open questions](docs/OPEN-QUESTIONS.md) | Every assumption made, and what it costs to change |
| [ADRs](docs/adr/) | One record per contested decision |

## Repository layout

```
packages/core/     contracts, DAG algorithms, routing, artifact parsing — no I/O
server/            orchestrator, providers, git, terminals, preview, connectors
  src/providers/   one file per provider; nothing else imports a vendor SDK
web/               React shell: Monaco, tabs, terminal, preview, chat
desktop/           Electron main process and packaging
cli/               `at` — headless access to the same local server
e2e/               Playwright smoke tests for the shell
docs/adr/          architecture decision records
```

## Status

All eight phases of the build plan are implemented and the app is runnable.

| Phase | |
|---|---|
| 1 · Desktop shell, explorer, Monaco, tabs, terminal, git | Done |
| 2 · Provider adapters, secrets, usage tracking | Done |
| 3 · Orchestrator (Instant), verification, diff review | Done |
| 4 · Shared memory, context packing, quota failover | Done |
| 5 · Browser preview and element picker | Done |
| 6 · Professional mode, roles, phase gates | Done |
| 7 · Skills, agents, plugins, MCP connectors | Done |
| 8 · Onboarding, cost dashboard, policy editor, packaging | Done |

**Verified by running it**, not only by tests: a real prompt against a real
project planned into a two-task DAG, routed to Claude Code, passed the syntax
gate and the project's own `npm install` / typecheck / tests in an isolated
worktree, landed in review with the working tree untouched, and applied on
acceptance — with the agent-written tests passing. Professional mode plans a
ten-task SDLC across five phases and holds every downstream task behind its
phase gate.

204 unit tests and 7 Playwright smoke tests; typecheck, lint and format clean
across every workspace.

## Development

```bash
npm test              # unit tests
npm run test:e2e      # Playwright smoke tests
npm run typecheck
npm run lint
npm run package       # installers for the current platform
```

## Licence

MIT
