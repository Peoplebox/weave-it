# Contracts: Open on change new and change switch

## Interfaces

- `weave change new <title> [--skill <name>] [--context <text>] [--open <place>[:<agent>]] [--no-open] …existing flags`
- `weave change switch <change> [--skill] [--context] [--open …] [--no-open] [--json]`
- `weave change open … [--skill] [--context]` (extends slice 01)
- `composeNextStep(changeId, skill?, context?) => string`

## Data

- Change `status.yml` gains an optional `next_step: { text: string, stage: Stage }`. Older readers ignore it.
- `ChangeOperationResult` and `SwitchChangeResult` gain `next_step: string` and `open: OpenOutcome` (worktree mode). In-place mode gets `open: { status: "not_attempted", reason: "in_place" }`.

## State

- Which next step is used: `--skill`/`--context` on this call (and store it) → the stored step while `stage === next_step.stage` → `use the weave-next skill for change <id>`.
- Bring-forward only after a non-`none` choice resolves. `tmux list-panes -a -F '#{session_name} #{window_id} #{pane_current_path}'` → `select-window` (+ `switch-client`), with a 2 s timeout and any error continuing.
- Inside the folder: the cwd realpath is under the folder realpath, with no explicit `--in`/`--open`.

## Validation and errors

- All open flags are validated before any create or switch work: `unknown_place`, `unknown_agent`, `agent_not_for_app`.
- `--open` and `--no-open` together → a usage error.
- `--context` has control characters stripped and is capped at 500 characters.

## Files and artifacts

- Modified: `src/commands/change.ts`, `src/lib/changes.ts` (result types, `writeChangeFiles` `next_step`, status read/write), `src/lib/open-change.ts`.
- Tests: `tests/cli-change-open-on-create.test.ts` (new), `tests/open-change.test.ts` (extend), `tests/worktrees.test.ts` (no changes expected; must stay green).
