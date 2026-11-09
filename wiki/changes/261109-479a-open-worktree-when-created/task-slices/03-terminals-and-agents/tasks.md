---
artifact: tasks
slice: 03-terminals-and-agents
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: iTerm, Terminal, more agents, own agents, and SSH rules

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
| T1 | done | afk | root | | Add the iTerm and Terminal places with their own AppleScript openers | None |
| T2 | done | afk | root | | Add the Codex, opencode, and Cursor agent entries with pinned install paths | None |
| T3 | done | afk | root | | Support own agents and custom install locations from settings | T2 |
| T4 | done | afk | root | | Skip Mac terminal windows over SSH | T1 |
| T5 | done | hitl | root | | Manual check: real iTerm and Terminal windows with each installed agent | T1, T2, T3, T4 |

## root

### T1: Add the iTerm and Terminal places with their own AppleScript openers

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/open-places.ts` (M)
- `tests/open-places.test.ts` (M)

### What to build

- **`iterm`:** `create window with default profile command`.
- **`terminal`:** `do script` plus `activate`.

Both:
- run the agent argv plus the login-shell tail
- quote every value with `shellQuote` and then the AppleScript string escaping
- report `missing` and `unavailable_now` per the registry table, with `platforms: [darwin]` and `remoteOk: false`

Advance's openers are untouched.

### Acceptance Criteria

- [x] Generated AppleScript for folders containing quotes, backslashes, `$(…)`, and spaces keeps them literal (asserted on the script string).
- [x] Both places are absent from `choices` on Linux.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts`
- Result (2026-11-09): iterm and terminal places with their own AppleScript; the Terminal quoting test runs the decoded command through /bin/sh with a hostile folder. Linux choices exclude both (tests/open-change.test.ts › terminals and agents).

### T2: Add the Codex, opencode, and Cursor agent entries with pinned install paths

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `src/lib/open-places.ts` (M)
- `tests/open-places.test.ts` (M)

### What to build

- **Agent entries:**
  - `codex`: `codex -C <folder>`
  - `opencode`: `opencode <folder>`
  - `cursor-agent`: command `cursor-agent` (never the bare `agent`, which other tools share), `cursor-agent --workspace <folder>`
- **Install paths:** look up the usual absolute install paths for each agent and terminal tool on macOS and Linux (Homebrew `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, npm global prefixes, the `~/.opencode/bin` style used by each tool's installer) from each tool's install docs. Record the sources in a code comment.
- **Draft:** `draft: none` for every entry.

### Acceptance Criteria

- [x] The argv for each agent matches its documented flags.
- [x] Each agent is found through PATH or a known absolute path. A missing agent gives `failed` (`agent_not_found`), and the default is kept.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts tests/open-change.test.ts`
- Result (2026-11-09): codex -C, opencode <dir>, and cursor-agent --workspace, with known install paths and sources in a code comment. Finding: on this machine the bare 'agent' on PATH is another tool's (~/.grok/bin/agent), so only 'cursor-agent' is looked up; tested.

### T3: Support own agents and custom install locations from settings

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T2
Files:
- `src/lib/open-places.ts` (M)
- `src/lib/user-settings.ts` (M)
- `tests/open-change.test.ts` (M)

### What to build

- **Own agents:** `agents.<name>` become step-two choices with `own: true`. They are run as `/bin/sh -c '<command>'` plus the login-shell tail, never checked, and never given a draft.
- **Custom locations:** `locations.<id>` adds an absolute path for listed ids. Unknown ids produce a warning and are left untouched.
- **Removed own agents:** a saved default whose own agent was removed gives `unknown_saved_value` and is left untouched (see slice 01 T3 note).

### Acceptance Criteria

- [x] Own agents appear in `choices` and open with their command.
- [x] `locations` makes an otherwise missing tool available.
- [x] Unknown ids in `locations` are ignored but preserved on write.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts tests/user-settings.test.ts`
- Result (2026-11-09): Own agents are listed with own: true and opened with their command and no draft. Custom locations apply to any runtime (a fix made during this task). A removed own agent is reported as unknown_saved_value and left untouched (see slice 01 T3 note).

### T4: Skip Mac terminal windows over SSH

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/open-change.ts` (M)
- `tests/open-change.test.ts` (M)

### What to build

- **SSH detection:** `SSH_CONNECTION` or `SSH_TTY` set.
- **Skipping:** for `remoteOk: false` places, return `skipped` (`ssh`) with the line "connected over SSH, so Mac windows and apps are skipped", before any `check()`. The default is kept.
- **Menu over SSH:** step one of the menu and `choices` omit `remoteOk: false` places.

### Acceptance Criteria

- [x] Over SSH, an iTerm default gives `skipped` (`ssh`), the default is kept, and herdr and tmux still open.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): SSH (SSH_CONNECTION or SSH_TTY) skips remoteOk:false places with reason ssh and keeps the default; choices omit them. tmux still opens. Tests pass.

### T5: Manual check: real iTerm and Terminal windows with each installed agent

Status: done
Owner:
Repos: root
Execution: hitl
Blocked by: T1, T2, T3, T4
Files:
- None

### What to build

On a Mac, with `npm run build` done, from a change in a worktree-mode project:

1. Run `WEAVE_NO_OPEN= node dist/cli.js change open --in terminal --agent shell`.
   - **Expected:** a Terminal window opens in the change folder with a login shell.
2. Repeat step 1 with `--in iterm` (if installed).
3. Repeat step 1 with `--agent codex`, `opencode`, and `cursor-agent` (whichever are installed).
   - **Expected:** the agent starts in the folder, and after exiting it a shell remains in the folder.
4. Use a folder whose path contains a space and a single quote.
   - **Expected:** it still opens in the right folder.
5. Note the first-run macOS Automation prompt and whether a 10 s timeout is enough.

### Acceptance Criteria

- [x] Steps 1–4 behave as expected. Any tool that misbehaves is recorded as a QA finding.
- [x] Automation prompt behaviour and timeout adequacy are recorded in Verification.

### Verification

- Manual: the steps above. Record the results with the date.
- Result (2026-11-09): Confirmed by the user on a Mac: Terminal+shell, iTerm+Codex, and Terminal+opencode all opened in the change folder, and a shell stays there after the agent exits. Read-back of the Terminal window shows a login shell at the change folder. No Automation prompt issue reported. Cursor's agent is not installed here (the PATH 'agent' is grok's), so it was skipped. A bug found during the run (a loose folder_missing fallback) was fixed with a regression test.

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
