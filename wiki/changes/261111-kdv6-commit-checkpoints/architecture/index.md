---
facet: index
description: Canonical entry point for a folder-based architecture artifact, holding the technical shape.
---

# Commit Checkpoints Architecture

## Decision Summary

- One module, `src/lib/checkpoints.ts`, makes every automatic commit through its own git runner that passes the environment through untouched; agents never run git for it.
- Planning commits run inside the commands that write change status (`progress`, `verdict`, `clear-stale`, `knowledge`, `review record`), after the status write, with **all hooks disabled** (`-c core.hooksPath=<empty dir>`) and a pathspec limited to Weave's planning paths for this change.
- A catch-up commit runs first for this change's planning files the recorded moment does not own; it uses `git commit --only -- <paths>` so the person's staged edits stay for the moment commit.
- Build commits are triggered by `weave slice rollup` when a slice is ready for review and its **coverage** (active task ids and statuses) differs from the last build commit's `Weave-Coverage` trailer. Git history, not `status.yml`, records what was committed.
- Fix commits are made at fix-round and final-fix packaging; skipped (`build_not_committed`) while the slice's build commit is missing, so reviewer fixes never land under a build subject or vice versa.
- Code commits stage the whole repo except other changes' folders and the person's coding guidelines, run the project's hooks with a bounded timeout, and are never made from unattended sessions.
- Review end boundaries point at the build or fix commit (merge-base carried in a `Weave-Merge-Base` trailer); start boundaries and every fallback stay snapshots.
- Every checkpoint returns an outcome (`committed | skipped | failed` + reason) inside the calling command's JSON; it never throws or blocks.
- Messages: skills pass an optional `--summary`; the CLI composes subjects, bodies, and `Weave-*` trailers from artifacts; per-kind subject templates in `.weave/workspace.yml` apply project conventions to every commit kind.
- Switches: `commits.enabled` in `.weave/workspace.yml` (off in the main checkout or the change folder wins), `commits` in `~/.weave/settings.yml` (set with `weave settings commits`), and a per-change skip; project off wins.

## System Context

No `research.md` exists for this change; the baseline below was read from code and the knowledge wiki.

- **Status writes.** `progressChange`, `clearChangeStaleness`, `verdictChange`, `knowledgeChange` in `src/lib/changes.ts` (lines ~1136, ~1237, ~1318, ~1628) read and rewrite `wiki/changes/<id>/status.yml`; none touches git today.
- **Slice rollup.** `rollupSlice` in `src/lib/sliceRollup.ts` derives `status` (`pending|in_progress|done`, `done` only when every task is `done`; lines 107–119) under `withChangeLock`, rebuilds the slice `status.yml` from a field whitelist (`readSliceStatus`, lines 422–439, keeps only known keys plus `review`), and computes `ready_for_review` (`isReadyForReview` in `src/lib/review/rules.ts`: every active task `done` or `not_tested`) without storing it. `rollupChange` `git add`s changed slice `status.yml` files and `dependency-graph.md` (`stageFiles`, lines 397–406, 664–674).
- **Git identity.** `gitEnv` in `src/lib/git.ts` (lines 19–27) and the boundary's `git()` (`src/lib/review/boundary.ts` 198–206) substitute `Weave <weave@example.invalid>` when the environment sets no identity. Fine for snapshots, wrong for branch commits.
- **Review boundaries.** `ReviewBoundary`/`SnapshotBoundary` in `src/lib/review/boundary.ts` (decision `261110-wdfo`). Created by `weave review snapshot --at start` (`src/commands/review/snapshot.ts`), packaging (`src/lib/review/package.ts` ~520, ~1064), and fix rounds (`src/lib/review/rounds.ts` ~127, ~286; a round can be re-packaged with `force: true`). Slice `review:` stores only `start_ref` (`src/lib/review/state.ts` ~41).
- **Review results.** `weave review record` (`src/lib/review/record.ts`) writes `review:` blocks and `review/` records under the change folder.
- **Settings.** `.weave/workspace.yml` via `readWorkspaceMetadata` (`src/lib/workspace-repos.ts`; review reads it from `ctx.weaveRoot`, i.e. the change folder in worktree mode); personal `~/.weave/settings.yml` (`src/lib/user-settings.ts`, per-feature `open.{default,projects}` shape, decision `261109-a8k5`); per-change skips follow `review.skipped` (`src/commands/review/skip.ts`).
- **Unattended phases.** Auto-advance phases are questions→research and exploration→PRD. Background sessions are allowed `Bash(weave *)` (`src/lib/agent-launchers.ts:44`, `src/lib/agent-permissions.ts:12`); handoff sub-agents carry no environment marker.
- **Skills.** Progress-calling skills: questions, research, explore, stress-test, prd, architect, slices, fix, clarify, capture, knowledge. The stress test writes its session note before `progress` and accepts decisions (`weave adr status`) after the verdict. Execute, fix, slices, prepare say they never commit. All skills share the "Silent Weave Command Output" block.
- **Change list.** `src/lib/change-states.ts`, `src/lib/landed.ts` (decision `261108-kl3n`) derive `no_commits_yet`, `done`, `landed_with_newer_commits` from branch commits; the PRD's change-list shifts need no code change.

## Options Considered

### A. Shared checkpoint module + commit-backed review end boundaries — Chosen

- How it works: recording commands, rollup, and review commands call `checkpoints.ts`; review end boundaries point at build/fix commits through `CommitBoundary`, with snapshot fallback.
- What changes: new `src/lib/checkpoints.ts`, `src/lib/review/commit-boundary.ts`; calls added in `changes.ts`, `sliceRollup.ts`/`commands/slice.ts`, `review/record.ts`, `review/rounds.ts`, `review/package.ts`; settings readers; `weave settings commits`, `weave change skip-commits`; skill template edits.
- Trade-offs: medium–large; recording commands gain a git side effect; the off switch restores today's code paths.
- Why chosen: one place for git writes, identical in every agent, and the `ReviewBoundary` seam absorbs the boundary switch.

### B. Commits beside reviews (snapshots kept as the only boundaries) — Rejected

- Trade-offs: smaller, but two parallel systems and FR16 unmet.
- Why rejected: misses a core goal.

### C. Build commit made at review packaging — Rejected

- Trade-offs: no rollup change, but code commits only happen when review is active.
- Why rejected: code commits must not depend on review.

### D. Separate `weave checkpoint` command called by skills — Rejected

- Trade-offs: explicit, but one more step agents can skip.
- Why rejected: recording already marks a stage's end (product decision C1).

### Build state in slice `status.yml` — Rejected (stress test)

- How it works: a `commits.build` block records state, shas, and failures.
- Why rejected: an older Weave's rollup drops unknown keys (`readSliceStatus` whitelist); writing the outcome after the commit always leaves the file dirty; readiness transitions are not stored. Commit trailers in git history are durable and self-describing.

## Architecture Overview

### Checkpoint module (`src/lib/checkpoints.ts`)

```text
planningCheckpoint(ctx, moment)                      codeCheckpoint(ctx, slice|change, kind)
  ├─ resolveCommitSettings → off → skipped             ├─ resolveCommitSettings; WEAVE_UNATTENDED → skipped(unattended)
  ├─ guardRepo(repo, branch)                           ├─ guardRepo per repo (not a git repo → skipped)
  ├─ catch-up: unowned paths in this change's          ├─ git add -A -- . ':!wiki/changes/*' wiki/changes/<id>
  │    planning scope → git add -- <p>;                │      ':!.weave/coding-guidelines*.md'
  │    git commit --only -- <p>   (hooks off)          ├─ git commit (hooks on, timeout)
  ├─ git add -- <owned paths>                          └─ outcome per repo, files listed
  ├─ git commit (whole index; hooks off; 60 s)
  └─ outcome {status, reason, sha, files, catch_up?}
```

- **Git runner.** A dedicated `checkpointGit()` passes `process.env` through untouched (no `gitEnv`), adds `GIT_TERMINAL_PROMPT=0`, and enforces the timeout by sending SIGTERM, which lets git remove its own `index.lock`. A machine with no identity → `failed: identity_missing`. No agent co-author line is added (Weave stays agent-neutral); commits are the person's, marked by `Weave-*` trailers.
- **Planning scope for this change** = the change folder; decision files whose frontmatter `change:` is this change, or whose `superseded_by` names one of them, plus `wiki/decisions/index.md`; knowledge files listed in the change's `knowledge.files`/`domains`/`shared` and the knowledge index files. Other changes' decisions and hand edits elsewhere in `wiki/` are never staged.
- **Ownership table** (paths in the change folder) splits the moment commit from the catch-up:
  - `questions` → `questions.md`; `research` → `research.md`; `exploration` → `exploration.md`; `prd` → `prd.md`; `findings` → `findings.md`; `architecture` → `architecture.md`, `architecture/**`, plus this change's decision files; `slices` → `task-slices/**`, `tasks.md`
  - progress of lane L also owns changed `sessions/*-<L>*.md` (captures and stress-test notes, which are written before `progress`)
  - `verdict` → its `--session` note if still uncommitted, plus this change's decision files (status edits made around the verdict)
  - `knowledge` → `knowledge-delta.md` and the change's knowledge files
  - `review` → `task-slices/<slice>/review/**`, `review/**`, `review.md`
  - every moment owns `status.yml` and any slice `status.yml`
- **Index semantics.** The catch-up commit uses `git commit --only -- <paths>`, so it contains exactly its paths and leaves everything already staged (the person's edits, files rollup staged) staged. The moment commit then commits the whole index. Owned paths are re-added from the working tree, so partial staging of Weave's own documents is replaced by their current content.
- **Hooks.** Planning and catch-up commits run with `-c core.hooksPath=<empty temp dir>`, which disables every hook (`pre-commit`, `commit-msg`, `prepare-commit-msg`, `post-commit`, `reference-transaction`), not only the two `--no-verify` skips. Code commits run the project's hooks.
- **Branch guard:** `HEAD` must be `refs/heads/<status.yml branch>`; `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/` absent. Otherwise `skipped` (`wrong_branch`, `detached_head`, `operation_in_progress`).
- **Empty commits:** skipped (`nothing_to_commit`).
- **Timeouts:** planning and catch-up 60 s; code commits `commits.code_timeout_seconds` (default 300). Timeout → `failed: timeout`.
- **Unattended sessions.** `background`/`terminal`/`here` launches set `WEAVE_UNATTENDED=1`; code checkpoints skip with `unattended`. No auto-advance phase runs rollup or review commands, and handoff briefs keep sub-agents to their phase skill, so a handoff sub-agent triggering a code commit is out of the supported paths (risk below).
- **Workspaces:** planning commits go to the workspace root repo; code commits iterate the slice's `repos:` (or the change's repos for the final fix). A repo id with no git checkout → `skipped: not_a_git_repo`.

### Planning commit triggers

| Command | Function | Moment |
| --- | --- | --- |
| `weave change progress <lane>` | `progressChange` | `progress` (lane, stale lanes from propagation) |
| `weave change verdict <lane> <v>` | `verdictChange` | `verdict` |
| `weave change clear-stale <lane>` | `clearChangeStaleness` | `clear-stale` |
| `weave change knowledge <status>` | `knowledgeChange` | `knowledge` |
| `weave review record … --finalize / --failed`, and a resolution that sets `waiting_on_person` | `review/record.ts` | `review` |

Decisions accepted after a verdict (`weave adr status`) are not a moment; they fall into the next catch-up through the planning scope.

### Code commit triggers

- **Coverage.** For a slice, coverage = sorted `taskId:status` of its active (non-`invalid`) tasks, hashed to 12 hex characters. Build commits carry `Weave-Slice: <id>` and `Weave-Coverage: <hash>`.
- **Build commit.** `weave slice rollup` (after the lock is released), for each slice with `ready_for_review: true`: find the newest commit on the branch since the diff base with `Weave-Slice: <id>` (first-parent walk, bounded to the change's commits). If none, or its coverage differs from now, call `codeCheckpoint(kind: "build")`. This covers first finishes, slices with `not_tested` tasks, and re-finishes ("additional work"). Nothing staged → no commit. Flat changes never get code checkpoints.
- **Retry window.** A slice with no matching build commit is retried at every rollup **until another slice starts building** (another slice's tasks move past `todo` after this slice became ready). After that it is superseded: rollup stops retrying it and returns `leftovers_from: <slice>` for the slice now building, whose build commit carries the leftovers and says so in its body (FR9/FR10). `weave-execute` runs `weave slice rollup --all --json` before the first task of each slice as well as after the last, so the retry happens whether or not review is active.
- **Fix commits.** At round-end packaging (`rounds.ts`) and the change run's `fix-end`, if the slice's build commit exists for its current coverage, call `codeCheckpoint(kind: "fix")` (or `"final-fix"`) with `Weave-Run`, `Weave-Round`, and the targeted finding ids. If the build commit is missing, skip with `build_not_committed`: the round uses snapshots, and the fixes go into the late build commit, whose body lists the rounds it includes. Re-packaging a round commits only new changes, subject suffixed "(continued)". A failed fix commit is not retried separately; its changes go into the next code commit for that slice or the next slice, whose body notes them.

### Review boundaries (`src/lib/review/commit-boundary.ts`)

- **End boundaries** (`r<N>/end`, `round<n>-end`, `_change/f<N>/end`, `fix-end`): if commits are active and the call's build or fix commit was made, or HEAD is that slice's build commit for current coverage, and the repo's tree outside `wiki/changes/**` is clean → `update-ref <ref> HEAD`; otherwise `SnapshotBoundary.create()`.
- **Start boundaries** (`start`, `round<n>-start`, `fix-start`) stay snapshots; on a clean tree they have HEAD's tree, so diffs equal commit diffs, and they carry the creation-time merge-base.
- `read()` parses the merge-base from a snapshot message or from the commit's `Weave-Merge-Base` trailer, written at commit time from the `mergeBase` the caller passes. It is never recomputed later.
- Packages and `weave review status` report `boundary: commit | snapshot` per repo with the fallback reason, so `261111-kx9x`'s reconsider condition is observable.
- Boundary refs stay machine-local exactly as today; no cross-machine claim is made.
- Callers get the boundary from one factory `reviewBoundaryFor(ctx)`.

### Commit messages

- **Planning:** `<Stage>: <summary or artifact H1>`; body: summary, `Now out of date: <lanes>`; trailers `Weave-Change`, `Weave-Checkpoint: planning`, `Weave-Stage`.
- **Catch-up:** `Planning notes for <change title>`; body lists files; `Weave-Checkpoint: catch-up`.
- **Build:** subject = slice title; body = slice goal, completed task ids and titles, included leftovers or review rounds when relevant; trailers `Weave-Change`, `Weave-Slice`, `Weave-Coverage`, `Weave-Merge-Base`, `Weave-Checkpoint: build`.
- **Fix:** `<slice title>: review fixes, round <n>`; body lists finding ids and titles; trailers add `Weave-Run`, `Weave-Round`, `Weave-Checkpoint: fix`. Final: `Final review fixes`, `Weave-Checkpoint: final-fix`.
- **Project rules:** `commits.subject_template` takes a string or a per-kind map (`planning`, `catch-up`, `build`, `fix`, `final-fix`) with `{subject}`, `{stage}`, `{slice}`, `{change}` placeholders, for formats such as conventional commits enforced by `commit-msg` hooks. Bodies wrap at 72 columns, and trailers are footer-compatible. Content rules ("never name X") are honoured where the text is written: skills follow the project's agent instructions when writing artifacts and `--summary`, which are the only sources of message text. `--commit-message` replaces a planning message entirely.

### Skills

- Progress-calling skills pass `--summary "<one line>"` and surface `checkpoint.status: failed` reasons and the `commits_enabled` notice. The shared silent-output block gains both as surfaced items.
- `weave-execute`: runs rollup before each slice's first task and after its last; reports build-commit files and `leftovers_from`; drops "never commits" claims (still never pushes or opens PRs). `weave-fix`, `weave-slices`, `weave-prepare` get the same wording change.
- `weave-review`: reports fix-commit outcomes and boundary kinds; judgement stays in the skill (decision `261110-dbm2`).
- `weave-next`: shows a failed checkpoint recorded on the latest run.
- Handoff briefs ask the sub-agent to include any `commits_enabled` notice in its summary, so the calling skill relays it.

### Visibility and notices

- Each command's JSON gains `checkpoint` (see `api-contract.md`); text output adds one line.
- **First-commit notice** `commits_enabled` is emitted on every checkpoint until it has been emitted once by a command not running under `WEAVE_UNATTENDED`; then it is recorded in `.git/weave/checkpoints.json`.
- A run whose lane's planning checkpoint failed records `checkpoint: {status, reason}` on the run.

## Facets

- `schema.md`: config keys, personal settings layout, change `status.yml` additions, git trailers, machine-local state, compatibility.
- `api-contract.md`: command flags, new commands, the `checkpoint` outcome object, reasons, and skill obligations.

## Decisions Recorded

- `261111-htho-weave-makes-checkpoint-commits-from-its-recording-commands`: the commit model (triggers, scopes, hooks, coverage trailers, best-effort, switches).
- `261111-kx9x-review-boundaries-are-checkpoint-commits-with-snapshot-fallback`: supersedes `261110-wdfo`.
- `261111-7orw-auto-advance-hands-phases-to-the-calling-agent-and-phases-save-their-stage-through-weave`: supersedes `261108-4z8l`.
- `261108-kl3n` (landed): its "Reconsider When" condition (planning files committed) is now met. No behaviour change is needed here; reading a change's starting branch from the committed `status.yml` is a possible follow-up, not proposed.

## Tradeoffs

- Recording commands gain a git side effect and up to a few hundred milliseconds; build commits add hook time (bounded) to rollup.
- Planning commits disable all hooks; teams whose policy forbids that turn the project switch off.
- The ownership table is a static list; a stale table only moves a file into the catch-up commit.
- Build commits sweep everything in the repo except other changes' folders and coding guidelines (for example, installed agent files after `weave agent update`); the file list in the result is the mitigation.
- Snapshot code stays for start boundaries and fallbacks, so two boundary implementations remain.
- Build state is derived from git history with a bounded walk on each rollup.

## Risks And Open Questions

- **Interactive commit signing** can stall commits; the timeout turns it into `failed: timeout`. Not blocking.
- **Hook cost** on build commits lengthens execute; bounded by `commits.code_timeout_seconds`. Skills should run rollup with a long enough tool timeout; an interrupted rollup is safe to re-run because coverage makes it idempotent. Not blocking.
- **Index contention:** while a code commit's hooks run, `index.lock` is held, and a concurrent planning commit in the same worktree fails with `index_locked`; the catch-up recovers it. Not blocking.
- **Handoff sub-agents** have no environment marker, so a sub-agent that ran rollup or review commands outside its phase could trigger a code commit. Supported phases never do; accepted residual risk. Not blocking.
- **Parallel slices in one folder** mix into each other's build commits (accepted in the PRD). Not blocking.
- **Capture note ownership** uses the lane-name match; misattribution only moves a note into the catch-up commit. Not blocking.
- **Template drift tests** (`tests/agent-skills.test.ts`) and the shared silent-output block need updating with the skill edits. Not blocking.

## Slices Readiness

Ready
