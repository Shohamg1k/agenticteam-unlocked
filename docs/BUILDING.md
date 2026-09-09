# Building and running

## Requirements

- **Node 20.11 or newer.** Node 22 is what CI uses.
- **git**, on your PATH. Checkpoints, rollback and worktree-isolated
  verification all use it. The app will initialise a repo in a project folder
  that does not have one, and says so when it does.
- Nothing else. No account, no database, no Docker.

## First run

```bash
npm install
npm run build -w @agentic/core   # everything else imports its build output
npm run dev                      # core service on :4400, renderer on :5273
```

Then open <http://localhost:5273>.

To run it as the desktop app instead:

```bash
npm run dev:desktop
```

That builds everything, bundles the Electron main process, and launches it. The
core service runs inside the Electron process, so there is nothing else to
start.

## Connecting a model

Nothing can run until at least one provider is connected. The two that cost
nothing:

- **Groq** — a free key from <https://console.groq.com>. Paste it into
  Settings → Providers, or set `GROQ_API_KEY`.
- **Ollama** — install from <https://ollama.com>, then
  `ollama pull qwen2.5-coder:7b`. Detected automatically once it is running.

If you already have **Claude Code**, **Codex**, **Antigravity** or **Gemini
CLI** installed, they are detected on your PATH with no key to paste — a
subscription you already pay for is the cheapest capable capacity available, and
the router prefers it over a metered key for exactly that reason.

Providers are re-probed every 30 seconds, so installing a CLI or pasting a key
lights it up without a restart.

## The commands

| | |
|---|---|
| `npm run dev` | Core service and renderer, both watching |
| `npm run dev:server` | Core service only |
| `npm run dev:web` | Renderer only (expects the service on :4400) |
| `npm run dev:desktop` | Build everything and launch the Electron app |
| `npm run build` | Build core, server and renderer |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Shell smoke tests (Playwright) |
| `npm run package` | Build installers for the current platform |
| `npm run at -- status` | The CLI |

## Environment

Everything is optional. Keys belong in the OS keychain via Settings; these exist
for CI, headless use, and people who prefer `.env`.

| | |
|---|---|
| `AGENTIC_PORT` | Core service port. Default `4400` |
| `AGENTIC_DATA_DIR` | Where machine-level state lives. Default is the OS app-data directory. Used by the test suites to stay out of your real state |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Read if the keychain has no entry for that provider |
| `OLLAMA_HOST`, `OLLAMA_MODEL` | Point at a non-default Ollama |
| `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODELS` | Register a custom OpenAI-compatible endpoint (vLLM, LM Studio, a corporate gateway) |

## Where state lives

**In your project**, under `.agentic-team/` — plans, memory, agent profiles,
skills, routing policies. Plain JSON and Markdown you can read and edit; commit
it if you want a shared task board. A `.gitignore` is written there that
excludes the volatile parts (worktrees, index, checkpoints).

**On your machine**, in the OS app-data directory — which projects exist, node
config, and usage ledgers.

**In your OS keychain** — API keys. Never in a project file, never in the
snapshot sent to the UI, and redacted from logs. Where no keychain is
available the app falls back to an encrypted file and says which backend is in
use.

## Native modules

`node-pty` (real terminals) and `@napi-rs/keyring` (OS keychain) are
`optionalDependencies`. If either fails to build, the app still runs:

- without `node-pty`, terminals fall back to a piped shell — no colour, no
  interactive prompts, and the terminal says so rather than behaving oddly;
- without the keychain, secrets go to an encrypted file under the app-data
  directory, and Settings reports which backend is active.

CI installs with `--omit=optional` deliberately, which means the degraded paths
are exercised on every run rather than only when something breaks.

## Testing

```bash
npm test              # unit tests: task graph, router, artifact parser, diff
npm run test:e2e      # Playwright, against the real service and renderer
```

The E2E suite runs with an isolated `AGENTIC_DATA_DIR` and needs no provider —
it passes on a machine with no keys and no CLI agents, which is also the state a
new user is in on first launch.

## Packaging

```bash
npm run package
```

Produces an installer for the current platform under `desktop/release/`
(NSIS and portable on Windows, DMG on macOS, AppImage and deb on Linux).
Native modules are unpacked from the asar, because a `.node` binary cannot be
loaded from inside an archive.

Cross-platform packaging is not attempted from one machine: it needs each
platform's toolchain, and the honest way to produce all three is a CI matrix.

## Troubleshooting

**"Port 4400 is already in use."** Another copy is running. Close it, or set
`AGENTIC_PORT`.

**The desktop window never appears.** The main process has no console on
Windows, so a startup failure is written to `startup-error.log` in the app-data
directory and the path is shown in the error dialog.

**A provider says it is off and you think it should not be.** The `detail` next
to it is the actual reason from the probe — a missing key, a binary not on
PATH, a daemon not running. Settings → Providers → refresh re-probes on demand.

**Verification says "skipped".** The project defines no typecheck, lint, test or
build script, so only the syntax gate ran. That is reported rather than passed
silently, because "tests passed" when there are no tests is a lie someone will
act on. Add the commands in Project settings.
