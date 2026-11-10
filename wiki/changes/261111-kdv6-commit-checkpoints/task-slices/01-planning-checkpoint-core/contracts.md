# Contracts: Planning commits when progress is recorded

Slice-level technical contracts for this vertical slice.

## Interfaces

- `planningCheckpoint(input: PlanningCheckpointInput): Promise<CheckpointOutcome>` in `src/lib/checkpoints.ts`.
- `weave change progress <lane> [--summary <text>] [--commit-message <file|->]`.
- Result field `checkpoint: CheckpointOutcome`.

## Data

- Project `.weave/workspace.yml` `commits.enabled` (default true), `commits.subject_template` (string or per-kind map).
- Trailers: `Weave-Change`, `Weave-Checkpoint`, `Weave-Stage`.

## State

- Order: status write → catch-up → moment commit.
- Never throws; outcome only.

## Validation and errors

- Reasons: `commits_off_project`, `nothing_to_commit`, `wrong_branch`, `detached_head`, `operation_in_progress`, `not_a_git_repo`, `hooks_rejected`, `index_locked`, `identity_missing`, `timeout`, `git_error`.
