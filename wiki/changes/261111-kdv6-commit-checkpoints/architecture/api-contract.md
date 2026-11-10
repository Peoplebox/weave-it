---
facet: api-contract
description: Request, response, event, and integration contract design.
---

# API Contract Design

## Consumers And Producers

- **Producers:**
  - planning commits: `weave change progress | verdict | clear-stale | knowledge`, `weave review record`
  - build commits: `weave slice rollup`
  - fix commits: `weave review package --fix-round`, and the change run's fix packaging
  - switches: `weave change skip-commits | unskip-commits`, `weave settings commits`
- **Consumers:**
  - every skill that calls those commands (questions, research, explore, stress-test, prd, architect, slices, fix, clarify, capture, knowledge, execute, review, next)
  - `weave advance --finish-run`, which records failures on runs
  - people reading text output

## Contract Shape

**New flags** on `weave change progress | verdict | clear-stale | knowledge` and `weave review record`:

- `--summary <text>`: one-line gist for the subject. Optional; falls back to the artifact's H1 or the lane name.
- `--commit-message <file|->`: full message, used verbatim. Weave appends its trailers. Optional.

**New commands:**

- `weave change skip-commits --reason <text> [--json]` and `weave change unskip-commits [--json]`
- `weave settings commits on|off [--project] [--json]`: the personal switch

**Outcome object**, added as `checkpoint` to each producer's JSON result. Code producers return `checkpoints[]`, one entry per repo or slice.

```json
{
  "status": "committed | skipped | failed",
  "kind": "planning | catch-up | build | fix | final-fix",
  "repo": "root",
  "slice": "02-slug",
  "sha": "abc1234",
  "subject": "PRD: commit checkpoints at each pipeline stage",
  "files": ["wiki/changes/<id>/prd.md", "wiki/changes/<id>/status.yml"],
  "reason": "nothing_to_commit",
  "detail": "first line of git/hook output",
  "catch_up": { "...same shape..." },
  "leftovers_from": "04-slug",
  "includes_rounds": [1, 2],
  "notice": "commits_enabled",
  "warnings": ["settings_unreadable"]
}
```

**Reasons:**

- `skipped`:
  - switches: `commits_off_project`, `commits_off_personal`, `change_skipped`
  - not applicable: `flat_change`, `unattended`, `not_a_git_repo`, `build_not_committed`, `nothing_to_commit`
  - repo state: `wrong_branch`, `detached_head`, `operation_in_progress`
- `failed`: `hooks_rejected`, `index_locked`, `identity_missing`, `timeout`, `git_error`

`files` is always present for build commits (FR12). `detail` is truncated to 500 characters.

**Review outputs.** `weave review package` and `weave review status` add `boundary: { <repo>: { kind: "commit" | "snapshot", reason? } }` for each end boundary.

**Exit codes are unchanged.** A failed or skipped checkpoint never makes the command exit non-zero.

**Text output** adds one line: `Committed <sha7> "<subject>" (<n> files)` or `Did not commit: <reason> — <detail>`.

## Versioning And Compatibility

- Additive JSON fields only; existing consumers ignore `checkpoint`.
- Skills update in the same release. Older installed skills keep working: without `--summary`, subjects come from the artifact title.
- `weave agent update` surfaces outdated skills through the existing drift notices.

## Authorization And Validation

- No new agent permission rules: commits happen inside `weave`, which is already allowed (`Bash(weave *)`).
- Code checkpoints refuse under `WEAVE_UNATTENDED=1`, which Weave's own `background`, `terminal` and `here` launches set.
- Planning and catch-up commits run with every hook disabled (`-c core.hooksPath=<empty temp dir>`). Code commits always run hooks.
- Commits use the environment as given, with no identity substitution, plus `GIT_TERMINAL_PROMPT=0`. Timeouts send SIGTERM.
- `--commit-message` content is not executed or templated; Weave only appends trailers.

## Observability And Testing

- **Unit:**
  - ownership table and planning scope (this change's decisions, superseded decisions, knowledge files)
  - catch-up versus moment split under `--only`
  - settings precedence, including main-off-wins
  - message composition (per-kind templates, summary, stale lanes, trailers, 72-column wrap)
  - coverage hashing
  - branch-guard states
- **Integration (temporary git repos, as the existing review tests use):**
  - author equals `git config user.email`; no identity gives `identity_missing`
  - progress commits only owned paths and leaves unstaged code alone
  - a staged code file and a rollup-staged slice `status.yml` land in the moment commit, not the catch-up
  - all hooks (including `prepare-commit-msg` and `post-commit`) are skipped for planning commits and run for build commits
  - a failing `pre-commit` gives `hooks_rejected`, and the status is still written
  - wrong branch, detached HEAD and a rebase in progress are skipped
  - no empty commits
  - rollup: first finish commits; `not_tested` readiness commits; a re-finish with new coverage gives a second commit; a re-run is idempotent
  - retry window: retried at the next rollup, superseded once another slice starts, and the later build carries the leftovers
  - fix round gives a fix commit and an end ref at HEAD; with the build missing it gives `build_not_committed` and a snapshot
  - re-packaged round gives "(continued)"
  - a dirty tree falls back to a snapshot
  - multi-repo partial failure; a repo that isn't a git repo is skipped
  - other changes' folders and coding guidelines are excluded from build commits
  - `WEAVE_UNATTENDED` skips code commits
  - timeout releases `index.lock`
  - the off switches restore snapshot behaviour exactly
- **Regression:** the fingerprint, out-of-date, package and prune suites run against both boundary kinds.
- **Skill templates:** `tests/agent-skills.test.ts` asserts `--summary` usage, the rollup-before-slice step in execute, the surfaced notice and failures in the shared block, and the removed "never commits" claims.
