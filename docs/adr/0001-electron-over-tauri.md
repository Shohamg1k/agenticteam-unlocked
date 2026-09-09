# 0001 — Electron over Tauri for the desktop shell

- Status: Accepted
- Date: 2026-09-09

## Context

The brief preferred Tauri for its smaller footprint, with Electron acceptable
"if Monaco/terminal integration is materially easier".

Three facts decided it:

1. The target machine has no Rust toolchain (`cargo` is not on PATH). A Tauri
   shell could not be compiled or verified here — it would be code shipped
   without ever having been run.
2. Real terminals need `node-pty`, and the preview needs an HTTP proxy that can
   rewrite and inject into a dev server's responses. Both want a Node process.
   Under Tauri that means shipping a Node sidecar anyway, which returns most of
   the binary-size saving while adding a process-supervision problem.
3. The renderer is a plain Vite + React app that talks to the local server over
   HTTP and WebSocket. It imports nothing from Electron.

## Decision

Ship an Electron shell. Keep every Electron-specific concern inside
`desktop/src/` — window lifecycle, native folder picker, menus, and the keychain
bridge. The renderer receives capabilities through a narrow, typed
`contextBridge` preload; `nodeIntegration` is off and `contextIsolation` is on.

## Consequences

- Larger download (~100MB versus ~10MB). Accepted.
- Chromium is already present, so the preview tab and its dev-overlay injection
  are a `<webview>` rather than a platform webview with per-OS behaviour
  differences.
- `node-pty` and `better-sqlite3` are native modules that must be rebuilt per
  Electron ABI. Both degrade rather than failing: the terminal falls back to a
  piped `child_process` shell, and the search index falls back to a pure-JS
  store.
- Migrating to Tauri later is a change to `desktop/` alone, because nothing in
  `web/` or `server/` knows which shell is hosting it. That is the property
  worth protecting, and this decision protects it.

## Alternatives considered

- **Tauri.** Rejected for now: unverifiable on this machine, and the Node
  sidecar erases much of the benefit.
- **Browser-only, no desktop shell.** Rejected: the product needs a native
  folder picker, OS keychain access, and the ability to run local processes.
  A browser tab can do none of those.
