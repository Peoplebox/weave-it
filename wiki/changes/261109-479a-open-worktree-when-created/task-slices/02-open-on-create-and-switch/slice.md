# Open on change new and change switch

## Outcome

`weave change new` and `weave change switch` open the change folder through `openChange` after they succeed. They accept a one-off choice (`--open`, `--no-open`) and a first step (`--skill`, `--context`). The first step is stored in the change's `status.yml`, so later opens reuse it. Switching from inside the folder opens nothing, and a tmux pane already in the folder is brought forward. With no default and no prompt, output is byte-for-byte today's.

## User flow

1. With a saved `tmux:claude` default, `weave change new "Add export" --skill weave-explore --context "CSV export for reports"` creates the change. The summary prints, then `Opened in tmux window …, continue there.`, the next step `use the weave-explore skill for change <id>: CSV export for reports`, and the fallback lines.
2. Later, `weave change switch add-export` from another folder finds the tmux pane already in the folder and brings it forward.
3. From inside the change folder, `weave change switch add-export` opens nothing and shows the next step.
4. A script with no default runs `weave change new "X"` and sees exactly today's output.

## In scope

- Flags on `new`/`switch`: `--open <place>[:<agent>]`, `--no-open`, `--skill`, `--context`, all validated before `createChange`/`openChangeFolder`.
- Stored `next_step: { text, stage }` in `status.yml`, written by `new --skill`, replaced by `open`/`switch --skill/--context`, and used while the stage matches.
- `composeNextStep` with context sanitising (control characters stripped, 500-character cap).
- Resolution step 2 (inside the folder, skipped by an explicit `--in`/`--open`) and step 4 (tmux bring-forward after a non-`none` choice, with `switch-client`).
- Output assembly: library `message` unchanged; the command layer replaces the `Open <folder>…` line in place (text and JSON `message`); summary printed before the menu.
- `next_step` and `open` fields on `ChangeOperationResult` and `SwitchChangeResult`.
- `change open` also gains `--skill`/`--context`.

## Out of scope

- New places or agents (slices 03, 04).
- Skill updates (slice 06).
- herdr bring-forward (slice 07).

## Acceptance criteria

- [ ] With no saved choice and no TTY, `change new` and `change switch` text output is byte-for-byte today's, including switch with `Slot changed`/`Setup reset` lines, and `--json` has `open.status: "needs_choice"`.
- [ ] With a saved default, the `Open <folder>…` line is replaced in place by the outcome lines, in text and in the JSON `message`.
- [ ] `--open cursor:claude` (app with agent) or `--open nope` fails before any change is created.
- [ ] `--no-open` gives `not_attempted` (`no_open_flag`) and today's output.
- [ ] `new --skill weave-questions --context …` stores the step. `change open` right after reuses it. After the stage changes, the `weave-next` fallback is used.
- [ ] Inside the folder → `already_inside`, unless `--open`/`--in` is given.
- [ ] Bring-forward never runs for `needs_choice`, `dont_ask`, `--no-open`, or an explicit `--in`, and uses `switch-client` across sessions.
- [ ] In-place checkouts are unchanged.
