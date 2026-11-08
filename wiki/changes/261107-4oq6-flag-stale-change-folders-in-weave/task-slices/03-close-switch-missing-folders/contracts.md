# Contracts: Close and switch for missing folders

## Interfaces

- `weave change close <id> [--json]`: new refusal codes `changes_unavailable` and `worktree_locked`, and a new `warnings[]` entry. Existing fields are unchanged (`../../architecture/api-contract.md`).
- `weave change switch <id> [--json]`: new optional `slot_changed: {from, to}` and `setup_reset: [<repo>]`.

## Data

- `changes/<id>.yml`: `slot` may be rewritten, `setup.<repo>` is dropped on recreate, and `repos` is written.
- `bases/<id>.yml` is never touched by close.

## State

- **Planning.** `planTarget` emits `remove_stale_entry`; nothing mutates during planning.
- **Apply order** per repo: remove stale entry, then `add_existing`.
- **Slots.** A slot is kept unless another state file with an existing folder holds it; otherwise `nextFreeSlot`, under `withStateLock`.

## Validation and errors

- A locked entry blocks both `close` and `switch`, with the hint `git worktree unlock <path>`.
- `close` refuses when the changes root is unavailable.
