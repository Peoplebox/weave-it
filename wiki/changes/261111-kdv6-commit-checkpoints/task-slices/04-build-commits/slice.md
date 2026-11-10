# Build commits when a slice finishes

## Outcome

When a slice is ready for review with new coverage, `weave slice rollup` commits its code with the project's hooks, retrying until another slice starts.

## User flow

1. The last task of slice 2 is marked done; execute runs `weave slice rollup --all --json`.
2. Weave sees slice 2 ready with no matching `Weave-Coverage` commit and commits everything except other changes' folders and coding guidelines.
3. The result lists the files; on hook failure it reports the reason and retries at the next rollup until another slice starts.

## In scope

- Coverage hash and trailer lookup; build commit per slice repo; exclusions; code timeout; `WEAVE_UNATTENDED` refusal; retry window and `leftovers_from`; flat changes skipped.

## Out of scope

- Fix commits and review boundaries (slice 05).

## Acceptance criteria

- [ ] First finish, `not_tested` readiness, and re-finish with new coverage each make one build commit; re-running rollup is idempotent.
- [ ] Other changes' `wiki/changes/<id>/` and `.weave/coding-guidelines*.md` are never staged.
- [ ] Hooks run; rejection gives `hooks_rejected` and the rollup result still succeeds.
- [ ] A failed build is retried until another slice has started; then the later build reports `leftovers_from`.
- [ ] Under `WEAVE_UNATTENDED`, rollup skips build commits with `unattended`.
