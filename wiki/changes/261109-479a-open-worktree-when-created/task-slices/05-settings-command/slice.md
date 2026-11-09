# weave settings open

## Outcome

A person or agent can view, change, or clear where changes open, without opening anything:
- **At a terminal:** `weave settings open` shows the same two-step menu.
- **From chat:** an agent runs `weave settings open --in cursor --project --json` or `--clear`, with no TTY needed.

## User flow

1. At a terminal, `weave settings open` shows the menu with the current default marked. The answer replaces the default.
2. In chat, "in this project, open changes in Cursor" leads the agent to run `weave settings open --in cursor --project --json`. Weave saves the override and reports it, and nothing opens.
3. "Stop opening changes" leads to `weave settings open --in none --json` (don't ask again). "Ask me again" leads to `weave settings open --clear --json`.
4. `weave settings open --json` alone lists the current default, overrides for this project, own agents, and the available choices.

## In scope

- `src/commands/settings.ts` with the `settings open` subcommand, registered in `src/cli.ts`.
- Flags `--in`, `--agent`, `--clear`, `--project`, `--json`, with the same validation as `change open`.
- Reusing the menu and `canPrompt` from slice 01.

## Out of scope

- Editing own agents or locations through the command (hand edits only).

## Acceptance criteria

- [ ] `settings open --in X [--agent Y] [--project]` saves without a TTY and never calls any opener.
- [ ] `--clear [--project]` removes only that entry.
- [ ] `--in none` saves `{place: none, ask: false}`.
- [ ] With no flags and `canPrompt`, the menu shows. With no flags and no prompt (or `--json`), it lists the current settings and choices.
- [ ] Invalid ids give argument errors and leave settings unchanged.
