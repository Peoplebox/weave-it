---
id: 261107-ohne-each-change-gets-its-own-worktree-folder
title: Each change gets its own folder of worktrees, made with plain git
status: accepted
date: 2026-11-07
owner: arpit016
applies_to:
  - src/lib/worktrees.ts
  - src/lib/changes.ts
  - src/lib/task-prepare.ts
  - src/lib/git.ts
supersedes: []
superseded_by: null
---

# Each change gets its own folder of worktrees, made with plain git

## Context

Switching branches in the checkouts people already work in went wrong in multi-repo workspaces: connected repos had no change branch until execution, a new branch started from whatever happened to be checked out (sometimes someone else's feature branch), a repo git could not read was silently skipped, and a failure halfway left repos half switched. Parallel agents also need changes that do not share a working tree.

## Decision

With `checkout: worktree`, the default for new workspaces, `weave change new` creates one folder per change holding a git worktree of the workspace root and of each registered repo, all on `change/<change-id>`, laid out with the same relative paths as the main checkout. Each starts from the freshly fetched remote default branch. Weave calls `git worktree` directly. Setup commands run at execution time, only after a person approves each command on that machine.

## Alternatives Rejected

- **Keep switching branches in place.** Even with the bugs fixed, only one change can be checked out at a time, and every switch risks someone's uncommitted work.
- **Depend on a separate worktree management tool.** The well-known one is a native binary that cannot be installed through npm, controls worktree paths through its own user config, and handles one repo at a time, so Weave would still coordinate every repo itself while adding an install step and a pre-1.0 output format to track.
- **Create worktrees only before implementation.** Questions and research would then read repos on whatever branch they happen to be on. Worktrees are cheap to create; the expensive part, installing dependencies, is what waits until execution.

## Consequences

- No Weave command moves a main checkout, so dirty work elsewhere never blocks starting a change, and several changes run side by side.
- Each change costs a full checkout of every repo on disk, plus its own installs once it reaches execution.
- An agent session cannot move into the new folder by itself, so people open the change folder in a new session.
- Weave owns the git edge cases itself (rollback, branch already checked out elsewhere, closing). Windows, submodules, and sparse checkouts are not handled yet.
- Existing workspaces keep `in-place` checkouts until they opt in.

## Reconsider When

Disk use or checkout time per change becomes a real cost for large repos, Windows support is needed, or a worktree tool appears that can be installed with Weave and coordinates several repos.
