# Opening Changes

## Purpose

In worktree checkouts each change lives in its own folder. Opening takes the person to that folder in a place they chose (a terminal with an agent or a shell, or an app), with the change's next step ready, so they don't have to open a tab, `cd`, start an agent, and remember what to run. The choice is a personal setting in `~/.weave/settings.yml`, never part of the project.

## Current Behavior

- **When it runs:** after `weave change new` or `weave change switch` succeeds in a worktree checkout, and on demand with `weave change open`. Opening is one entry point (`openChange`) used by all three. In in-place checkouts it does nothing (`not_attempted`, `in_place`).
- **Places** (fixed list, in this order): `herdr` (a herdr tab), `tmux` (a tmux window), `iterm` (iTerm window, macOS), `terminal` (Terminal window, macOS), `vscode`, `cursor`, `claude-desktop` (macOS), `t3code`. herdr and tmux are only available while the person is working inside them (`HC_TERMINAL_ID`, `TMUX`).
- **Agents** for terminal places: `claude`, `codex`, `opencode`, `cursor-agent` (Cursor's agent; only the `cursor-agent` name is looked up, never the bare `agent` alias), the person's own agents from settings, or `shell`. Apps bring their own agent or editor, so `--agent` with an app is refused (`agent_not_for_app`). The terminal runs the agent and then the person's login shell (`exec "${SHELL:-/bin/sh}" -l`), so the tab stays in the folder after the agent exits.
- **How a tool is found:** each place and agent is checked only at its command name (on `PATH`) and its usual absolute install paths, plus a custom path from `locations:` in settings. Weave never scans or guesses.
- **Asking:** with no saved choice, Weave asks once:
  - at a real terminal (text output, stdin and stdout are TTYs, and none of `CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `WEAVE_NO_PROMPT` is set), a menu: where, then (terminals only) what to start, then "Just this once" or "Make it my default". `new`/`switch` print their summary first. Choosing "Don't open" then asks "Don't ask again?".
  - otherwise (`--json`, no TTY, or inside an agent) nothing opens and the result is `open.status: "needs_choice"` with `open.choices`: one entry per place available on this machine right now (`place`, `kind`, `label`, optional `hint`, and for terminals the found `agents`), plus `{ place: "none", kind: "none", label: "Don't open" }`. The calling agent asks in chat and answers with `weave change open <id> --in <place> [--agent <agent>] [--remember] --json`.
- **Saving:** "just this once" opens without saving, so the person is asked again next time. "Make it my default" (the menu answer, or `--remember` on `weave change open`) saves the choice as the default for every project; `--project` on `weave change open`, or `weave settings open --project`, saves it for this project only, keyed by the main checkout's real path. "Don't open, don't ask again" is saved as `{ place: none, ask: false }`. Once saved, the choice is used for every create, switch, and open, whoever runs the command (person, agent, or script), and is never asked again.
- **One-off choices:** `--open <place>[:<agent>]` on `new`/`switch`, and `--in`/`--agent` on `open`, open there once and never change the saved choice (unless `open` also gets `--remember`/`--project`). `--no-open` on `new`/`switch` skips opening once. `--in none` on `open` opens nothing; with `--remember` it saves "don't ask again". Flags are validated before anything is created or switched to (`unknown_place`, `unknown_agent`, `agent_not_for_app`; `agent_needs_place` for `--agent` without `--in`).
- **Already there:** without an explicit place, nothing opens when the command runs inside the change folder (`not_attempted`, `already_inside`); the output is just the next step. When a saved or just-chosen place resolves, Weave first looks for a tmux pane (any session; it switches the client to that session) or a live herdr terminal already in the folder and brings it forward (`brought_forward`) instead of opening another. An explicit place never brings forward.
- **Next step:** `--skill <name>` and `--context <text>` compose `use the <skill> skill for change <id>: <context>` (skill defaults to `weave-next`; context has control characters and escape codes removed, whitespace collapsed, and is cut to 500 characters). A given step is stored as `next_step: { text, stage }` in the change's `status.yml` and reused by later switches and opens until the change's stage moves on; after that, and when none was given, it is `use the weave-next skill for change <id>`. The result's `next_step` always carries it.
- **Drafts:** only the Claude desktop app receives the step as an unsent first message (`claude://code/new?folder=<path>&q=<step>&source=weave`; the app asks the person to confirm the folder). If opening with the draft fails, it opens without it. herdr's first message is sent, not drafted, so herdr opens with no message, and every other place and every own agent gets none. In those cases `open.draft` is `shown` and the step is printed for the person to paste.
- **What is printed:** the outcome lines replace the summary's "Open <folder> in a new session to work on this change." line, keeping other lines in place. `opened` prints where, the next step (marked "filled in, not sent" for a draft), a fallback ("If it didn't start: open <folder> and run the step there."), and, when a default was used, "Change where changes open: weave settings open". With no default and nobody to ask (and no step or notice to add), the output is exactly what it was before opening existed.
- **`weave change open [change]`:** resolves the change (default: the active change) with `locateChange`, which reads the recorded folder without fetching or touching worktrees. It fails with `folder_missing` (pointing at `weave change switch <id>`) when the recorded folder is gone, and `no_active_change` when no change is given or active. `--choices` lists the menu's choices on this machine without opening anything.
- **`weave settings open`:** sets or clears the saved choice directly and never opens anything. `--in <place> [--agent <agent>]` saves it, `--clear` removes it so the person is asked again, `--project` applies either to this project only (needs a Weave project: `no_weave_context`). With no flags it shows the menu at a real terminal (pre-selecting the current choice) or prints the current default, the project override, and the choices.

## Domain Model

`~/.weave/settings.yml` (directory redirected by `WEAVE_USER_HOME`), `version: 1`:

```yaml
version: 1
open:
  default: { place: tmux, agent: claude }      # or { place: none, ask: false }
  projects:
    /abs/real/path/of/main/checkout: { place: cursor }
agents:                                        # the person's own agents
  pi: { command: "pi", label: "Pi" }
locations:                                     # absolute install paths for listed tools
  cursor: /opt/cursor/bin/cursor
```

- A project override wins over the default.
- Writes are atomic read-modify-write and keep unknown keys. A file that can't be parsed (or isn't a mapping) or that was written by a newer Weave (`version` > 1) is never written.
- `open` result in `--json` (`new`, `switch`, `open`): `status`, `place`, `agent`, `where`, `draft` (`unsent`|`shown`), `used_default`, `saved` (`default`|`project`|null), `reason`, `detail`, `choices`.

## Decision Tables

### Table: Outcome

| Situation | `open.status` | `reason` | Saved choice |
| --- | --- | --- | --- |
| `WEAVE_NO_OPEN` set | `not_attempted` | `disabled` | kept |
| In-place checkout | `not_attempted` | `in_place` | kept |
| `--no-open`, or `--in none` without `--remember` | `not_attempted` | `no_open_flag` | kept |
| Inside the change folder, no explicit place | `not_attempted` | `already_inside` | kept |
| Saved "don't open, don't ask again" (or `--in none --remember`) | `not_attempted` | `dont_ask` | kept / saved |
| Saved place or agent this Weave doesn't know, or settings from a newer Weave | `not_attempted` | `unknown_saved_value` | untouched |
| Settings file can't be read | `failed` | `open_failed` | untouched |
| No saved choice, nobody to ask | `needs_choice` | `no_choice` | none |
| Saved place's tool gone from every absolute install path | cleared, then asked (`needs_choice`, `default_missing`, with a detail line) | | cleared |
| Menu cancelled, or "Don't open" just this once | `not_attempted` | `no_choice` | none |
| tmux pane or herdr terminal already in the folder | `brought_forward` | | kept |
| Opened | `opened` | | kept |
| Over SSH (`SSH_CONNECTION`/`SSH_TTY`) and the place is iTerm, Terminal, or an app | `skipped` | `ssh` | kept |
| herdr/tmux chosen but not working inside it, or tmux not found | `skipped` | `unavailable_now` | kept |
| Place not supported on this OS | `skipped` | `unavailable_now` | kept |
| App on Linux with no `DISPLAY`/`WAYLAND_DISPLAY` | `skipped` | `no_display` | kept |
| Agent not found | `failed` | `agent_not_found` | kept |
| Tool missing for a one-off choice, opener error, T3 Code | `failed` | `open_failed` | kept |
| Check over 2s, open over 10s | `failed` | `timeout` (macOS adds an Automation-permission hint) | kept |

### Table: Proving a tool is gone

| Tool | Known absolute install paths | Can be cleared |
| --- | --- | --- |
| herdr, iTerm, VS Code, Cursor, Claude desktop, T3 Code | yes (plus any `locations:` entry) | yes, when none of them exist |
| tmux | none (found on `PATH` or Homebrew/system paths) | never |
| Terminal | ships with macOS | never |

`PATH` only helps find a tool; only a missing absolute install path proves it is gone. A tool that is installed but not usable now keeps the default.

## Behavioral Rules

- Opening never blocks, fails, or undoes the create or switch: every opening error becomes an `open` outcome, and the folder and next step are always printed in the original session.
- Opening never runs or approves `weave change setup`.
- Opening never starts a place or agent the person didn't choose, and never sends a message on their behalf.
- A failed, skipped, or timed-out open keeps the default; only a tool provably gone clears it.
- One-off flags never change the saved choice.
- Personal settings are never written into the project.
- Opening is independent of auto-advance: it never reads `advance.*`, and `weave advance` never reads the opening default.

## Integrations And Side Effects

- Openers: herdr `herdr-app do tab.new` (name, folder, argv); tmux `tmux new-window -c <folder> -n <name>` in the foreground; iTerm and Terminal via `osascript`; VS Code and Cursor `<cli> -n <folder>` (detached); Claude desktop `open claude://code/new?...`; T3 Code is brought up (`open -a`, or the binary on Linux) and reported `failed` with "add the folder as a project there", because it has no outside way to open a folder. Bring forward uses `tmux list-panes -a` / `select-window` / `switch-client`, and herdr-core `hc ls --json` / `herdr-app do pane.focus`.
- Skills: `weave-new` chooses the first skill before creating, runs `weave change new "<title>" --skill <skill> --context "<gist>" --json`, and acts on `open.status`. On `needs_choice` it asks in chat: where (each choice's `label` and `hint`), what to start only for `kind: "terminal"` (never for an app, never `--agent` with an app), then "just this once, or make it your default?" (for "Don't open": "just this once, or don't ask again?"). It runs `weave change open <id> --in … [--agent …] [--remember] --json`, with `--remember` only for a default. `weave-next` handles `switch`, reopening, and `weave settings open` the same way. `weave-fix` passes `--no-open` because it writes files into the folder before anyone works there. All three fall back when an older CLI rejects the new options.
- Tests: the global Vitest setup (`vitest.config.ts`, `tests/setup/no-open.ts`) sets `WEAVE_NO_OPEN=1` and a temporary `WEAVE_USER_HOME`, so no test opens real windows or reads the developer's settings. Opening tests clear `WEAVE_NO_OPEN` and inject a recording registry and runtime.
- Decisions: [261109-mn61](../../../../../decisions/261109-mn61-weave-opens-change-folders-in-the-place-the-person-chose.md) (opening; supersedes `261107-ohne`; the saving rule is "just this once or default"), [261109-a8k5](../../../../../decisions/261109-a8k5-personal-settings-live-in-the-user-s-weave-folder-never-in-the-project.md) (personal settings file), [261109-bv3c](../../../../../decisions/261109-bv3c-opening-a-change-is-separate-from-auto-advance-launching.md) (separate from auto-advance).

## Edge Cases

- The project override is looked up by the main checkout's real path, which is the same from the main checkout or any of its change folders.
- Moving or re-cloning a project drops its project override; old keys stay in the file.
- The person's own agents are started with their configured command, never checked for existence and never given a draft.
- `listChoices` lists only places that pass their check right now, so over SSH the choices are at most herdr, tmux (when working inside them), and "Don't open".

## Invariants

- `open` and `next_step` are present in every `new` and `switch` JSON result, and in `weave change open` results except `--choices`.
- No test run opens a real terminal or app.

## Source Anchors

- Resolution, next step, outcome lines: `src/lib/open-change.ts` (`openChange`, `openAt`, `bringForward`, `listChoices`, `canPrompt`, `resolveNextStep`, `composeNextStep`, `formatOpenLines`, `placeOpenLines`, `validateExplicitChoice`, `clackMenu`)
- Place and agent registry: `src/lib/open-places.ts` (`defaultRegistry`, `locateTool`, `claudeDesktopUrl`, `terminalLine`, `ownAgentEntry`)
- Personal settings: `src/lib/user-settings.ts` (`loadUserSettings`, `updateUserSettings`, `saveOpenChoice`, `clearOpenChoice`, `resolveSavedChoice`); `src/lib/user-paths.ts`
- Commands: `src/commands/change.ts` (`new`/`switch` `--skill --context --open --no-open`, `open`, `openAfter`); `src/commands/settings.ts` (`weave settings open`)
- Change lookup without git side effects: `src/lib/changes.ts` (`locateChange`); main checkout key: `src/lib/worktrees.ts` (`mainCheckoutPath`)
- Skills: `templates/skills/weave-new/SKILL.md`, `templates/skills/weave-next/SKILL.md`, `templates/skills/weave-fix/SKILL.md`
- User docs: README "Where changes open"
- Tests: `tests/open-change.test.ts`, `tests/open-places.test.ts`, `tests/user-settings.test.ts`, `tests/cli-change-open.test.ts`, `tests/cli-change-open-on-create.test.ts`, `tests/cli-settings.test.ts`, `tests/helpers/open-fixture.ts`, `tests/setup/no-open.ts`

## Change History

- 2026-11-10 (change `261109-479a-open-worktree-when-created`): introduced opening on create and switch, `weave change open`, `weave settings open`, personal settings in `~/.weave/settings.yml`, the stored next step, and the skills' `needs_choice` handling.

## Open Questions

- QF1: Cursor 3.21 run from outside Cursor may open its Agents window instead of an editor window on the folder (`cursor -n <folder>`); from inside Cursor it opens the folder. Another launch form is still to be tried.
- README "Where changes open" mentions only tmux for bringing forward; the code also brings forward a live herdr terminal.
