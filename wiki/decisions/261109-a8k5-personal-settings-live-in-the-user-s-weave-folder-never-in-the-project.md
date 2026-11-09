---
id: 261109-a8k5-personal-settings-live-in-the-user-s-weave-folder-never-in-the-project
title: Personal settings live in the user's Weave folder, never in the project
status: accepted
date: 2026-11-09
owner: arpit016
change: 261109-479a-open-worktree-when-created
applies_to:
  - src/lib/user-settings.ts
  - src/lib/user-paths.ts
supersedes: []
superseded_by: null
---


# Personal settings live in the user's Weave folder, never in the project

## Context

Until now Weave settings were project settings (`.weave/workspace.yml`, committed) or machine-local state (`.git/weave/`, the session file). Opening a change needs a preference that belongs to the person and their machine: their default place and agent, per-project overrides, their own agents, and custom install paths. It must never be shared with teammates. Weave already keeps user-level state under `~/.weave/` (`getUserWeaveDir`, `src/lib/user-paths.ts`), and tests redirect it with `WEAVE_USER_HOME`.

## Decision

Personal settings live in one YAML file, `~/.weave/settings.yml` (`version: 1`), read and written through a single module (`src/lib/user-settings.ts`) with atomic writes. Per-project overrides are keyed by the absolute path of the project's main checkout, which every change folder resolves to through `workspaceLayout`. Nothing in this file is written to the project.

## Alternatives Rejected

- **Key overrides by git remote URL.** It survives moving the project, but two clones would share one override, and projects without a remote need a fallback.
- **Store overrides in `.git/weave/`.** Machine-local and never committed, but personal settings would be split across two places.
- **XDG `~/.config/weave/`.** More conventional on Linux, but `~/.weave/` is where Weave's user-level state already lives (run logs, the npm-version cache) and where `WEAVE_USER_HOME` already redirects tests. The session file in `~/.cache/weave/` is a cache, not settings.

## Consequences

- One file for a person to read and edit, and the same location on macOS and Linux.
- Moving or re-cloning a project drops its per-project override, and stale keys stay in the file until removed. This is accepted.
- Future personal preferences have a home, and every new key must stay personal and never describe the project.
- The file is shared by every Weave install on the machine. A Weave that doesn't recognise a saved value leaves it untouched and never overwrites it.

## Reconsider When

People need personal settings synced across machines, Weave adds Windows support, or overrides keyed by path go stale often enough to cause confusion.
