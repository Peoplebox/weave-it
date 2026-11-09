---
artifact: architecture
capture_mode: stress-test
captured_at: 2026-11-09T16:24:09.000Z
---

# Stress Test: Architecture - 2026-11-09

## Challenges

### C1 — blocking — Unowned assumption / failure mode
- Challenge: Clearing a saved default on `missing` depends on PATH, so a cron job, a GUI-launched agent, or a short PATH could wipe a default whose tool is installed. A missing agent with a found place, and an unknown agent name, were undefined.
- Answer: PATH only finds tools and never proves they are gone. A default is cleared only when the tool is absent from its absolute install locations (registry paths plus `locations.<id>`), or when the saved agent name is unknown. A tool with no absolute paths to check that is not found reports `unavailable_now`. A missing agent with a found place reports `failed`, and the default is kept.
- Outcome: decided

### C2 — blocking — Contract gap (TTY detection)
- Challenge: Agent shell tools that run commands under a pseudo-terminal would make `change new` wait on a menu the agent can't answer. The shape didn't say how `--json` affects the menu.
- Answer: `--json`, a known agent marker (`CLAUDECODE`, `CURSOR_AGENT`, `OPENCODE`, `CODEX_*`), or `WEAVE_NO_PROMPT=1` each turn the menu off and return `needs_choice` (text output: today's message). The menu shows only for text output at a real TTY. The user confirmed the intended flow: the agent gets the options, asks in chat, and passes the answer back.
- Outcome: decided

### C3 — major — Contract gap (next step lost on first run)
- Challenge: `--skill`/`--context` given to `change new` are lost when the agent then calls `change open` after `needs_choice`, and on every later reopen.
- Answer: Weave stores the composed next step and the stage it was created at in the change's `status.yml`. `open` and `switch` reuse it until the stage moves on, then fall back to `weave-next`. Passing `--skill`/`--context` to `open` replaces it.
- Outcome: decided

### C4 — major — Contradiction with code / conflict with 261109-bv3c
- Challenge: The existing openers take a shell line, look up herdr on PATH again, open tmux detached (`-d`), and close the tab when the agent exits. Changing them would change `weave advance`.
- Answer (recommended and accepted): opening gets its own argv-based open functions in `open-places.ts`. They take a resolved executable path, open tmux in the foreground (with `switch-client` across sessions), and keep a login shell after the agent exits. Only `shellQuote` and the AppleScript escaping are shared. Advance's openers are untouched.
- Outcome: decided

### C5 — major — Failure modes / inner conflict
- Challenge: Only bring-forward had a timeout. `osascript` Automation prompts, a dead herdr socket, or an app CLI could block `change new`. Option C's sandbox rejection reason applies to B too.
- Answer: Each `check()` gets 2 s and each `open()` gets 10 s. A timeout reports `failed` with an Automation-permission hint, and the default is kept. App processes are detached and unref'd. The Option C rejection is reworded to consistent failure handling across callers. The numbers can be tuned during implementation.
- Outcome: decided

### C6 — major — Inner conflict (bring-forward ordering)
- Challenge: Bring-forward ran before the saved choice, so scripts inside tmux with no default, and people who chose "don't ask", would have tmux switched. `select-window` doesn't work across sessions.
- Answer: Bring-forward runs only after a non-`none` choice has resolved (saved, or answered in the menu or chat). It never runs for `needs_choice`, `dont_ask`, `--no-open`, or an explicit `--in`. It uses `switch-client` across sessions.
- Outcome: decided

### C7 — major — Contradiction with PRD (SSH, Linux display)
- Challenge: Linux apps were allowed over SSH, and a headless Linux session was unhandled.
- Answer: All app places, plus iTerm and Terminal, are skipped over SSH on every platform. On Linux, an app with no `DISPLAY` or `WAYLAND_DISPLAY` reports `unavailable_now`.
- Outcome: decided

### C8 — major — Mixed versions
- Challenge: Committed newer skills with an older global CLI fail the create on unknown flags. An older Weave reading newer settings would treat an unknown place as unset and overwrite it.
- Answer: Skills retry without the new flags when they are rejected as unknown, then use today's guidance. Any Weave that doesn't recognise a saved value reports `not_attempted` ("update Weave"), never shows the menu, and never writes that entry.
- Outcome: decided

### C9 — major — Output assembly and ordering
- Challenge: Dropping the "Open …" line changes the JSON `message`; the order of switch lines; the menu showing before the summary; flag errors after creation.
- Answer: `formatWorktreeLines` and the library `message` stay unchanged. The command layer replaces that one line in place only when opening happened. The summary prints before the menu. All open flags are validated before `createChange` and `openChangeFolder`.
- Outcome: decided

### C10 — minor — Settings from chat; explicit `--in` inside the folder
- Challenge: There was no way to change or clear the default from chat without a window opening, no way to remove a per-project override, and the inside-folder check blocked an explicit `--in`.
- Answer: `weave settings open` accepts `--in/--agent/--clear [--project]` without a TTY and never opens anything. An explicit `--in` skips the inside-folder check.
- Outcome: decided

### C11 — minor — Weak proposed decisions
- Challenge: `261107-ohne`'s stale consequence would keep being returned to agents. `mn61`'s `applies_to` was off. `a8k5`'s XDG reasoning ignored `~/.cache/weave/`.
- Answer: `mn61` supersedes `261107-ohne`, carrying over its core decision unchanged and replacing only the consequence. `mn61`'s `applies_to` covers the opening files, the skills, and ohne's paths. `a8k5`'s XDG rejection is reworded.
- Outcome: decided

### C12 — minor — Testability
- Challenge: CLI tests could read a developer's real settings and open real tabs.
- Answer: A `WEAVE_NO_OPEN=1` kill switch (`not_attempted`, reason `disabled`), plus a global vitest setup that sets it and a temporary `WEAVE_USER_HOME`.
- Outcome: decided

## Verdict

holds-with-changes — Option B stands. Detection, timeouts, ordering, output assembly, version skew, and the opener split were tightened, and `mn61` now supersedes `261107-ohne`.

## Next Resume Point

Run `weave-slices` to split the architecture into vertical slices. Each per-tool slice includes the manual checks (draft support, focus, herdr tab listing, install paths, T3 Code and Claude desktop launch mechanism, agent PTY behaviour).
