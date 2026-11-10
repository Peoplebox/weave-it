---
artifact: exploration
capture_mode: stress-test
captured_at: 2026-11-10T21:17:32.000Z
---

# Stress Test: Exploration - 2026-11-11

## Challenges

### C1 — blocking — contradiction with reality
- Challenge: "Anything that ends in progress recorded" did not match the listed moments: session-only captures record no progress, the stress test records progress before its verdict, knowledge uses its own status command, and questions were missing from the list.
- Answer: Writing a file is not visible to Weave, and detecting writes (per-agent hooks or a watcher) would be agent-specific and commit half-finished states. The reliable, agent-neutral signal is the Weave command each skill runs right after writing. Rule: Weave commits whenever it records something in the change's status (stage progress, verdict, knowledge status, clearing an out-of-date flag, review results). Before that commit, a catch-up save commits leftover planning files (session notes, work from interrupted skills) as their own commit. The stress test yields two commits (revised shape, then verdict).
- Outcome: decided

### C2 — major — uncovered scenario
- Challenge: Planning commits would run the project's commit checks in change folders not yet set up, and unattended phases would run project commands without a person's approval.
- Answer: Planning commits skip the project's checks; they are plain documents and must never be blocked. Code commits always run the checks.
- Outcome: decided

### C3 — major — conflict with recorded decision 261108-4z8l
- Challenge: Unattended phases would move the branch forward with no person present, which the decision's "nothing more" wording does not allow; the shape held this only as an assumption.
- Answer: Accepted deliberately. Record as a decision; `weave-architect` should propose a superseding version of 4z8l.
- Outcome: decided

### C4 — major — uncovered scenario
- Challenge: Work could land in the wrong commit: a failed build commit swept into the next slice's build, review records left unsaved after a clean review, and half-built slice notes going into planning commits.
- Answer: The catch-up save extends to code (leftover slice code is committed as that slice's late build commit before the next slice starts; if that fails, the person is told the next review will include it). Recording a review result is a recorded moment and commits. Half-built slices' notes may go into planning commits; only their code stays uncommitted.
- Outcome: decided

### C5 — major — uncovered scenario
- Challenge: In shared (in-place) checkouts, "everything changed" sweeps in the person's own edits; unclear what happens to edits the person staged when a planning commit happens.
- Answer: Keep "everything" in both checkout types and tell the person which files each build commit included. A planning commit may simply include edits the person had staged. General principle: keep it simple; a failed commit only informs the person of the failure and its reason.
- Outcome: decided

### C6 — major — uncovered scenario
- Challenge: Older changes without slices would never get code commits; the final review's cross-slice fix batch was not covered.
- Answer: Older changes without slices get planning commits only and keep private save points for review. The final review's fix batch gets its own commit.
- Outcome: decided

### C7 — major — uncovered scenario
- Challenge: No scenario for undoing a slice (task ticks, review status, dependent slices) or for a slice finished a second time.
- Answer: Weave adds no undo command; people undo with git. Task ticks reverting is correct, existing out-of-date review detection covers the review, and dependent slices are covered by their own reviews and tests. Finishing a slice again makes another build commit ("additional work") and the existing out-of-date check asks for re-review.
- Outcome: decided

### C8 — major — conflict with recorded decision 261108-kl3n
- Challenge: The decision's "Reconsider When" names planning commits; change-list states shift (no-commits notes vanish, abandoned changes read "closed, not landed", post-merge saves flag newer commits, teams keeping planning files off main never read as landed).
- Answer: All intended; the PRD should list them as visible changes. Teams are assumed to merge the whole change branch. Revisiting kl3n is an open question for `weave-architect`.
- Outcome: decided (kl3n revisit deferred, non-blocking)

### C9 — major — existing users / missing people
- Challenge: Unclear whether upgrading projects start committing immediately; no personal switch, despite decision 261109-a8k5.
- Answer: On from the upgrade with a one-time notice. Project off means off for everyone; with the project on, a person can turn it off in their own settings; the per-change skip still applies.
- Outcome: decided

### C10 — minor — unowned assumption
- Challenge: Fixed message styles may clash with project rules on format or on what may appear in history.
- Answer: The project's documented rules win (format and exclusions); Weave's styles are the default only.
- Outcome: decided

### C11 — minor — concurrency
- Challenge: Two saves at once may collide.
- Answer: Accept; one fails with a reason and the catch-up save picks up what was missed. No waiting or queueing.
- Outcome: decided

### C12 — minor — inner conflict
- Challenge: A multi-repo slice where only some repos committed mixes boundaries.
- Answer: Per repo: commit where made, private save point elsewhere; the person is told which repos failed and why; the catch-up save retries before the next slice.
- Outcome: decided

## Verdict

holds-with-changes — the two-tier direction stands; the commit trigger was redefined as "status recorded" with a catch-up save, planning commits skip project checks, and several scope and control rules were added.

## Next Resume Point

Write the PRD from the updated `exploration.md` (auto-advance handoff, or `weave-prd`), then `weave-architect`, which should take up the open questions on superseding decisions 261108-4z8l and 261110-wdfo and revisiting 261108-kl3n.
