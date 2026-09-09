# 0006 — A quota death is a hand-off, not a restart

- Status: Accepted
- Date: 2026-09-09

## Context

Hitting a usage cap mid-task is the failure this product exists to fix. The
normal experience is: work stops, the partial output is lost, and the user
starts again somewhere else by re-pasting the prompt. The same work is then done
twice, on two quotas.

## Decision

A provider error classified as `quota` is treated as a **hand-off**, not a
failure:

1. The failing provider is put on a cooldown (respecting its `retry-after` when
   it gives one, clamped to an hour so a provider claiming 24 hours does not
   remove itself for the session).
2. The task keeps everything: its context pack, its worklog, its partial
   output, and its attempt history.
3. The task is **re-routed**, with the failed provider excluded, and continues
   on the next rung.

The re-route is a fresh routing decision rather than walking a ladder computed
earlier. That matters: a provider that recovered while the task was running is
eligible again, and one that just refused us is not retried.

The worklog travelling with the task is what makes this "continued" rather than
"restarted" — the next model is told what has already been established, and the
pack is rebuilt to include prior attempts.

## Consequences

- Quota exhaustion costs a cooldown and a re-route, not a lost task. This is the
  central product claim and it falls out of the design rather than being a
  special case.
- The classification has to be right, which is why `classifyError` belongs to
  the adapter (ADR 0002): only the adapter knows what its vendor's 429 body
  looks like. A misclassification in the permissive direction costs one wasted
  failover; in the strict direction it strands a task, so the shared fallback
  heuristic errs permissive.
- The worklog is **bounded** (200 entries). An unbounded one would grow the
  context pack on every hand-off, so the mechanism that makes failover free
  would slowly make each attempt more expensive.
- Failed attempts still count against the plan's budget, because they still
  spent tokens. A budget that only counted successes would not be a budget.
- A task can exhaust every provider. That is a genuine failure and is reported
  as one, naming what was tried — not silently left pending.

## Alternatives considered

- **Retry the same provider with backoff.** Rejected: a daily cap does not
  clear in thirty seconds, and the user has other providers connected for
  exactly this reason.
- **Fail the task and let the user restart it.** Rejected — that is the
  behaviour the product exists to replace.
- **Keep the ladder computed at task start and walk it.** Rejected: it goes
  stale. A provider that came back mid-task should be available, and one whose
  quota was consumed by a *parallel* task should not be tried.
