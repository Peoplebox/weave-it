---
artifact: tasks
slice: 05-settings-command
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: weave settings open

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
| T1 | done | afk | root | | Add weave settings open with non-interactive save and clear | None |
| T2 | done | afk | root | | Show the menu and list current settings | T1 |
| T3 | done | afk | root | | Verify settings open never opens anything and only touches the named scope | T2 |

## root

### T1: Add weave settings open with non-interactive save and clear

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/commands/settings.ts` (C)
- `src/cli.ts` (M)
- `tests/cli-settings.test.ts` (C)

### What to build

- **The command:** a `settings` command with an `open` subcommand, registered in `createProgram`.
- **Saving:** `--in`/`--agent` validate and save to the default, or with `--project` to the project override (key from the main checkout). `--in none` saves `ask: false`.
- **Clearing:** `--clear` removes the scoped entry.
- **Output:** the JSON shape from `contracts.md`, and a one-line text confirmation.

### Acceptance Criteria

- [x] Saving and clearing work without a TTY.
- [x] `--project` resolves the same key from the main checkout and from a change folder.

### Verification

- Automated tests: `npx vitest run tests/cli-settings.test.ts`
- Result (2026-11-09): src/commands/settings.ts registered in src/cli.ts. --in, --agent, --clear, and --project work without a TTY (tests/cli-settings.test.ts).

### T2: Show the menu and list current settings

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/commands/settings.ts` (M)
- `tests/cli-settings.test.ts` (M)

### What to build

- **With no `--in`/`--clear`:**
  - when `canPrompt`: show the slice 01 menu, with the current choice preselected, and save the answer to the scope
  - otherwise: print the current settings and `choices` (text or JSON)
- **The prompt** is injected for tests.

### Acceptance Criteria

- [x] A driven menu answer is saved.
- [x] `--json` lists without prompting.

### Verification

- Automated tests: `npx vitest run tests/cli-settings.test.ts`
- Result (2026-11-09): The menu shows when canPrompt, with the current choice passed in; otherwise it lists current settings and choices. Tested through settingsOpen with an injected prompt.

### T3: Verify settings open never opens anything and only touches the named scope

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `tests/cli-settings.test.ts` (M)

### What to build

Write regression tests with a recording registry and `WEAVE_NO_OPEN` cleared:
- No `open()` or `check()` exec happens for any `settings open` form.
- `--clear --project` leaves the default intact, and `--clear` leaves project overrides intact.
- Unknown keys in `settings.yml` survive every write.

### Acceptance Criteria

- [x] All regressions pass. `npm test` and `npm run typecheck` are green.

### Verification

- Automated tests: `npm test` and `npm run typecheck`
- Result (2026-11-09): No tmux calls for any settings open form; --clear --project keeps the default; unknown keys survive. 5 tests pass.

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
