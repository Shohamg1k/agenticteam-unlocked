# Architecture

One page on what the pieces are, how they talk, and what happens when you type
one prompt in Instant mode.

## The shape

```mermaid
flowchart TB
    subgraph Desktop["Desktop shell — Electron"]
        Main["main process<br/>window, folder picker, menus,<br/>OS keychain bridge"]
        Renderer["renderer — React + TS<br/>Monaco · xterm · tabs · preview"]
    end

    subgraph Core["@agentic/core — pure contracts, no I/O"]
        Types["types · task graph · routing policy<br/>artifact parser · role table · protocol"]
    end

    subgraph Server["Local core service — Node, 127.0.0.1 only"]
        API["HTTP + WebSocket<br/>one snapshot, pushed"]
        Orch["Orchestrator<br/>tick loop · worker pool · file locks"]
        Planner["Planner<br/>goal → task DAG"]
        Router["Router<br/>policy → provider ladder"]
        Ctx["Context engine<br/>packs · code map · memory"]
        Verify["Verification<br/>tier 1 syntax · tier 2 project checks"]
        Git["Git service<br/>worktrees · checkpoints · diffs"]
        PTY["Terminals · sandbox<br/>allow-list"]
        Preview["Dev-server runner<br/>proxy + element picker"]
        Vault["Vault<br/>OS keychain"]
        MCP["Connector host<br/>MCP client"]
    end

    subgraph Providers["Provider adapters — the only place a vendor exists"]
        HTTP["HTTP: anthropic · openai · google<br/>groq · openrouter · openai-compatible"]
        CLI["CLI subprocess: claude-code<br/>codex · antigravity · gemini-cli"]
        Local["local: ollama"]
    end

    Store[(".agentic-team/<br/>plans · tasks · memory<br/>checkpoints · config<br/>canonical, file-first")]
    Repo[("Your project folder<br/>real files, no sandbox")]

    Renderer <-->|"HTTP + WS"| API
    Main --> Renderer
    Main -->|"keychain"| Vault
    API --> Orch
    Orch --> Planner & Router & Ctx & Verify & Git & PTY
    Planner --> Router
    Router --> Providers
    Orch --> Providers
    Ctx --> Store
    Orch --> Store
    Git --> Repo
    Verify --> Git
    Preview --> Repo
    API --> Preview
    MCP -.->|"untrusted data"| Ctx
    Core -.->|"imported by"| Server & Renderer

    style Core fill:#eef,stroke:#88a
    style Store fill:#efe,stroke:#8a8
    style Repo fill:#efe,stroke:#8a8
```

### Why these boundaries

**`@agentic/core` does no I/O.** It holds the types, the DAG algorithms, the
routing scorer and the artifact parser. Everything in it is a pure function, so
the parts most likely to deadlock a plan or write to the wrong path are the
parts that are exhaustively unit-testable without a network or a filesystem.

**Provider code lives in exactly one directory.** `server/src/providers/`. Every
adapter implements `ProviderAdapter`; nothing outside that directory imports a
vendor SDK or branches on a provider id. Adding a provider is one file.

**The server is local-only.** It binds `127.0.0.1`, and it is the only process
that ever calls a model. The renderer holds no keys.

**Canonical state is files.** `.agentic-team/` inside the project holds plans,
tasks, memory and config as plain JSON and Markdown. If deleting a JSON file
kills a feature, the feature is built wrong. Any index is rebuildable.

**One snapshot, pushed.** The server pushes a whole-state snapshot over a
WebSocket instead of exposing a REST endpoint per panel that the UI polls. This
costs bandwidth and buys the absence of panels disagreeing with each other.
Streaming model output is the one exception — per-token deltas go on their own
channel.

## Data flow: one prompt in Instant mode

You type _"Add Google sign-in to the settings page"_ and press Enter.

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant W as Web shell
    participant O as Orchestrator
    participant P as Planner
    participant R as Router
    participant C as Context engine
    participant A as Provider adapters
    participant V as Verification
    participant G as Git service

    U->>W: prompt + mode=instant
    W->>O: POST /api/plans
    O->>C: project summary (code map, conventions, memory)
    O->>R: route the planning call itself
    R-->>O: strongest available reasoner
    O->>P: decompose(goal, context, roster)
    P->>A: stream() one planning call
    A-->>P: JSON task graph
    P->>P: validate DAG · reject cycles
    P-->>O: 4 tasks, deps, contracts, model hints
    O-->>W: snapshot — plan awaiting approval
    U->>W: Approve (or auto-start)

    loop tick until settled
        O->>O: readyTasks(deps met, no file-lock collision)
        par worker 1
            O->>C: pack context for T2
            O->>R: route(T2)
            R-->>O: ladder — best first
            O->>A: execute(T2) in a git worktree
            A-->>O: stream deltas → UI
        and worker 2
            O->>A: execute(T3)
            A-->>O: 429 quota exhausted
            O->>R: next rung, same pack + worklog
            O->>A: execute(T3) — continued, not restarted
        end
        A-->>O: FILE: blocks
        O->>V: tier 1 — syntax parse every file
        alt syntax fails
            V-->>O: real compiler errors
            O->>A: one bounded repair with those errors
        end
        O->>V: tier 2 — typecheck · lint · test · build
        V->>G: run in a throwaway worktree
        V-->>O: green
        O->>G: checkpoint
        O-->>W: task → review, with a diff
    end

    U->>W: accept hunks
    W->>G: apply to the real working tree
    G-->>W: files written, checkpoint recorded
```

### What each step guarantees

| Step            | Guarantee                                                                              | Where                                      |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Plan validation | No cycles, no dangling deps — a bad graph fails at plan time, not at 3am in a deadlock | `core/taskgraph.validateGraph`             |
| Scheduling      | Two agents never hold the same file                                                    | `core/taskgraph.readyTasks` + the lock set |
| Routing         | Every choice returns its score breakdown and is shown to you                           | `core/routing.scoreCandidates`             |
| Failover        | The same context pack and worklog move to the next rung — continued, not restarted     | `server/orchestrator`                      |
| Tier 1          | Every produced file parses, with one bounded auto-repair from the real error           | `server/verify`                            |
| Tier 2          | The project's own typecheck/lint/test/build, in a throwaway worktree                   | `server/projectchecks`                     |
| Human gate      | Enforced at the route layer, not in the UI                                             | `server/routes`                            |
| Taint           | External content never becomes instructions, and never self-accepts                    | `server/taint`                             |
| Rollback        | Every acceptance is a git checkpoint                                                   | `server/checkpoints`                       |
| Effort          | A task gets the model, effort and verification its complexity warrants, not the maximum | `core/profiles.profileFor`                 |
| Expertise       | A task is matched to the specialist prompt and skills for what it is about              | `core/matching.selectAgent`                |
| Placeholders    | A file the model described instead of writing never reaches disk                        | `server/placeholders`                      |

## How hard a task tries

Routing decides WHO runs a task. A profile decides how hard they try, and it is
the difference between a simple job taking four minutes and taking twenty-five
seconds. Measured on `make me a calculator` with Claude Code: 227s with the
agentic tool loop, 25s without, both producing a complete working calculator.

`profileFor` reads the task and returns one of three:

| Profile      | When                                                     | Model | Effort | Tool loop | Context | Tier 2 |
| ------------ | -------------------------------------------------------- | ----- | ------ | --------- | ------- | ------ |
| **fast**     | Complexity ≤2 on a greenfield project                    | mid   | low    | no        | 12k     | no     |
| **balanced** | Complexity ≤3, or anything that must fit existing code   | mid   | medium | yes       | 40k     | yes    |
| **thorough** | Complexity ≥4, architecture, security, strong reasoning  | large | high   | yes       | 80k     | yes    |

Two rules override complexity upward, because being fast and wrong is much
worse than being slow. Work that must fit an existing codebase never gets a
lean context — it has to see the code. And architecture, security review and
anything the planner scored 4 or 5 always get the full treatment, however few
files they touch.

Turning the tool loop off is what buys most of the time. Without it the agent
answers once with FILE: blocks and the orchestrator writes them, which is the
reviewable path anyway; with it, the agent explores the repository, writes,
re-reads and verifies for minutes. The syntax and secret gates always run, so
nothing broken is waved through — only the project's own install-and-test cycle
is skipped, and only on tasks small enough that it would cost more than the task.

This makes `complexity` load-bearing rather than decorative, which is why the
planner prompt carries an anchored rubric for it rather than adjectives.

## The two modes

**Instant** — one planning call, a flat-ish DAG, generic workers, no role
preamble. Optimised for a small number of tokens and a short wall clock.

**Professional** — the same engine with a role table and phase gates:
discovery → design → implementation → verification → release. Each phase must
close before the next opens, and each role produces a named artefact (PRD, ADRs,
UX spec, tests, security review, release notes). Slower and more expensive by
design; the gates are the product.

Both run through one orchestrator. Professional mode is not a second engine —
it is a populated role table plus `PhaseGate` records.

## Failure behaviour

The system degrades rather than stopping:

| What breaks                    | What happens                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Provider hits its cap mid-task | Cooldown that rung; the task continues on the next with the same pack and worklog          |
| A CLI agent is not installed   | Probed at boot and on a timer; the ladder skips it; installing it mid-session lights it up |
| Model emits a truncated file   | Tier 1 catches it; one repair from the real parser error; then a human                     |
| Project has no test script     | Tier 2 reports `skipped`, with the reason, rather than passing silently                    |
| Every provider is down         | The plan pauses and says so. It never marks work done that no model produced               |
| A budget ceiling is hit        | Pause and ask, with the number, before spending past it                                    |

## Repository layout

```
packages/core/     contracts, DAG, routing, profiles, matching, artifact parsing — no I/O
server/            orchestrator, adapters, git, pty, preview, connectors
  src/providers/   one file per provider; nothing else imports a vendor SDK
  src/library/     built-in specialist agents and skills, matched per task
web/               React shell: Monaco, tabs, terminal, preview, chat
desktop/           Electron main process, packaging
cli/               `at` — headless access to the same server
docs/adr/          one ADR per contested decision
docs/DESIGN-BRIEF.md   the prompt for redesigning the frontend
```
