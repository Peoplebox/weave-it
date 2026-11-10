# Contracts: Review switches, status lines, and the reviews-available notice

See `architecture/index.md` (Visibility, Switches and settings), `architecture/api-contract.md` (`weave review skip`, Status and notices), and PRD § Notifications and Visibility.

## Interfaces

- `weave review skip --reason <text> [--json]` → `{status: "ok", skipped: {reason, at}}`. `weave review unskip [--json]` → `{status: "ok", skipped: null}`.
- `weave change status [--json]`: when the change has a `review` block or review is active, add text lines after the stress-test lines:
  - `Review: slice 02 reviewed (1 ruling) · slice 03 waiting on you: plan problem · slice 04 reviewed, out of date (code changed) · final: not started`
  - `Verdict: ready with parked items (4)` (or `ready to merge`, `not ready: waiting on you`, `not ready: partial review`), with `, out of date` when the verdict is out of date
  - `Review: skipped (<reason>)` when skipped
  - JSON: `change.review = {active, skipped, slices: [{id, stored_state, effective_state, out_of_date_reasons, counts}], final: {state, verdict, out_of_date, counts, latest_run}}`
- `weave status`: one line `Review (<change id>): <same summary as above, shortened>` when the current folder resolves an active change with review data; JSON `review` with the same object or `null`.
- `src/lib/notices.ts`: `NoticeKind` gains `skills_available`. Details: `{agents: {<agent>: string[]}}`. Message: `Bundled skills not installed for <agent>: <names>. Run 'weave agent install <agent>' to add them.` There is no per-skill install command today, so the message names the agent form.

## Data

- Change `status.yml` `review.skipped: {reason, at}` (written through `updateChangeReview`).
- No new fields elsewhere.

## State

- Skipped change or workspace `review.enabled: false` → every slice's effective state is `skipped`; the change state is `skipped` only for a per-change skip.
- Explicit on-demand runs (`package --force`) still work while the workspace is off (slice 04 behaviour).

## Validation and errors

- `skip` without `--reason` → `missing_reason` (same code as `weave change verdict ... waived`).
- `unskip` on a change that is not skipped → `status: "ok"`, no write.
- Status reads must not fail when review files are malformed: show `review: unreadable` and continue.

## Files and artifacts

- New: `tests/cli-review-skip.test.ts`, `tests/cli-change-status-review.test.ts`.
- Modified: `src/commands/review.ts` (`skip`, `unskip`), `src/lib/review/rules.ts` or `src/lib/review/state.ts` (skipped overlay, if not already covered), `src/lib/changes.ts` (status text and JSON), `src/lib/status.ts` (review line and JSON), `src/lib/notices.ts`, `tests/notices.test.ts`, `tests/cli-status.test.ts`.
