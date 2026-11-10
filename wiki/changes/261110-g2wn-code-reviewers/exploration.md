---
artifact: exploration
status: draft
owner: product
created_at: 2026-11-09T21:52:06.174Z
updated_at: 2026-11-09T22:37:05.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: discussion
---

# Code Reviewers

## Topic

Code reviewers: independent reviewers that check the code a change produced against what the change said it would do, before it is merged.

## Problem

Weave plans a change in detail (PRD, architecture, slices with acceptance criteria, recorded decisions) and then builds it, but nothing checks the result against that plan. Execution proves each task's code works (tests, typecheck, build pass), not that it matches the PRD, follows the architecture, stays within recorded decisions, or meets the team's coding standards. The agent that built the code is also the only one that has looked at it, and it is inclined to believe its own work. Problems found late, after later slices have built on them, are expensive to undo. Changes that span several repositories, each with its own language and conventions, make this harder: there is no single standard to review against.

## Existing Behavior

- Building a change happens task by task. Each task is implemented, its verification is run, and evidence (passing checks, acceptance criteria met) is recorded against the task. A task is marked done when its verification passes. Nothing is committed automatically.
- A slice is finished when all of its tasks are done. There is no review step at slice level or change level.
- Weave already uses an independent critic for plans: the stress test hands the written product or architecture shape to a reviewer that never saw the conversation that produced it, ranks weak points, and the answers are written back into the shape. When the agent client cannot run a separate reviewer, the critique runs inside the same session with less independence.
- Recorded decisions apply to specific parts of the code, and agents are told to work within them.
- There is no concept of coding guidelines in Weave today, shared or per repository.
- Weave works with several agent clients and does not depend on any one client's built-in features.

## Options Considered

### A. Review after every task — Rejected

- What it means for users: every task gets an independent review before it is marked done; nothing extra to remember.
- Trade-offs: adds time and cost to every task; no view across the whole change; reviewers judge fragments too small to show whether a piece of work does what was agreed.
- Why rejected: too fine-grained. Task verification already covers "does it work"; the review is most useful on a complete, testable unit.

### B. Review only when the person runs it — Folded in

- What it means for users: a review the person runs on a slice or the whole change when they want one.
- Trade-offs: nothing is reviewed automatically; people forget to run it.
- Why folded in: kept as a way to re-run a review at any time, but not as the only way reviews happen.

### C. One review of the whole change, only at the end — Rejected

- What it means for users: a single review once every slice is done.
- Trade-offs: a defect in an early slice is found only after later slices have built on it, so the fix spreads across slices.
- Why rejected: too late. Kept as the final review, paired with reviews after each slice.

### D. Team-defined reviewer panels, several lenses in parallel — Rejected

- What it means for users: teams define their own reviewers (plan fit, decisions, correctness, knowledge, security…) and Weave runs several in parallel and merges their findings.
- Trade-offs: overlapping and conflicting findings, cost that grows with each reviewer, findings people learn to ignore.
- Why rejected: one strong reviewer whose checklist covers every lens gives the same coverage without duplicate findings. Team standards are captured through coding guidelines instead.

### E. Review after each slice, plus a final whole-change review, run by the agent with rulings reported — Chosen

- What it means for users: each finished slice is reviewed and fixed without the person's involvement; once every slice is reviewed, a final review of the whole change runs on its own; the person receives a verdict and the full list of decisions the agent made on their behalf.
- Trade-offs: some fixes the person might have disagreed with are already made by the time they see them; costs more than a single end-of-change review.
- Why chosen: catches defects before later slices build on them, catches problems that only show across slices or repositories, and keeps the person's attention on the decisions rather than on routine fixes.

### Sub-choices settled within E

- **Final review: person walks through every finding first** — Rejected. Requires the person to be present and to approve obvious fixes.
- **Final review: mixed (agent fixes clear-cut findings, person decides judgement calls)** — Rejected in favour of the agent acting on everything and reporting rulings, with the one exception that plan conflicts always stop for the person.
- **Slice findings reviewed by the person** — Rejected. Slice reviews are frequent; walking through each would be tiring.
- **Confirmed findings become new tasks in the slice** — Rejected. Findings are fixed directly and recorded in the slice's review record, which shows what changed without inflating the task list.
- **Reviewers installed as separate named agents with enforced read-only access** — Rejected in favour of reviewer instructions that live inside the review skill and are handed to a general-purpose reviewer, with the model chosen by capability level each time.

## Chosen Direction

### The two kinds of review

1. **Slice review.** When the last task of a slice is done, an independent reviewer checks the slice.
   - **What starts it:** the build session that finishes a slice's last task runs the review right there, in the foreground, before it moves on; that session waits for the review and its fixes. Nothing runs in the background. If the last task was finished by hand, or in a session that ended before the review ran, the slice shows **tasks done, not reviewed** and "what next" recommends running the review skill on that slice.
   - Every task in the slice counts, including tasks finished as "not tested": the slice is still reviewed, and the untested tasks are called out in its review record and in the final verdict.
   - The reviewer starts with no memory of how the slice was built. It sees only what is written down: the slice and its acceptance criteria, whichever planning documents the change has (PRD, architecture, exploration, or for fixes the findings), the recorded decisions that apply, the coding guidelines, and the code the slice changed, across every repository the slice touches.
   - It treats the build evidence recorded on each task (what passed, which criteria are met) as claims to check, not as facts.
   - It never changes code and never brings in other reviewers.
   - It returns what was done well, findings ranked Critical, Important, or Minor (each naming where in the code and which requirement, decision, or guideline it fails), anything it chose not to judge with the reason, and a verdict.
2. **Final review.** Once every slice has been reviewed, a final review of the whole change starts on its own.
   - **What starts it:** the session that completes the last slice review (automatic or on demand) starts the final review straight away. If that session has ended, "what next" recommends it. It does not start while any slice is waiting on a person, not reviewed, or out of date.
   - It runs on the most capable model available.
   - It checks the whole change against its planning documents (the PRD where there is one), looks for problems that only show across slices or repositories (inconsistent handling, a requirement that fell between slices, duplicated logic), checks the change stays within recorded decisions, and checks the knowledge wiki will still describe the product once the change lands.
   - It also sorts the Minor findings and rulings saved from slice reviews into must-fix and can-wait.

### What happens with findings

- The agent that built the work receives the findings and checks each one against the code before acting. It fixes what holds up, explains and leaves alone what does not, asks rather than guesses when a finding is unclear, and does not add features nothing uses because a reviewer suggested them.
- **Slice review:** up to **2 rounds**. Each round, the agent fixes the Critical and Important findings it agrees with in one batch, re-runs the slice's automatic checks, and a fresh reviewer checks only those fixes. Anything still open after round 2 becomes a **ruling**: the agent's written reasoning for leaving it. Minor findings skip the rounds and go to the final review.
- Fixes stay within the slice's own code. A fix that would need to change code another slice built is not made; it becomes a ruling and goes to the final review.
- **Human checks.** If a slice's verification includes a step only a person can do (a visual check, a browser check, credentials), a fix touching that slice is marked **needs your check**: the automatic checks still run, the human step is listed in the review record and the verdict, and the slice is not blocked.
- **Final review:** the agent fixes the Critical and Important findings it agrees with and the Minor findings sorted as must-fix, in one batch, then a fresh reviewer checks those fixes once. Anything still open becomes a ruling.
- **Exception — the plan itself is wrong or incomplete.** If a finding shows the planning documents or a recorded decision are wrong, or that something the plan requires was built by no slice, the agent does not fix, build, or rule on it. It stops and asks the person, because that is a plan change. Examples: the slice does exactly what the architecture says and the architecture breaks a recorded decision; the final review finds a PRD requirement no slice covers.
- **Who decides what counts as a plan problem.** The reviewer labels each finding as a code problem or a plan problem. The agent can add its view to a plan-problem finding but cannot relabel it as a code problem; it still stops.
- At the end of the final review, the verdict and the complete list of rulings from every slice review and the final review are recorded on the change, each ruling with what it costs if it is wrong. The person running the session sees them there, and anyone working on the change sees them in the change status. Weave sends no notifications and never merges.
- **Verdicts:**
  - **ready to merge**: nothing is left open.
  - **ready with parked items**: only parked items are left. A parked item is a Minor finding sorted as can-wait, or a ruling, or a human check still to do.
  - **not ready**: a plan problem is waiting on a person, part of the change could not be reviewed (for example, a repository was missing), or a Critical finding the agent agreed with is still not fixed.
- **Seeing and undoing a fix.** Each fix in the review record lists the finding it addressed and exactly what it changed, so a person can find a fix they disagree with and reverse it.

### Slice states

- A slice moves from **tasks done** to **in review** to **reviewed**, or **reviewed with rulings** when anything was set aside.
- A slice that finished its tasks without a review running shows **tasks done, not reviewed**.
- A slice whose review found a plan problem is **waiting on you**. The slice's owner decides it; if the slice has no owner, whoever is working on the change does. Nothing times out: the slice and the final review wait, and the change status keeps showing it.
- **Resolving a plan problem.** The person either changes the plan through Weave's existing tools (revising the PRD or architecture, or replacing a recorded decision), or dismisses the finding, which records it as the person's own ruling. Changing the plan marks the planning work built on it as out of date, as today; the slice is then reviewed again against the updated plan, and slices already built on the old plan are flagged for review again too.
- A slice's **reviewed** state, and the change's verdict, show as **out of date** when the code they cover changes afterwards (hand edits, tasks added to the slice, bringing in newer work from the main branch). "What next" recommends reviewing again.
- Each slice keeps a review record: the findings, fixes (with what each changed), rulings, saved Minor findings, untested tasks and human checks, and the history of every review run on it.
- Weave's "what next" guidance and the change status show review progress, for example "slice 2 reviewed, 1 ruling" or "slice 3 waiting on you: plan problem".
- The session that built a slice waits for its review before starting another slice. Other people or sessions may build later slices at the same time, unless those slices depend on the one in review. A slice that depends on one waiting on a person waits too.

### Running a review on demand

- The person can run a review at any time through the review skill, on a single slice or on the whole change, and run it again as often as they like (for example after editing code by hand or changing guidelines).
- It behaves like the automatic review for that scope. Each run is added to the history.
- Running it before all slices are done reviews what exists so far and records that it was partial.
- Later reviews read earlier rulings and do not raise the same finding again unless the code it covers has changed, or the guideline, planning document, or recorded decision the ruling relied on has changed. Either change reopens the ruling.
- A change with no slices (older changes that keep one flat task list) gets no slice reviews; the person can run the whole-change review on demand.

### Coding guidelines

- **Shared guidelines** hold rules that apply everywhere (for example error handling, security, testing expectations). They live in one place for the whole Weave workspace. Setting up a workspace writes a starter set the team then owns and edits; Weave upgrades never overwrite it.
- **Repository guidelines** hold what is specific to one repository's language and stack. Weave looks for them in a file with a fixed name at a known place in each repository. Weave does not search other files a repository may already have for conventions; teams copy or link those into the guidelines file.
- Both always apply. When they conflict, the repository's guidelines win.
- A repository without its own file is reviewed against the shared guidelines only. If the shared file is missing too, the review still runs against the planning documents, decisions, and any repository guidelines, and the review record says no shared guidelines were found.
- **Single-repository projects** have one guidelines file: the project's own. Layering only applies when a workspace holds several repositories.
- A review uses the guidelines as they are in the change's own folder, so guideline edits made on the change apply to that change's review.
- If a repository the slice touches is not available locally, that part cannot be reviewed; the record says the review was partial, and the change's verdict cannot be better than **not ready** until it is reviewed.
- When a slice spans repositories, one reviewer reads all of the slice's code and applies each repository's guidelines to that repository's code. This lets it spot mismatches between repositories (for example, what a server returns versus what a screen expects).

### How reviewers are run

- Reviewer instructions live inside the review skill as fill-in-the-blank briefs (one for slice reviews, one for checking fixes, one for the final review). Each review hands a filled brief to a general-purpose reviewer with a fresh context.
- The rules each reviewer follows (read-only, no further reviewers, evidence is claims to verify, fixed report format) are part of the brief.
- The model is chosen by capability level every time and must always be stated, never left to default:
  - slice reviews: sized to the slice's size and risk, never below mid-level
  - checks of fixes: cheap to mid-level
  - final review: the most capable model available
- The skill describes actions ("hand this to a reviewer") so the same skill text works across agent clients, each mapping it to its own way of running a separate reviewer.

### Rollout

- Review applies to every change type that is built from slices (features, fixes, refactors, chores, and others). The reviewer checks against whichever planning documents the change has: for a fix, its findings; for a chore or refactor, its exploration or architecture; always the slices' acceptance criteria and recorded decisions.
- Review is on by default for new changes, once the review skill is installed.
- Changes already in progress: slices finished before this ships are not reviewed retroactively; the next slice to finish is reviewed, and the final review still runs.
- A team can turn reviews off for the workspace. A person can skip review for one change (for example docs only); the change records "review skipped" so the skip is visible.
- New workspaces get the starter shared guidelines on set-up.
- Existing projects: updating Weave does not add new skills or files on its own today. Weave's status tells an existing team that reviews are available and how to install them. The starter guidelines file is written into an existing project only when a person asks for it, never silently during an update.

## Scenarios

1. **Slice review fixes a bug on its own.** Priya's change has four slices. When slice 1's last task is done, the slice reviewer finds an Important issue: a failure case returns success silently, against the shared guideline "no silent failures". The agent confirms it, fixes it, re-runs the slice's checks, and a fresh reviewer confirms the fix. Slice 1 shows "reviewed". Priya was never interrupted.
2. **The agent disagrees with a reviewer.** The reviewer on slice 2 asks for a caching layer "for performance". The agent checks and finds nothing calls the code often enough to matter; it declines with that reasoning. After 2 rounds it is still open, so it becomes a ruling. Slice 2 shows "reviewed with rulings", and the ruling appears in Priya's final list with what it costs if wrong.
3. **The plan is wrong.** Slice 3 does exactly what the architecture says, but the reviewer finds that this breaks a recorded decision. The agent stops. Slice 3 shows "waiting on you: plan conflict". Slice 4, which does not depend on slice 3, continues; anything depending on slice 3 waits.
4. **Two repositories, two stacks.** Slice 2 changes an endpoint in the Go backend and the screen that calls it in the React app. One reviewer reads both; it applies the backend's guidelines (which say errors are wrapped with context) to the Go code and the web repository's guidelines to the React code, with shared guidelines underneath both. It flags that the screen expects a field the endpoint no longer returns.
5. **Final review runs unattended.** All four slices are reviewed. The final review, on the most capable model, finds that slices 1 and 4 handle the same error differently. The agent fixes the inconsistency, a fresh reviewer confirms it, and the change records "ready with parked items" (one ruling, one can-wait Minor finding) and the full rulings list, which Priya reads in the change status.
6. **Final review finds a gap in the plan.** The final review also finds a PRD requirement that no slice built. The reviewer labels it a plan problem. The agent does not build it; the change shows "not ready: waiting on you". Priya either adds a slice for it or dismisses it, and the final review then completes.
7. **Re-running after a hand edit.** After reading the rulings, Priya edits slice 2's code herself and re-runs the review on slice 2. The reviewer does not raise the caching ruling again unless the code it covered changed. The new run is added to slice 2's history.
8. **Agent client without separate reviewers.** On a client that cannot hand work to a separate reviewer, the review runs inside the same session and the record notes it was less independent.
9. **Several people on one change.** Arjun owns slice 2 and Mei owns slice 3. Slice 3's review finds a plan problem; Mei decides it. Arjun keeps building slice 2 in his own session meanwhile. The final review waits until Mei has decided, and its verdict and rulings are recorded on the change for both of them.
10. **A slice finished by hand.** Mei finishes slice 3's last task by hand without running a build session. The slice shows "tasks done, not reviewed", and "what next" recommends reviewing it before the final review can start.
11. **A fix needs a human check.** A review fix touches slice 4's sign-in screen, whose verification includes a visual check. The automatic checks pass; the fix is marked "needs your check" and appears as a parked item in the verdict.
12. **Code changes after review.** After slice 1 is reviewed, Priya hand-edits one of its files. Slice 1 shows "reviewed, out of date", and so does the verdict if one exists.

## Decisions

- Review happens after each slice and once over the whole change, never after each task — a slice is the smallest complete, testable unit, and the whole-change review catches what slice reviews cannot see.
- Reviewers start with fresh context and see only what is written down plus the code — the agent that built the work is inclined to defend it; this matches how Weave's stress test already critiques plans.
- The agent acts on findings and reports rulings; the person is not asked to approve fixes — keeps the build moving and puts the person's attention on decisions, not routine fixes.
- The agent checks each finding against the code before acting and may push back with reasoning — reviewers are wrong sometimes; blind fixes cause harm.
- Slice reviews allow up to 2 fix rounds; the final review allows one batch of fixes and one check — enough to resolve most findings without loops that hide a problem the implementer cannot see.
- Plan conflicts always stop for the person — changing the PRD, architecture, or a recorded decision is the person's call.
- Minor findings are saved for the final review rather than fixed per slice — keeps slice reviews focused; the final review decides what must be fixed.
- Findings are fixed directly and recorded in the slice's review record, not turned into new tasks — the record shows what changed without inflating the task list.
- One reviewer per review, not parallel reviewers per lens; the final reviewer's checklist covers plan fit, decisions, correctness, and knowledge — avoids duplicate and conflicting findings.
- Final review runs on the most capable model; other reviews are sized by capability level and never left to the session default — matches cost to the risk of each review.
- Reviewer instructions live inside the review skill as briefs handed to a general-purpose reviewer, not as separately installed agents — one skill text for every client; accepted trade-off: read-only is asked for in the instructions, not enforced by the client.
- Coding guidelines are layered: shared guidelines owned by the team plus an optional fixed-name file per repository; both apply, the repository wins on conflict — each repository's language and stack needs its own rules, while some rules apply everywhere.
- The shared guidelines are a starter set Weave writes once and the team owns; upgrades never overwrite it — teams can see and change every rule the reviewer applies.
- Weave looks only in the fixed-name guidelines file per repository, not other convention files — predictable and simple.
- One reviewer per slice even when it spans repositories — so mismatches between repositories are visible.
- Rulings prevent the same finding from being raised again unless the code it covers changed — avoids re-litigating decisions.
- Review is on by default, can be turned off per workspace or skipped per change, and a skip is recorded — safe default with a visible escape hatch.
- The person can run a review on a slice or the whole change at any time, repeatedly — covers hand edits and guideline changes.
- Weave records the verdict but never merges — merging stays the person's action.
- Reviews run inside the session that is building, never in the background; anything that did not get reviewed shows as "not reviewed" and "what next" recommends it — matches how Weave works today (no background agents) and keeps every review visible. Running a review is part of building, not a move between planning stages, so the rule that steps where a person decides never auto-advance is not affected.
- Plan gaps (a requirement no slice built) stop for the person exactly like plan conflicts, and the reviewer, not the agent, labels a finding as a plan problem — the agent that built the work must not decide on its own to build new scope or downgrade a plan problem.
- A plan problem on a slice belongs to the slice's owner, else whoever is working on the change; outcomes are recorded on the change rather than sent to anyone — Weave has no notifications, and the change status is where everyone already looks.
- Review fixes stay within the slice's own code — avoids clashing with other slices being built in parallel.
- Human checks never block an unattended review; they are listed as "needs your check" — keeps the review hands-off without pretending a human step happened.
- "Reviewed" states and verdicts go out of date when the code they cover changes, and rulings reopen when what they relied on changes — a verdict must describe the code that will actually be merged.
- Every review fix is listed with what it changed — the person accepted fixes being made before they see them, so each must be findable and reversible.
- Review covers every change type built from slices, checking against whichever planning documents exist — fixes and refactors deserve review too.
- Existing projects are told reviews exist and opt in to the starter guidelines; nothing is written into their project silently — an update that adds team-owned files unannounced would surprise people.
- Single-repository projects have one guidelines file, and a change's review uses the guidelines in that change's own folder — simplest for the common case, and lets a change that edits guidelines be reviewed by them.

## Assumptions

- Agent clients that cannot run a separate reviewer run the review inside the same session, with less independence, and the record says so — the same rule the stress test already follows.
- Execution's existing per-task verification stays as it is; review adds to it and does not replace it.
- Mid-level is a sensible floor for slice reviewers; cheaper models take more turns and end up costing more.
- Weave does not guard against two people editing the same files in one change folder today; reviews do not change that beyond keeping fixes inside the slice's own code.

## Open Questions

- What each capability level (cheap, mid, most capable) means for each supported agent client, and whether teams can override it — blocks the PRD: no (architecture).
- The fixed file name and location for repository guidelines, and where the shared guidelines live in the workspace — blocks the PRD: no (architecture).
- Can teams raise the number of slice fix rounds above 2? — blocks the PRD: no.
- Should the person be able to choose which agent reviews, so code written by one agent is reviewed by another? — blocks the PRD: no.
- How "the code a slice changed" and "what each fix changed" are determined when execution does not commit, so a review has a clear boundary and fixes can be reversed — blocks the PRD: no (architecture).
- How Weave tells that a slice's code changed after its review, to show it as out of date — blocks the PRD: no (architecture).
- Should Weave's existing plan critic later move to the same reviewer-brief approach for consistency? — blocks the PRD: no (out of scope for this change).

## PRD Readiness

Ready
