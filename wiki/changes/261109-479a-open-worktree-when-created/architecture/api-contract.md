---
facet: api-contract
description: Request, response, event, and integration contract design.
---

# API Contract Design

## Consumers And Producers
- **Producers:** `weave change new`, `weave change switch`, and `weave change open` (`src/commands/change.ts`), plus `weave settings open` (new `src/commands/settings.ts`). All go through `openChange` (`src/lib/open-change.ts`).
- **Consumers:**
  - People at a terminal (text output and the TTY menu).
  - Guided skills: `weave-new` and `weave-next` read `--json`; `weave-fix` passes `--no-open`.
  - Scripts and CI (text or JSON, no TTY).
- **External integrations:** herdr (`herdr-app do`), tmux, iTerm and Terminal (`osascript`), VS Code, Cursor, Claude desktop, T3 Code, and the agent CLIs. None of them are Weave dependencies.

## Contract Shape

### Flags

| Command | New flags |
| --- | --- |
| `change new <title>` | `--skill <name>`, `--context <text>`, `--open <place>[:<agent>]`, `--no-open` |
| `change switch <change>` | same as `new` |
| `change open [<change>]` | `--in <place>` (incl. `none`), `--agent <agent>`, `--skill`, `--context`, `--remember`, `--project`, `--choices`, `--json` |
| `settings open` | `--in <place>`, `--agent <agent>`, `--clear`, `--project`, `--json`. With no `--in`/`--clear` and `canPrompt`, it shows the menu. With `--in`/`--clear` it saves or removes the default (or the `--project` override) without a TTY and **never opens anything**. With `--json` alone it lists the current settings and choices |

- **Where flags apply:** `--open`, `--no-open`, `--skill`, and `--context` are ignored in in-place mode, which has no folder to open.
- **One-off choices:** `--open` on `new` or `switch` is never saved.
- **What `--remember` and `--project` save:** `--remember` saves the personal default, and `--project` saves an override for the current main checkout. A person at the TTY menu or an agent passing on the menu answer uses them; one-off instructions do not. `--in none --remember` records "don't open, don't ask again".
- **`change open` with no `<change>`:** uses the current change.
- **Folder missing:** if the change's folder does not exist, `change open` returns error code `folder_missing` ("Run `weave change switch <id>` to recreate it"). It never fetches or touches worktrees.
- **Running at a TTY:** `change open` without `--in` uses the saved choice. With no saved choice it shows the menu only when `canPrompt`, otherwise it returns `needs_choice`.
- **When the menu can show (`canPrompt`):** text output (no `--json`), stdin and stdout are both TTYs, and none of `CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`, `CODEX_SANDBOX`/`CODEX_THREAD_ID`, or `WEAVE_NO_PROMPT` is set. `--json` never shows a menu.
- **Explicit `--in` from inside the folder:** an explicit `--in` (or `--open`) skips the inside-folder check and bring-forward, so "open it in Cursor instead" works from inside the change folder.
- **`--choices`:** prints `choices` without opening anything.
- **Validate before creating:** `new` and `switch` validate every open flag (`unknown_place`, `unknown_agent`, `agent_not_for_app`) before calling `createChange` or `openChangeFolder`, so a bad flag fails before anything is created.
- **Stored step:** `--skill`/`--context` on `new` also store the composed step in the change's `status.yml` (`schema.md`). On `open` or `switch` they replace it.

### Environment switches

- **`WEAVE_NO_OPEN=1`:** every opening outcome is `not_attempted` with reason `disabled`. Used by the global test setup and available to people.
- **`WEAVE_NO_PROMPT=1`:** never show the menu, and return `needs_choice` instead.

### JSON (additive)

Added to `ChangeOperationResult` (new) and `SwitchChangeResult` (switch), and returned by `change open`:

```jsonc
{
  "folder": "/abs/path/to/change-folder",
  "next_step": "use the weave-explore skill for change 261109-479a-open-worktree-when-created: <context>",
  "open": {
    "status": "opened" | "brought_forward" | "skipped" | "failed" | "not_attempted" | "needs_choice",
    "place": "herdr",             // when a place was involved
    "agent": "claude",            // terminals only; "shell" for a plain shell
    "where": "a new herdr tab named \"261109-479a\"",
    "draft": "unsent" | "shown",  // shown = next_step must be typed/pasted by the person
    "used_default": true,         // true when a saved default/override was used
    "saved": "default" | "project" | null,   // what this call wrote to settings
    "reason": "disabled" | "in_place" | "already_inside" | "no_open_flag" | "dont_ask" | "no_choice"
            | "unknown_saved_value" | "ssh" | "no_display" | "unavailable_now" | "default_missing"
            | "agent_not_found" | "open_failed" | "timeout",
    "detail": "T3 Code is not running",       // one human line for skipped/failed
    "choices": [                               // needs_choice only (and --choices)
      { "place": "herdr", "kind": "terminal", "label": "herdr tab",
        "agents": [ { "id": "claude", "label": "Claude" }, { "id": "pi", "label": "pi", "own": true },
                    { "id": "shell", "label": "Just a shell" } ] },
      { "place": "t3code", "kind": "app", "label": "T3 Code", "hint": "must be running" },
      { "place": "none", "kind": "none", "label": "Don't open" }
    ]
  }
}
```

- In in-place mode `open` is `{ "status": "not_attempted", "reason": "in_place" }`, and `folder` is absent, as today.
- `default_missing` comes with `needs_choice`, or with the TTY menu having been shown. The saved entry has already been cleared.

### Text output (worktree mode)

`formatWorktreeLines` and the library `message` are unchanged, so `createChange` and `openChangeFolder` callers see exactly today's text.

The command layer then assembles the output:
- **Line replacement:** it replaces the single `Open <folder> in a new session to work on this change.` line **in its existing position**, in both the printed text and the JSON `message`, and only when the outcome is something other than `not_attempted`/`needs_choice` (or `already_inside`, or a `--skill`-given step). Any `Slot changed` / `Setup reset` lines stay where they are, after it.
- **Menu order:** when the menu is shown, the summary is printed first, then the menu, then the outcome lines.

The replacement lines for each outcome:

| Outcome | Final lines |
| --- | --- |
| `not_attempted` (no choice, `--no-open`, `dont_ask`) / `needs_choice` | `Open <folder> in a new session to work on this change.` (today's line, unchanged) plus `Next step there: <next_step>` only when `--skill` was given |
| `not_attempted` (`already_inside`) | `Next step: <next_step>` |
| `opened` | `Opened in <where>, continue there.` / `Next step: <next_step>` (`(filled in, not sent)` when the draft is `unsent`) / `If it didn't start: open <folder> and run the step there.` / when `used_default`: `Change where changes open: weave settings open` |
| `brought_forward` | `Brought forward <where>.` / `Next step: <next_step>` |
| `skipped` / `failed` | `Didn't open: <detail>.` / `Open <folder> in a new session and run: <next_step>` |

- Script compatibility: with no saved choice and no TTY, the text output is byte-for-byte today's.

### Exit codes and errors
- An opening outcome never changes the exit code or the create or switch result. `openChange` catches every error from `check()` and `open()`.
- New error codes come only from argument validation, in the existing `runAction` JSON error shape:
  - `unknown_place`, `unknown_agent`, and `agent_not_for_app` (an agent given with an app place)
  - `folder_missing` (`change open` only)
  - `invalid_settings` (unreadable `settings.yml`). For `new` and `switch` this is downgraded to `open.status: "failed"`, `detail: "settings.yml could not be read"`, so a broken settings file never blocks a create.

## Versioning And Compatibility
- JSON changes are additive. Existing fields are unchanged.
- Text output changes only when opening happened or was attempted with a saved choice.
- **Older skills, newer CLI:** older installed skills call `change new` in text mode. With no default they see today's output. With a default the change opens and their "open the folder" advice is redundant. Weave's existing out-of-date skill notice prompts an update.
- **Newer skills, older CLI:** skills are committed to the project, while the CLI may be an older global install. If `change new`/`switch` fails with commander's unknown-option error, `weave-new`, `weave-next`, and `weave-fix` re-run without `--skill`, `--context`, and `--no-open`, then use today's "open the folder in a new session" guidance.
- **Several Weave versions on one machine sharing `settings.yml`:** a saved place or agent this version doesn't recognise → `not_attempted` (`unknown_saved_value`, "update Weave"). No menu is shown and the entry is never overwritten (`schema.md`).
- There is no feature flag and no migration. `settings.yml` is created on first save.
- `weave advance` flags, `.weave/workspace.yml` `advance.*`, and `findTerminalOpener` are unchanged (`261109-bv3c`).

## Authorization And Validation
- **Who decides:** only the person decides. Agents pass `--remember` or `--project` only when passing on the person's menu answer, and the skills say so explicitly.
- **Allowed names:** `--in` and `--agent` must be listed ids, or agent names from the person's own `settings.yml`.
- **`--context`:** control characters are stripped and it is capped at 500 characters. It is passed only as one argv element or JSON field and never put into a shell line unquoted.
- **The folder:** passed as an argv element. In the AppleScript-wrapped iTerm and Terminal lines it is quoted with `shellQuote` and then escaped as an AppleScript string.
- **No permission or setup changes:**
  - Opening never runs `change setup` and never approves setup commands.
  - It never passes permission or bypass flags to agents: no `--permission-mode` and no `--dangerously-*`.
- **SSH (`SSH_CONNECTION` or `SSH_TTY` set):** every app place, plus iTerm and Terminal, has `remoteOk: false` on all platforms → `skipped`, with reason `ssh`. Only herdr and tmux open over SSH.
- **Linux with no display:** an app place with neither `DISPLAY` nor `WAYLAND_DISPLAY` set → `skipped`, with reason `no_display`.
- **Time limits:** each `check()` has 2 s and each `open()` 10 s. Exceeding either → `failed` (`timeout`). On macOS the reason line suggests checking System Settings › Privacy › Automation. App processes are spawned detached and unref'd, so Weave waits only for the launcher command to return.

## Observability And Testing
- **Observability:** there is no telemetry. Every outcome is reported in the calling session, through `open.status`, `reason`, and `detail`. An opening failure prints one line and never a stack trace. `WEAVE_DEBUG`-style tracing is out of scope.
- **Contract tests:**
  - A JSON snapshot for each `open.status`.
  - Text fixtures checking that the no-default, no-TTY output is identical to today's.
  - `change open` with `folder_missing`.
  - Argument validation errors.
  - Hostile `--context` and folder names (quotes, `$(…)`, spaces) produce argv with no shell evaluation.
- **Fixtures:** a recording registry (in the same pattern as `AdvanceOptions.terminalOpeners`) and a temporary `WEAVE_USER_HOME`. A global vitest setup file sets `WEAVE_NO_OPEN=1` and a temporary `WEAVE_USER_HOME` for every test, so no test can reach a real opener or a developer's real settings. Tests that exercise opening clear `WEAVE_NO_OPEN` and inject the recording registry.
- **More contract tests:**
  - text output with no default and no TTY is identical to today's for switch with `Slot changed` lines
  - `--json` never prompts
  - each agent marker suppresses the menu
  - invalid open flags fail before a change is created
  - the "Open …" line is replaced in place
