---
artifact: tasks
slice: 07-unsent-drafts-and-herdr
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: Unsent drafts where supported, and herdr bring-forward

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
| T1 | done | hitl | root | | Manual check: which tools hold an unsent first message | None |
| T2 | done | afk | root | | Mark verified tools as unsent and pass the draft safely | T1 |
| T3 | done | afk | root | | Spike herdr tab listing and add bring-forward if supported | None |
| T4 | done | afk | root | | Verify draft reporting and fallback when injection fails | T2, T3 |

## root

### T1: Manual check: which tools hold an unsent first message

Status: done
Owner:
Repos: root
Execution: hitl
Blocked by: None
Files:
- `wiki/changes/261109-479a-open-worktree-when-created/task-slices/07-unsent-drafts-and-herdr/contracts.md` (M: record results)

### What to build

On a real machine, for each candidate:
- herdr `tab.new` with `task` (with and without `argv`)
- `claude`, `codex [PROMPT]`, `opencode --prompt`, `agent <prompt>`
- Claude desktop (slice 04 T2's mechanism)

1. Start it with the message `echo draft-test`.
2. Observe whether the message is sent automatically, or sits typed and unsent in the input.
3. Record the result per tool with the version and date.

### Acceptance Criteria

- [x] Each candidate is marked `unsent` or `none`, with evidence.

### Verification

- Manual: the steps above. Record the results with the date.
- Result (2026-11-09): herdr tab.new task: SENT (herdr appends it to the agent's argv as 'claude "echo draft-test"'; verified with hc read, Claude 2.1.319, herdr 0.1.14), so it stays 'none'. Claude desktop claude://code/new?q=: UNSENT, sitting in the input (confirmed by the user), so it becomes 'unsent'. Codex, opencode --prompt, and Cursor's agent were not checked by hand, so they stay 'none' under the rule.

### T2: Mark verified tools as unsent and pass the draft safely

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/open-places.ts` (M)
- `tests/open-places.test.ts` (M)

### What to build

- **Mark verified entries:** set `draft: "unsent"` only for the entries T1 verified.
- **Pass the draft safely:** pass the draft as one argv element or JSON field (herdr `task`).
- **Compute the effective capability:** for a terminal, the place mechanism first, then the agent. Own agents never receive a draft.

### Acceptance Criteria

- [x] Only T1-verified entries are `unsent`.
- [x] A hostile draft (quotes, `$(…)`, newlines) stays one literal element.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts`
- Result (2026-11-09): claude-desktop is draft: unsent; the step travels as the q= URL parameter (one argv element to open, never a shell line). Every other entry stays none. Tests: hostile context stays literal in q; herdr gets no task.

### T3: Spike herdr tab listing and add bring-forward if supported

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/open-places.ts` (M)
- `src/lib/open-change.ts` (M)
- `tests/open-change.test.ts` (M)
- `wiki/changes/261109-479a-open-worktree-when-created/architecture/index.md` (M: Risks)

### What to build

1. Run `herdr-app commands` and read herdr-core's docs. Find out whether tabs or terminals can be listed with their folders, and focused.
2. **If they can:** implement `findTabInFolder` and focus, wired into resolution step 4 under the same rules as tmux.
3. **If they can't:** record the limitation in the architecture's Risks section and leave herdr opening a new tab.

### Acceptance Criteria

- [x] Either herdr bring-forward is implemented and tested with a recording exec, or the limitation is recorded.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): Supported: hc ls --json gives the cwd of each live terminal, and herdr-app do pane.focus {terminal} brings it forward (checked on this machine against this session's own pane). Implemented in herdrPlace.bringForward, skipping the caller's own terminal. 2 tests pass. Recorded in the architecture's Risks section.

### T4: Verify draft reporting and fallback when injection fails

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2, T3
Files:
- `tests/open-change.test.ts` (M)
- `tests/cli-change-open-on-create.test.ts` (M)

### What to build

Write regression tests:
- `open.draft` is `unsent` only for verified entries, and the text says "(filled in, not sent)".
- A draft-injection error opens without the draft and reports `shown`, and the open does not fail.
- The draft never appears in a shell line.

Run the full suite.

### Acceptance Criteria

- [x] All regressions pass. `npm test` and `npm run typecheck` are green.

### Verification

- Automated tests: `npm test` and `npm run typecheck`
- Result (2026-11-09): open.draft is unsent only for Claude desktop, and the text says '(filled in, not sent)'. If opening with the draft fails, Weave retries without it and reports shown. npm test (506 passed), typecheck, and build green.

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
