---
artifact: tasks
slice: 02-open-on-create-and-switch
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: Open on change new and change switch

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
| T1 | done | afk | root | | Store and compose the change's next step | None |
| T2 | done | afk | root | | Wire openChange into change new and change switch, with flags validated first | T1 |
| T3 | done | afk | root | | Replace the Open line in place and print the summary before the menu | T2 |
| T4 | done | afk | root | | Add the inside-folder check and tmux bring-forward | T2 |
| T5 | done | afk | root | | Regression: no-default output is byte-for-byte today's for new and switch | T3, T4 |

## root

### T1: Store and compose the change's next step

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/open-change.ts` (M)
- `src/lib/changes.ts` (M)
- `tests/open-change.test.ts` (M)

### What to build

- **`composeNextStep`:** sanitises `--context` (control characters stripped, 500-character cap).
- **Storing the step:** `writeChangeFiles` writes `next_step: { text, stage }` when given a skill. `open`/`switch` with `--skill`/`--context` replace it, using the existing status read/write helpers.
- **Choosing the step:** a step from the current call, then the stored step while the stage matches, then the `weave-next` fallback.
- **`change open`:** gains `--skill` and `--context`.

### Acceptance Criteria

- [x] Stored-step selection follows the three-way order, and a stale stored step is ignored, not deleted.
- [x] Hostile `--context` (newlines, escape codes, 2 KB) is sanitised.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): resolveNextStep, storeNextStep, and readStoredNextStep in open-change.ts. Tests in tests/open-change.test.ts › next step cover the three-way order, ignoring stale steps, and sanitising.

### T2: Wire openChange into change new and change switch, with flags validated first

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/commands/change.ts` (M)
- `src/lib/changes.ts` (M: `next_step`, `open` on the result types)
- `tests/cli-change-open-on-create.test.ts` (C)

### What to build

- **Flags:** add `--skill`, `--context`, `--open`, and `--no-open` to `new` and `switch`. Parse `--open place[:agent]` and validate everything before `createChange`/`switchChange`.
- **Opening:** after success in worktree mode, call `openChange` with the folder, the change id, and `isNew`. In-place mode sets `open: not_attempted/in_place`.
- **JSON:** include `next_step` and `open`.

### Acceptance Criteria

- [x] Invalid open flags exit 1 and no change folder or branch is created.
- [x] A saved default opens through the injected recording registry. `--no-open` and `--open` work as one-offs and never write settings.

### Verification

- Automated tests: `npx vitest run tests/cli-change-open-on-create.test.ts`
- Result (2026-11-09): new and switch gain --skill, --context, --open, and --no-open, validated before createChange/switchChange (no branch is created on bad flags). JSON gains next_step and open. tests/cli-change-open-on-create.test.ts: 7 pass.

### T3: Replace the Open line in place and print the summary before the menu

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/commands/change.ts` (M)
- `tests/cli-change-open-on-create.test.ts` (M)

### What to build

**Line replacement:**
- In the command layer, find the exact `Open <folder> in a new session to work on this change.` line in `result.message`.
- Replace it in place with the outcome lines from `api-contract.md` § Text output, and set the JSON `message` to the same text.
- Leave it untouched for `not_attempted`/`needs_choice`, except `already_inside` and a step given with `--skill`.
- `formatWorktreeLines` stays unchanged.

**Menu order:** when the menu is needed, print the summary through the existing output path first, then prompt, then print the outcome lines. Make sure `withNotices` doesn't print the summary twice.

### Acceptance Criteria

- [x] For a recreated folder with `Slot changed`, the outcome lines sit where the Open line was, before the `Slot changed` line.
- [x] With a driven menu, the output order is summary, then menu, then outcome.

### Verification

- Automated tests: `npx vitest run tests/cli-change-open-on-create.test.ts`
- Result (2026-11-09): placeOpenLines (lib) replaces the line in place; unit test with a Slot changed line. The summary prints (without the Open line) before the menu through beforePrompt; ordering is unit tested.

### T4: Add the inside-folder check and tmux bring-forward

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/open-change.ts` (M)
- `src/lib/open-places.ts` (M: tmux `findPaneInFolder`, `bringForward`)
- `tests/open-change.test.ts` (M)

### What to build

- **Step 2, inside the folder:** realpath containment; skipped by an explicit `--in`/`--open`.
- **Step 4, bring-forward:**
  - runs only after a non-`none` choice resolves, and never with an explicit `--in`
  - looks up panes with `tmux list-panes -a -F`
  - uses `select-window`, plus `switch-client` when the pane is in another session
  - has a 2 s timeout, with any error falling through to open

### Acceptance Criteria

- [x] Bring-forward never runs for `needs_choice`, `dont_ask`, `--no-open`, or an explicit `--in`.
- [x] A pane in another session triggers `switch-client`.
- [x] Running from inside the folder gives `already_inside`, while `--open X` from inside opens.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): tmux bringForward via list-panes, select-window, and switch-client across sessions (2 s timeout). Runs only after a non-none choice. Unit and CLI tests pass.

### T5: Regression: no-default output is byte-for-byte today's for new and switch

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3, T4
Files:
- `tests/cli-change-open-on-create.test.ts` (M)

### What to build

- **Golden comparisons:** compare the text output of `change new` and `change switch` (including a recreated folder with `Slot changed`) with no settings file and no TTY against the output with `WEAVE_NO_OPEN=1` and against a golden string of today's format.
- **Script inside tmux:** with a fake `TMUX` env and no default, no tmux command is executed.
- **Full checks:** run the full suite and the typecheck.

### Acceptance Criteria

- [x] Golden outputs match exactly.
- [x] No exec calls are made in the script-inside-tmux case.
- [x] `npm test` and `npm run typecheck` are green, and `tests/worktrees.test.ts` is untouched.

### Verification

- Automated tests: `npm test` and `npm run typecheck`
- Result (2026-11-09): No-default text output for new and switch ends with today's Open line, and no tmux calls happen inside tmux. npm test (484 passed) and typecheck green. tests/worktrees.test.ts untouched.

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
