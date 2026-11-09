---
facet: schema
description: Data model, persistence, and migration design.
---

# Personal Settings And Stored Next Step Schema

## Location
- `~/.weave/settings.yml`, found through `getUserWeaveDir(env)` (`src/lib/user-paths.ts`), so `WEAVE_USER_HOME` redirects it in tests.
- Owned by the new `src/lib/user-settings.ts`. No other module reads or writes the file.
- Personal to the person and their machine. It is never written into the project, `.weave/`, or `.git/weave/` (`261109-a8k5`).
- The change's stored next step lives in the change's own `status.yml` (see below), because it describes the change, not the person.

## Shape

```yaml
version: 1
open:
  default:                      # personal default; absent = unset
    place: herdr                # listed place id, or "none"
    agent: claude               # terminals only: listed agent id, own agent name, or "shell"
    ask: false                  # only with place: none -> "don't open, don't ask again"
  projects:                     # per-project overrides, same value shape as default
    /Users/arpit/personal/weave-it:
      place: cursor
agents:                         # the person's own agents (terminal step two)
  pi:
    command: "pi"               # shell line, run as /bin/sh -c; no check, no draft
    label: "pi"                 # optional
locations:                      # extra absolute install paths for listed tools only
  cursor: /opt/Cursor.app/Contents/Resources/app/bin/cursor
```

- **Project keys:** absolute, realpath-normalised main checkout paths, from `workspaceLayout(root).mainRoot` (`src/lib/worktrees.ts:461-464`). The same key results whether the command runs in the main checkout or in any change folder.
- **`place: none` without `ask: false`:** never written. A plain "don't open" leaves the entry unset, so the menu shows again next time.

## Validation
- **Unknown `version` (newer):** treated as `unknown_saved_value`. Opening reports `not_attempted` ("update Weave"), no menu is shown, and the file is never written.
- **A place or agent this Weave version doesn't recognise** in `default` or `projects`: `unknown_saved_value`. Opening reports `not_attempted`, no menu is shown, and **that entry is never written or cleared**. This protects a default saved by a newer Weave on the same machine.
- **Unknown ids in `locations`:** ignored with a warning, never removed. Personal settings cannot add places.
- **`agent` with an app place:** ignored.
- **Unknown top-level keys and unknown fields:** preserved on write.
- **Unreadable YAML:** opening reports `failed` (`settings.yml could not be read`). `new` and `switch` still succeed, and the file is never overwritten while it is unreadable.

## Precedence
1. Per-change flags (`--no-open`, `--open`, `--in`). An explicit `--in`/`--open` also skips the inside-folder check and bring-forward.
2. `open.projects[<main checkout>]`.
3. `open.default`.
4. Unset: the menu when `canPrompt`, otherwise `needs_choice`.

Bring-forward (tmux) runs only after step 2 or 3 resolves to a non-`none` place, or after the menu or chat answer. It never runs for `needs_choice`, `dont_ask`, or `--no-open`.

## Clearing a saved default
- **Cleared only when it is definitely gone:**
  - the place is recognised and its `check()` finds the tool at **none of its absolute install locations** (the registry's known paths plus `locations.<id>`), or
  - the saved `agent` is a recognised format, but is neither a listed agent, nor a key in `agents:`, nor `shell`. For example, an own agent that was removed.
- **PATH is never proof of absence.** PATH is used only to find tools. A tool that has no absolute path to check (such as tmux) and isn't found reports `unavailable_now`.
- **A listed agent that can't be found**, while its place is found, gives a `failed` run, and the default is kept.
- **Only the resolved entry is cleared** (the project override or the default). The other is left alone.

## How the file changes
- **When it is written:**
  - a menu answer, or `--remember` / `--project`
  - `weave settings open --in … | --clear [--project]` (no TTY needed)
  - clearing a definitely-gone entry
- **How it is written:** read, modify, then `writeFileAtomic` (`src/lib/files.ts`). If two Weave processes write at once, the last one wins, which is acceptable for a personal file. No lock.
- **Edits by hand:** read on every command, with no cache.

## Stored next step (`status.yml`)

```yaml
next_step:
  text: "use the weave-explore skill for change 261109-479a-open-worktree-when-created: <context>"
  stage: exploration            # the change's stage when the step was stored
```

- **Written by:** `change new --skill …`, or `open`/`switch` given `--skill`/`--context`, which replace it.
- **Used by `open` and `switch`:** used while the change's `stage` still equals `next_step.stage`. After that they use `use the weave-next skill for change <id>`. A stale entry is left in place and simply ignored.
- **Readers that don't know the field:** older Weave versions ignore unknown `status.yml` keys, so they are unaffected.
- **Shared with the change:** this is part of the committed change folder, so teammates who switch to the change see the same draft while it still applies. That is intended, because it describes the change, not the person.

## Migration And Existing Data
- No migration or backfill. There is no previous preference store, and `next_step` is optional.
- `.weave/workspace.yml` `advance.*` is untouched and never read for opening (`261109-bv3c`).
- `~/.cache/weave/current-session.yml` and `.git/weave/` are untouched.

## Testing
- Round-trip parse and write, keeping unknown keys.
- Each validation rule.
- Unrecognised values never written or cleared.
- Precedence across flags, project override, and default.
- Clearing only on absolute-path absence or an unknown agent name, never on PATH misses, a missing agent, a timeout, or `unavailable_now`.
- `--clear [--project]`.
- A key resolved from a change folder equals the key resolved from the main checkout.
- The stored `next_step` is used, then ignored after a stage change.
