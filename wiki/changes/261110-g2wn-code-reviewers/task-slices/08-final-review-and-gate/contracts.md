# Contracts: Final review gate, change package, and the change verdict

See `architecture/index.md` (Final review, On demand, Shared rules: Verdict and File ownership), `architecture/schema.md` (Change `review:` block, Readable records, Refs), and `architecture/api-contract.md` (`weave review gate`, `weave review package --change`, `record --finalize`, `final_only`).

## Interfaces

- `weave review gate --change [--json]` → `{status: "ok", pass: boolean, blocking: [{slice, effective_state, reasons}]}`. Exit 0 whether or not it passes; `pass` carries the answer.
- `weave review package --change [--partial] [--force] [--out <path>] [--json]` → the slice package shape with `scope: {kind: "change"}`, `run_id: "change/f<N>"`, `model_level: "most_capable"`.
- Final fix batch, reusing slice 06 commands with round 1 only:
  - `weave review snapshot --run change/f<N> --at round-start --round 1` → `refs/weave/reviews/<change>/_change/f<N>/fix-start`
  - `weave review package --run change/f<N> --fix-round 1` → `fix-end` ref and `wiki/changes/<id>/review/f<N>-fix.patch`
- `weave review record --run change/f<N> ...`: same options as slice runs. A change report may carry `final_only.minor_sort` with fully scoped finding ids from slice runs.
- `src/lib/review/gate.ts`: `evaluateGate(ctx): Promise<GateResult>`.

## Data

- Refs: `refs/weave/reviews/<change>/_change/f<N>/{end,fix-start,fix-end}` per change repo.
- Files: `wiki/changes/<id>/review.md`, `wiki/changes/<id>/review/f<N>.report.md`, `f<N>.findings.json`, `f<N>-fix.patch`, `f<N>-fix.check.md`.
- Change `status.yml` `review:`: `state` (`not_started | in_progress | ready_to_merge | ready_with_parked_items | not_ready | skipped`), `adopted_at`, `latest_run`, `fingerprint`, `counts {open_rulings, parked_items, plan_problems_open}`, `partial`, `updated_at`.
- `minor_sort` results are stored on the referenced slice findings as `final_sort: must_fix | can_wait` in the change run's findings file (slice files are not rewritten).
- Change `review.md`: verdict line, runs newest first (sections as in slice records), then "All rulings": every ruling from every slice run and the change run with reasoning, cost if wrong, and reopened flag.

## State

- `package --change` sets the change `review.state: in_progress`. It is `partial: true` when the gate fails (requires `--partial`, otherwise `gate_failed`), a repo is missing, or the base is unknown.
- Verdict inputs: open plan findings in any run, `partial`, Critical rulings with `agreed: true`, can-wait Minors, `agreed: false` rulings, outstanding human checks, any other open finding.
- Finalize takes ownership: every covered file leaves all slice fingerprints (`releaseOwnership`) and enters the change fingerprint, computed after the fix batch.
- Change out-of-date uses the same code and plan comparisons as slices, over the change fingerprint.

## Validation and errors

- `gate_failed` (without `--partial`), `change_review_skipped`, `review_disabled` (without `--force`), `base_unknown` (warning, partial), `round_limit` (a second fix round on a change run): exit 1 unless noted.
- `minor_sort` entries naming unknown or non-Minor findings → `report_invalid` (exit 4).

## Files and artifacts

- New: `src/lib/review/gate.ts`, `tests/review-gate.test.ts`, `tests/cli-review-change.test.ts`.
- Modified: `src/commands/review.ts` (`gate`, `package --change`), `src/lib/review/package.ts` (change package), `src/lib/review/record.ts` (change runs, `minor_sort`, verdict, change `review.md`), `src/lib/review/fingerprint.ts` (change fingerprint and out-of-date), `src/lib/review/state.ts` (change block helpers if missing).
