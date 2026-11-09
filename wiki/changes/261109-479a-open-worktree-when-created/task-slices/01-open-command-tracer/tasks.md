---
artifact: tasks
slice: 01-open-command-tracer
status: draft
owner: engineering
created_at: 2026-11-09T16:30:00.000Z
updated_at: 2026-11-09T16:30:00.000Z
source: architecture
---

# Tasks: weave change open with saved settings (tmux, herdr, claude, shell)

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
| T1 | done | afk | root | | Add the global test guard and the personal settings store | None |
| T2 | done | afk | root | | Add the place and agent registry with tmux, herdr, claude, and shell | T1 |
| T3 | done | afk | root | | Implement openChange resolution, timeouts, and outcomes | T1, T2 |
| T4 | done | afk | root | | Add the weave change open command and the terminal menu | T3 |
| T5 | done | afk | root | | Verify defaults survive PATH misses and that tests never open real windows | T4 |

## root

### T1: Add the global test guard and the personal settings store

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `vitest.config.ts` (C)
- `tests/setup/no-open.ts` (C)
- `src/lib/user-settings.ts` (C)
- `tests/user-settings.test.ts` (C)

### What to build

- **Test guard:** create `vitest.config.ts` with a `setupFiles` entry that sets `WEAVE_NO_OPEN=1` and a fresh temporary `WEAVE_USER_HOME` for every test file. Keep the existing defaults, because there is no config today.
- **Settings store:** implement `user-settings.ts` per `architecture/schema.md`:
  - path from `getUserWeaveDir`
  - YAML load and validate (`version: 1`)
  - `writeFileAtomic`, preserving unknown keys
  - precedence: project override, then default
  - project key = realpath of the main checkout
  - unrecognised place or agent values are reported as `unknown_saved_value` and never written
  - an unreadable file is never overwritten
  - `clearResolvedEntry` removes only the entry that resolved

### Acceptance Criteria

- [x] Every existing test still passes with the setup file in place.
- [x] Round trip keeps unknown keys. Precedence, unrecognised values, unreadable files, and clearing behave as in `schema.md`.
- [x] A project key resolved from a change folder equals the key from the main checkout.

### Verification

- Automated tests: `npx vitest run tests/user-settings.test.ts` and `npm test`
- Result (2026-11-09): vitest.config.ts + tests/setup/no-open.ts added; user-settings.ts with 7 tests passing; full suite green with the setup file. Project key from a change folder matches the main checkout (tests/cli-change-open.test.ts).

### T2: Add the place and agent registry with tmux, herdr, claude, and shell

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `src/lib/open-places.ts` (C)
- `src/lib/terminal-launch.ts` (M: export `shellQuote` and the AppleScript string helper only)
- `tests/open-places.test.ts` (C)

### What to build

Define the `Place` and `AgentEntry` types (`architecture/index.md` § Registry).

**Places:**
- **`tmux`:** `missing` never. `unavailable_now` when `TMUX` is unset or tmux isn't found. `open` runs `new-window -c <folder> -n <title> -- <argv>` without `-d`, plus `switch-client` when needed.
- **`herdr`:** `missing` only when `herdr-app` is absent from its known absolute paths and `locations.herdr` (PATH is only used to find it). `unavailable_now` when `HC_TERMINAL_ID` is unset. `open` runs `tab.new` with the resolved executable path, `folder`, `name`, and `argv`.

**Agents:**
- **`claude`:** relies on the working directory, `draft: none`.
- **`shell`:** `$SHELL -l`.

**Shared pieces:**
- Terminal argv ends with the login-shell tail (`<agent argv>; exec "$SHELL" -l`, quoted).
- `listChoices(ctx)` returns the choices for the menu and for `needs_choice`.
- `terminalOpeners` and `findTerminalOpener` stay unchanged.

### Acceptance Criteria

- [x] The `check()` matrix (inside/outside, PATH only, known path, `locations`) matches the registry table.
- [x] Built argv contains no unquoted folder. Folders with spaces, quotes, or `$(…)` stay literal.
- [x] `git diff src/lib/terminal-launch.ts` shows only added exports.

### Verification

- Automated tests: `npx vitest run tests/open-places.test.ts`, plus `npx vitest run tests/advance.test.ts` stays green
- Result (2026-11-09): open-places.ts has the full fixed registry (all eight places and agents, used by slices 03/04). 12 tests in tests/open-places.test.ts pass, including hostile-folder quoting run through /bin/sh. terminal-launch.ts only gained an export. advance tests unchanged.

### T3: Implement openChange resolution, timeouts, and outcomes

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2
Files:
- `src/lib/open-change.ts` (C)
- `tests/open-change.test.ts` (C)

### What to build

**`openChange(ctx)`:** implements resolution steps 0, 1, 3, 5, and 6 (`architecture/index.md` § Choice resolution). It uses an injected registry, env, exec, and clock, and returns `OpenOutcome` with the statuses and reasons from `api-contract.md`.

**Failure handling:**
- Each `check()` has 2 s and each `open()` 10 s; a timeout gives `failed` (`timeout`), with an Automation hint on macOS.
- A missing agent gives `failed` (`agent_not_found`), and the default is kept.
- Clear an entry only on absolute-path `missing` or an unknown agent name.

**Other rules:**
- `canPrompt`: text output, a TTY, and no `CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, or `WEAVE_NO_PROMPT`.
- `WEAVE_NO_OPEN` gives `not_attempted` (`disabled`).
- `composeNextStep` returns the `weave-next` fallback.

### Acceptance Criteria

- [x] Each resolution step and each status/reason has a test.
- [x] A default is never cleared on a PATH miss, a missing agent, a timeout, `unavailable_now`, or an unrecognised value.
- [x] Timeouts are covered with fake timers.

### Verification

- Automated tests: `npx vitest run tests/open-change.test.ts`
- Result (2026-11-09): open-change.ts: 19 tests pass. Refinement: a saved agent name this Weave doesn't know is reported as unknown_saved_value and left untouched, never cleared (C8 wins over C1's 'unknown agent clears', because Weave can't tell a removed own agent from one added by a newer Weave).

### T4: Add the weave change open command and the terminal menu

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T3
Files:
- `src/commands/change.ts` (M)
- `src/lib/open-change.ts` (M: menu prompt adapter)
- `tests/cli-change-open.test.ts` (C)

### What to build

**The `open` subcommand:**
- Flags: `[<change>] --in --agent --remember --project --choices --json`.
- Resolve the change (default: current), and return `folder_missing` when its folder doesn't exist.
- Validate `--in`/`--agent` before doing anything.
- Call `openChange` and print the outcome lines (`api-contract.md` § Text output), or the JSON.

**The menu:** the two-step `@clack/prompts` menu (place, then agent for terminals, plus "don't open" with "don't ask again"), shown only when `canPrompt`. Inject the prompt function so tests can drive it.

### Acceptance Criteria

- [x] `--json` never prompts, and with no choice returns `needs_choice` with `choices`.
- [x] `--choices --json` lists choices without opening anything.
- [x] `--in none --remember` saves `dont_ask`.
- [x] Argument errors exit 1 with the JSON error shape.

### Verification

- Automated tests: `npx vitest run tests/cli-change-open.test.ts`
- Result (2026-11-09): weave change open added (8 CLI tests with a fake tmux on PATH). A deleted folder reports folder_missing via the local change state.
- Result (2026-11-09): (2026-11-10) The terminal menu gains a third question, 'Just this once / Make it my default'; just this once opens without saving (MenuAnswer.remember). weave settings open still saves directly. A new test passes; npm test: 503 passed.

### T5: Verify defaults survive PATH misses and that tests never open real windows

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- `tests/open-change.test.ts` (M)
- `tests/cli-change-open.test.ts` (M)

### What to build

Add regression tests:
- **Short PATH:** a saved `herdr` default with a short PATH, where `herdr-app` exists at a known absolute path, opens rather than being cleared.
- **No known path:** a saved `tmux` default with tmux absent from PATH reports `skipped` (`unavailable_now`) and keeps the default.
- **Real-opener guard:** with `WEAVE_NO_OPEN=1` from the global setup, a CLI `change open --in tmux` under a fake `TMUX` env reports `not_attempted` (`disabled`) and never calls exec.

Run the full suite and typecheck.

### Acceptance Criteria

- [x] All three regressions pass.
- [x] `npm test` and `npm run typecheck` are green.

### Verification

- Automated tests: `npm test` and `npm run typecheck`
- Result (2026-11-09): npm test (471 passed) and npm run typecheck green.

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
