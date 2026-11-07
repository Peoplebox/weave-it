# weave-prepare

> **Deprecated (0.1.6+):** `/weave-prepare` is deprecated; branch preparation is built into [weave-execute](../weave-execute/behavior.md). The deterministic CLI `weave task prepare` remains the shared prepare implementation used by `weave-execute`.

## Purpose

`weave-prepare` and `weave task prepare` prepare local branches for an active Weave change. The workflow bridges the active change branch to repo/workspace branch readiness, especially in workspace mode where the artifact root and implementation repos are different git checkouts.

## Current Behavior

The deterministic CLI surface is:

```bash
weave task prepare [--repo <id> ...] [--json]
```

The opencode slash wrapper `/weave-prepare` loads the `weave-prepare` skill. The skill resolves the active Weave context, runs one bare prepare command, and summarizes prepared, skipped, or blocked repos. Task, scope, and slice selection belong to `weave-execute`.

Prepare is branch-readiness-only. It does not implement tasks, run verification, update task statuses, commit, push, open PRs, stash, discard changes, or create remote branches.

## Domain Model

Prepare has no task selector. In repo mode, it targets the artifact root repo as synthetic repo id `root` at path `.`. In workspace mode, it targets every registered repo in `.weave/workspace.yml` unless one or more `--repo <id>` filters are provided.

## Behavioral Rules

- The CLI accepts no task ids, scope, slice, or `--all` selector. It accepts repeatable `--repo <id>` filters for callers that have already resolved task or slice scope.
- Prepare does not read root `tasks.md`, `task-slices/`, task metadata, or task dependencies.
- In repo mode, prepare targets synthetic repo id `root` at path `.`.
- In workspace mode without `--repo`, prepare targets every registered workspace repo. With `--repo`, prepare targets only the requested registered repos. Unknown requested repo ids block prepare.
- `status.yml.branch` is the canonical desired branch. `status.yml.execution.branch` is a readiness snapshot and is stale if it differs from top-level `branch`.
- Prepare uses a two-phase preflight/apply flow. If any targeted repo has a blocker, no targeted repo branch is moved. Untargeted workspace repos are not inspected, switched, or blocked.
- A git repo already on the expected branch succeeds even when dirty because no branch movement is needed.
- A dirty git repo on another branch blocks. Prepare never stashes, commits, discards, or force-checkouts dirty work.
- Clean git repos checkout the expected branch if it exists locally, or create it from the current branch if it is missing. A clean repo on a branch other than its `base` (or its default branch) blocks instead, so the change branch never picks up someone else's work.
- If switching a later repo fails, prepare switches the repos it already moved back to their previous branch, deletes the branches it created, and reports the failure as a blocker.
- A repo whose git state cannot be read blocks instead of being skipped. Registered paths are compared as real paths, so a symlinked repo path is prepared.
- With `checkout: worktree`, prepare never switches branches: it reports existing repo worktrees as `already_active`, creates worktrees for registered repos the change does not have yet (`created`), and records them in `status.yml.checkout`. See [change-checkouts](../../domain-wide/change-checkouts.md).
- Detached HEAD or unknown current branch blocks for git repos.
- Non-git targeted repos/folders succeed with `state: skipped` and `branch_status: skipped_not_git`.

## Status Storage

Successful prepare writes durable branch readiness under `wiki/changes/<change-id>/status.yml`:

```yaml
execution:
  version: 1
  branch: change/<change-id>
  repos:
    <repo-id>:
      path: <relative path or .>
      mode: <repo | workspace>
      branch: change/<change-id>
      state: <prepared | skipped>
      branch_status: <created | checked_out | already_active | skipped_not_git>
      prepared_head: <git sha, omitted when not git>
      prepared_at: <iso timestamp>
      verified_at: <iso timestamp>
```

Re-running prepare for a repo on the same branch preserves `prepared_at`, refreshes `verified_at`, and updates `prepared_head` when available. Prepare does not store dirty state, selector-specific preparation history, or `last_prepare`.

## Integrations And Side Effects

- `src/commands/task.ts` exposes the `weave task prepare` command group.
- `src/lib/task-prepare.ts` orchestrates active change resolution, workspace repo lookup, git preflight/apply, and `status.yml.execution` writes.
- `templates/skills/weave-prepare/SKILL.md` and `templates/opencode/commands/weave-prepare.md` provide agent and slash-command UX.
- `weave change new` and `weave change switch` remain scoped to the resolved artifact root; they do not prepare workspace implementation repos.

## Source Anchors

- CLI command: `src/commands/task.ts`
- Prepare orchestration and storage: `src/lib/task-prepare.ts`
- Git helpers: `src/lib/git.ts`
- Active change context helper: `src/lib/changes.ts` (`activeChangeContext`)
- Skill and wrapper: `templates/skills/weave-prepare/SKILL.md`, `templates/opencode/commands/weave-prepare.md`
- Installed copies: `.agents/skills/weave-prepare/SKILL.md`, `.claude/skills/weave-prepare/SKILL.md`, `.opencode/commands/weave-prepare.md`
- Tests: `tests/task-prepare.test.ts`, `tests/agent-skills.test.ts`

## Change History

- 2026-06-07 (change `260607-eac5-task-prepare-workflow`): introduced `weave task prepare` and `/weave-prepare`, task selector parsing, repo/workspace branch safety, two-phase preflight/apply, non-git skipped records, durable `status.yml.execution.repos` readiness storage, and packaging tests.
- 2026-06-09 (change `260609-rrsq-weave-slice`): `/weave-prepare` skill deprecated; `weave-execute` calls `weave task prepare` directly. CLI unchanged.
- 2026-06-11 (change `260611-c8up-fix-task-prepare`): simplified `weave task prepare` to branch readiness for the active repo or all registered workspace repos; task and slice selection moved fully to `weave-execute`.
- 2026-06-12 (change `260611-cuvh-slices-execution-default-afk`): added repeatable `--repo <id>` filters so workspace callers can prepare only the repos selected by an upstream slice/task resolver; untargeted repos are left untouched.

## Open Questions

- Future task execution, publish, remote branch creation, and PR workflows remain out of scope.
