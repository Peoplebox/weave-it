# Contracts: weave change open with saved settings

See `architecture/api-contract.md` and `architecture/schema.md` for the full contract. This slice implements this subset.

## Interfaces

- `weave change open [<change>] [--in <place>] [--agent <agent>] [--remember | --project] [--choices] [--json]`
  - `<change>` defaults to the current change. Places: `herdr`, `tmux`, `none`. Agents: `claude`, `shell`.
- Library:
  - `openChange(ctx: OpenContext): Promise<OpenOutcome>`. It never throws for opening failures.
  - `loadUserSettings(env)`, `saveOpenChoice(env, scope, choice)`, `resolveSavedChoice(settings, mainRoot)`.
  - `registry: { places: Place[]; agents: AgentEntry[] }`, injectable through `OpenContext`.
  - `canPrompt({ json, env, stdin, stdout })`.

## Data

- `~/.weave/settings.yml` `version: 1`, with `open.default`, `open.projects[<main checkout realpath>]`, `agents`, and `locations` (shape in `schema.md`). Unknown keys are preserved on write.
- JSON: `next_step`, `folder`, and `open: { status, place?, agent?, where?, draft, used_default, saved, reason?, detail?, choices? }`.

## State

- Resolution order (this slice): disabled/in-place → explicit `--in` → saved choice (dont_ask / unknown_saved_value / missing → clear) → no choice (menu or `needs_choice`) → open (unavailable_now → skipped; agent not found → failed; open error or timeout → failed).
- Settings are written only on a menu answer of "make it my default" (or "don't ask again"), `--remember`, `--project`, or clearing a definitely-gone entry. "Just this once" saves nothing.

## Validation and errors

- Argument errors (`unknown_place`, `unknown_agent`, `agent_not_for_app`, `folder_missing`) use the existing `runAction` JSON error shape and exit 1.
- Opening outcomes never change the exit code.
- An unreadable `settings.yml` → `failed` ("settings.yml could not be read"), and the file is not rewritten.

## Files and artifacts

- New: `src/lib/user-settings.ts`, `src/lib/open-places.ts`, `src/lib/open-change.ts`, `vitest.config.ts`, `tests/setup/no-open.ts`, `tests/user-settings.test.ts`, `tests/open-places.test.ts`, `tests/open-change.test.ts`, `tests/cli-change-open.test.ts`.
- Modified: `src/commands/change.ts` (the `open` subcommand), `src/lib/terminal-launch.ts` (export `shellQuote` and the AppleScript helper only).
