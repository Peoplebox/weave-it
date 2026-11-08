---
artifact: tasks
slice: 02-list-change-states
status: draft
owner: engineering
created_at: 2026-11-08T14:27:28.000Z
updated_at: 2026-11-08T14:27:28.000Z
source: architecture
---

# Tasks: Change states in weave change list

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
| T1 | done | afk | root | | Derive change states as a pure function | None |
| T2 | done | afk | root | | Gather live local facts for every change | T1 |
| T3 | done | afk | root | | Render states in change list text and JSON | T2 |
| T4 | done | afk | root | | Verify change list states end to end in worktree and in-place mode | T3 |

## root

### T1: Derive change states as a pure function

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/change-states.ts` (C)
- `tests/change-states.test.ts` (C)

### What to build

Define `ChangeFacts` and `ChangeView` types. Implement `deriveStates`:
- per-repo status, then multi-repo combination
- precedence and notes ("work already landed in <t>", "nothing was committed…")
- every state id and label id from api-contract.md, with the `contained` wording
- `next.commands` and `next.text`, with the `switch` condition (committed status.yml) for folder missing and closed states, and the `git worktree add` recovery hint
- `needs_attention` and `attentionCounts`

Write table-driven unit tests covering every state, precedence, multi-repo combination, each label, and `next` adaptation.

### Acceptance Criteria

- [x] No I/O in `change-states.ts`
- [x] Every row of the api-contract state table has a test

### Verification

- Automated tests: `npx vitest run tests/change-states.test.ts`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/change-states.test.ts (28 tests); npm run typecheck

### T2: Gather live local facts for every change

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/change-facts.ts` (C)
- `src/lib/git.ts` (M)
- `src/lib/worktrees.ts` (M)

### What to build

Implement `gatherFacts`:
- root resolution (`findWorkspaceMode` → `mainWorktreePath` → repos)
- discovery: main `wiki/changes/*` ∪ worktree entries ∪ `changes/` ∪ `bases/` ∪ local `change/<id-pattern>` branches with a record or a committed `status.yml`
- the repo set, from entries ∪ `changes/<id>.yml` `repos`, with `repos` written at create
- `listGitWorktrees` parsing `prunable` and `locked` (and reading `.git/worktrees/<name>/locked` below 2.31)
- `pathExists` and uncommitted counts
- changes-root unavailable (parent missing or dangling symlink) versus deleted
- titles, types, and stages read from a committed `status.yml` with `git show`
- `switch` eligibility through `git cat-file -e`
- `checkLanded` calls with a 2 s total inline budget; the remaining changes get `unchecked` with "still checking"

### Acceptance Criteria

- [x] The same facts from the main checkout, a change folder, and a subfolder
- [x] A hand-made `change/experiment` branch is ignored

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4

### T3: Render states in change list text and JSON

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/changes.ts` (M)
- `src/commands/change.ts` (M)

### What to build

Wire `listChanges` to `gatherFacts` and `deriveStates` in worktree mode only; in-place mode keeps today's path.
- **Text.** Extend `formatListMessage` with the indented state, `next:`, and folder or `folder not found` lines; the top unavailable line; and the git < 2.38 line.
- **JSON.** Add `planning`, `missing_folder`, `state`, `labels`, `landed_check`, `repos[]`, `freshness`, and `unavailable`, keeping every `ChangeSummary` field.
  - `active` and `targets[].path` keep their cwd meaning.
  - `id`, `slug`, `branch`, and `path` are never blanked.
  - `folder` appears only for existing folders.
- **Other.** Add `--all`. Write `attention.json` with `facts_at` under `withStateLock`.

### Acceptance Criteria

- [x] Past changes hidden without `--all`
- [x] Existing `--json` field names and types unchanged

### Verification

- Typecheck: `npm run typecheck`
- Covered by T4
- Result (2026-11-08): passed via T4; warm list on this repo ~390 ms with ~40 candidates

### T4: Verify change list states end to end in worktree and in-place mode

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `tests/cli-change-list.test.ts` (C)
- `tests/worktrees.test.ts` (M)

### What to build

With `WEAVE_NO_BACKGROUND_REFRESH=1` set, cover:
- text snapshots for every state and label
- JSON field presence and types against today's `ChangeSummary` keys
- the same list from the main checkout, a change folder, and a subfolder
- `active` from a change folder
- `rm -rf` of a folder, then list (`folder_missing`)
- a locked entry (`folder_missing_kept`)
- an unavailable root (parent missing) versus a deleted root (parent present)
- a `--repo` subset
- a hand-made `change/experiment` ignored
- closed with and without a committed status.yml
- `--all` showing `done`
- the 2 s budget leaving "still checking"
- in-place mode byte-identical to today

### Acceptance Criteria

- [x] Every case above has a named test

### Verification

- Automated tests: `npx vitest run tests/cli-change-list.test.ts tests/worktrees.test.ts`
- Full suite: `npm test`
- Typecheck: `npm run typecheck`
- Result (2026-11-08): passed: npx vitest run tests/cli-change-list.test.ts (14 tests); npm test (377 tests); npm run typecheck

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
