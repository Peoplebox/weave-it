# Change states in weave change list

## Outcome

In worktree mode, `weave change list` gives every change one state, labels, and a runnable next step, in text and `--json`, from live local facts, plus whatever remote refs already exist locally. Past changes move behind `--all`. In-place mode is unchanged.

## User flow

1. A developer runs `weave change list` from the main checkout, a change folder, or any subfolder, and sees the same list.
2. Each change shows today's first line, then a state line, a `next:` line, and the folder line.
3. An agent runs `weave change list --json` and matches on `state.id`.

## In scope

- `change-facts.ts`:
  - root resolution through `mainWorktreePath`
  - discovery, including the branch-counting rule (C3)
  - the repo set (C9)
  - worktree `prunable`/`locked` parsing, with the `<2.31` file fallback
  - path existence and uncommitted counts
  - changes-root unavailable versus deleted (C8)
  - reading titles from the branch
- `change-states.ts` (pure): every state in api-contract.md, including `folder_missing`, `folder_missing_kept`, `folder_unavailable`, the closed states, and `done`; precedence, multi-repo combination, notes, labels (except `may_have_landed` and `local_view_older`, which come from slice 04 data), and `next`.
- List wiring and rendering: the text layout, the additive JSON, `--all`, `active` and `targets[].path` unchanged, the blanking rules, the git < 2.38 line, and the 2 s inline landed budget with "still checking".
- `changes/<id>.yml` optional `repos` field, written at create.
- `attention.json` write with `facts_at`, under the state lock.
- The worktree-mode gate in `src/commands/change.ts`.

## Out of scope

- `close` and `switch` behaviour changes (slice 03).
- Fetching, the age line, and `--fetch` (slice 04). The age line is omitted until slice 04.
- The `weave status` line (slice 05).

## Acceptance criteria

- [ ] PRD Acceptance Criteria on scope, one state per change, identical text and JSON, the first line, `--all`, closed and done, ignoring non-Weave branches, uncommitted files, folder missing, kept on purpose, unavailable root, and JSON compatibility all hold, for local facts.
- [ ] A hand-deleted `<repo>.changes` (parent present) shows `folder_missing`, not unavailable.
- [ ] A `--repo` subset change is not `folder_missing` for repos it never had.
- [ ] Closed changes without a committed `status.yml` offer the `git worktree add` hint, not `switch`.
- [ ] In-place mode output is byte-identical to today.
