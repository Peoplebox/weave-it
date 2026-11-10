---
id: 261111-htho-weave-makes-checkpoint-commits-from-its-recording-commands
title: Weave makes checkpoint commits from its recording commands
status: accepted
date: 2026-11-11
owner: arpit016
change: 261111-kdv6-commit-checkpoints
applies_to:
  - src/lib/checkpoints.ts
  - src/lib/changes.ts
  - src/commands/change.ts
  - src/lib/sliceRollup.ts
  - src/commands/slice.ts
  - src/lib/user-settings.ts
  - src/lib/workspace-repos.ts
  - src/commands/settings.ts
  - templates/skills/*/SKILL.md
supersedes: []
superseded_by: null
---

# Weave makes checkpoint commits from its recording commands

## Context

Weave never committed: planning documents, code, and review fixes stayed uncommitted until a person committed by hand, so planning work could be lost with a folder and history said nothing about stages (change `261111-kdv6-commit-checkpoints`, PRD FR1–FR38). Agents write documents with their own file tools, so Weave never sees a write; it only sees the commands a skill runs to record status. Those commands are identical in every agent.

## Decision

All automatic commits are made by one module, `src/lib/checkpoints.ts`, called from Weave's own commands, never by agents running git:

- **Planning commits** after every status write: `weave change progress`, `verdict`, `clear-stale`, `knowledge`, and `weave review record` (finalize, failed, waiting on a person). They stage only this change's planning scope (its change folder, its own and superseded decision files, its knowledge files) and commit the index with every hook disabled (`core.hooksPath` set to an empty directory).
- **Catch-up commit** first, with `git commit --only`, for scope files the recorded moment does not own (a fixed ownership table), so the person's staged edits stay for the moment commit.
- **Code commits** (slice build at rollup, fix round and final fix batch at fix packaging) stage the whole repo except other changes' folders and coding guidelines, run the project's hooks with a bounded timeout, and are never made under `WEAVE_UNATTENDED`. Build state lives in git as `Weave-Slice`/`Weave-Coverage` trailers, not in `status.yml`; a missing build is retried at each rollup until another slice starts building.
- Commits use the person's git identity unaltered, with no agent co-author line.
- **Best-effort:** a checkpoint returns `committed`, `skipped`, or `failed` with a reason inside the command's result; it never throws, retries in a loop, or blocks the command. Commits happen only on the change's own branch with no merge/rebase in progress, are never empty, and are never pushed.
- On by default; `commits.enabled` in `.weave/workspace.yml` (project), `commits` in `~/.weave/settings.yml` (personal, default or per project), and a per-change skip in the change `status.yml`. Project off wins.

## Alternatives Rejected

- **Detect file writes (agent hooks or a watcher):** different or missing per agent, needs a long-running process, and commits half-finished rewrites.
- **A separate `weave checkpoint` command skills call:** one more step agents can forget; recording already marks the end of a stage.
- **Run hooks on planning commits, or only `--no-verify`:** hooks are often not installed before setup, unattended phases would run project commands nobody approved, and `--no-verify` still runs `prepare-commit-msg` and `post-commit`.
- **Track build state in slice `status.yml`:** older rollups drop unknown keys, and the outcome write always leaves the file dirty.
- **Per-task commits:** noisy, and slices would span many commits.

## Consequences

- Every agent gets identical behaviour with no new permissions: unattended phases already may run `weave`.
- Recording commands now write git history, so tests must cover branch guards, empty-tree skips, and hook failures.
- Staged edits the person lined up go into the moment's planning commit.
- Commits use the person's git identity; a machine without one gets `failed: identity_missing`.
- Interactive signing or slow hooks are bounded by timeouts (SIGTERM, so git releases its lock) and reported.
- Change-list states shift as decision `261108-kl3n` anticipated (no-commits notes fade, abandoned changes read closed-not-landed).

## Reconsider When

Agents gain a common, reliable post-write event; teams routinely need hooks on planning commits; or history volume becomes a complaint that squash-on-merge does not solve.
