# Planning commits when progress is recorded

## Outcome

Recording progress on any lane commits the change's planning work on the change branch, with a catch-up commit for leftovers, all hooks disabled, the person's identity, and a checkpoint outcome in the command result.

## User flow

1. A skill writes `prd.md` and runs `weave change progress prd --summary "…"`.
2. Weave writes `status.yml`, commits leftover planning files with `git commit --only`, then commits the PRD and status.
3. The JSON result carries `checkpoint` (committed/skipped/failed + reason); text output adds one line.

## In scope

- `src/lib/checkpoints.ts`: git runner (env untouched, `GIT_TERMINAL_PROMPT=0`, SIGTERM timeout), branch guard, planning scope, ownership table, catch-up, moment commit with `core.hooksPath` set to an empty dir, message + trailers, outcome object.
- Settings resolution limited to project `commits.enabled` (main checkout and change folder) for now.
- Wiring into `progressChange` and `weave change progress` with `--summary` and `--commit-message`.

## Out of scope

- Verdict, clear-stale, knowledge, review triggers (slice 02).
- Personal switch, per-change skip, notice, unattended marker (slice 03).
- Code commits (slices 04–05).

## Acceptance criteria

- [ ] `weave change progress <lane>` commits owned paths plus status on the change branch and returns `checkpoint`.
- [ ] Leftover planning files go into a separate catch-up commit made with `--only`; staged edits stay for the moment commit.
- [ ] Planning commits run no hooks (including `prepare-commit-msg`/`post-commit`).
- [ ] Wrong branch, detached HEAD, operations in progress, and empty commits are skipped with reasons; status is always written.
- [ ] Author is the configured git identity; missing identity gives `failed: identity_missing`.
- [ ] Existing tests stay green.
