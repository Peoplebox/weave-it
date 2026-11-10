# Checkpoint Commits

## Purpose

Weave commits a change's work on the change's own branch at fixed moments, so planning work is never lost, history reads stage by stage and slice by slice, and code reviews measure between real commits. Nobody has to remember to commit, and the behavior is identical in every agent because the commits come from Weave's own commands, never from agents running git (decisions `261111-htho`, `261111-kx9x`, `261111-7orw`).

## Current Behavior

### Planning commits

Every command that records change status makes a planning commit after its status write:

| Command | Moment | Subject (default) |
| --- | --- | --- |
| `weave change progress <lane>` | `progress` | `<Stage>: <--summary, else the artifact's H1, else the change title>` |
| `weave change verdict <lane> <verdict>` | `verdict` | `Stress test (<lane>): <verdict>[ — <summary>]` |
| `weave change clear-stale <lane>` | `clear-stale` | `<Stage>: back in line[ — <summary>]` |
| `weave change knowledge <status>` | `knowledge` | `Knowledge: <summary or status>` |
| `weave review record --finalize / --failed`, or a resolution that leaves the run waiting on a person | `review` | `Slice <id> review: <state>` or `Final review: <verdict>` |

Stage names: Questions, Research, Product shape (exploration), PRD, Findings, Architecture, Slices.

- **Scope.** A planning commit stages only this change's planning scope:
  - the change folder
  - decision files whose frontmatter `change:` is this change, decisions whose `superseded_by` names one of them, and `wiki/decisions/index.md`
  - knowledge paths listed in the change's `knowledge` status (`files`, `domains`, `shared`) and the knowledge index files

  It then commits the whole index, so anything the person had staged goes in too.
- **Ownership and catch-up.** Each moment owns some paths. Changed scope paths it does not own are committed first in a separate catch-up commit (`Planning notes for <change title>`, made with `git commit --only` after `git add --intent-to-add` for new files, so the person's staged edits stay for the moment commit).
  - Every moment owns `status.yml`, slice `status.yml` files, and `task-slices/dependency-graph.md`.
  - Progress of lane L owns its artifact (`questions.md`, `research.md`, `exploration.md`, `prd.md`, `findings.md`, `architecture.md`/`architecture/`, `task-slices/`/`tasks.md`) and changed `sessions/*-<L>*.md`.
  - Architecture progress and verdicts also own this change's decision files. A verdict owns its `--session` note and `sessions/*-<lane>-stress-test.md`.
  - Knowledge owns `knowledge-delta.md` and the change's knowledge paths. Review owns `review.md`, `review/`, and `task-slices/<slice>/review/`.
- **Hooks.** Planning and catch-up commits run with `-c core.hooksPath=<empty temp dir>`, so no project hook runs, including `prepare-commit-msg` and `post-commit`.
- **Message.** The body has the summary and `Now out of date: <stages>` when propagation marked lanes stale. Trailers: `Weave-Change`, `Weave-Checkpoint: planning|catch-up`, `Weave-Stage`.
- **Flags.** All five commands accept `--summary <text>`. Change commands also accept `--commit-message <file|->` (used verbatim; trailers appended).
- A run finished by `progress` whose planning commit failed records `checkpoint: {status, reason, detail}` on the run.

### Build commits

`weave slice rollup` (after the change lock is released) commits a slice that is ready for review (every active task `done` or `not_tested`) when no build commit on HEAD's first-parent line (≤500 commits) records its current coverage.

- **Coverage** is a 12-hex hash of the slice's active `T#:status` rows. Build commits carry `Weave-Slice`, `Weave-Coverage`, `Weave-Merge-Base`, `Weave-Checkpoint: build`, and `Weave-Includes: <slice>:<coverage>` for leftovers. Build state lives only in git, never in slice `status.yml`.
- A slice finished again with new coverage gets another build commit, `<title> (additional work)`.
- **Retry window.** A due slice is retried at every rollup until another slice is `in_progress` (and not itself ready). When several slices are due, the one whose `tasks.md` changed last owns the commit and the others are its leftovers (`leftovers_from`, "Also includes uncommitted work from slice …").
- **Content.** The commit stages the whole repo except other changes' `wiki/changes/<id>/` folders and `**/.weave/coding-guidelines*.md`, runs the project's hooks, and is bounded by `commits.code_timeout_seconds` (default 300).
- **Message.** Subject: slice title. Body: the slice's `## Outcome` paragraph and its finished tasks.
- **Multiple repos.** One commit is made per repo in the slice's `repos:`. A repo id without a checkout is `skipped: not_a_git_repo`.
- Flat (legacy) changes never get code commits.

### Fix commits and review boundaries

Review packaging uses `reviewBoundaryFor(ctx, scope)`: a `CommitBoundary` for sliced changes while commits are on, `SnapshotBoundary` otherwise.

- **Start boundaries** (`start`, `round<n>-start`, `fix-start`) are always snapshots.
- **Round ends and the final fix end** first make a fix commit. Round ends give `<slice title>: review fixes, round <n>`, with `(continued)` when the round was packaged before. The final fix end gives `Final review fixes`. The body lists the targeted findings. Trailers are `Weave-Run`, `Weave-Round`, `Weave-Merge-Base`, and `Weave-Checkpoint: fix|final-fix`. Hooks run.
- **End refs** point at HEAD when HEAD (or the nearest non-planning commit below planning commits) is one of this change's build/fix commits, its `Weave-Merge-Base` equals the caller's merge-base, and the tree outside `wiki/changes`, other changes' folders, and coding guidelines is clean.
- **Snapshot fallback** reasons: `unattended`, `build_not_committed` (also skips fix commits), `head_not_checkpoint`, `merge_base_moved`, `uncommitted_changes`, `ref_failed`, `commit_failed`.
- **Reporting.** `weave review package` results add `boundary: {<repo>: {kind, reason?}}` and `checkpoints[]`. `weave review status --slice` adds `boundary` for the latest run's end ref: a ref with parents is `commit`, a parentless one is `snapshot`.
- `parseSnapshotMergeBase` reads both `merge-base:` (snapshots) and `Weave-Merge-Base:` (commits).

### Outcomes

Every checkpoint returns `{status: committed|skipped|failed, kind, repo?, slice?, sha?, subject?, files?, reason?, detail?, catch_up?, leftovers_from?, notice?, warnings?}`. It never throws, and exit codes are unchanged.

- **Skip reasons:**
  - switches: `commits_off_project`, `commits_off_personal`, `change_skipped`
  - not applicable: `flat_change`, `unattended`, `not_a_git_repo`, `build_not_committed`, `nothing_to_commit`
  - repo state: `wrong_branch`, `detached_head`, `operation_in_progress` (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge, rebase-apply)
- **Failure reasons:** `hooks_rejected`, `index_locked`, `identity_missing`, `timeout`, `git_error`. `detail` holds at most 500 characters of git's output.
- **Text output** adds `Committed <sha7>[ in <repo>] "<subject>" (<n> files)` (build and fix commits also list their files) or `Did not commit: <reason> — <detail>`.

## Configuration Dimensions

- **Project switch:** `commits.enabled` in `.weave/workspace.yml` (default true). `false` in either the main checkout or the change folder turns commits off.
- **Project settings:** `commits.subject_template` takes a string, or a map keyed by `planning`, `catch-up`, `build`, `fix`, and `final-fix`, with `{subject}`, `{stage}`, `{slice}` and `{change}` placeholders. `commits.code_timeout_seconds` sets the code-commit timeout. Both are read from the change folder, then the main checkout.
- **Personal switch:** `commits.default.enabled` and `commits.projects.<main-checkout-path>.enabled` in `~/.weave/settings.yml`, set with `weave settings commits on|off [--project]`. Project scope beats the default. An unreadable or newer settings file means no preference, plus the warning `settings_unreadable`.
- **Per-change switch:** `weave change skip-commits --reason <text>` and `weave change unskip-commits`, stored as `commits.skipped: {reason, at}` in the change's `status.yml`.
- **Precedence:** project off, then personal off, then the per-change skip.

## Behavioral Rules

- Commits are made only on `refs/heads/<status.yml branch>` and use the person's git identity, passed through untouched with `GIT_TERMINAL_PROMPT=0`. Weave never pushes, never amends, and never makes empty commits.
- Timeouts send SIGTERM: 60 s for planning commits, `commits.code_timeout_seconds` for code commits.
- Sessions Weave launches (`background`, `here`, `terminal`) carry `WEAVE_UNATTENDED=1`. Under it, planning commits still happen, but build commits and fix commits do not (`unattended`), and the first-commit notice is not marked delivered.
- **First-commit notice.** `notice: "commits_enabled"` is returned on committed planning checkpoints until an attended command shows it. Delivery is recorded in `.git/weave/checkpoints.json`.
- Skills never run `git commit`. The shared "Silent Weave Command Output" block tells them to:
  - surface failures, and skips for `wrong_branch`, `detached_head` or `operation_in_progress`
  - list build and fix commit files
  - say the notice once

  The lifecycle block's step 6 tells them to pass `--summary`.

## Integrations And Side Effects

- `weave-execute` runs `weave slice rollup --all --json` before each slice's first task, which retries an earlier slice's build, and again after its last. It reports `checkpoints[]`.
- Handoff briefs tell sub-agents not to commit and to relay failed checkpoints and the notice.
- The change list (decision `261108-kl3n`) sees commits from the first recorded stage:
  - "no commits yet" and "planning files can't be recovered" largely disappear
  - a change abandoned in planning reads `closed`, not landed
  - a planning save after a merge reads `landed_with_newer_commits`

## Source Anchors

- `src/lib/checkpoints.ts`: runner, settings, guard, scope, ownership, planning and code commits, trailers, notice, rendering
- `src/lib/build-checkpoints.ts`: coverage, due slices, retry window, build messages
- `src/lib/review/commit-boundary.ts`: `CommitBoundary`, `reviewBoundaryFor`, `boundaryReport`, `boundaryKindOf`
- `src/lib/changes.ts`: `recordPlanningCheckpoint`, progress/verdict/clear-stale/knowledge wiring, `setChangeCommitsSkipped`, run failure recording
- Commands: `src/commands/change.ts`, `src/commands/slice.ts`, `src/commands/settings.ts`, `src/commands/review/{record,package,status}.ts`
- `src/lib/agent-launchers.ts` and `src/lib/advance.ts`: `WEAVE_UNATTENDED` and the brief line
- `src/lib/skill-template-checks.ts`: the canonical shared blocks
- Tests: `tests/checkpoints-planning.test.ts`, `tests/checkpoints-controls.test.ts`, `tests/checkpoints-build.test.ts`, `tests/checkpoints-review.test.ts`

## Change History

- 2026-11-11 (change `261111-kdv6-commit-checkpoints`): introduced planning, catch-up, build and fix checkpoint commits, commit-backed review end boundaries, switches, the first-commit notice, and the unattended marker.

## Open Questions

- Pushing and drafting pull requests after the knowledge stage is a planned separate change.
- Reading a change's starting branch from the committed `status.yml` (decision `261108-kl3n`'s reconsider condition) was not pursued.
- Handoff sub-agents carry no unattended marker; supported phases never trigger code commits.
