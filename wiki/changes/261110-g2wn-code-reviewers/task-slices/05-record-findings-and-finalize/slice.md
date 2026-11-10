# Record reviewer reports, rulings, and the finished slice review

## Outcome

A reviewer's report becomes durable, trusted review state. The agent pipes the reviewer's response into `weave review record --run 02/r1 --report -`. The CLI extracts and validates the fixed JSON block, freezes each finding's `kind` and `severity`, writes the verbatim report and the validated findings beside the slice, and regenerates the slice's readable `review.md`. The agent can record rulings (with `agreed`, reasoning, and cost if wrong), park Minors, and the person can dismiss a plan problem. The agent can never resolve a plan problem itself: that exits 5 and leaves the slice `waiting_on_person`. `--finalize` ends the run as `reviewed` or `reviewed_with_rulings` and stores the fingerprint, `plan_basis`, merge-base, and task total that later out-of-date checks compare against. A slice review with no fixes needed now works end to end.

## User flow

1. The reviewer returns its response. The agent runs `weave review record --run 02/r1 --report - < response.md --json`.
2. The CLI stores `review/r1.report.md` and `review/r1.findings.json` and regenerates `task-slices/02/review.md`.
3. An invalid JSON block exits 4 (`report_invalid`) and writes nothing. After a second failure the agent runs `--failed`, and the slice shows `review_failed`.
4. A plan finding: the agent tries `--resolve 02/r1-F2 --as ruling ...`, gets exit 5 (`plan_finding_requires_person`), and the slice shows `waiting_on_person`.
5. The person runs `--resolve 02/r1-F2 --as dismissed --by <name>`. The slice returns to `in_review`.
6. The agent records remaining findings as rulings or parks Minors, then runs `--finalize`. The slice shows `reviewed_with_rulings`, and `review.md` lists the rulings with their cost if wrong.
7. If an old CLI dropped the `review` block, `weave review status --repair` rebuilds it from `review/*.findings.json`.

## In scope

- `src/lib/review/record.ts`: report extraction and schema validation, scoped ids, path normalisation, findings storage, resolutions with immutability rules, state machine, `review.md` writer.
- `src/lib/review/fingerprint.ts` (compute side only): blob-hash fingerprints of owned files, ruling basis hashes, `plan_basis` body hashes.
- `weave review record --run <run> (--report - | --resolve <finding> --as ruling|parked|dismissed ... | --finalize | --failed) [--independent false] [--json]`.
- `weave review status --repair`.

## Out of scope

- `--as fixed`, fix-check reports, and fix rounds (slice 06).
- Out-of-date evaluation, ownership handoff, ruling reopen (slice 07).
- Change runs and `final_only.minor_sort` handling (slice 08).

## Acceptance criteria

- [ ] A valid report is stored verbatim and as validated findings with ids `02/r1-F<n>`; unknown fields are ignored and missing required fields are rejected.
- [ ] An invalid report exits 4 with the schema errors and writes no file and no state.
- [ ] A location path outside every known repo, or with `..`, is rejected.
- [ ] `kind` and `severity` cannot change after the first write.
- [ ] Resolving a `kind: plan` finding with anything but `dismissed --by` exits 5 and sets `waiting_on_person`; `dismissed` returns the slice to `in_review`.
- [ ] `--finalize` sets `reviewed` with zero open findings, `reviewed_with_rulings` when every open finding has a ruling and no plan finding is open, and refuses otherwise.
- [ ] Finalize stores `fingerprint` (owned, non-foreign files only), `plan_basis`, `merge_base`, `reviewed_task_total`, and `counts`.
- [ ] `review.md` holds every section in `architecture/schema.md` § Readable records, newest run first.
- [ ] `--independent false` is shown in `review.md` and stored.
- [ ] `status --repair` rebuilds an equivalent block from the findings files.
- [ ] Exit codes 4 and 5 are not used elsewhere in the CLI (today only 0 and 1 are used).
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
