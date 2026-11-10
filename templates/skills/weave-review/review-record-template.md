# Review Record Layout

`weave review record` writes every review record. Nobody edits one by hand: the CLI regenerates it from the run files each time it records a report, a resolution, or the end of a run. This file shows the layout so a person or agent knows where to look.

## Files

```text
wiki/changes/<change-id>/task-slices/<slice-id>/review.md     slice record, newest run first
wiki/changes/<change-id>/task-slices/<slice-id>/review/
  r<N>.report.md            the reviewer's response, verbatim
  r<N>.findings.json        the validated findings; kind and severity never change
  r<N>-round<n>.patch       one fix round's exact changes (undo: git apply -R, from the Weave root)
  r<N>-round<n>.check.md    the fix checker's response, verbatim
wiki/changes/<change-id>/review.md                            change record: verdict, final review runs, all rulings
wiki/changes/<change-id>/review/
  f<N>.report.md, f<N>.findings.json, f<N>-fix.patch, f<N>-fix.check.md
```

## Slice record (`task-slices/<slice-id>/review.md`)

```md
# Review record: <slice-id>

## Run <slice-id>/r<N>

- Scope: slice `<slice-id>`
- State: <in review | reviewed | reviewed with rulings | waiting on person | review failed>
- Verdict: <the reviewer's verdict>
- Model level: <cheap | mid | most_capable>
- Independent: <yes | no (the review ran inline in the building session)>
- Partial: <yes | no>
- Start: <start snapshot ref, or the fallback base>
- End: <end snapshot ref>
- Reports: <report files>

### Strengths

### Findings

| ID | Severity | Kind | Location | Fails | Status |

Status is one of: open, waiting on person, fixed in round N, ruling (agreed | disagreed | reopened), parked, dismissed by <person>.

### Fixes

| Finding | Round | Patch | Files | Needs your check |

Fix rounds: each round's patch, how to undo it, and what its fix check found.

### Rulings

Each ruling: the finding, agreed or disagreed, the reasoning, the cost if wrong, the basis it relied on, and whether it reopened.

### Declined to judge

### Saved Minors

### Untested tasks

### Human checks (needs your check)
```

## Change record (`review.md` in the change folder)

```md
# Review record: change <change-id>

## Verdict

- Verdict: <ready to merge | ready with parked items (<n>) | not ready>
- From run: `change/f<N>`
- Rulings: <n>; parked items: <n>; plan problems open: <n>
- Partial: <yes | no>

## Run change/f<N>

(the same sections as a slice run, plus "### Minor sort" after "### Declined to judge": each saved Minor and each slice review ruling the final reviewer sorted, as must fix or can wait)

## All rulings

Every ruling from every slice review and the final review, oldest run first: the finding, where it came from, agreed or disagreed, the reasoning, the cost if wrong, whether it reopened, and how the final review sorted a slice ruling. Each plan problem a person dismissed is listed too, as the person's own ruling, with who dismissed it.
```
