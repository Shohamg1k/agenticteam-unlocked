# 0004 — The human gate is enforced at the route layer

- Status: Accepted
- Date: 2026-09-09

## Context

The product promises that agent output lands in your review before it touches
anything real, and that outward writes (a PR, a deploy, a message) wait for a
person. A promise enforced in the UI is not enforced: a CLI client, an
automation, or a UI bug routes straight past it.

## Decision

Every write-class operation checks the gate inside its HTTP handler:

- applying a task's files to the working tree,
- any connector write (PR, issue, message, deploy),
- any command outside the sandbox allow-list,
- closing a phase gate in Professional mode.

`ExecutionMode` (`approval` | `hybrid` | `auto`) is a **standing, server-side,
user-chosen policy that the same handler consults** — not a bypass path. The
check always runs; the policy is one of its inputs.

Two rules hold in every mode:

1. **Tainted content never auto-accepts.** Anything carrying external content —
   a fetched page, a connector payload, an imported issue — requires an explicit
   acknowledgement that is separate from the routine approval.
2. **Every automatic acceptance is audited**, recording what was accepted and
   which policy allowed it.

## Consequences

- The UI can be wrong without being dangerous.
- The CLI gets the same guarantees for free, because it uses the same routes.
- Auto mode is genuinely usable — it is a policy, not an escape hatch — which
  matters, because a gate people switch off entirely protects nobody.
- Cost: the check is repeated in each write-class handler rather than living in
  one middleware. Accepted deliberately: a middleware that has to know which
  routes are write-class is a list that silently goes stale as routes are added,
  and the failure mode of a stale list is an ungated write. A repeated explicit
  call fails closed; a missing list entry fails open.

## Alternatives considered

- **Gate in the orchestrator only.** Rejected: the orchestrator is not on the
  path for a direct API call to apply a diff.
- **Gate in a middleware keyed by path pattern.** Rejected for the staleness
  reason above.
