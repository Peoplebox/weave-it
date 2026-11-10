---
facet: index
description: Canonical entry point for the code reviewers technical shape.
---

# Code Reviewers Architecture

## Decision Summary

- A new `weave-review` skill holds every judgement: when to review, the three reviewer briefs, how findings are received, fix-round limits, plan-problem stops, rulings, and model levels. The skill folder holds only markdown.
- A new `weave review` command group holds every mechanical step: snapshots, review packages, recording, gating, switches, and guideline seeding. Skills call it the way they already call `weave change verdict` and `weave slice rollup`.
- Review boundaries are working-tree **snapshots** stored as commit objects under Weave-only refs `refs/weave/reviews/<change>/<slice>/…`. They never touch the branch, index, or HEAD. They sit behind a "review boundary" interface so a later checkpoint-commits change can replace them with real commits.
- Boundaries are per slice only: a start snapshot when the slice's first task begins, an end snapshot when its review runs, and a pair around each fix round. There are no per-task boundaries.
- A slice package is the **whole-tree diff** between its snapshots. Files outside the slice's repos and task `Files:` anchors are labelled "possibly another slice's work".
- Reviewers return a **fixed JSON block**. The CLI validates it, stores finding `kind` and `severity` immutably, and refuses agent resolutions of plan findings.
- **Out of date** is detected by blob-hash fingerprints of the reviewed files, recomputed wherever status is shown. Rulings store hashes of their basis and reopen when any hash changes. Out-of-date is **derived at read time and never stored**.
- **State** lives in a `review:` block in the slice and change `status.yml`. Only `weave review` subcommands write it, under a per-change lock. Rollup preserves it and never writes it. The readable record is `review.md`, with fix patches beside it.
- **Review readiness is one shared rule**, defined in `src/lib/review/rules.ts`: a slice is ready for review when every active task is `done` or `not_tested`. Its review state decides whether dependent slices may start. Rollup, the gate, `weave-next`, and `weave-execute` all use this rule.
- **Weave's own files are never "code".** `wiki/changes/**` is excluded from every diff, patch, and fingerprint. Other documentation edits (`wiki/knowledge/**`, `wiki/decisions/**`, `.weave/coding-guidelines.md`) appear in change packages as a separate "plan and docs edits" section.
- **The diff base** is the merge-base with the change's target branch, resolved as `landed.ts` does, falling back to `base_commit`. Boundaries are machine-local, and packages say so when a start snapshot is missing.
- **Coding guidelines** live in `.weave/coding-guidelines.md` at the workspace root (shared) and at each registered repo's root (repo-specific). A single-repo project naturally has one file.
- Review is **not a lifecycle lane**. It never enters `changeStages` and never propagates staleness.

## System Context

No `research.md` exists for this change. The facts below were verified directly in code.

- **Execution never commits.** The `weave-execute` contract (`templates/skills/weave-execute/SKILL.md`; knowledge `features/weave-execute/behavior.md`, Non-Goals) means a slice's code exists only as uncommitted edits over the change base. The per-repo base is recorded at `status.yml.checkout.repos.<repo>.base_commit`, with recovery in `src/lib/change-bases.ts`. A separate future change will introduce checkpoint commits.
- **Slice state is rollup-owned.** `weave slice rollup` (`src/lib/sliceRollup.ts`) derives `status: pending | in_progress | done` from `tasks.md`. `readSliceStatus` (`sliceRollup.ts:363`) rebuilds metadata from a fixed field list, so any extra block in a slice `status.yml` is **dropped** on the next rollup.
- **Weave-only refs exist.** `refs/weave/remotes/origin/*` (`src/lib/git.ts:490`, `src/lib/change-refresh.ts`; decision `261108-4ko1`) establish `refs/weave/` as Weave's namespace.
- **Machine-local state lives in `<git-common-dir>/weave/`** (`src/lib/local-state.ts:6-10`). Claude Code blocks agent writes under `.git/`, so agents must not be asked to write there.
- **Skills ship from `templates/skills/<name>/`.** `SKILL.md` plus flat text resources are copied on install (`src/lib/agent-skills.ts:368`). Executable bits are not preserved.
- **`weave status` only reports installed skills** (`src/lib/status.ts:117`). Notices are `package_outdated | skills_outdated | skills_modified` (`src/lib/notices.ts:12`), so nothing announces a newly bundled skill.
- **Document hashing exists**: `hashDocument` in `src/lib/sync.ts:3`.
- **Lifecycle lanes** are `changeStages` in `src/lib/changes.ts:68`. Staleness propagates only between lanes.
- **Workspace config** is `.weave/workspace.yml`. `.weave/architecture-considerations.md` sets the precedent for team-owned advisory files under `.weave/`.
- **Change lifecycle commands** live in `src/commands/change.ts`, including `close` at line 567.
- **Applicable accepted decisions**:
  - `261101-qcgh`: independent critics see only what is written. The reviewers follow the same rule.
  - `261108-4z8l`: phases are handed to fresh foreground sub-agents. Reviews use the same pattern from inside the skill, not via `weave advance`.
  - `261108-4ko1`: Weave-only refs.
  - `261108-adko`: person-decision steps never auto-advance. Review is not a lane transition, so this is unaffected.
  - `261109-a8k5`: personal settings stay out of the project. The review switches are team settings, so `.weave/workspace.yml` is correct.

## Options Considered

### B. Skill for judgement, `weave review` CLI for mechanics, snapshot refs — Chosen

- **How it works:** the skill drives the flow and fills the briefs. The CLI snapshots, packages, records, gates, and detects out-of-date state.
- **What changes:** new `src/commands/review.ts` and `src/lib/review/*`, slice and change `status.yml` schema, rollup and status integration, a new skill, an execute hook, `weave init` seeding, and a new notice.
- **Trade-offs:** more CLI surface, and snapshot refs need cleanup. Slices started before this ships fall back to the change base.
- **Why chosen:**
  - The CLI needs the snapshot and diff logic anyway for out-of-date checks in `weave change status`, so there is one implementation, not bash plus TypeScript.
  - Each command has a typed contract with `--json` output, exit codes, and tests. The agent only names the slice, so it cannot pick a wrong range.
  - State stays CLI-owned, as everywhere else in Weave.
  - There is no bash dependency, and installs that drop exec bits do not matter. Weave does not handle Windows today (`261109-mn61`), so Windows support is not claimed as a benefit.

### A. Skill only — Rejected

- **How it works:** the skill plus briefs. The agent diffs against `base_commit` filtered by task `Files:` anchors and hand-writes review fields.
- **Trade-offs:** there is no reliable per-fix diff (FR23) and no out-of-date detection (FR33). Rollup would erase hand-written fields. The CLI could not show review state without trusting agent edits.
- **Why rejected:** it cannot meet the visibility and staleness requirements, and it breaks Weave's rule that state is written through the CLI.

### C. Commits as boundaries — Rejected (deferred to a separate change)

- **How it works:** execute commits per task or slice, reviews use commit ranges, and fixes are revertible commits.
- **Trade-offs:** diffs, staleness, and undo would be simplest. But it breaks execute's "never commits" contract and imposes a commit policy.
- **Why rejected:** the user will introduce checkpoint commits as a separate change. The boundary interface lets that change replace snapshots later.

### D. CLI-issued handoff briefs, like auto-advance — Rejected

- **How it works:** `weave review` owns and fills the brief templates and returns a handoff recorded in `runs[]`.
- **Trade-offs:** most deterministic, but it contradicts PRD FR45 (briefs live in the skill), and `runs[]` is lane-oriented.
- **Why rejected:** it would need a PRD revision for little gain over B.

### Bundled scripts for the mechanics (variant of B) — Rejected

- **How it works:** bash scripts inside the skill folder for snapshot and package, called with `bash <path>`.
- **Trade-offs:** bash would be required, so no plain Windows. Installs drop exec bits. The logic would be duplicated with the CLI's out-of-date check.
- **Why rejected:** every Weave skill already requires the `weave` CLI, so scripts add no portability.

### Package scope: declared files only, or per-task file tracking — Rejected

- **Declared files only:** misses edits beyond the `Files:` anchors.
- **Per-task file tracking in execute:** new bookkeeping in execute, and it misses hand edits.
- **Chosen instead:** the whole-tree diff with "possibly another slice's work" labels, so nothing the slice touched is silently excluded.

## Architecture Overview

### Components

```text
templates/skills/weave-review/
  SKILL.md                     flow, receiving rules, rounds, rulings, model levels, client mapping
  slice-reviewer-brief.md      fill-in brief; ends with required JSON block
  fix-check-brief.md           scoped re-check of one fix round
  final-reviewer-brief.md      whole-change brief (plan fit, decisions, correctness, knowledge)
  review-record-template.md    layout of review.md

src/commands/review.ts         weave review snapshot|package|record|gate|skip|status|guidelines
src/lib/review/
  boundary.ts                  ReviewBoundary interface; SnapshotBoundary impl (refs/weave/reviews)
  package.ts                   diff assembly, foreign-file labelling, context manifest, guideline resolution
  record.ts                    report parsing + schema validation, resolutions, state machine, review.md writer
  fingerprint.ts               blob-hash fingerprints, ruling basis hashes, out-of-date evaluation
  gate.ts                      final-review gate (FR6)
  guidelines.ts                path resolution + starter template
  state.ts                     review state types; locked read-merge-write of review: blocks
  rules.ts                     isReadyForReview, satisfiesDependents, effectiveState, verdict, exclusions
  base.ts                      merge-base resolution (target branch -> base_commit -> base_unknown)
  prune.ts                     ref + package cleanup for landed / missing changes
```

`src/lib/sliceRollup.ts` changes:

- carry `review` through `readSliceStatus`
- take the per-change lock around read-modify-write
- use `satisfiesDependents` in `renderSliceDisplayStatus`
- expose `ready_for_review` and `ready_slices` in `--json`

`templates/skills/weave-slices/tasks-template.md` gains an optional `Human check:` line under `### Verification`. That line is the only marker the CLI reads for "needs your check" (FR19).

### Shared rules (`src/lib/review/rules.ts`, pure functions)

These rules were settled in the architecture stress test. Every consumer imports them, so the rules cannot drift between consumers.

- **`isReadyForReview(slice)`:** every non-`invalid` task is `done` or `not_tested`. This is independent of rollup's `done`, which still requires every task to be `done` (`sliceRollup.ts:91-103`). It drives:
  - the execute hook
  - the derivation of `not_reviewed`
  - `package`'s `slice_not_ready` error
  - the gate (FR4)
- **`satisfiesDependents(slice, reviewActive)`:** with review active, true only when the slice is ready for review and its review state is one of `reviewed`, `reviewed_with_rulings`, `skipped`, or `predates_review`. With review inactive, it is rollup's `done`, as today.
  - `renderSliceDisplayStatus` (`sliceRollup.ts:440-450`) and `dependency-graph.md` use it.
  - `weave slice rollup --json` exposes `ready_slices`.
  - The `weave-next` and `weave-execute` skills read `ready_slices` instead of computing readiness from `depends_on` themselves (FR7, FR26).
- **`predates_review`:** the first time the new CLI touches a change (any `weave review` command, or rollup), it records `review.adopted_at` on the change. Every slice that is already ready for review and has no `review` block and no `start_ref` gets `state: predates_review`, once. It passes the gate without being reviewed, so there is no retroactive review. After adoption, a newly finished slice without a review is `not_reviewed`.
- **`effectiveState(slice)`:** the stored state, overlaid with out-of-date at read time. A slice is out of date when any of these holds:
  - a fingerprinted file it still owns has changed
  - the task count has risen
  - its `plan_basis` changed (FR27)

  The stored `reviewed` or `reviewed_with_rulings` value is kept. Status shows `reviewed, out of date (code changed | plan changed | tasks added)`. Reverting the code returns the slice to current. Rollup never writes this, so `weave slice rollup --check` is unaffected.
- **File ownership for fingerprints:** a file belongs to the **latest review that covered it**. When a later slice's review or the final review covers a file, earlier reviews stop fingerprinting it. This prevents cascades when slices share files. After the final review, the change fingerprint owns everything it covered, and its own fix batch re-baselines it. Files labelled foreign are never fingerprinted.
- **Excluded paths:** `wiki/changes/**`, relative to the Weave root, is excluded through a pathspec from diffs, patches, and fingerprints. Change packages list `wiki/knowledge/**`, `wiki/decisions/**`, and `.weave/coding-guidelines.md` edits under "plan and docs edits". They are not fingerprinted for slices.
- **Body-only hashing:** document hashes for `plan_basis` and ruling basis strip YAML frontmatter before `hashDocument`, so lifecycle edits such as a decision's `status` reopen nothing. **Exception, decided during execution:** a decision's hash also covers its `superseded_by` value. Superseding a decision is a plan change: the old decision's `superseded_by` is set when the new decision is accepted, and from then on it reopens rulings and marks reviews that cite it as `plan_changed`.
- **Verdict:**
  - `not_ready` when a plan finding is open, the review is partial, or a Critical ruling has `agreed: true` (the agent agreed the finding was real but could not fix it).
  - `ready_with_parked_items` when only can-wait Minors, rulings with `agreed: false`, or human checks remain.
  - Otherwise `ready_to_merge`.

### Diff base

- **Change packages and fallbacks** use `git merge-base HEAD <target>`, where `<target>` is resolved as in `landed.ts:205-215`. If that fails, they use `checkout.repos.<repo>.base_commit`. If both are unknown, they fail with `base_unknown` and the package is partial. This also covers in-place changes, which have no `base_commit` (`worktrees.ts:333-350` writes it only in worktree mode).
- **Merging main into the change** moves the merge-base forward, so main's changes are excluded automatically.
- **Rebases:** every snapshot records the merge-base it was taken against. If the merge-base moved between start and end, files changed between the old and new merge-base are labelled "from main". They are excluded from the fingerprint and the reviewer is told to ignore them.

### Activation and locating the skill

- `weave review status --slice <id> --json` returns `active`. It is true when all of these hold:
  - `review.enabled` is not false (absent means true)
  - the change is not skipped
  - `weave-review` is in `.weave/agents.yml` for at least one agent
- The response also returns `skill_paths`, the installed copies of the skill.
- The execute hook calls this command first and does nothing when the result is inactive. This covers projects that updated `weave-execute` but never installed `weave-review` (FR50).
- `weave-execute` hands over using the same wording as the auto-advance briefs: "load the `weave-review` skill and run its slice review for `<id>`; if you cannot load it by name, read it from one of `skill_paths`".

### Locking

- Every `weave review` write, and rollup's write of slice `status.yml`, runs under a per-change lock: a lock directory named after the change id in the local state folder, reusing the `withStateLock` pattern in `local-state.ts:13-47`.
- Each write re-reads the file before writing and writes atomically (temporary file, then rename).
- Run ids are allocated under the lock.
- Other `changes.ts` writers to the change `status.yml` stay unlocked, as today. Review writes merge only the `review` key, after re-reading. This is stated as a residual risk.

### Slice flow (inside the build session)

```text
weave-execute: first task of slice 02 -> in_progress
  └─ weave review status --slice 02 --json  -> active? if not, skip all review steps
  └─ weave review snapshot --slice 02 --at start
... tasks done or not_tested ...
weave slice rollup --json  -> slice 02 ready_for_review: true
weave-execute loads weave-review, runs "slice review":
  1. weave review package --slice 02 --json        -> {run_id: "02/r1", package_path, model_level}
  2. dispatch fresh reviewer (slice-reviewer-brief, model level stated)
  3. weave review record --run 02/r1 --report -  (stdin) -> findings stored, kind/severity frozen
  4. plan findings?  -> state waiting_on_person, stop
  5. for round in 1..review.slice_rounds (default 2):
       weave review snapshot --run 02/r1 --at round-start --round N
       agent verifies + fixes agreed Critical/Important (inside slice-owned files only)
       re-run slice automatic checks
       weave review package --run 02/r1 --fix-round N  -> fix-round diff + patch saved
       dispatch fix checker (fix-check-brief)
       weave review record --run 02/r1 --report -      -> addressed / not_addressed / new findings
       weave review record --run 02/r1 --resolve 02/r1-F3 --as fixed --round N
  6. remaining open -> weave review record --run 02/r1 --resolve <F> --as ruling
                        --agreed true|false --reason ... --cost ...
  7. weave review record --run 02/r1 --finalize -> reviewed | reviewed_with_rulings; fingerprint + plan_basis stored
  8. weave review gate --change -> pass? start final review (same session)
```

### Resolving a plan problem (FR25-FR27)

- **The person dismisses the finding:** `weave review record --resolve <F> --as dismissed --by <name>` records the person's own ruling. The slice returns to `in_review` with the run's other open code findings intact. The person, or a later session, runs `weave-review slice <id>`, which resumes the same run at its next fix round. It does not start a new review.
- **The person changes the plan:** they edit through existing tools (`weave-clarify`, or `weave adr new --supersedes`). On every read, the waiting run's `plan_basis` (body hashes of the PRD, architecture files, `slice.md`, and the cited decisions) is compared with the current documents. Any difference turns the slice to `not_reviewed (plan changed)`, and the next review is a fresh run. The same comparison marks other reviewed slices `out of date (plan changed)` (FR27). This piggybacks on document hashes, not on lane staleness, so review still never touches `changeStages`.

### Final review

`weave review package --change` diffs the merge-base (see Diff base) against the current tree for every repo in the change. It includes all slices' saved Minors, rulings, untested tasks, and human checks. The skill dispatches `final-reviewer-brief` at the most capable level. Then:

1. Record the report.
2. Plan findings stop the flow, with the change in `not_ready`.
3. Otherwise, one fix batch covers the agreed Critical and Important findings plus the must-fix Minors.
4. One fix check follows.
5. Rulings are recorded.
6. The verdict is derived by the CLI from the open items: `ready_to_merge | ready_with_parked_items | not_ready`.

### On demand

`weave-review slice <id>` or `weave-review change` runs the same flows at any time. A run while the gate fails is recorded as `partial: true`. Changes in flat mode (no `task-slices/`) allow only `--change`.

### Visibility

- `weave slice rollup` preserves `review:` under the lock, never writes it, and exposes `ready_for_review` and `ready_slices`.
- `weave change status` and `weave status` show per-slice review state and the change verdict.
- `weave-next` recommends `weave-review` for `not_reviewed`, `out_of_date`, or a passing gate with no final review.
- A new `skills_available` notice names bundled skills that are not installed.

### Guidelines

`package` resolves, for each repo in scope:

- the shared file: `<workspace root>/.weave/coding-guidelines.md`
- the repo file: `<repo root>/.weave/coding-guidelines.md`

It reads both from the change's own checkout folder (FR43). In repo mode the two paths are the same file, so only one is listed. Missing files are recorded as `absent`. A missing repo checkout makes the package `partial`, and the verdict is capped at `not_ready` (FR44).

### Switches and settings (`.weave/workspace.yml`)

```yaml
review:
  enabled: true          # FR51; false -> automatic reviews off, slices show skipped
  slice_rounds: 2        # FR15 default; teams may raise it
  models:                # optional per-client level mapping; skill's built-in table otherwise
    claude: { cheap: haiku, mid: sonnet, most_capable: opus }
```

Per change: `weave review skip --reason "<why>"` writes `review.skipped` to the change `status.yml` (FR52).

### Seeding guidelines

`weave init` writes the starter `.weave/coding-guidelines.md` when it is absent. Existing projects run `weave review guidelines init`, and nothing is written during `weave agent update` (FR38, C7).

### Packages, snapshots and cleanup

- **Package location:** packages default to `<change folder>/.weave/tmp/reviews/<change>/…`, inside the session's own folder. `weave review` creates `.weave/tmp/.gitignore` containing `*`, so reviewer sub-agents never read outside the folder they run in. The temporary index file stays in the local state folder, because only the CLI writes it.
- **Snapshot speed:** the temporary index is seeded by copying the real index file before `git add -A`. Cached stat data then lets git rehash only the files that changed.
- **Machine-local boundaries:** snapshot refs exist only on the machine that built the slice. When `start_ref` is named in `status.yml` but missing locally, `package` reports `start_ref_missing_on_this_machine`, falls back to the merge-base, and labels the package.
- **Cleanup:** not at `weave change close`, because closed changes can be reopened. `weave review prune` deletes `refs/weave/reviews/<change>/` and packages for changes that are landed (per `landed.ts`) or no longer exist. Weave's background refresh runs it after its landed check, and a future `weave change discard` will call it.
- **Pushing:** snapshot refs are outside `refs/heads` and `refs/tags`, so normal pushes skip them. `git push --mirror` or an explicit `refs/*` refspec would push them. That is documented, not prevented.

### Clients without separate reviewers

The skill runs the brief inline and passes `--independent false` to `record`, and the run shows that.

## Facets

- `schema.md`: review state blocks in slice and change `status.yml`, `review.md` layout, patch files, refs, local package layout, rollup compatibility. Ready.
- `api-contract.md`: the `weave review` subcommands, the reviewer JSON report schema, exit codes, and how status, rollup, next, and notices consume review state. Ready.

## Decisions Recorded

- `261110-wdfo-code-reviews-use-weave-only-snapshot-refs-as-boundaries`: until checkpoint commits exist, slice and fix boundaries are working-tree snapshots under `refs/weave/reviews/`, behind a replaceable boundary interface.
- `261110-dbm2-review-judgement-lives-in-the-skill-review-mechanics-in-the-weave-cli`: briefs and judgement live in `weave-review`. Snapshots, packages, recording, gating, and out-of-date checks live in `weave review`. No bundled scripts.
- `261110-dtld-coding-guidelines-live-in-weave-coding-guidelines-md-at-workspace-and-repo-roots`: layered guideline files, with the repo winning on conflict, read from the change's own folder.

## Tradeoffs

- **Whole-file fingerprints** mark a slice out of date for unrelated edits to a reviewed file. This false positive is accepted because it errs towards re-review.
- **Whole-tree snapshot diffs** include other slices' parallel edits. Labels mitigate this, and the reviewer is told to judge only slice-owned files. Revisit when checkpoint commits land.
- **Reviewer read-only behaviour and report integrity** are requested, not enforced. An agent could edit the report before `record`. Plan-relabel protection covers the normal path only.
- **Snapshot refs accumulate** until the change lands or disappears and `weave review prune` runs.
- **Boundaries are machine-local.** A second person reviewing on another machine gets a labelled fallback diff.
- **Plan edits flag all reviewed slices.** Any body edit to the PRD or architecture marks every reviewed slice "out of date (plan changed)". That is noisy, but it is what FR27 asks for.
- **A rebase onto main** puts reviewed slices out of date if it touches reviewed files. This is intended (FR33).

## Risks And Open Questions

- **Unlocked writers:** other writers to the change `status.yml` in `changes.ts` stay unlocked. A concurrent lifecycle write could still race a review write. Review writes re-read and merge only their own key, which narrows the window. Not blocking.
- **Re-raising settled rulings:** de-duplication is the reviewer's job, from the "settled rulings" list in the package. The CLI does not match new findings to old rulings. Not blocking.
- **Exit codes:** the new exit codes 4 (`report_invalid`) and 5 (`plan_finding_requires_person`) must be checked against existing CLI conventions during implementation. Not blocking.
- **Snapshot cost on very large repos** is unmeasured. The seeded index should keep it close to `git status` cost. Not blocking.
- Slices already in progress when this ships have no start snapshot, so the fallback to `base_commit` over-includes earlier slices' work. Labels cover the files outside the slice. Not blocking.
- The built-in per-client model-level table needs one row per supported client (Claude Code, Codex, opencode, pi). The exact model names are decided at implementation time. Not blocking.
- Choosing which agent reviews (cross-agent review) is deferred. `review.models` leaves room for it later. Not blocking.
- If the checkpoint-commits change lands first, `CommitBoundary` replaces `SnapshotBoundary` with no skill changes. Not blocking.

## Slices Readiness

Ready
