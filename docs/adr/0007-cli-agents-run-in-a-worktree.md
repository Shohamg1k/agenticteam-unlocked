# 0007 — CLI agents run in an isolated worktree, not the project root

- Status: Accepted
- Date: 2026-09-09

## Context

HTTP adapters return text. Nothing they do reaches the filesystem until the
orchestrator writes it, so the human gate is trivially enforceable for them.

CLI coding agents are different in kind. Claude Code, Codex, Antigravity and
Gemini CLI are autonomous agents with their own file tools, their own agentic
loop, and their own idea of a working directory. They edit files. That is what
they are, and it is why they are worth having on the ladder.

They were originally spawned with the user's project root as their `cwd`, for
the obvious reason: it is the directory the work is about.

The consequence was found by watching a real Professional-mode run —
`docs/PRD.md` appeared in the working tree while the task was still executing
and long before anyone had reviewed it.

That made the product's central promise **selectively true**. "Nothing touches
your working tree until you accept it" held for six providers and quietly did
not for four. A guarantee with an undocumented exception is worse than no
guarantee, because people rely on it.

## Decision

A CLI agent's working directory is a throwaway git worktree created off the
project's current HEAD. When it finishes, its work is collected back out of the
worktree as file artifacts, and the worktree is destroyed.

Those artifacts then go through exactly the same path as an HTTP adapter's
output: tier-1 syntax gate, secret scan, tier-2 project checks, the human gate,
the diff, the checkpoint.

Three supporting rules:

- **No worktree, no run.** If one cannot be created, the attempt fails and the
  ladder moves the task to a provider that does not need one. It never falls
  back to the real tree.
- **Files beat prose.** A CLI agent's real output is what it wrote, not what it
  said. Written files take precedence over any `FILE:` blocks it also described.
- **Deletions are reported, not applied.** A reviewer cannot distinguish
  "deliberately deleted" from "lost", so a deletion is surfaced in the worklog
  and left for the user to make themselves.

## Consequences

- The promise is now true for every provider, which is the whole point.
- CLI agents become genuinely reviewable. They typically edit files and say
  "done" rather than emitting file blocks, so before this their work was
  invisible to the diff view; now it is the diff view.
- Cost: a `git worktree add` per attempt. Measured at well under a second on a
  normal repository, against agent runs measured in minutes.
- **Limitation, stated plainly:** the worktree is created from HEAD, so an
  agent does not see changes the user has made but not committed *after* the
  plan started. In practice the plan-start checkpoint commits the working tree
  first, so the common case is covered — but a file edited by hand mid-run is
  not visible to a task that starts afterwards.
- A related bug fell out of building this: git collapses a new untracked
  directory into a single `?? src/` status entry, so files inside a folder the
  agent created were silently dropped — which is most of what a build task
  produces. Collecting an agent's work now expands untracked directories.

## Alternatives considered

- **Let CLI agents write to the project and diff afterwards.** Rejected: the
  user's tree is modified before they have seen anything, so "reject" would
  require a rollback rather than being free. It also races with the editor,
  which would reload files mid-run.
- **Run them with filesystem tools disabled.** Rejected: it removes the reason
  to use them. An agent that cannot read the repository as it works is an
  expensive way to get a single completion.
- **A container or a copied directory instead of a worktree.** Rejected: a
  container is a heavy dependency for a local app, and a plain copy loses the
  git history the agent uses to orient itself. A worktree is a real checkout
  that costs almost nothing.
