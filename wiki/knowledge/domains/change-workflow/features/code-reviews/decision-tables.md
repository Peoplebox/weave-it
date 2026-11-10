# Code Reviews Decision Tables

## Table: Slice review state a reader sees

| Stored state | Tasks | Out-of-date reasons | Review active? | Shown as |
| --- | --- | --- | --- | --- |
| none | some active task open | any | yes | `not_ready_for_review` ("tasks open") |
| none | every active task `done` or `not_tested` | any | yes, change adopted | `not_reviewed` ("tasks done, not reviewed") |
| none | ready | any | yes, change not yet adopted (read-only views) | `predates_review` (what adoption would stamp) |
| `reviewed` / `reviewed_with_rulings` | any | none | yes | stored state |
| `reviewed` / `reviewed_with_rulings` | any | one or more | yes | `out_of_date` ("reviewed, out of date (reasons)"); stored state kept |
| `waiting_on_person` | any | includes `plan_changed` | yes | `not_reviewed` (plan changed); next package starts a fresh run |
| `waiting_on_person` | any | none | yes | `waiting_on_person` ("waiting on you: plan problem") |
| any other stored state | any | ignored | yes | stored state |
| any | any | ignored | no: change skipped or workspace off | `skipped` (overlay, never written) |
| none | any | ignored | no: skill not installed | no review state (null) |
| any stored state | any | as above | no: skill not installed | stored state (with out-of-date overlay) |

## Table: Does a slice let its dependents start?

| Review active? | Slice ready for review? | Stored review state | Dependents may start |
| --- | --- | --- | --- |
| no | n/a | n/a | when the slice's rollup `status` is `done` |
| yes | no | any | no |
| yes | yes | `reviewed`, `reviewed_with_rulings`, `skipped`, `predates_review` | yes |
| yes | yes | none, `in_review`, `waiting_on_person`, `review_failed` | no |

The out-of-date overlay is not used here, so rollup output stays deterministic.

## Table: Final-review gate (`weave review gate --change`)

| Situation | Result |
| --- | --- |
| Review inactive (any cause) | `pass: true`, `reason: "inactive"`, nothing blocking |
| Flat change (no slices) | `pass: true`, `flat: true` |
| Every slice `reviewed`, `reviewed_with_rulings`, or `predates_review`, none out of date | `pass: true` |
| A slice out of date | blocked: `effective_state: out_of_date` with its reasons |
| A slice `skipped` while the change itself is not skipped | blocked: `skipped_while_change_reviewed` |
| A slice `not_reviewed`, `not_ready_for_review`, `in_review`, `waiting_on_person`, or `review_failed` | blocked with that state |

The command exits 0 either way; `pass` carries the answer. `package --change` refuses with `gate_failed` unless `--partial` is given, which records the run as partial.

## Table: Change verdict

| Open across the latest slice runs and the change run | Verdict |
| --- | --- |
| an unresolved plan finding | `not_ready` |
| the run is partial (gate failed, missing repo, unknown base) | `not_ready` |
| a Critical ruling with `agreed: true` | `not_ready` |
| any other unresolved finding | `not_ready` |
| only can-wait Minors, other rulings (including `agreed: false`, agreed non-Critical, and a person's dismissals), or human checks | `ready_with_parked_items` |
| nothing | `ready_to_merge` |

## Table: Resolving a finding

| `--as` | Allowed for | Required options | Outcome |
| --- | --- | --- | --- |
| `fixed` | code findings | `--round <n>` (round packaged) | closes it; carries the round patch and files; "needs your check" when the slice has a `Human check:` step |
| `ruling` | code findings | `--agreed true\|false`, `--reason`, `--cost` | stores reasoning, cost if wrong, and the basis hashes |
| `parked` | Minor code findings only | none | saved for the final review; Important or Critical gives `invalid_resolution` |
| `dismissed` | any finding; the only way for `kind: plan` | `--by <person>` | the person's own ruling |
| any other on a plan finding | n/a | n/a | exit 5 `plan_finding_requires_person`; scope stays `waiting_on_person` (`not_ready` for a change run) |

## Table: `weave review` exit codes

| Exit | Meaning |
| --- | --- |
| 0 | success (including a gate that does not pass) |
| 1 | any other error, with `{status: "error", code, message, details?}` in `--json` |
| 4 | `report_invalid`: the reviewer response failed validation; nothing was written |
| 5 | `plan_finding_requires_person`: a plan finding was resolved other than `dismissed` |

## Table: Final-review Minor and ruling sort

| Entry in `final_only.minor_sort` | `must_fix` | `can_wait` |
| --- | --- | --- |
| a Minor of the change run | stays open; joins the fix batch | parked |
| a slice run's Minor | copied into the change run unresolved; joins the fix batch | copied in and parked |
| a slice run's ruling (any severity) | copied into the change run unresolved; joins the fix batch | stays parked as the slice's ruling; not copied |
| anything else (unknown id, non-Minor that is not a slice ruling) | report invalid (exit 4) | report invalid (exit 4) |

A Minor or slice ruling the reviewer leaves unsorted stays parked.

## Notes

- Model level hints: slice `mid` (`most_capable` above 1500 changed lines), fix round `cheap-mid`, change `most_capable`.
- A change run has exactly one fix batch; `snapshot --at round-start --round 2` or `package --fix-round 2` on a change run gives `round_limit`. Slice round counts are capped only by the skill (`review.slice_rounds`).

## Source Anchors

- `src/lib/review/rules.ts` (`effectiveState`, `satisfiesDependents`, `deriveVerdict`)
- `src/lib/review/summary.ts` (`sliceReviewStatus`, `sliceReviewPhrase`)
- `src/lib/review/gate.ts` (`evaluateGate`, `gatePassingStates`)
- `src/lib/review/record.ts` (`applyResolution`, `recordExitCodes`, `resolveMinorSort`, `applyMinorSort`, `changeVerdictSummary`)
- `src/lib/review/rounds.ts` (round ordering and `round_limit`)
- Tests: `tests/review-rules.test.ts`, `tests/review-gate.test.ts`, `tests/cli-review-record.test.ts`, `tests/cli-review-change.test.ts`, `tests/cli-review-skip.test.ts`
