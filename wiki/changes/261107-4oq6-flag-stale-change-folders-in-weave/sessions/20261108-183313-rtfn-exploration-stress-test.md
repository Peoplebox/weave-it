---
artifact: exploration
capture_mode: stress-test
captured_at: 2026-11-08T13:03:13.000Z
---

# Stress Test: Exploration - 2026-11-08 (short, changes only)

This was a focused re-test of what changed after the first stress test (`20261108-180441-xego-exploration-stress-test.md`): the resolved assumptions and open questions, the git version rule, the refresh rules, the layout, and the compatibility promise. Earlier decisions were not reopened. An independent `weave-challenger` sub-agent read only the shape, research.md, the earlier note, and the knowledge wiki.

## Challenges

### C1 — major — Contradiction with reality
- Challenge: Weave records the starting branch only in uncommitted planning files, so it is lost after close, when a folder goes missing, and for old branches. Stacked changes would then be measured against main and mislabelled.
- Answer: Weave remembers each change's starting branch per repo, separately from the folder, and keeps it after close and after a folder disappears. It tries to recover it for old branches from git's record of where the branch was created. When it's still unknown, Weave falls back to the default branch with a "starting branch unknown" label.
- Outcome: decided

### C2 — major — Inner conflict
- Challenge: "--json only adds fields" can't hold. Past changes disappear by default, and new entries have no planning files to fill today's fields. Readers also assume a listed folder exists.
- Answer: The promise is that no field is renamed, removed, or changes meaning, not the same set of changes. Fields with no source are left empty with a reason field. Today's folder field keeps meaning "a folder that exists", and a missing folder's location goes in a new field. Release notes cover the default hiding.
- Outcome: decided

### C3 — major — Uncovered scenario
- Challenge: A hung refresh would block all later refreshes, and `--fetch` during a background refresh would start a second, conflicting fetch.
- Answer: Each refresh gives up after about 30 seconds per repo, and a dead one doesn't block the next. The list gives the reason when a refresh failed or timed out. `--fetch` joins a running refresh, or starts one, and waits at most the same limit.
- Outcome: decided

### C4 — major — Inner conflict
- Challenge: The shape didn't say whether "landed, with newer commits" is safe to delete under the shared definition, or how it combines across repos.
- Answer: Only *landed* is safe to delete, and *landed, with newer commits* is explicitly not. Across repos the least-finished repo decides: in progress, then landed with newer commits, then landed.
- Outcome: decided

### C5 — major — Uncovered scenario
- Challenge: The one-line layout dropped title, type, stage, folder, and slot, and had no room for labels, per-repo refresh problems, differing ages, or the unavailable message.
- Answer: Keep today's layout and add the state, labels, next step, and per-change age as indented lines. Show "(title unknown)" when planning files are gone, and put the unavailable message at the top. The user also pointed out that "landed … uncommitted work" read as a contradiction. The label is now "N uncommitted files in folder", and the next step becomes "commit or discard them, then close", because `close` refuses with uncommitted files.
- Outcome: decided

### C6 — minor — Unsupported claim and uncovered scenario
- Challenge: The 2.38 rule and the test result appeared only in the shape, and the shape didn't say what a branch with no folder becomes when the check can't run on old git.
- Answer: Only squash detection needs 2.38, and normal and rebase merges are recognised on older git. A branch with no folder that couldn't be checked shows as "closed, couldn't check whether it landed": shown by default, not counted, with `switch` as the next step. The git test is now recorded in research.md, and design confirms the minimum version.
- Outcome: decided

### U1 — raised by the user — Scope
- Challenge: The user read "every change this machine knows about" as meaning every repo and workspace on the machine, and compared it with `git status`, which shows only the current repo.
- Answer: The list already covers only the repo or workspace it runs in. The wording is fixed to say so, and it's now a decision that neither the list nor the `weave status` line includes other repos or workspaces. `weave change status` is the single-change view, like `git status`. `weave change list` is like `git branch`.
- Outcome: decided

## Verdict

holds-with-changes — The direction stands. Seven decisions tightened scope wording, starting-branch memory, refresh limits, the shared safe-to-delete rule, the layout, and JSON compatibility.

## Next Resume Point

Revise prd.md (it is marked stale) with `weave-prd`, carrying over the resolved assumptions and open questions and these seven decisions.
