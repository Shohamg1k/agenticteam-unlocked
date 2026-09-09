# 0005 — One state snapshot pushed over a WebSocket

- Status: Accepted
- Date: 2026-09-09

## Context

The UI shows the same underlying state in many places at once: the task panel,
the task graph, the status bar, the inbox, the cost dashboard and the provider
list are all views of one running plan. While a plan runs, that state changes
several times a second.

The conventional design is a REST endpoint per feature, polled or refetched by
each panel. Every panel then holds its own copy, fetched at its own moment.

## Decision

The server pushes **one whole-state `Snapshot`** over a single WebSocket
whenever anything changes, coalesced to at most one frame every 120ms. The
client keeps exactly one copy and every panel is a pure function of it.

Two things are deliberately *not* in the snapshot:

- **Streamed model output**, which changes per token. It goes on its own
  channel to only the clients watching that task, and is held in a ref so a
  token does not re-render the tree.
- **Terminal bytes**, for the same reason, re-broadcast as DOM events straight
  into the xterm instance that owns them.

## Consequences

- **Panels cannot disagree.** The bug class where the status bar says "2
  running" while the task list shows three is not fixed here — it is
  unrepresentable.
- **Reconnect is free.** A dropped socket reconnects and the server sends a
  fresh snapshot. There is no client-side reconciliation, no cache
  invalidation, and no stale-data window after the core service restarts, which
  it does constantly in development.
- **Cost: bandwidth.** The snapshot is scoped to the active project for exactly
  this reason — sending every project's tasks would grow without bound for a
  user who has opened twenty folders, and no view shows more than one project
  at a time.
- **Cost: serialisation.** Building the snapshot on every mutation would spend
  more CPU on JSON than on the work, hence the coalescing window. 120ms is
  below the threshold where a person reads the UI as laggy, and well above the
  rate at which a running plan mutates state.
- The CLI reads the same snapshot through `GET /api/snapshot`, so it cannot
  drift from what the app shows.

## Alternatives considered

- **REST per feature, polled.** Rejected: it is the design that produces
  disagreeing panels, and polling a local service several times a second per
  panel is not cheaper than one push.
- **Server-sent events.** Fine for the snapshot, but the terminal needs a
  bidirectional channel anyway, and one connection is simpler to reason about
  than two.
- **Diffs instead of whole snapshots.** Rejected for now: it reintroduces
  reconciliation and the reconnect edge cases, to save bandwidth on a loopback
  connection. Worth revisiting only if a project ever makes the snapshot large
  enough to matter.
