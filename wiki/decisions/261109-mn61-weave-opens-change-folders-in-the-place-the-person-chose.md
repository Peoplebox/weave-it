---
id: 261109-mn61-weave-opens-change-folders-in-the-place-the-person-chose
title: Weave opens change folders in the place the person chose
status: accepted
date: 2026-11-09
owner: arpit016
change: 261109-479a-open-worktree-when-created
applies_to:
  - src/lib/open-change.ts
  - src/lib/open-places.ts
  - src/commands/change.ts
  - src/commands/settings.ts
  - src/lib/worktrees.ts
  - src/lib/changes.ts
  - src/lib/task-prepare.ts
  - src/lib/git.ts
  - templates/skills/weave-new/SKILL.md
  - templates/skills/weave-next/SKILL.md
  - templates/skills/weave-fix/SKILL.md
supersedes:
  - 261107-ohne-each-change-gets-its-own-worktree-folder
superseded_by: null
---

# Weave opens change folders in the place the person chose

## Context

Decision `261107-ohne` gave each change its own folder of worktrees. One of its consequences was that "an agent session cannot move into the new folder by itself, so people open the change folder in a new session". In practice every create and switch then costs a manual tab, a `cd`, starting an agent, and remembering the first step, and people often keep working in the old session by mistake. Most agents still cannot move a session, but Weave can open a new one: terminals and apps accept a folder on their command line. This record supersedes `261107-ohne` so that agents looking up `worktrees.ts` or `changes.ts` find one current record. It keeps that decision's core unchanged.

## Decision

**Carried over unchanged from `261107-ohne`:** with `checkout: worktree`, the default for new workspaces, `weave change new` creates one folder per change holding a git worktree of the workspace root and of each registered repo, all on `change/<change-id>`, laid out with the same relative paths as the main checkout. Each starts from the freshly fetched remote default branch. Weave calls `git worktree` directly. Setup commands run at execution time, only after a person approves each command on that machine.

**New:** in change-folder mode, Weave opens the change's folder in a place the person chose explicitly:
- **Where:** a terminal from a fixed list (herdr, tmux, iTerm, Terminal) with a chosen agent or a shell, or an app from a fixed list (VS Code, Cursor, Claude desktop, T3 Code).
- **How the choice is made and kept:** it is asked once, through a terminal menu (text output at a real TTY only) or by the calling agent in chat (`needs_choice` in `--json`). It is then saved as a personal default that applies to every create and switch, whoever runs the command.
- **The command:** opening is a separate command with no git side effects (`weave change open`), which `new` and `switch` call.
- **Guarantees:** opening never blocks or undoes the create or switch, never sends a step, and always leaves the folder and next step in the original session.

## Alternatives Rejected

- **For the folder model:** see `261107-ohne` (switch branches in place, depend on a separate worktree tool, create worktrees only before implementation). Those reasons still hold.
- **Better hand-off text, no opening.** It describes the chore without removing it.
- **Guess the place from the environment.** Unpredictable, and it opens windows nobody chose.
- **Move the current session where possible (Claude Code), otherwise a new tab.** Best in one agent and weaker everywhere else.
- **Open from inside `new` and `switch` only, reopening through `switch`.** Reopening would fetch and touch worktrees.
- **Return an open plan for the calling agent to run.** Failure handling would move into every skill, and older guided flows would silently do nothing.

See `wiki/changes/261109-479a-open-worktree-when-created/architecture/index.md`, Options Considered.

## Consequences

- **Carried over from `261107-ohne`:**
  - No Weave command moves a main checkout.
  - Each change costs a full checkout of every repo on disk, plus its own installs.
  - Weave owns the git edge cases.
  - Windows, submodules, and sparse checkouts are not handled.
  - Existing workspaces keep `in-place` checkouts until they opt in.
- **Replaced:** people no longer open the change folder themselves. After one answer, creating or switching lands them in the folder, with the folder and next step always shown as a fallback.
- **Accepted:** scripts on a machine with a saved default open one session per create or switch.
- **Fixed registry:** Weave carries a fixed registry of places and agents with fixed checks. A new tool needs a Weave release, and each tool's draft support has to be checked by hand.
- **Skills:** `weave-new`, `weave-next`, and `weave-fix` must handle `needs_choice` (or pass `--no-open`), and fall back when an older CLI rejects the new flags.

## Reconsider When

Any of these:
- From `261107-ohne`: disk use or checkout time per change becomes a real cost, Windows support is needed, or a worktree tool appears that can be installed with Weave and coordinates several repos.
- From this decision: most supported agents can move their own session into another folder, a common cross-agent way to open a visible session appears, or keeping the fixed tool list up to date costs more than it saves.
