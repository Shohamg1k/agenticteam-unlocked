# Open questions and assumptions

The brief asked for clarifying questions only where a wrong guess is expensive
to undo. Everything below is either **decided** (with the reasoning, so you can
overturn it cheaply) or **open** (with the assumption being built on meanwhile).

Nothing here blocks the build. Each open item names the file that would change.

---

## Decided, with reasoning

### D1 — Electron, not Tauri

The brief preferred Tauri for footprint. **Electron was chosen.**

- No Rust toolchain on the target machine (`cargo` is not installed), so Tauri
  could not be built or verified here at all. Shipping an unbuildable shell is
  worse than a larger one.
- `node-pty` (real terminals) and the dev-server proxy both want a Node main
  process. Under Tauri they would need a sidecar Node process anyway, which
  gives back most of the footprint saving.
- The renderer is a plain Vite app talking HTTP + WebSocket to a local server.
  Nothing in it is Electron-specific, so a Tauri shell later is a change to
  `desktop/`, not to `web/` or `server/`.

Recorded as [ADR 0001](adr/0001-electron-over-tauri.md).

### D2 — Adapters are one interface, and CLI agents are adapters too

`ProviderAdapter` covers HTTP models and CLI agents through the same five
methods. A CLI agent is a subprocess whose stdout is normalised into the same
`AgentRunEvent` stream. The orchestrator cannot tell them apart, which is what
lets the router mix a Claude Code subscription and a Groq key on one plan.

### D3 — File-first state, no database on the critical path

`.agentic-team/` holds plans, tasks, memory and config as JSON/Markdown.
SQLite is optional and only ever an index that can be deleted and rebuilt.
Vector search uses a local TF-IDF-style index by default so the app works
offline with no embedding key; a real embedding provider is used when one is
connected.

Rationale: portable, greppable, diffable, and survivable. A corrupt database
should never cost you a plan.

### D4 — The human gate lives at the route layer

Approval is checked in the HTTP handler, not in the UI. A UI bug, a CLI call, or
a future automation cannot bypass it. Auto-accept in `hybrid`/`auto` mode is a
standing server-side policy the same code path consults — not a bypass. Tainted
content never auto-accepts in any mode.

### D5 — Verification is two tiers, and tier 2 runs in a worktree

Tier 1 is a syntax parse of every produced file (esbuild), needs no project
config, and runs everywhere from the first task. Tier 2 runs the project's own
typecheck/lint/test/build in a throwaway git worktree, so a failing agent run
never touches your working tree.

### D6 — Cost estimates are estimates, and say so

Token counts use a character heuristic, not a per-provider tokenizer. Real
tokenizers are per-vendor dependencies in shared code, and these numbers are
only ever used for ranking and warnings. Every number the UI shows from an
unmeasured call is labelled as an estimate; measured provider-reported usage
replaces it as soon as it arrives.

### D7 — Default execution mode is `approval`

Nothing is applied to your working tree without you accepting it. `hybrid` and
`auto` exist and are one click away, but the shipped default is the strict one.

---

## Open — building on a stated assumption

### Q1 — Which subscription CLIs should ship enabled by default?

**Assumption:** adapters ship for `claude-code`, `codex`, `antigravity` and
`gemini-cli`, each probed by running `<bin> --version`. A CLI that is not
installed shows as unavailable and the ladder skips it. No CLI is _required_.

**Why it matters:** if you want a different set (Cursor, Copilot, Amp, Droid),
each is a config object in `server/src/providers/cli-agents.ts`, not new code.

**Cost to change:** minutes.

### Q2 — Claude Code subscription usage: how should it be counted?

**Assumption:** subscription providers are billed at **$0 per token** for
routing purposes, and their quota is tracked as _requests_ with a cooldown when
the CLI reports a usage limit. The router therefore prefers a subscription over
a metered key, which matches "I already paid for this".

**The open part:** we cannot read your remaining Claude Pro/Max allowance
programmatically — the CLI does not expose it. So the ledger is reactive: it
learns the cap exists when a call is refused. If you would rather set a manual
daily ceiling, that is a field in the provider settings.

**Cost to change:** small — `server/src/providers/claude-code.ts` and the quota
ledger.

### Q3 — Should agents run with permission prompts skipped?

**Assumption:** yes, by default, _because the run is contained_: it happens in a
throwaway git worktree, the command sandbox has an allow-list, and every file
lands in review before it touches your tree. `manual` is one switch away and is
honestly labelled — a CLI that blocks on a prompt in a non-interactive run will
hang until the adapter's timeout, and the UI says so rather than hiding it.

**Cost to change:** trivial — it is a setting today.

### Q4 — Miro and Figma: read-only, or write too?

**Assumption:** **read is enabled, write requires explicit approval per action.**
Agents can read a Figma file to implement UI and read a Miro board as context.
Writing a diagram to a board or creating a Figma frame is a connector write, so
it goes through the same human gate as opening a PR.

**The open part:** whether you want agents to draw architecture diagrams to Miro
_automatically_ at the end of the design phase in Professional mode. It is
currently a task the Architect role can produce but a human must approve.

**Cost to change:** small — a phase-gate policy flag.

### Q5 — What is the element picker's source resolution contract?

**Assumption:** a dev-overlay script is injected into the preview. Resolution is
best-effort and layered:

1. `data-agentic-source` attributes, if the project uses our Vite/Babel plugin;
2. React DevTools fibre inspection, when React is present;
3. a stable CSS selector plus the element's outer HTML, always.

Layer 3 always works, so the picker never hard-fails — it just gives the agent a
selector to search for rather than a file and line.

**The open part:** whether to auto-install the Vite plugin into the user's
project (which edits their config) or require them to add it. Currently: **we do
not edit your config**; the app offers a one-click patch you can review.

**Cost to change:** small.

### Q6 — Git strategy for parallel workers

**Assumption:** each task runs in its own **git worktree** off a scratch branch,
and accepted output is applied to the real working tree as a patch. Worktrees
are used rather than an in-memory patch queue because tier-2 checks need a real
directory to run `npm test` in.

**The open part:** whether accepted work should also produce a **commit per
task** on a feature branch (currently: no — a checkpoint ref per acceptance,
with commits left to you, because most people want to shape their own history).

**Cost to change:** small — `server/src/git.ts`.

### Q7 — Budget defaults

**Assumption:** per-plan ceilings of **120 model calls, $5, 60 minutes**, with
"ask before exceeding" on. These are guesses about a median session; they are
per-project settings.

### Q8 — Does the project folder get `.agentic-team/` committed?

**Assumption:** **not committed by default** — the app writes a
`.agentic-team/.gitignore` that ignores checkpoints and the index but leaves
plans, memory and config trackable if you choose. Teams that want a shared task
board can remove that file and commit the folder.

---

## Things deliberately not built

Stated plainly so they are not mistaken for oversights:

- **No hosted service, no account, no telemetry.** The app runs offline apart
  from the model calls you configure.
- **No cloud sync of secrets.** Keys live in the OS keychain and never leave the
  machine, never enter a project file, and are redacted from logs.
- **No agent-authored `git push` or deploy without approval.** Both are
  destructive-class actions behind the human gate, in every execution mode.
