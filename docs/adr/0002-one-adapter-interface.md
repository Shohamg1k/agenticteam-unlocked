# 0002 — One adapter interface for API models and CLI agents

- Status: Accepted
- Date: 2026-09-09

## Context

Agentic Team drives two very different things: HTTP APIs that return a
completion, and CLI coding agents (Claude Code, Codex, Antigravity) that are
long-running subprocesses with their own agentic loop, their own tool use, and
their own idea of a working directory.

The obvious design is two interfaces. The reference implementation we studied
started that way and ended up with each CLI agent duplicating the same
probe/spawn/timeout/error-shape boilerplate, differing only in the binary and
its arguments.

## Decision

One interface, `ProviderAdapter`, with five methods:

- `probe()` — is this usable right now?
- `stream(request, signal)` — the only method that talks to a model, emitting a
  normalised `AgentRunEvent` stream.
- `estimateCost(request)` — predicted cost, before the call.
- `getQuotaState()` — observed headroom.
- `classifyError(err)` — map a vendor failure onto `AgentRunErrorKind`.

`plan()` and `execute()` are optional overrides. The default implementations
build a prompt and call `stream()`; a CLI agent with a real agentic loop
overrides `execute()` so the loop runs where it lives.

CLI agents are further factored into one declarative registry: adding Cursor or
Copilot is a config object (binary, args, how the prompt is delivered), not a
new adapter file.

## Consequences

- The orchestrator cannot tell an API model from a CLI agent, so the router can
  put a Claude Code subscription and a Groq key on the same plan and fail over
  between them. This is the core product promise, and it falls out of the
  interface rather than being special-cased.
- `classifyError` being the adapter's job is what makes failover correct: only
  the adapter knows what its vendor's 429 body looks like. The orchestrator
  routes on the classification and never parses a vendor message.
- Every adapter must emit exactly one terminal event and honour `AbortSignal`.
  These are invariants the shared adapter conformance test asserts.
- Cost estimation for subscription and local providers returns zero. That is
  correct for routing — they are not billed per token — and is why the router
  prefers capacity you have already paid for.

## Alternatives considered

- **Separate `ModelAdapter` and `AgentAdapter`.** Rejected: every consumer would
  need to branch on which one it had, which pushes provider knowledge out of the
  adapter directory — the one thing this design exists to prevent.
- **LangChain / Vercel AI SDK as the abstraction.** Rejected: neither models CLI
  subprocess agents, quota ledgers, or cross-provider failover with a carried
  worklog, which is most of what this layer is for.
