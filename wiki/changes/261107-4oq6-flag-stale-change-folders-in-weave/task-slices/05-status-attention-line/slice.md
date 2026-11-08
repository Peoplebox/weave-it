# Attention line in weave status

## Outcome

`weave status` shows one line when changes need attention, using the last known snapshot. It never calls git or the network.

## User flow

1. A developer runs `weave status` anywhere in a worktree-mode repo and sees `2 changes need attention (1 landed, 1 folder missing). Run 'weave change list'.`
2. With nothing to report, or before any list has run, no line appears.

## In scope

- Resolving the main checkout from cwd, then reading `<git-common-dir>/weave/attention.json`.
- The text line before `Notices`, with zero counts omitted.
- `changes_attention` in `--json` (`null` without a snapshot or outside worktree mode).

## Out of scope

- Computing states (slices 02, 03, and 04 write the snapshot).

## Acceptance criteria

- [ ] PRD `weave status` Acceptance Criteria hold: exact wording and counts, only landed and folder missing counted, the same output from the main checkout, change folders, and subfolders, no remote contact, and the `--json` count.
