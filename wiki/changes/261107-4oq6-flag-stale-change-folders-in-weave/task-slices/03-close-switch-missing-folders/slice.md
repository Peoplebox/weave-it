# Close and switch for missing folders

## Outcome

Every next step that `weave change list` offers for a missing folder works. `close` clears only this change's leftovers, and `switch` recreates the folder from committed work, even after a move. `weave status` counts update right away.

## User flow

1. A developer deletes a change folder by hand, and `list` shows `folder missing` with `next: weave change close <id>`.
2. They run `close`. Git's and Weave's records are cleared, the slot is freed, the branch and `bases/` are kept, and a moved-folder warning appears. Afterwards the branch can be deleted or checked out.
3. Alternatively, they run `switch <id>`. The folder is recreated, keeping its slot if free, setup is reset, and moved folders are handled.

## In scope

- `close`:
  - `git worktree remove` for this change's entries only, nested repos first, never `prune`
  - refusals: `changes_unavailable`, `worktree_locked`, uncommitted files in an existing folder, landed with uncommitted files
  - the warning
  - keeping `bases/`
  - recomputing `attention.json`
- `switch`:
  - `remove_stale_entry` as a planned action, applied after every repo passes
  - any unlocked prunable entry at any path
  - slot re-check
  - `slot_changed` and `setup_reset` outputs
  - `repos` written to `changes/<id>.yml`
  - recomputing `attention.json`
- `change status <id>` and opening a folder: "folder missing; run `weave change list`".

## Out of scope

- Deleting branches (`261107-6c16`).
- Refresh (slice 04).

## Acceptance criteria

- [ ] PRD Acceptance Criteria for `close` on folder missing, `close` refusing kept-on-purpose, `switch` recreating, slot keep-or-reassign, setup reset, and "nothing is cleaned up without an explicit close" all hold.
- [ ] Every `next.commands` entry that slices 02 and 03 emit for missing-folder and closed states succeeds when run in tests.
- [ ] A blocked second repo during `switch` leaves the first repo's entry untouched.
