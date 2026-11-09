---
facet: index
description: Canonical entry point for a folder-based architecture artifact, holding the technical shape.
---

# Open Worktree When Created Architecture

## Decision Summary
- A new git-free command, `weave change open [<change>]`, opens a change folder in a chosen place. `change new` and `change switch` call the same internal function (`openChange`) after they succeed. "Git-free" means no fetch and no worktree changes. Resolving the main checkout still reads git.
- When there is no default, `--json` (or a known agent marker, or `WEAVE_NO_PROMPT=1`) returns `open.status: "needs_choice"` with `choices`. The guided agent asks in chat and runs `weave change open <id> --in … [--agent …] --remember`. The terminal menu shows only for text output at a real TTY with no agent marker. With no default and no menu, text output is byte-for-byte today's.
- Personal settings live in `~/.weave/settings.yml`, with per-project overrides keyed by the main checkout's absolute path (`schema.md`).
- The draft text comes from `--skill` and `--context` (`use the <skill> skill for change <id>: <context>`). `weave-new` picks `weave-questions` or `weave-explore` from the conversation. `change new` stores the composed step in the change's `status.yml` so that later opens reuse it until the stage moves on. Otherwise the draft is `use the weave-next skill for change <id>`.
- A fixed, code-defined registry of places and agents lives in `src/lib/open-places.ts`. It has its **own argv-based open functions**. Advance's openers in `terminal-launch.ts` are untouched; only `shellQuote` and the AppleScript escaping are shared.
- A saved default is cleared only when its tool is absent from every **absolute** install location (PATH only helps find tools, never proves one is gone), or when its agent name is unknown. `unavailable_now` (→ `skipped`), a failed or timed-out `open()` (→ `failed`), and a missing agent all keep the default. A saved value this Weave version doesn't recognise is never touched.
- Each `check()` gets 2 s and each `open()` gets 10 s. App processes are detached and unref'd.
- Bring-forward (tmux only for now) runs only after a non-`none` choice resolves, and uses `switch-client` across sessions.
- Commands are built as argv arrays, and unavoidable shell lines are fully quoted. Opening never runs setup and never sets agent permission flags. `WEAVE_NO_OPEN=1` disables opening (and tests always set it).

## System Context
- `weave change new` → `createChange` (`src/lib/changes.ts:458-521`). In worktree mode it runs `ensureChangeWorktrees` (`src/lib/worktrees.ts:111-204`) and `summarizeChangeOperation` (`src/lib/changes.ts:2470-2518`), which ends with `Open <folder> in a new session…` from `formatWorktreeLines` (`:2520-2535`). The JSON has `folder` but no next step (research: "`weave change new` decides the checkout mode…").
- `weave change switch` in worktree mode → `openChangeFolder` (`src/lib/changes.ts:889-940`): it fetches, ensures the worktrees, refreshes attention, and prints the same lines, followed by any `Slot changed` / `Setup reset` lines.
- Text is printed by `withNotices` only after the action returns (`src/lib/with-notices.ts:30-41`).
- `src/lib/terminal-launch.ts`: the `TerminalOpener` contract and the herdr, tmux, iTerm, and Terminal openers. They take a single shell line. herdr is looked up again on PATH (`:35-39`), and tmux opens detached with `-d` (`:51`). Only `openPhaseTerminal` (`src/lib/advance.ts:458-476`) uses them.
- `src/lib/agent-launchers.ts`: only `claudeLauncher`, plus `commandTemplateLauncher`. `claude <prompt>` sends the prompt immediately.
- TTY prompting already exists: `interactiveTerminal()` (`src/commands/change.ts:491-493`) with `@clack/prompts`, used by `change setup`.
- User-level state already exists: `getUserWeaveDir` (`src/lib/user-paths.ts`, `WEAVE_USER_HOME` in tests) holds advance run logs and the npm-version cache. Tests set `WEAVE_USER_HOME` per file, and there is no global setup (`tests/cli-advance.test.ts:44`).
- "What's next" exists only as the `weave-next` skill. `change-states.ts` computes next steps for change state, not for the workflow phase.
- `weave-new` tells the person to open the folder themselves (`templates/skills/weave-new/SKILL.md:41`) and picks the first skill by judgment (`:52`). `weave-fix` (`:49`), `weave-next` (`:56`), the README (`:486`), and `change-checkouts.md` say the same.
- Agent markers research found: `CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`/`AGENT`, and `CODEX_*` (undocumented).
- Decisions: `261107-ohne` (worktree folders; superseded by `261109-mn61`, which keeps its core) and `261108-4z8l` (auto-advance never opens visible windows by default; unaffected, see `261109-bv3c`).

## Options Considered

### A. Open from inside `change new` and `change switch` — Rejected
- How it works: `new` and `switch` open after they succeed, with `--open`, `--no-open`, and `--remember` flags. Guided agents answer `needs_choice` by re-running `weave change switch <id> --open … --remember`.
- Trade-offs: fewest new surfaces. But reopening goes through switch, which fetches, runs `ensureChangeWorktrees`, and can recreate worktrees as a side effect.
- Why rejected: reopening should be cheap and have no side effects, and opening should be testable without git fixtures.

### B. A separate `weave change open` command, called by create and switch — Chosen
- How it works: everything in A, but opening is its own command with no git side effects. `new` and `switch` call the same function. Guided agents and reopen requests call `weave change open`.
- What changes: new `open-places.ts`, `open-change.ts`, and `user-settings.ts`; the `change open` and `settings open` commands; flags on `new` and `switch`; a stored `next_step` in `status.yml`; additive JSON fields; skill and doc updates.
- Trade-offs: one more command to document, plus a rule for a missing folder (error and point to `switch`). Like any option that spawns from `weave`, it runs inside the calling agent's sandbox, so `osascript`, the herdr socket, or GUI launches may be blocked there. That surfaces as `failed` with the fallback lines.
- Why chosen: one opening primitive serves every caller, reopening has no git side effects, and it can be unit-tested with an injected registry.

### C. Weave plans the opening, and the caller runs it — Rejected
- How it works: Weave returns an `open_plan` (argv, cwd, draft). The CLI runs it at a TTY, and agents run it through their own shell tool.
- Trade-offs: Weave never spawns from inside an agent's process. But each skill would have to own running the plan and handling failure, and older guided flows would silently do nothing even with a saved default. Its sandbox exposure is the same as B's.
- Why rejected: failure handling would move into every skill, and it breaks the PRD goals "same experience for every agent" and "the default fires for every caller". B fails the same way for every caller, with a reported `failed` and the fallback lines.

## Architecture Overview

### Modules

```text
src/commands/change.ts
  change new    --skill --context --open <place[:agent]> --no-open   ─┐
  change switch --skill --context --open <place[:agent]> --no-open   ─┼─> openChange(ctx)  (src/lib/open-change.ts)
  change open [<change>] --in --agent --skill --context              ─┘        │
              --remember | --project | --choices                               │
src/commands/settings.ts (new)                                                  │
  settings open [--in --agent | --clear] [--project]                            │
                                                                                ▼
              canPrompt / resolveOpenChoice ──> user-settings.ts (~/.weave/settings.yml)
              nextStep (status.yml next_step | weave-next fallback)
              insideFolder? / bringForward (tmux, after a choice)
              registry check() / open()  ──> open-places.ts (own argv openers)
                                                └─ shares shellQuote + AppleScript escaping with terminal-launch.ts
```

- `src/lib/user-settings.ts` (new): loads and validates `settings.yml`, writes it atomically with `writeFileAtomic`, and resolves the effective choice for a main-checkout path (`schema.md`).
- `src/lib/open-places.ts` (new): the `Place` and `AgentEntry` registry, `listChoices(ctx)`, and each place's `check()` and `open()`. `open()` takes a resolved absolute executable path and an argv:
  - **herdr:** `tab.new` with `folder`, `argv`, and optionally `task`.
  - **tmux:** `new-window` without `-d`, then `switch-client` when the window is in another session.
  - **iTerm and Terminal:** AppleScript with fully quoted values.
  - **Apps:** `open -a` or the app's CLI, detached and unref'd.
  - **When the agent exits:** terminal places run `<agent argv>; exec "$SHELL" -l` (built with quoting), so the tab stays in the folder.
- `src/lib/open-change.ts` (new): `openChange(ctx)`, the one entry point. It never throws for opening failures and wraps every `check()` and `open()` in its timeout.
- `src/lib/terminal-launch.ts`: export only `shellQuote` and the AppleScript string helper. `terminalOpeners`, `findTerminalOpener`, and the four openers are unchanged (`261109-bv3c`).
- `src/lib/changes.ts`:
  - **Unchanged:** `createChange`, `openChangeFolder`, `formatWorktreeLines`, and the library `message`.
  - **Added:** `ChangeOperationResult` and `SwitchChangeResult` gain `next_step` and `open`. `writeChangeFiles` writes `next_step` into `status.yml` when `--skill` is given.
- `src/commands/change.ts`:
  - validates every open flag **before** calling `createChange` or `openChangeFolder`
  - prints the summary **before** any menu
  - when opening happened, replaces the single `Open <folder> in a new session…` line **in place** with the outcome lines, in text and in the JSON `message`

### Can Weave prompt?

`canPrompt` = text output (no `--json`) **and** stdin and stdout are TTYs **and** none of `CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`, `CODEX_SANDBOX`/`CODEX_THREAD_ID`, or `WEAVE_NO_PROMPT` is set.

### Choice resolution (in order)

0. **Opening disabled:** if `WEAVE_NO_OPEN=1` or the checkout is in-place → `not_attempted` (`disabled` / `in_place`).
1. **Explicit flags:** `--no-open` → `not_attempted`. `--open X` / `--in X` → a one-off choice, which skips steps 2 and 4. It is saved only with `--remember` or `--project`.
2. **Inside the folder:** if there is no explicit `--in`/`--open` and the cwd realpath is under the change folder → `not_attempted` (`already_inside`). Only the next step is shown.
3. **Saved choice:** the per-project override for the main-checkout path, otherwise the personal default.
   - `place: none, ask: false` → `not_attempted` (`dont_ask`).
   - A value this Weave version doesn't recognise → `not_attempted` (`unknown_saved_value`, "update Weave"). The entry is never written.
   - The place's `check()` is `missing` (no absolute install location found), or the agent name is unknown → that entry is cleared → step 5 with `default_missing`.
4. **Bring forward:** only when a non-`none` choice has resolved (from step 3, or step 5 just answered) and there was no explicit `--in`. If inside tmux and a pane's `pane_current_path` is under the folder → `select-window` (plus `switch-client` when it's another session) → `brought_forward`. 2 s timeout; any error continues.
5. **No choice:** if `canPrompt`, print the summary, then show the two-step `@clack/prompts` menu, saving the answer unless it is a plain "don't open". Otherwise → `needs_choice` with `choices`, and text output is today's.
6. **Open:**
   - Over SSH (`SSH_CONNECTION` or `SSH_TTY`) with a place that has `remoteOk: false` → `skipped` (`ssh`).
   - `check()` is `unavailable_now` → `skipped`.
   - The agent can't be found → `failed`.
   - `open()` throws or exceeds 10 s → `failed`, with a one-line reason. On a macOS timeout the reason suggests checking System Settings › Privacy › Automation.

In steps 4–6 the default is never cleared.

### Next step

- `composeNextStep(changeId, skill?, context?)` builds `use the <skill> skill for change <id>[: <context>]`. `--context` has control characters stripped and is capped at 500 characters.
- `change new --skill …` stores `next_step: { text, stage }` in the change's `status.yml`.
- `open` and `switch` use, in order:
  1. a step built from `--skill`/`--context` passed to this call, which also replaces the stored step
  2. the stored step, while the change's `stage` still equals its `stage`
  3. `use the weave-next skill for change <id>`
- The step goes into the tool's draft slot only when the place, or the place plus agent, declares `draft: "unsent"`. Otherwise `draft: "shown"`. The person's own agents never receive a draft.
- `next_step` is always returned and printed in the fallback lines.

### Registry (initial entries; install paths and draft support to confirm during implementation)

| Place | Kind | Platforms | `missing` when (absolute paths only) | `unavailable_now` when | Over SSH |
| --- | --- | --- | --- | --- | --- |
| herdr | terminal | darwin, linux | no `herdr-app` at its known install paths or `locations.herdr` (found via PATH if present) | `HC_TERMINAL_ID` unset; not on PATH and no known path to check | opens |
| tmux | terminal | darwin, linux | never (no fixed install path; known paths like `/opt/homebrew/bin/tmux` and `/usr/bin/tmux` only help find it) | `TMUX` unset, or not found | opens |
| iterm | terminal | darwin | no `/Applications/iTerm.app` (or `locations.iterm`) | — | skipped |
| terminal | terminal | darwin | never | — | skipped |
| vscode | app | darwin, linux | none of VS Code's own install paths; never the `code` command | linux: no `DISPLAY`/`WAYLAND_DISPLAY` | skipped |
| cursor | app | darwin, linux | no `Cursor.app/…/bin/cursor` or Linux install path; opens with `-n` | linux: no display | skipped |
| claude-desktop | app | darwin | no `/Applications/Claude.app` | — | skipped |
| t3code | app | darwin, linux | no known install path; hint "must be running" | linux: no display | skipped |

- **Listed agents:** `claude`, `codex`, `opencode`, `cursor-agent` (`agent`), and `shell`. Each has a command name, known absolute install paths, and an interactive argv: `codex -C`; `opencode <dir>`; `agent --workspace`; `claude` relies on the working directory.
- **A missing agent:** if the agent isn't found, that run is `failed` and the default is kept. A saved agent name that isn't listed and isn't in `agents:` counts as unknown, and that entry is cleared.
- **Draft support:** every entry declares `draft`, defaulting to `none`. It is changed to `unsent` only after a manual check on a real machine.
- **Settings:** `locations.<id>` adds an absolute install path for a listed id. `agents.<name>` adds a terminal agent run as `/bin/sh -c '<command>'`, with no check and no draft.

### Skills and docs

- **`weave-new`:** choose `--skill weave-questions|weave-explore` (or another fitting skill for non-feat changes) from the conversation, and ask one short question if the intent is unclear. Run `weave change new "<title>" --skill … --context "<one-line gist>" --json`.
  - On `needs_choice`, ask in chat with `choices`, then run `weave change open <id> --in … [--agent …] --remember` (`--in none --remember` for "don't open, don't ask again").
  - On `opened` or `brought_forward`, say where it opened, give the fallback, and stop editing the change.
  - For one-off instructions, call `open` without `--remember`.
- **`weave-next`:** for resuming or switching, run `weave change switch <id> --json` with the same `needs_choice` handling. "Open it again" or "open it in Cursor instead" uses `weave change open <id> [--in …]`.
- **`weave-fix`:** pass `--no-open` on `change new`.
- **Changing settings from chat** uses `weave settings open --in … [--agent …] [--project] --json` or `--clear [--project]`, which never open anything.
- **All three skills, older CLIs:** if `change new`/`switch` fails with an unknown-option error, re-run without `--skill`, `--context`, and `--no-open`, then use today's "open the folder in a new session" guidance.
- **README, `weave change` and `weave settings` help, and `wiki/knowledge/.../change-checkouts.md`:** describe the menu, the default, `weave settings open`, the per-change override, `WEAVE_NO_OPEN`/`WEAVE_NO_PROMPT`, and that opening is independent of `advance.*`.

### Testing strategy

- **Global guard:** a vitest `setupFiles` entry sets `WEAVE_NO_OPEN=1` and a temporary `WEAVE_USER_HOME` for every test. Tests that exercise opening clear `WEAVE_NO_OPEN` and inject a recording registry.
- **`open-change.ts` unit tests:**
  - each step of the resolution order and each outcome status
  - clearing a default only on absolute-path `missing` or an unknown agent name, never on PATH misses, a missing agent, a timeout, `unavailable_now`, or an unrecognised value
  - `canPrompt` against `--json`, each agent marker, and `WEAVE_NO_PROMPT`
  - bring-forward ordering and `switch-client`
  - SSH and Linux display rules
  - `--remember`, `--project`, and one-off choices
  - timeouts, using fake timers
- **`user-settings.ts` tests:** parsing, validation, unrecognised values left untouched, atomic writes, precedence, and `--clear`.
- **`open-places.ts` tests:**
  - the `check()` matrix against a fake filesystem and PATH (VS Code is never found through PATH `code`)
  - the argv built for each place and agent, including the login-shell tail
  - quoting of hostile folders and `--context`
- **CLI tests:**
  - no default and no TTY: the text output is identical to today's, including switch with `Slot changed` lines, and `--json` has `needs_choice`
  - with a default, the "Open …" line is replaced in place
  - invalid open flags fail before any change is created
  - `change open` on a missing folder → `folder_missing`
  - stored `next_step` is reused, then falls back after a stage change
- **`tests/advance.test.ts`:** stays green, unchanged.
- **Manual checks per tool** (in slices): draft support, focus, Claude desktop when already running, herdr tab listing, the T3 Code and Claude desktop launch mechanism, and whether each agent's shell tool runs commands under a PTY.

## Facets
- `api-contract.md`: CLI flags, JSON `open` and `next_step` fields, statuses, text output assembly, and compatibility. Updated after the stress test.
- `schema.md`: `~/.weave/settings.yml`, the stored `next_step` in `status.yml`, validation, precedence, and version-skew rules. Updated after the stress test.

## Decisions Recorded
- `261109-mn61-weave-opens-change-folders-in-the-place-the-person-chose`: Weave opens change folders in an explicitly chosen place through `weave change open`. **Supersedes `261107-ohne`**: it carries over ohne's core (one folder of worktrees per change, made with plain git) unchanged and replaces only its "people open the folder themselves" consequence.
- `261109-bv3c-opening-a-change-is-separate-from-auto-advance-launching`: companion to `261108-4z8l`. Separate settings and separate open functions, and `weave advance` is unchanged.
- `261109-a8k5-personal-settings-live-in-the-user-s-weave-folder-never-in-the-project`: personal settings in `~/.weave/settings.yml`, keyed by main-checkout path.

## Tradeoffs
- One more command (`change open`) and one more settings command (`settings open`) to document.
- About 40 lines of opener code exist in two places (advance and opening) to keep hand-offs untouched. Merging them later is its own change.
- A fixed registry means each new tool needs a release, and each claim of draft support needs a manual check. Defaulting to `none` keeps it safe but at first gives fewer pre-filled drafts.
- Overrides keyed by path are dropped when a project is moved or re-cloned.
- When a script runs with a saved default, each create or switch opens a session (accepted in the PRD).
- Agent detection relies on known environment markers. An agent that sets none, uses a PTY, and calls without `--json` would see the menu. `WEAVE_NO_PROMPT=1` and the skills always using `--json` cover this.
- The 2 s and 10 s timeouts are first guesses, to tune during implementation.

## Risks And Open Questions
- **Draft support per tool.** Checked 2026-11-10 (slice 07 T1): the Claude desktop app holds `q=` unsent, so it is `unsent`. herdr's `task` is passed as the agent's prompt and sent, so it is `none`. Codex, opencode, and Cursor's agent were not checked and stay `none`.
- **herdr tab listing.** Resolved (slice 07 T3, herdr 0.1.14): herdr-core's `hc ls --json` lists live terminals with their `cwd`, and `herdr-app do pane.focus {"terminal": <address>}` brings one forward. herdr now brings forward a terminal already in the folder, just like tmux.
- **T3 Code can't open a folder from outside** (slice 04 T2, T3 Code 0.1.7): `t3code://` only handles pairing, and there is no CLI. Weave brings the app up and reports `failed` with "add the folder as a project there". Product question: keep T3 Code on the list until it supports this, or drop it. Not blocking.
- **Claude desktop link** (slice 04 T2): `claude://code/new?folder=<path>&q=<message>`, the same link the app's own Finder service uses.
- **Focus and windows.** Does a herdr tab or app take focus? What does Claude desktop do when already running? `herdr-app` folders are always passed as absolute paths. Not blocking slices.
- **Launch mechanisms.** How do Claude desktop (folder plus unsent message) and T3 Code open a folder: URL scheme, `open -a`, or a CLI? If none works, the place stays with its hint and reports `failed`. Not blocking slices.
- **Exact install paths** on macOS and Linux for each listed tool and agent. Pin them in the registry slice, with tests. Not blocking slices.
- **Agent PTY behaviour** for Codex, Cursor's agent, opencode, and pi shell tools. This is covered by `--json` and the agent markers, but should be confirmed. Not blocking slices.
- **Timeout values** (2 s / 10 s). Tune once real Automation prompts and app launches have been observed. Not blocking slices.

## Slices Readiness

Ready
