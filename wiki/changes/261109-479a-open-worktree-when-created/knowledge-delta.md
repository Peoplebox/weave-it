# Knowledge Delta

## Durable Behavior Changes

- In worktree checkouts, `weave change new` and `weave change switch` open the change folder in a place the person chose: a herdr tab or tmux window (only when working inside them), an iTerm or Terminal window (macOS), or the VS Code, Cursor, Claude desktop, or T3 Code app. Terminals start Claude, Codex, opencode, Cursor's agent (`cursor-agent` only), the person's own agent, or a shell, then keep a login shell open.
- The choice is asked once: through a terminal menu (text output at a real TTY with no agent marker) or by the calling agent in chat, from `open.status: "needs_choice"` and `open.choices` in `--json`. The person then picks "just this once" (nothing saved) or "make it my default" (saved in `~/.weave/settings.yml`, as the default or for this project, keyed by the main checkout's real path). One-off flags (`--open`, `--no-open`, `--in` without `--remember`) never change it.
- Outcomes: `opened`, `brought_forward` (a tmux pane or live herdr terminal already in the folder), `skipped` (SSH for Mac windows and apps; not inside herdr or tmux; Linux with no display), `failed` (one line, default kept; T3 Code always, with "add the folder as a project there"), `not_attempted` (in-place, inside the folder, `--no-open`, don't ask again, `WEAVE_NO_OPEN`, unrecognised saved value), and `needs_choice`. A default is cleared only when its tool is gone from every absolute install path.
- Next step: `--skill`/`--context` compose `use the <skill> skill for change <id>: <context>`, stored as `next_step` in `status.yml` until the stage moves on; otherwise `use the weave-next skill for change <id>`. Only the Claude desktop app receives it as an unsent draft (`claude://code/new?folder=…&q=…`); everywhere else it is printed.
- New commands: `weave change open [change] [--in] [--agent] [--skill] [--context] [--remember|--project] [--choices]` reopens without fetching or touching worktrees (`folder_missing` when the recorded folder is gone); `weave settings open [--in [--agent] | --clear] [--project]` sets or clears the choice and never opens anything.
- Opening never blocks or undoes the create or switch, never runs setup, and leaves output unchanged when there is no default and nobody to ask. It is independent of auto-advance (`advance.*`).
- Skills: `weave-new` picks the first skill before creating the change, passes `--skill`/`--context`, acts on `open.status`, and on `needs_choice` asks in chat (what to start only for a terminal, never for an app; then just this once or default; `--remember` only for a default). `weave-next` does the same for switching, reopening, and `weave settings open`. `weave-fix` passes `--no-open`.
- Tests: the global Vitest setup sets `WEAVE_NO_OPEN=1` and a temporary `WEAVE_USER_HOME`, so no test opens real windows or reads the developer's settings.

## Affected Knowledge Areas

- Domain `change-workflow`: new feature `opening-changes`; domain-wide `change-checkouts`, `auto-advance-launch`, `change-creation-and-stages`; feature `weave-fix`; domain index.
- Domain `cli-commands`: feature `core-command-reference` (command synopsis).

## Knowledge Files Updated

- `wiki/knowledge/domains/change-workflow/features/opening-changes/behavior.md` (new): full current-state spec for opening, personal settings, the next step, outcomes, and skill handling.
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`: condensed the Opening bullet, corrected `brought_forward` (tmux pane or herdr terminal) and drafts (Claude desktop only), added `folder_missing`, and linked the feature page.
- `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md`: links the feature page and names the only shared code (quoting helpers).
- `wiki/knowledge/domains/change-workflow/domain-wide/change-creation-and-stages.md`: `weave-new` picks the first skill before creating; `--skill`/`--context` and the stored `next_step`.
- `wiki/knowledge/domains/change-workflow/features/weave-fix/behavior.md`: `weave change new … --no-open`.
- `wiki/knowledge/domains/change-workflow/index.md`: lists `opening-changes`.
- `wiki/knowledge/domains/cli-commands/features/core-command-reference/behavior.md`: new `new`/`switch` flags, `weave change open`, `weave settings open`, source anchors.

## No-Impact Rationale

Not applicable: this change has durable behavior impact.

## Source Evidence

- `src/lib/open-change.ts` (`openChange`, `openAt`, `bringForward`, `listChoices`, `canPrompt`, `resolveNextStep`, `formatOpenLines`, `placeOpenLines`)
- `src/lib/open-places.ts` (`defaultRegistry`, `locateTool`, `claudeDesktopUrl`, each place's `check`/`open`/`bringForward`)
- `src/lib/user-settings.ts`, `src/commands/settings.ts`, `src/commands/change.ts` (`openAfter`, `open` subcommand), `src/lib/changes.ts` (`locateChange`), `src/lib/worktrees.ts` (`mainCheckoutPath`)
- `templates/skills/weave-new/SKILL.md`, `templates/skills/weave-next/SKILL.md`, `templates/skills/weave-fix/SKILL.md`; README "Where changes open"
- Tests: `tests/open-change.test.ts`, `tests/open-places.test.ts`, `tests/user-settings.test.ts`, `tests/cli-change-open.test.ts`, `tests/cli-change-open-on-create.test.ts`, `tests/cli-settings.test.ts`, `tests/setup/no-open.ts`, `vitest.config.ts`
- Decisions: `261109-mn61` (supersedes `261107-ohne`; the saving rule is "just this once or default"), `261109-a8k5`, `261109-bv3c`

## Follow-Up Knowledge Work

- QF1 (open): Cursor run from outside Cursor may open its Agents window instead of the folder. Update `opening-changes` when a different launch form lands.
- README "Where changes open" says only a tmux window is brought forward; the code also brings forward a live herdr terminal. The README needs a one-line fix (outside this knowledge update).
- If a further decision supersedes `261109-mn61` for the just-once rule, point `opening-changes` and `change-checkouts` at it.
