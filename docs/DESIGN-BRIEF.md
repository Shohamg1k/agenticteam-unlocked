# Design brief — a prompt for Claude Design

Paste everything below the line into [Claude Design](https://claude.ai/design).
It is written to be pasted whole: it carries the product, the constraints, the
current state and what to produce, because a design tool given only "redesign my
IDE" returns a beautiful screenshot of a different product.

Two things to add yourself before sending:

1. **Screenshots of the app as it is now.** The Welcome tab, the Tasks tab
   mid-run, the Diff review, and the Preview tab with the annotation overlay
   active. Design works from what exists far better than from a description of
   it, and the description below is deliberately not a substitute.
2. **Anything you personally dislike about it.** Your taste is the input this
   brief cannot supply. If the tab strip annoys you, say so — it is far more
   useful than a general request to make things nicer.

When the design comes back, the implementation path is: put the tokens into
`web/src/styles/base.css`, the primitives into `web/src/styles/components.css`,
and the layout into `web/src/styles/shell.css`. No component in this codebase
branches on theme or hard-codes a colour, so a token change reaches everything.

---

## What you are designing

**Agentic Team** is a desktop IDE that runs a *team* of AI coding agents on one
codebase, instead of one agent in one chat window.

The user types a goal. A planner decomposes it into a dependency graph of tasks.
Each task is routed to the model best suited to it — a subscription seat before
a metered API key, a cheap fast model for boilerplate, a frontier model for the
hard part — and independent tasks run in parallel against isolated git
worktrees. When a provider hits its quota, the task hands off to the next one
with its full context intact. Everything an agent produces is verified before a
human sees it, and nothing touches the working tree until it is accepted.

It runs as an Electron app on Windows, macOS and Linux. It is local-first: a
local service holds the credentials and does the model calls; the interface
talks to it over HTTP and one WebSocket.

## Who uses it

A working software engineer, on their own machine, on their own repository, for
hours at a time. They already use VS Code and Claude Code. They are not
impressed by chrome and they will notice if the interface is slower than the
work it is describing.

They are usually in one of four states, and the interface is judged on all four:

1. **Starting something.** An empty folder or a fresh repo, a goal in their
   head, and the question "will this actually do it".
2. **Watching a run.** Six tasks in flight, and the questions are: what is
   happening, is it going well, what is it costing, and do I need to intervene.
3. **Reviewing.** A task finished and produced a diff. They have to decide
   whether to accept it, and they need to be able to decide quickly and be
   right.
4. **Fixing.** Something failed, or the output is wrong, and they want to see
   why and say what to do instead.

State 2 is the one that makes this product different from a chat window, and it
is the one the current interface serves least well.

## What exists today

A dark, VS Code-shaped shell. Working, coherent, and unmistakably built by an
engineer rather than designed.

**Layout** — a CSS grid: a 48px icon rail down the left, a resizable sidebar
(200–560px) beside it, and the main area filled by a tab strip over the active
tab. A status bar runs along the bottom.

**The rail** switches which panel the sidebar shows: Explorer, Search, Tasks,
Inbox, Providers. Clicking the active icon collapses the sidebar, as VS Code
does.

**The tab strip** holds everything: files (Monaco), diffs, terminals (xterm),
the browser preview, and the full-screen views — Tasks, Inbox, Providers,
Routing, Cost, Memory, Skills, Settings, Chat, Welcome. Tabs opened by a single
click are transient and get replaced by the next one; double-clicking or editing
makes them permanent.

**The status bar** shows connection state, the open project, model spend today,
connected provider count, and the execution mode (approval / hybrid / auto).

**Tokens** live in `web/src/styles/base.css`: four themes, all four being
redefinitions of the same variable names. Surfaces are low-chroma near-blacks
(`#16181d` app, `#1c1f26` panel, `#23262f` elevated); text is `#e4e6eb` down to
`#6b7280`; the accent is indigo `#6366f1`; state colours are GitHub-ish green,
amber, red and blue. Type is Inter for UI and JetBrains Mono for code, on an
11/12/13/14/16/20px scale. Spacing is a 4px scale.

**Provider tiers have their own colours** — local green, free-cloud blue,
subscription purple, BYOK amber — so the failover ladder is legible at a glance.
That idea is worth keeping and worth extending; it is currently used in one
place and could be a real visual language.

## What is wrong with it

Be direct about these; they are why this brief exists.

- **It looks like a settings panel, not a product.** Everything is the same
  weight, the same size, the same grey. Nothing tells you where to look. The
  Welcome screen is three bordered boxes in a column.
- **A running plan is the whole point and it reads as a list.** Six agents
  working in parallel on a dependency graph, each on a different model, some
  waiting on others — and the interface shows rows of text with status words.
  There is no sense of motion, of the graph, of what is blocked on what, or of
  progress.
- **Density is uniform and wrong.** An IDE should be dense, but the same density
  applied to a review decision and to a file tree means the review decision does
  not get the room it needs to be made well.
- **State is announced, not shown.** "running", "verifying", "review" are words
  in a table. A person glancing at the screen from across the room should be
  able to tell whether things are going well.
- **Cost and quota are buried.** A core promise of the product is that it is
  cheaper — the interface barely says so, and never in the moment when it is
  being earned.
- **Only dark.** It should be excellent in light too, and the token system is
  already built to allow it.

## What to produce

1. **A refreshed token set** — surfaces, text, borders, accent, state colours,
   elevation and focus — as CSS custom properties, for a **dark theme and a
   light theme** with the same variable names. Keep the four provider-tier
   colours as a deliberate part of the system.

2. **A type and spacing scale** with real steps, sized for an interface that is
   read all day at close range. Say which size is used for what.

3. **Four screens, designed:**
   - **Welcome / new project** — the moment someone decides whether this is
     worth using. Currently three boxes.
   - **A plan in flight** — the signature screen. Several agents, several
     models, a dependency graph, live progress, running cost. This is the one to
     spend the most time on.
   - **Review a task's diff** — a decision surface: what changed, what the
     verification found, accept / reject / send back.
   - **The preview with annotations** — the user's app in a frame, with drawn
     notes on it and a way to send them to an agent.

4. **Component specs** for the primitives the shell is built from: button
   (primary, ghost, icon, danger), input, select, badge, card, tab, panel
   header, empty state, toast, progress. Each with its hover, focus-visible,
   active, disabled and loading states — the states are the specification, not
   an afterthought.

5. **A status vocabulary.** Nine task states — planned, queued, running,
   verifying, review, done, failed, cancelled, blocked — that are
   distinguishable at a glance and not by colour alone.

## Constraints, all of them real

- **Electron desktop, one window.** No mobile layout. Assume 1280×800 as the
  smallest sensible size and design for 1440×900. It must not fall apart at
  1920 or on a 4K display.
- **Monaco is the editor and xterm is the terminal.** Both bring their own
  theming and their own type. The design has to sit around them convincingly,
  not pretend they are not there.
- **Dark by default**, light fully supported, both from the same token names.
- **Nothing branches on theme.** A component reads `var(--bg-panel)`; it never
  knows which theme is active. Keep it that way.
- **The tab strip stays.** Files, diffs, terminals and the preview live in one
  strip; that is the model users already have and it is the right one.
- **Keyboard first.** Every action reachable without a mouse, a visible focus
  ring on everything, and Ctrl/Cmd+B, Ctrl+Tab and Ctrl+W already bound.
- **No new dependency.** Plain CSS with custom properties, no Tailwind, no
  component library. A design that requires one is a design that cannot be
  built here.
- **It has to stay fast.** No layout that needs measurement on every frame, no
  animation on a list that can hold hundreds of rows.

## The bar

The product's claim is that a team of specialist models beats one generalist
session. The interface should make that claim visible: you should be able to see
several agents working, see which model each is on and why, see the cost being
kept down, and see the moment your judgement is needed.

Aim for the density and confidence of Linear, the calm of a good terminal, and
none of the decoration of a marketing page. If a person opens this next to VS
Code, it should look like it belongs on the same machine — and like it knows
something VS Code does not.
