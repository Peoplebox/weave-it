---
artifact: tasks
slice: 04-app-places
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: Open in VS Code, Cursor, Claude desktop, and T3 Code

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
| T1 | done | afk | root | | Add the VS Code and Cursor places with detached launch | None |
| T2 | done | afk | root | | Work out and record how Claude desktop and T3 Code open a folder | None |
| T3 | done | afk | root | | Add the Claude desktop and T3 Code places with hints | T2 |
| T4 | done | afk | root | | Skip apps over SSH and on Linux with no display | T1, T3 |
| T5 | done | hitl | root | | Manual check: each installed app opens the change folder | T1, T3, T4 |

## root

### T1: Add the VS Code and Cursor places with detached launch

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/open-places.ts` (M)
- `tests/open-places.test.ts` (M)

### What to build

**`vscode`:**
- Use only its own install paths: `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`, `~/Applications/…`, `/usr/share/code/bin/code`, and the snap path.
- Never use a PATH `code`.

**`cursor`:**
- Found through PATH `cursor` or `Cursor.app/Contents/Resources/app/bin/cursor`, plus Linux paths.
- Opens with `-n <folder>`.

**Both:**
- Spawn detached and unref'd, with a 10 s limit on the launcher.
- No agent step.

### Acceptance Criteria

- [x] A fake PATH `code` is ignored for VS Code.
- [x] The Cursor argv is `["-n", folder]`.
- [x] The spawn options include `detached: true`, and `unref` is called.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts`
- Result (2026-11-09): vscode (own install path only; a PATH code is ignored) and cursor (-n), started detached and unref'd (defaultRuntime.spawnDetached tested). tests/open-places.test.ts and tests/open-change.test.ts pass.

### T2: Work out and record how Claude desktop and T3 Code open a folder

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `wiki/changes/261109-479a-open-worktree-when-created/task-slices/04-app-places/contracts.md` (M: record findings)

### What to build

From the vendors' docs, release notes, and the installed apps' `Info.plist` URL schemes (`plutil -p /Applications/Claude.app/Contents/Info.plist`), find how each app accepts a folder, and whether Claude desktop accepts an initial message:
- URL scheme
- `open -a <app> <folder>`
- a bundled CLI

For T3 Code, also confirm that it must already be running. Record the mechanism, the source links, and any limits in `contracts.md` § Interfaces.

### Acceptance Criteria

- [x] Each app has a documented launch mechanism (or "none found"), with sources.
- [x] Whether Claude desktop supports an unsent first message is recorded, for slice 07.

### Verification

- Manual: findings recorded with links. No code is changed in this task.
- Result (2026-11-09): Findings recorded in contracts.md: Claude desktop uses claude://code/new?folder=…&q=…; T3 Code has no outside way to open a folder (only t3code://pair).

### T3: Add the Claude desktop and T3 Code places with hints

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/open-places.ts` (M)
- `tests/open-places.test.ts` (M)

### What to build

**Places:**
- **`claude-desktop`:** darwin only, `missing` when there is no `/Applications/Claude.app`.
- **`t3code`:** darwin and linux, with the hint "must be running".

Both use the T2 mechanism, spawned detached. A non-zero exit or a timeout gives `failed` with a useful detail line (for T3 Code: "T3 Code must be running"). If T2 found no mechanism, `open` returns `failed` with an explanation.

### Acceptance Criteria

- [x] The argv or URL matches the T2 findings.
- [x] Failures keep the default and print the folder and step.
- [x] `choices` shows the T3 Code hint.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts tests/open-change.test.ts`
- Result (2026-11-09): claude-desktop opens through the claude:// link. t3code brings the app up and reports failed with an explanation, keeping the default. Hint updated. Product question flagged for T3 Code.

### T4: Skip apps over SSH and on Linux with no display

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T3
Files:
- `src/lib/open-change.ts` (M)
- `tests/open-change.test.ts` (M)

### What to build

- **Over SSH:** every `kind: app` place has `remoteOk: false`, so it is `skipped` (`ssh`), on darwin and on linux.
- **No display on Linux:** with neither `DISPLAY` nor `WAYLAND_DISPLAY` set, app places report `unavailable_now` (`no_display`) and are omitted from `choices`.

### Acceptance Criteria

- [x] SSH on Linux with a Cursor default gives `skipped` (`ssh`).
- [x] Headless Linux gives `skipped` (`no_display`).
- [x] The default is kept in both cases.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): All app places are remoteOk:false (skipped over SSH on Linux too). Linux with no display gives no_display. The default is kept; tested.

### T5: Manual check: each installed app opens the change folder

Status: done
Owner:
Repos: root
Execution: hitl
Blocked by: T1, T3, T4
Files:
- None

### What to build

On a Mac, with `npm run build` done:

1. Run `WEAVE_NO_OPEN= node dist/cli.js change open --in vscode`.
   - **Expected:** VS Code, not Cursor, opens the change folder.
2. Run with `--in cursor`.
   - **Expected:** a new Cursor window on the folder.
3. Run with `--in claude-desktop`.
   - **Expected:** the Claude app opens on the folder (confirm its folder prompt). Record whether it opens a new window or reuses the existing one when already running.
4. Run with `--in t3code`, first with T3 Code closed, then running.
   - **Expected:** first `failed` with the hint, then it opens.
5. Record whether each app takes focus.

### Acceptance Criteria

- [x] Steps 1–4 behave as expected, or the deviation is recorded as a QA finding.
- [x] Focus and window behaviour are recorded.

### Verification

- Manual: the steps above. Record the results with the date.
- Result (2026-11-09): Partial: VS Code, Claude desktop, and T3 Code ran as designed from the CLI (user confirmation of VS Code and Claude desktop is pending). Cursor opened its Agents window instead of the folder (QF1). Left in_progress.
- Result (2026-11-09): Confirmed by the user 2026-11-10: VS Code opened (not Cursor) on the change folder; the Claude desktop app opened a Code session and held the q= draft unsent; T3 Code came to the front with the 'add the folder there' failure. Cursor from inside Cursor opened the folder correctly; from outside it opened the Agents window (QF1, left open).

## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |
| QF1 | open | major | manual check 2026-11-10 | T1, T5 | Cursor 3.21.16: `cursor -n <folder>` (bundled CLI, also when run directly) opens Cursor's Agents window instead of an editor window on the folder. Needs another launch form (`-r`, `--classic`, `open -a Cursor <folder>`, or a cursor:// link) to be tried. Update 2026-11-10: run from inside Cursor (`/weave-new` in Cursor's agent), the same `-n <folder>` opened a new Cursor window on the change folder, in focus. So the Agents window seems to come from Cursor 3.10+ routing to the last-focused window type when Weave runs from outside Cursor. Still open for the outside case. |

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

Not run yet.
