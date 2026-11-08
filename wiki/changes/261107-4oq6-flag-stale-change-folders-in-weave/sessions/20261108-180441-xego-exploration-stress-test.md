---
artifact: exploration
capture_mode: stress-test
captured_at: 2026-11-08T12:34:41.000Z
---

# Stress Test: Exploration - 2026-11-08

The challenger was an independent `weave-challenger` sub-agent that read only the shape, research.md, the knowledge wiki, and accepted decisions. The interview ran in the same session as the brainstorm, at the user's request.

## Challenges

### C1 — blocking — Contradiction with reality
- Challenge: Today the list shows every past change whose planning files reached main (about 32 here), and none of the five states fits them. The shape never said whether they stay or go.
- Answer: By default the list shows only changes that still have something on this machine (a folder, a missing-folder leftover, or a branch). Past changes appear only with `--all`, under a new state, *done*, with no next step. The shape states openly that this changes today's list.
- Outcome: decided

### C2 — blocking — Unowned assumption
- Challenge: "Landed" meant "on the remote's main", but changes can start from other branches (this one started from `origin/change/worktrees`), repos can use other default branches, and some have no remote.
- Answer: Measure against the branch the change started from, and always name it ("landed in main (squashed)", "landed in change/worktrees, not in main yet"). If that branch is gone, fall back to the repo's default branch. "No commits yet" counts from the starting point. With no remote, compare locally and skip the refresh. The user chose this because naming the branch is the easiest wording for anyone to read.
- Outcome: decided

### C3 — major — Inner conflict
- Challenge: *Partly landed* mixed multi-repo work still underway with follow-up commits after landing, and both counted as "need attention", so the status line would nag about changes that need nothing.
- Answer: Multi-repo work still underway is *in progress*, with per-repo lines. The follow-up case is renamed *landed, with newer commits*, listed but not counted. "Need attention" counts only *landed* and *folder missing*.
- Outcome: decided

### C4 — major — Inner conflict
- Challenge: There was no precedence when several states fit, and uncommitted planning files would put the *uncommitted work* label on nearly every planning change.
- Answer: Fixed order: folder missing, then landed with newer commits, then landed, then in progress. Closed and done apply only when there's no folder. The winning state carries a note (for example "folder missing (work already landed in main)"), and each change counts once. *Uncommitted work* shows only on landed changes. Added principle: output must read cleanly for both developers and AI agents, with fixed state names in text and JSON, fixed next-step commands, and plain wording.
- Outcome: decided

### C5 — major — Uncovered scenario
- Challenge: "Bring it back" fails for a missing folder whose change never committed anything, because the planning files are lost.
- Answer: Offer `switch` only when the branch has the change's files committed. Otherwise offer only `close`, and say plainly that the uncommitted planning files can't be recovered. When `switch` is offered, say it restores committed work only.
- Outcome: decided

### C6 — major — Existing data
- Challenge: A recreated folder could keep a slot that's now taken by another change, and would keep a setup record that's no longer true.
- Answer: Keep the old slot if it's free, otherwise assign a new one and say so. Setup is treated as not yet run for recreated folders. Approvals stay.
- Outcome: decided

### C7 — major — Uncovered scenario
- Challenge: A folder may be moved, renamed, on an unmounted drive, or deliberately kept. Git also clears its own record after about three months.
- Answer: Say "folder not found at <path>", not "deleted", and have `close` warn about moved folders. If the whole changes location is missing, say the change folders are unavailable, and don't count them or suggest `close`. A folder kept on purpose is listed as *folder missing (kept on purpose)*, isn't counted, and `close` refuses with how to unmark it. After git clears its record, Weave's own record still shows *folder missing*, and `close` cleans up the rest.
- Outcome: decided

### C8 — major — Unowned assumption
- Challenge: The refresh plan didn't cover a per-repo vs. whole-list time budget, login prompts, agents waiting on the network, or how a fetch squares with "read-only".
- Answer: The user asked why this couldn't be handed to a script. Decided instead: the list answers instantly from what's already known and starts a background refresh for next time, the pattern Weave already uses for its version check. `--fetch` waits for a fresh answer. The refresh never asks for a login, and the list shows when a login blocked it. `--json` gives each repo's data age. The 2-second limit and `--offline` are dropped. "Read-only" is reworded: the list updates only Weave's copy of what's on the remote. A scheduled job and git's own background maintenance were considered and rejected.
- Outcome: decided

### C9 — major — Existing users and data
- Challenge: Any local `change/` branch without a folder would show as *closed*. There are 15 here, many never closed through Weave.
- Answer: Branches whose work has landed are *done* (hidden by default, shown with `--all`). Branches whose work hasn't landed are shown as *closed, work not in <branch>*, aren't counted, and suggest `switch`. Branches that don't contain a Weave change are ignored. The shape states that the first run after upgrading may show a few unlanded old branches.
- Outcome: decided

### C10 — major — Blocking gap understated
- Challenge: This change and `261107-6c16-close-delete-merged` would both tell users whether a change landed, and different definitions would contradict each other.
- Answer: "Landed" must mean exactly the same thing in both. This change's PRD defines it, and 6c16 adopts it when it reaches exploration. Which change builds the check first stays open for design, not blocking the PRD.
- Outcome: decided

### C11 — major — Unowned assumption
- Challenge: Showing *in progress* when unsure, with no sign of uncertainty, hides merged changes among real work.
- Answer: The user asked why it would ever be unclear. Explained that the check is reliable except when main later changes the same lines, and that "couldn't check" is a separate, rarer failure to run the check at all. Decided: checked and not landed is *in progress* with no label. Couldn't check is *in progress* labelled with the reason, plus a separate JSON field. A remote branch deleted with no landing found is *in progress* labelled "branch deleted on origin; it may have landed". None of these count.
- Outcome: decided

### C12 — minor — Uncovered scenario
- Challenge: The shape didn't say where `weave status` reports from, or how it stays fast.
- Answer: The line appears anywhere in a worktree-mode workspace (the main checkout, change folders, subfolders) and counts the whole machine. `weave status` never runs the landed check. It shows the last known result, may briefly lag the list, and shows no line if nothing has been worked out yet.
- Outcome: decided

## Verdict

holds-with-changes — The direction stands. Twelve decisions refined states, landed detection, freshness, and edge cases, and none broke the direction.

## Next Resume Point

Run `weave-prd` for this change. The PRD defines "landed" for both this change and `261107-6c16-close-delete-merged`. Flag for `weave-architect`: landed detection with plain git, the background refresh, and the shared landed definition may deserve recorded decisions.
