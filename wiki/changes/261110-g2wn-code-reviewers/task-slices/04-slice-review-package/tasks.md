---
artifact: tasks
slice: 04-slice-review-package
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: Slice review package

## Status Legend

- `todo`: ready when blockers are done
- `in_progress`: currently being implemented
- `blocked`: cannot proceed without listed blocker
- `done`: implemented and verified
- `not_tested`: implementation complete, automated verification incomplete
- `invalid`: no longer applies

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Parse task evidence, untested tasks, and human checks, and add the Human check template line | None |
| T2 | done | afk | root | | Assemble the slice diff with foreign-file labels and fallback bases | None |
| T3 | done | afk | root | | Build the context manifest and write the package file | T1, T2 |
| T4 | done | afk | root | | Add weave review package --slice with run allocation and errors | T3 |
| T5 | done | afk | root | | Verify slice packages for foreign files, fallbacks, missing repos, and guideline layouts | T4 |

## root

### T1: Parse task evidence, untested tasks, and human checks, and add the Human check template line

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/package.ts` (C: `parseTaskEvidence`)
- `templates/skills/weave-slices/tasks-template.md` (M)
- `tests/review-package.test.ts` (C)

### What to build

`parseTaskEvidence(tasksMd)` per `contracts.md`: tasks with `Status: not_tested`, each `Human check:` line under a task's `### Verification`, and the verification lines of each task. Ignore `invalid` tasks. Add the optional `Human check:` line to the tasks template.

### Acceptance Criteria

- [x] A `Human check:` line anywhere except under `### Verification` is not counted.
- [x] `not_tested` and `invalid` tasks are classified correctly in a fixture copied from a real slice.
- [x] `tests/agent-skills.test.ts` still passes with the template change.

### Verification

- Automated tests: `npx vitest run tests/review-package.test.ts tests/agent-skills.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-package.test.ts tests/agent-skills.test.ts` passed (parseTaskEvidence over a fixture adapted from this slice's tasks.md: `not_tested` and `invalid` classified, a `Human check:` line under `### What to build` and under the change-level `## Verification` not counted); `npm run typecheck` passed.

### T2: Assemble the slice diff with foreign-file labels and fallback bases

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/review/package.ts` (M: diff assembly, `labelForeignFiles`)
- `tests/review-package.test.ts` (M)

### What to build

For each slice repo: pick `from` = the slice's `start_ref` if it exists locally, else the diff base from `base.ts` (with `fallback_base` and the warning), else `base_unknown`; `to` = the end snapshot. Use `ReviewBoundary.diff` with `-U10` and the exclusion pathspecs. Split paths into owned (inside the slice's repos and matching a task `Files:` anchor, matched as a path prefix or exact file) and foreign. Compute diff stat, size hint, and model level.

### Acceptance Criteria

- [x] A file under a `Files:` anchor is owned; a file in another directory is foreign.
- [x] A missing start ref uses the diff base; a named but locally missing ref adds the warning.
- [x] `wiki/changes/**` never appears.
- [x] Size above the threshold raises `model_level` to `most_capable`.

### Verification

- Automated tests: `npx vitest run tests/review-package.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-package.test.ts` passed (anchor ownership by exact file and path prefix, repo-relative or Weave-root-relative; size threshold raises `most_capable`; `wiki/changes/**` absent from the diff). Fallback and missing-start-ref cases are covered end to end in `tests/cli-review-package.test.ts`. `npm run typecheck` passed.

### T3: Build the context manifest and write the package file

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- `src/lib/review/package.ts` (M: manifest and rendering)
- `tests/review-package.test.ts` (M)

### What to build

Render the package layout in `contracts.md` § Data. Planning docs by change type. Applicable accepted decisions via `listDecisions` and `matchesAppliesTo` over every diffed path. Guideline files via `resolveGuidelines`; missing repo checkouts make the package partial. Write to the default location (creating `.weave/tmp/.gitignore` with `*`) or `--out`.

### Acceptance Criteria

- [x] A `feat` package lists `prd.md`, `architecture/*.md`, and `slice.md`; a `fix` package lists `findings.md`; a `chore` package lists `exploration.md`.
- [x] Only accepted decisions whose `applies_to` matches a diffed file are listed.
- [x] An absent shared guidelines file shows "no shared guidelines found".
- [x] `.weave/tmp/.gitignore` exists after the first package and `git status` does not show the package.

### Verification

- Automated tests: `npx vitest run tests/review-package.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/review-package.test.ts` passed (feat lists PRD, architecture with index.md first, slice.md; fix lists findings.md; chore lists exploration.md and architecture when present; only accepted decisions matching a diffed file; "no shared guidelines found"; `.weave/tmp/.gitignore` is `*` and `git status --porcelain --untracked-files=all` is unchanged by packaging). `npm run typecheck` passed.

### T4: Add weave review package --slice with run allocation and errors

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/commands/review.ts` (M: add `package --slice`)
- `src/lib/review/package.ts` (M: run allocation)
- `tests/cli-review-package.test.ts` (C)

### What to build

The subcommand per `contracts.md` § Interfaces, § State, and § Validation and errors. Allocate the run id and write `in_review` / `latest_run` through `updateSliceReview` under the change lock.

### Acceptance Criteria

- [x] Returns every contract field for a ready slice and sets `in_review`.
- [x] Each error code in `contracts.md` is produced by its scenario, and `--force` bypasses `review_disabled`.
- [x] Two concurrent calls allocate distinct run ids.

### Verification

- Automated tests: `npx vitest run tests/cli-review-package.test.ts`
- `npm run typecheck`
- Result (2026-11-10): `npx vitest run tests/cli-review-package.test.ts` passed (all contract fields and `in_review`/`latest_run`; `review_disabled` and `--force`, `change_review_skipped`, `no_slices`, `slice_not_found`, `slice_not_ready` and `--partial`, `base_unknown`, `start_ref_missing_on_this_machine`; two concurrent calls get r1 and r2; a later `review/r5.report.md` moves allocation to r6). `npm run typecheck` passed.

### T5: Verify slice packages for foreign files, fallbacks, missing repos, and guideline layouts

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `tests/cli-review-package.test.ts` (M)

### What to build

End-to-end CLI tests in temporary repos: snapshot start, edit owned and foreign files plus a file under `wiki/changes/`, mark tasks done, then package. Cover repo mode versus a two-repo workspace (guideline listing and per-repo diffs), a missing repo checkout, and a slice started before snapshots existed. Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] Each scenario's package text and JSON match `contracts.md`.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/cli-review-package.test.ts`, then `npm test`
- `npm run typecheck && npm run build`
- Result (2026-11-10): `tests/cli-review-package.test.ts` end to end in temporary repos (repo mode with owned, foreign, and `wiki/changes/` edits; two-repo workspace with per-repo diffs, `repo:path` labels, shared and per-repo guidelines; a missing repo checkout; a slice without a start snapshot) passed. `npm test` 42 files / 610 tests passed, `npm run typecheck` and `npm run build` passed. While writing these tests a flaky miss of same-size edits was traced to the snapshot's temporary index getting a fresh mtime (defeating git's racy-entry check); `src/lib/review/boundary.ts` now keeps the real index's timestamps, with a regression test in `tests/review-boundary.test.ts`.

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck`, `npm test` (42 files, 610 tests), and `npm run build` passed after T1-T5.
