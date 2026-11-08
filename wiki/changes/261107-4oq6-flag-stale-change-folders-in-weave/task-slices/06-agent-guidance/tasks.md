---
artifact: tasks
slice: 06-agent-guidance
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Agent guidance for change cleanup

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
| T1 | done | afk | root | | Point cleanup guidance at list --fetch --json | None |
| T2 | done | afk | root | | Verify bundled skills still pass drift and content checks | T1 |

## root

### T1: Point cleanup guidance at list --fetch --json

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-next/SKILL.md` (M)

### What to build

Update `weave-next` (and any other bundled skill found with `grep -rn "change list\|change close" templates/`) to:
- run `weave change list --fetch --json` before recommending `close` or saying nothing needs cleanup
- match on `state.id`
- treat only `landed` and `folder_missing` as needing attention
- never treat `landed_with_newer_commits` as safe to delete

Keep plain `weave change list` for quick looks. Follow the existing skill-versioning rules.

### Acceptance Criteria

- [x] No skill matches on label text

### Verification

- Covered by T2
- Result (2026-11-09): weave-next template updated; installed copies refreshed with weave agent update all

### T2: Verify bundled skills still pass drift and content checks

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `tests/agent-skills.test.ts` (M)
- `tests/cli-skills.test.ts` (M)

### What to build

Run the skill test suites. Add an assertion that the `weave-next` template contains `weave change list --fetch --json` and references `state.id`.

### Acceptance Criteria

- [x] The assertion is present and passing

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts tests/cli-skills.test.ts`
- Full suite: `npm test`
- Result (2026-11-09): passed: npx vitest run tests/agent-skills.test.ts tests/cli-skills.test.ts (63 tests); npm test (405 tests); npm run typecheck

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
