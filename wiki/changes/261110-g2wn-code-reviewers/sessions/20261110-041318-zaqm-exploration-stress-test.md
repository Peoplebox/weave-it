---
artifact: exploration
capture_mode: stress-test
captured_at: 2026-11-09T22:43:18.000Z
---

# Stress Test: Exploration - 2026-11-10

The user asked the agent to answer the challenges itself and escalate only if absolutely needed. None needed escalation; every answer below is the agent's ruling, written into the shape for the user to review.

## Challenges

### C1 — blocking — uncovered scenario / recorded decision
- Challenge: Nothing says what starts a slice review or the final review when tasks are built over several sessions, finished by hand, or paused for a person; an unattended final review seemed to pull against "steps where a person decides never auto-advance".
- Answer: The build session that finishes a slice's last task runs the review in the foreground; the session completing the last slice review starts the final review. Nothing runs in the background. Slices finished without a review show "tasks done, not reviewed" and "what next" recommends reviewing. Review is part of building, not a move between planning stages, so decision 261108-adko is not affected.
- Outcome: decided

### C2 — major — missing people
- Challenge: Slices can have different owners; the shape sent every outcome to one "person".
- Answer: A slice's plan problem belongs to the slice's owner, else whoever is working on the change. Verdicts and rulings are recorded on the change and visible in its status; Weave sends no notifications. Nothing times out.
- Outcome: decided

### C3 — major — concurrency
- Challenge: Review fixes and other slices' work could touch the same files in one uncommitted change folder.
- Answer: The session that built a slice waits for its review before starting another. Review fixes stay within the slice's own code; a fix needing another slice's code becomes a ruling. Other people may build independent slices in parallel; Weave does not otherwise guard concurrent edits today (assumption).
- Outcome: decided

### C4 — major — internal conflict
- Challenge: Scenario 5 had the agent build a missing PRD requirement unattended, and the agent itself decided what counts as a plan conflict.
- Answer: Plan gaps stop for the person like plan conflicts. The reviewer labels findings as code or plan problems; the agent cannot relabel a plan problem. Scenario 5 split into 5 and 6.
- Outcome: decided

### C5 — major — reversal / absence
- Challenge: What happens after a plan problem is resolved, and can the final review run with one open?
- Answer: The person changes the plan through existing tools or dismisses the finding (recorded as their ruling). Changing the plan marks dependent work out of date as today; the slice and slices built on the old plan are reviewed again. The final review does not start while any slice is waiting, unreviewed, or out of date.
- Outcome: decided

### C6 — major — change types
- Challenge: Fix, chore, refactor, and flat-mode changes have no PRD or no slices.
- Answer: Review covers every change type built from slices, checking against whichever planning documents exist (findings for fixes). Flat-mode changes get no slice reviews; the whole-change review can be run on demand.
- Outcome: decided

### C7 — major — contradiction with today
- Challenge: Updating Weave does not install new skills, and writing a team-owned guidelines file during an update would be unannounced.
- Answer: Review is on by default once the skill is installed. Weave's status tells existing teams reviews are available and how to install them. The starter guidelines file is written into an existing project only when a person asks.
- Outcome: decided

### C8 — major — uncovered scenario
- Challenge: Re-running verification after fixes may need a human step; slices with "not tested" tasks were unaddressed.
- Answer: Fixes re-run automatic checks; human steps are marked "needs your check" and listed as parked items without blocking. Slices with untested tasks are still reviewed, with untested tasks called out.
- Outcome: decided

### C9 — major — reversal / staleness
- Challenge: Reviewed states and verdicts could describe code that has since changed; fixes made unattended could not be found to undo.
- Answer: Reviewed states and verdicts show as out of date when the covered code changes. Each fix in the review record lists the finding and exactly what it changed. How to detect both without commits is an architecture question.
- Outcome: decided (mechanics deferred to architecture, non-blocking)

### C10 — minor — unowned assumption
- Challenge: Single-repo projects, guideline edits on a change branch, missing repositories.
- Answer: Single-repo projects have one guidelines file. Reviews use guidelines in the change's own folder. A missing repository makes the review partial and the verdict "not ready".
- Outcome: decided

### C11 — minor — unclear terms
- Challenge: "Parked item" and how must-fix findings affect the verdict were undefined.
- Answer: Parked item = can-wait Minor finding, ruling, or pending human check. Must-fix Minors are fixed in the final batch. "Not ready" = waiting plan problem, unreviewed part, or an agreed Critical finding still unfixed.
- Outcome: decided

### C12 — minor — internal conflict
- Challenge: Rulings would stay hidden after the guideline they relied on was tightened.
- Answer: A ruling reopens when the guideline, planning document, or decision it relied on changes, as well as when its code changes.
- Outcome: decided

## Verdict

holds-with-changes — the direction stands; answers added triggers, ownership, plan-gap handling, staleness, change-type coverage, and rollout detail, and changed Scenario 5 so plan gaps stop for the person.

## Next Resume Point

Write the PRD from the updated shape. The user should review the agent's rulings above, since they were made on the user's behalf.
