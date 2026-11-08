---
artifact: architecture
capture_mode: stress-test
captured_at: 2026-11-08T14:22:39.000Z
---

# Stress Test: Architecture - 2026-11-08

The user settled the three blocking challenges one by one, and then accepted the agent's suggested answers for every major and minor challenge so the test could be fast-tracked. Before the interview, the git claims were checked on git 2.50.1:

- **Reflog messages (confirmed).** `add_new` logs `Created from <sha>`, `add_tracking` logs `Created from origin/change/<id>`, and `checkout -b` logs `Created from HEAD`.
- **`fetch.pruneTags` (not reproduced).** With explicit refspecs, it neither fetched nor pruned tags.
- **`log --all` (half right).** It includes commits reachable only through `refs/weave/*`, but the ref names aren't decorated by default.

## Challenges

### C1 — blocking — contradiction with reality (starting-branch recovery)
- **Challenge:** Reflog recovery yields a SHA for `add_new`, the change's own remote branch for `add_tracking`, and `HEAD` for `checkout -b`. The second makes a change measure against itself and read `landed` (safe to delete). The folder's `status.yml` checkout block was never read.
- **Answer:** Accepted the suggestion. Recovery order is `bases/`, then the `status.yml` checkout block, then the reflog with SHA, `HEAD`, and `[origin/]change/<id>` rejected, then `unknown`. Each creation path gets a test.
- **Outcome:** decided

### C2 — blocking — contradiction with reality (landed algorithm order)
- **Challenge:** "No commits" ran before "merged", using `merge-base(target, tip)` when `base_commit` was unknown. After any merge, that merge-base equals the tip, so merged branches read "no commits yet".
- **Answer:** Accepted. The no-commits test runs only with a known `base_commit`. The user rejected calling an empty branch with an unknown base `landed`, because that falsely says the work went into main. So when the base is unknown and the tip is on the target's first-parent line, the method is `contained`, labelled "nothing left to merge: every commit is already in <t>". The state stays `landed`, since deleting loses nothing.
- **Outcome:** decided

### C3 — blocking — blocking gap (which branches count, and closed-state next steps)
- **Challenge:** No rule said which `change/*` branches are Weave changes. Closed states always offered `switch`, which fails without a committed `status.yml`. Closed changes always showed "(title unknown)".
- **Answer:** Accepted.
  - A branch counts when its name matches the id pattern and it has a `bases/` or `changes/` record or a committed `status.yml`.
  - `switch` is offered only when `status.yml` is on the branch; otherwise the closed state shows a `git worktree add` recovery hint.
  - Titles are read from the branch when present.
  - A branch with no folder and no commits is `done`.
- **Outcome:** decided

### C4 — major — conflict with the PRD (target selection, gone branches, may_have_landed)
- **Challenge:** A local-only merge counted as landed. A stale `origin/<t>` kept dead parents alive. `may_have_landed` had no stored "previously existed" fact.
- **Answer:** Accepted the suggestion.
  - Only remote-derived targets count for repos with `origin`.
  - "Gone" means absent on origin at the last successful refresh.
  - `refresh.json` keeps per-repo `seen` and `absent` lists.
- **Outcome:** decided

### C5 — major — unowned assumption (cost and object-store writes)
- **Challenge:** merge-tree writes loose objects into the user's store. The 50-commit walk reruns whenever the target moves. "Instant" had no budget.
- **Answer:** Accepted the suggestion.
  - merge-tree uses a temporary object directory, with the real store as an alternate.
  - The inline cache-miss budget is 2 s, with "still checking" for the rest, which the refresh finishes.
  - The target is a warm list in ≤ 500 ms for 30 changes, measured in the first slice.
  - The cache files under `.git/weave/` are raised as a PRD wording point.
- **Outcome:** decided

### C6 — major — contradiction with reality (fetch side effects, prompts), merged with C7 — major — scale (fetch scope, ref visibility)
- **Challenge:** The fetch could trigger auto-gc, maintenance, submodule recursion, and commit-graph writes. Askpass, GCM, and a user ssh command could still prompt. `change/*` fetched every teammate branch. `log --all` visibility was misstated.
- **Answer:** Accepted the suggestion.
  - `ls-remote`, then named refspecs for known change branches and targets only, deleting gone refs with `update-ref -d`.
  - Hardened `-c` flags (`fetch.pruneTags=false` kept as belt and braces).
  - A failing askpass, `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`, and a git child with no controlling terminal, including in-process `--fetch`.
  - The `log --all` claim was corrected, and visibility accepted as a trade-off.
- **Outcome:** decided

### C8 — major — uncovered scenario (deleted changes root)
- **Challenge:** A hand-deleted changes root read as "unmounted", leaving no recovery path, and unavailable changes had no `state.id`.
- **Answer:** Accepted the suggestion. The root is unavailable only when its parent is missing or it is a dangling symlink; otherwise it's treated as deleted, with normal `folder_missing` states. A new `folder_unavailable` state was added.
- **Outcome:** decided

### C9 — major — blocking gap (a change's repo set)
- **Challenge:** No source of truth said which repos a change should have, so `--repo` subsets and repos registered later would be flagged missing.
- **Answer:** Accepted the suggestion. A repo belongs to a change if it has a `change/<id>` worktree entry (prunable included) or is listed in the new optional `changes/<id>.yml` `repos` field.
- **Outcome:** decided

### C10 — major — uncovered scenario (attention snapshot after close, write race)
- **Challenge:** `weave status` kept counting closed changes, and an older refresh could overwrite a newer snapshot.
- **Answer:** Accepted the suggestion. `close` and `switch` recompute the snapshot, and writes are conditional on a newer `facts_at`, under the state lock.
- **Outcome:** decided

### C11 — major — conflict with JSON compatibility
- **Challenge:** Root resolution could change `active` and `targets[].path`. Blanking typed fields could break consumers. In-place mode wasn't gated. The library-level spawn was risky.
- **Answer:** Accepted the suggestion.
  - `active` and `targets[].path` keep their cwd meaning.
  - `id`, `slug`, `branch`, and `path` are never blanked; `title`, `type`, and `stage` come from the branch when possible.
  - Everything new is gated to worktree mode in `src/commands/change.ts`, which owns the spawn.
- **Outcome:** decided

### C12 — major — inner conflict (switch recreate inside planTarget)
- **Challenge:** Removing worktree entries during planning broke check-everything-then-act, and moved folders weren't handled.
- **Answer:** Accepted the suggestion. Removal is a planned `remove_stale_entry` action run in the apply phase. Any unlocked prunable entry for the branch, at any path, qualifies.
- **Outcome:** decided

### C13 — minor — batch of minor points
- **Challenge:**
  - git version floors for 2.29 and 2.31
  - old-git noise
  - the cache key leaving out `base_commit`
  - the auth-failure test transport
  - ADR `applies_to` gaps
  - no ADR for the state-id contract
  - `change status <id>` and opening a folder still saying `change_not_found`
- **Answer:** Accepted the suggestions. The state-id contract ADR is deferred and recorded as an open risk.
  - capability floors added
  - one list-level line on git < 2.38
  - `base_commit` added to the cache key
  - the auth test uses `ext::` with `protocol.ext.allow=always`
  - `applies_to` widened
  - those commands now report "folder missing"
- **Outcome:** decided (one item deferred, not blocking)

## Verdict

holds-with-changes — Approach A and both proposed decisions stand. The landed algorithm, base recovery, fetch scope and hygiene, and several contracts were corrected.

## Next Resume Point

Run `weave-slices`. Separately, run `weave-clarify prd` to record the new visible wording (`contained`, `folder_unavailable`, the recovery hint, "still checking", cache files), and `weave-clarify exploration` for the earlier lag. Neither blocks slices.
