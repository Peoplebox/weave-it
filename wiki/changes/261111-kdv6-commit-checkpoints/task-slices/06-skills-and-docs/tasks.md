---
artifact: tasks
slice: 06-skills-and-docs
status: draft
owner: engineering
created_at: 2026-11-11T03:30:00.000Z
updated_at: 2026-11-11T03:30:00.000Z
source: architecture
---

# Tasks: Skills and docs describe and drive checkpoints

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
| T1 | done | afk | root | | Update skill templates | None |
| T2 | done | afk | root | | Document checkpoints in the README | None |
| T3 | done | afk | root | | Verify skill templates and refresh installed copies | T1, T2 |

## root

### T1: Update skill templates

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- templates/skills/weave-execute/SKILL.md (M)
- templates/skills/weave-review/SKILL.md (M)
- templates/skills/weave-next/SKILL.md (M)
- templates/skills/weave-slices/SKILL.md (M)
- templates/skills/weave-fix/SKILL.md (M)
- templates/skills/weave-prepare/SKILL.md (M)
- templates/skills/ (M)
- src/lib/advance.ts (M)

### What to build

Edit the templates as listed in scope.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T1): passed — npx vitest run tests/agent-skills.test.ts (63/63); installed copies refreshed with `weave agent update all` (local build); full suite 773/773; typecheck and build clean (2026-11-11). weave-prepare left unchanged: it still never commits, which stays accurate.

### T2: Document checkpoints in the README

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- README.md (M)

### What to build

Add a section on automatic commits, switches, and change-list effects.

### Acceptance Criteria

- [x] Implemented as described and typechecks

### Verification

- Automated tests: covered by the slice's verification task
- Typecheck: `npm run typecheck`
- Result (T2): passed — npx vitest run tests/agent-skills.test.ts (63/63); installed copies refreshed with `weave agent update all` (local build); full suite 773/773; typecheck and build clean (2026-11-11). weave-prepare left unchanged: it still never commits, which stays accurate.

### T3: Verify skill templates and refresh installed copies

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- tests/agent-skills.test.ts (M)
- .claude/skills/ (M)
- .agents/skills/ (M)
- .opencode/commands/ (M)

### What to build

Extend template tests; refresh repo-local installed skill copies.

### Acceptance Criteria

- [x] Every progress-calling skill passes `--summary`.
- [x] Execute runs rollup before a slice's first task and reports build commit outcomes and `leftovers_from`.
- [x] The shared silent-output block surfaces checkpoint failures and the `commits_enabled` notice.
- [x] No skill claims it never commits; they still never push or open PRs.
- [x] README documents commit moments, switches, and change-list effects.
- [x] `tests/agent-skills.test.ts` covers the new obligations.

### Verification

- `npx vitest run tests/agent-skills.test.ts tests/bump-skill-versions.test.ts` pass
- full suite and `npm run typecheck` pass
- Result (T3): passed — npx vitest run tests/agent-skills.test.ts (63/63); installed copies refreshed with `weave agent update all` (local build); full suite 773/773; typecheck and build clean (2026-11-11). weave-prepare left unchanged: it still never commits, which stays accurate.


## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

Not run yet.
