---
artifact: prd
status: draft
owner: product
created_at: 2026-11-09T22:44:02.000Z
updated_at: 2026-11-09T22:44:02.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: exploration.md
---

# Code Reviewers PRD

## Problem Statement

Teams use Weave to plan a change in detail before building it: a PRD, an architecture, slices with acceptance criteria, and recorded decisions. Then an agent builds the change task by task. Nothing checks the finished code against that plan.

- **Who has the problem:** engineers and product owners who run Weave changes and later merge them, and teams whose changes span several repositories.
- **What they are trying to do:** merge code that does what the change said it would do, follows the agreed architecture, stays within recorded decisions, and meets the team's coding standards.
- **What is missing today:**
  - Task verification shows the code *works* (tests, typecheck and build pass). It does not show the code *matches the plan*.
  - The agent that built the code is the only one that has looked at it, and it tends to trust its own work.
  - Problems found late, after later slices have built on them, are expensive to undo.
  - Weave has no coding guidelines. When a change spans repositories with different languages and conventions, there is no standard to review against.
- **Why it matters:** the planning work only pays off if the result is checked against it. Without an independent check, gaps between plan and code reach the merge unnoticed.

## Goals

1. Each finished slice is reviewed by an independent reviewer, and fixed, before later slices build on it, without needing the person.
2. Once every slice is reviewed, the whole change is reviewed for problems that only show across slices or repositories, and for fit with the plan, recorded decisions, and the knowledge wiki.
3. The person's attention goes to decisions (rulings and plan problems), not to approving routine fixes.
4. Changes to the plan (the PRD, the architecture, or a recorded decision) are always the person's decision. The agent never makes one on its own.
5. Teams can state their coding standards: shared rules for every repository, plus rules for each repository's language and stack.
6. The person gets a clear verdict on whether the change is ready to merge, and the verdict always describes the code that will actually be merged.
7. Every fix the agent makes on its own can be found and undone.

## Non-Goals

- Reviewing after every task. Task verification already covers "does it work".
- Panels of several reviewers, each with its own focus, running in parallel.
- Reviewers installed as separate named agents with enforced read-only access.
- Turning review findings into new tasks.
- Merging, committing, or opening pull requests. Weave records a verdict, and merging stays the person's action.
- Sending notifications (in-app, email, chat). Outcomes are recorded on the change.
- Running reviews in the background.
- Reviewing slices retroactively in changes that were already in progress when this ships.
- Reading convention files in a repository other than its guidelines file.
- Replacing or changing today's per-task verification.

## Actors

- **Person running the change:** starts build sessions, reads verdicts and rulings, resolves plan problems, runs on-demand reviews.
- **Slice owner:** the person assigned to a slice. Decides plan problems found on that slice.
- **Build agent:** the agent that built the slice. It receives findings, checks them against the code, fixes what holds up, writes rulings for what it leaves, and stops on plan problems.
- **Slice reviewer:** an independent reviewer with fresh context. It reviews one slice, across every repository the slice touches.
- **Fix checker:** a fresh independent reviewer that checks only the fixes made in a round.
- **Final reviewer:** an independent reviewer on the most capable model available. It reviews the whole change.
- **Team:** owns the shared and repository coding guidelines. Can turn reviews off for the workspace.
- **Agent client:** the tool the person uses to run Weave skills. Some clients can hand work to a separate reviewer and some cannot.

## Current Behavior

- A change is built task by task. Each task is implemented and its verification is run, and the evidence (passing checks, acceptance criteria met) is recorded on the task. A task is marked done when verification passes. Nothing is committed automatically.
- A slice is finished when all its tasks are done. There is no review of a slice or of the whole change.
- Weave already has an independent critic, but only for plans. The stress test hands the written product or architecture shape to a reviewer that never saw the conversation behind it. The reviewer ranks weak points, and the answers are written back into the shape. When the agent client cannot run a separate reviewer, the critique runs inside the same session, with less independence.
- Recorded decisions apply to specific parts of the code, and agents are told to work within them.
- Weave has no coding guidelines, shared or per repository.
- Weave works with several agent clients and does not rely on any one client's built-in features.
- Updating Weave does not install new skills or write new files into a project by itself.
- Older changes may keep one flat task list with no slices.

**Workarounds and pain today:** the person must read the code against the plan themselves, or ask an agent for an ad hoc review with no standard brief, guidelines, or record. Problems that cross slices or repositories are easy to miss.

## Proposed Product Behavior

Weave adds two kinds of independent code review to building a change. A review skill can also run either one on demand. Teams set coding guidelines that reviewers apply.

### Slice review

- **Trigger.** When the build session finishes the last task of a slice, it runs the slice review right away, in the foreground, and waits for the review and its fixes before moving on.
- **Missed reviews.** If the last task was finished by hand, or in a session that ended before the review ran, the slice shows **tasks done, not reviewed**, and "what next" recommends running the review skill on it.
- **Untested tasks.** Every task counts, including tasks finished as "not tested". The slice is still reviewed, and its untested tasks are called out in the review record and in the final verdict.
- **What the reviewer sees.** The reviewer starts with no memory of how the slice was built. It sees only what is written down:
  - the slice and its acceptance criteria
  - the change's planning documents (PRD, architecture, exploration, or for fixes, the findings)
  - the recorded decisions that apply
  - the coding guidelines
  - the code the slice changed, in every repository it touches
- **How it treats evidence.** The build evidence on each task is treated as claims to check, not as facts.
- **Limits.** The reviewer never changes code and never brings in other reviewers.
- **Report.** The reviewer returns:
  - what was done well
  - findings ranked **Critical**, **Important**, or **Minor**, each naming the place in the code and the requirement, decision, or guideline it fails, and each labelled a **code problem** or a **plan problem**
  - anything it chose not to judge, with the reason
  - a verdict

### Final review

- **Trigger.** Once every slice has been reviewed, the session that completed the last slice review (automatic or on demand) starts the final review straight away. If that session has ended, "what next" recommends it.
- **When it cannot start.** It does not start while any slice is waiting on a person, not reviewed, or out of date.
- **Model.** It runs on the most capable model available.
- **What it checks.**
  - the whole change against its planning documents (the PRD where there is one)
  - problems that only show across slices or repositories, such as inconsistent handling, a requirement that fell between slices, or duplicated logic
  - that the change stays within recorded decisions
  - that the knowledge wiki will still describe the product once the change lands
- **Saved Minor findings.** It sorts the Minor findings and rulings saved from slice reviews into **must-fix** and **can-wait**.

### Handling findings

- **Checking before acting.** The build agent checks each finding against the code before acting. It fixes what holds up, and explains and leaves alone what does not. When a finding is unclear, it asks rather than guessing. It does not add features nothing uses just because a reviewer suggested them.
- **Slice review rounds.** A slice review allows up to **2 rounds**. Each round:
  1. the agent fixes, in one batch, the Critical and Important findings it agrees with
  2. it re-runs the slice's automatic checks
  3. a fresh fix checker checks only those fixes

  Anything still open after round 2 becomes a **ruling**: the agent's written reasoning for leaving it. Minor findings skip the rounds and are saved for the final review.
- **Fixes stay in the slice.** Fixes stay within the slice's own code. If a fix would need to change code another slice built, it is not made. It becomes a ruling and goes to the final review.
- **Human checks.** Some slices have a verification step only a person can do, such as a visual check, a browser check, or entering credentials. A fix touching such a slice is marked **needs your check**. The automatic checks still run, the human step is listed in the review record and the verdict, and the slice is not blocked.
- **Final review fixes.** The agent fixes, in one batch, the Critical and Important findings it agrees with plus the Minor findings sorted as must-fix. Then a fresh fix checker checks those fixes once. Anything still open becomes a ruling.
- **Plan problems always stop.** A plan problem is a finding that shows one of these:
  - a planning document or recorded decision is wrong
  - something the plan requires was built by no slice

  For a plan problem the agent does not fix, build, or rule. It stops and asks the person. The reviewer, not the agent, decides whether a finding is a plan problem. The agent may add its view, but it cannot relabel a plan problem as a code problem.
- **Recording rulings.** At the end of the final review, the verdict and the full list of rulings from every slice review and the final review are recorded on the change. Each ruling says what it costs if it is wrong.
- **Finding and undoing fixes.** Each fix in the review record names the finding it addressed and exactly what it changed, so a person can find a fix and reverse it.

### Verdicts

- **ready to merge**: nothing is left open.
- **ready with parked items**: only parked items are left. A parked item is one of:
  - a Minor finding sorted as can-wait
  - a ruling
  - a human check still to do
- **not ready**: one of these is true:
  - a plan problem is waiting on a person
  - part of the change could not be reviewed (for example, a repository was missing)
  - a Critical finding the agent agreed with is still not fixed

### Running a review on demand

- The person can run the review skill at any time, on one slice or on the whole change, as often as they like (for example, after editing code by hand or changing guidelines). It behaves like the automatic review for that scope, and each run is added to the history.
- If not all slices are done, an on-demand review covers what exists so far and records that it was partial.
- A change with no slices (a flat task list) gets no slice reviews, but the person can run the whole-change review on demand.

### Rulings and re-review

- Later reviews read earlier rulings and do not raise the same finding again.
- A ruling reopens if either of these changes:
  - the code the ruling covers
  - the guideline, planning document, or recorded decision it relied on

### Coding guidelines

- **Shared guidelines** hold rules that apply everywhere (for example, error handling, security, testing expectations). There is one set for the whole Weave workspace. Setting up a workspace writes a starter set, which the team then owns and edits. Weave upgrades never overwrite it.
- **Repository guidelines** hold rules specific to one repository's language and stack. Weave looks for them in a file with a fixed name at a known place in each repository. Weave does not search a repository's other files for conventions. Teams copy or link those into the guidelines file.
- **Layering.** Both sets always apply. When they conflict, the repository's guidelines win.
- **Single-repository projects** have one guidelines file, the project's own. Layering only applies when a workspace holds several repositories.
- **Missing files.**
  - A repository without its own guidelines file is reviewed against the shared guidelines only.
  - If the shared file is also missing, the review still runs against the planning documents, recorded decisions, and any repository guidelines. The review record says no shared guidelines were found.
- **Which version applies.** A review uses the guidelines as they are in the change's own folder, so guideline edits made on a change apply to that change's review.
- **Changes across repositories.**
  - When a slice spans repositories, one reviewer reads all of the slice's code and applies each repository's guidelines to that repository's code. This lets it catch mismatches between repositories, such as a screen expecting a field an endpoint no longer returns.
  - If a repository the slice touches is not available locally, that part cannot be reviewed. The record says the review was partial, and the change's verdict cannot be better than **not ready** until that part is reviewed.

### How reviewers are run

- Reviewer instructions live inside the review skill as fill-in-the-blank briefs: one for slice reviews, one for checking fixes, and one for the final review. Each review hands a filled brief to a general-purpose reviewer with a fresh context.
- The brief includes the rules the reviewer follows: read-only, no further reviewers, evidence is claims to check, and a fixed report format. Read-only is asked for in the brief. The agent client does not enforce it.
- The model is chosen by capability level every time and is always stated, never left to the session default:
  - slice reviews: sized to the slice's size and risk, never below mid-level
  - fix checks: cheap to mid-level
  - final review: the most capable model available
- The skill describes actions ("hand this to a reviewer"), so the same skill text works with every agent client. Each client runs a separate reviewer in its own way.
- If a client cannot run a separate reviewer, the review runs inside the same session and the record notes that it was less independent.

## User Workflows

### Workflow: Build session finishes a slice and reviews it unattended

1. The person (or an agent session) builds a slice's tasks.
2. The session finishes the slice's last task, and the slice shows **tasks done**.
3. The session starts the slice review in the foreground, and the slice shows **in review**.
4. A slice reviewer with fresh context reviews the slice against its acceptance criteria, the planning documents, the recorded decisions that apply, the coding guidelines, and the slice's code in every repository it touches.
5. The build agent checks each Critical and Important finding against the code. It fixes the ones it agrees with in one batch and re-runs the slice's automatic checks.
6. A fresh fix checker checks only those fixes. Steps 5 and 6 repeat at most once more.
7. Anything still open becomes a ruling. Minor findings are saved for the final review.
8. The slice shows **reviewed**, or **reviewed with rulings** if anything was set aside. The review record holds the findings, the fixes with what each changed, rulings, saved Minor findings, untested tasks, human checks, and the run history.
9. The session moves on to its next slice.

### Workflow: Slice review finds a plan problem

1. The slice reviewer labels a finding a plan problem. Either the slice follows the architecture but the architecture breaks a recorded decision, or the plan is otherwise wrong.
2. The build agent may add its view but does not fix, build, or rule on it. It stops.
3. The slice shows **waiting on you: plan problem**, and the change status shows it too.
4. The slice owner decides. If the slice has no owner, whoever is working on the change decides.
5. While it waits, other people or sessions can keep building slices that do not depend on this one. Slices that depend on it wait. The final review does not start.
6. The person resolves it in one of two ways:
   - **Changes the plan** with Weave's existing tools: revises the PRD or architecture, or replaces a recorded decision. Planning work built on it is marked out of date, as today. The slice is reviewed again against the updated plan, and slices already built on the old plan are flagged for review again.
   - **Dismisses the finding.** It is recorded as the person's own ruling.
7. Nothing times out. The slice waits until it is resolved.

### Workflow: Final review runs unattended

1. The session that completes the last slice review sees that every slice is reviewed and none is waiting, not reviewed, or out of date.
2. It starts the final review on the most capable model available.
3. The final reviewer checks the whole change against its planning documents, across slices and repositories, against recorded decisions, and against the knowledge wiki. It sorts the saved Minor findings and rulings into must-fix and can-wait.
4. The build agent fixes, in one batch, the Critical and Important findings it agrees with and the must-fix Minor findings. A fresh fix checker checks them once.
5. Anything still open becomes a ruling. Plan problems (including a PRD requirement no slice built) stop for the person, and the change shows **not ready: waiting on you**.
6. The change records its verdict (**ready to merge**, **ready with parked items**, or **not ready**) and the full list of rulings, each with what it costs if wrong.
7. The person reads the verdict and rulings in the change status and decides whether to merge.

### Workflow: Person re-runs a review on demand

1. The person edits code by hand, changes guidelines, or wants a fresh look.
2. They run the review skill on one slice or on the whole change.
3. The review behaves like the automatic review for that scope. Earlier rulings are not raised again unless their code or the material they relied on has changed.
4. The run is added to the history. If slices were not all done, the record says the review was partial.
5. If the run completes the last outstanding slice review, the final review starts.

### Workflow: Slice finished outside a build session

1. A person finishes a slice's last task by hand, or the session ends before the review runs.
2. The slice shows **tasks done, not reviewed**.
3. "What next" recommends running the review skill on that slice. The final review cannot start until it has been reviewed.

### Workflow: Code changes after a review

1. After a slice is reviewed, its code changes. This can be a hand edit, tasks added to the slice, or newer work brought in from the main branch.
2. The slice shows **reviewed, out of date**, and so does the change's verdict if one exists.
3. "What next" recommends reviewing again.

### Workflow: Team sets up and maintains guidelines

1. When a new workspace is set up, Weave writes a starter shared guidelines file.
2. The team edits the shared guidelines and adds a fixed-name guidelines file to each repository that needs stack-specific rules.
3. Reviews apply both, and the repository's rules win on conflict.
4. An existing project asks Weave for the starter guidelines file when it wants one. Weave never writes it during an update.

### Workflow: Turning reviews off or skipping them

1. A team turns reviews off for the workspace, and no automatic reviews run.
2. Or a person skips review for one change (for example, a docs-only change), and the change records **review skipped**.

## User Stories

1. As a person running a change, I want each finished slice reviewed and fixed without my involvement, so that defects are caught before later slices build on them.
2. As a person running a change, I want a final review of the whole change to run on its own once every slice is reviewed, so that problems across slices or repositories are caught before merge.
3. As a person running a change, I want a single verdict (ready to merge, ready with parked items, not ready), so that I know whether I can merge.
4. As a person running a change, I want the full list of rulings, each with what it costs if wrong, so that I can review the decisions the agent made on my behalf.
5. As a person running a change, I want every fix listed with the finding it addressed and what it changed, so that I can find and reverse any fix I disagree with.
6. As a slice owner, I want plan problems on my slice to stop and wait for me, so that the agent never changes the plan or builds new scope on its own.
7. As a person running a change, I want to resolve a plan problem by changing the plan or by dismissing the finding, so that the change can move on either way.
8. As a person running a change, I want plan gaps (a requirement no slice built) to stop for me just like plan conflicts, so that new scope is always my decision.
9. As a person running a change, I want reviewers to start with no memory of how the code was built, so that they are not inclined to defend it.
10. As a person running a change, I want reviewers to treat recorded build evidence as claims to check, so that a passing claim is not taken on trust.
11. As a person running a change, I want the build agent to check each finding and push back with reasons when the reviewer is wrong, so that blind fixes do not cause harm.
12. As a person running a change, I want slice reviews limited to two fix rounds, so that a problem the agent cannot see does not cause an endless loop.
13. As a person running a change, I want Minor findings saved for the final review, so that slice reviews stay focused and the final review decides what must be fixed.
14. As a person running a change, I want a slice whose tasks finished outside a build session to show "tasks done, not reviewed" and be recommended by "what next", so that nothing is merged unreviewed by accident.
15. As a person running a change, I want slices with "not tested" tasks still reviewed, with the untested tasks called out, so that missing verification is visible in the verdict.
16. As a person running a change, I want fixes touching a slice with a human-only verification step marked "needs your check", so that the review stays unattended without pretending the human step happened.
17. As a person running a change, I want a reviewed slice and the verdict to show "out of date" when the code they cover changes, so that the verdict always describes the code I will merge.
18. As a person running a change, I want to run a review on one slice or the whole change at any time, as often as I like, so that hand edits and guideline changes are reviewed too.
19. As a person running a change, I want later reviews not to raise a finding that already has a ruling unless its code or the material it relied on changed, so that settled points are not argued again.
20. As a team, I want shared coding guidelines for the workspace that we own and that Weave upgrades never overwrite, so that every rule the reviewer applies is visible and editable by us.
21. As a team with several repositories, I want a fixed-name guidelines file per repository that wins over the shared rules on conflict, so that each language and stack is reviewed by its own conventions.
22. As a team with one repository, I want a single guidelines file, so that the common case stays simple.
23. As a person running a change that spans repositories, I want one reviewer to read all of a slice's code and apply each repository's guidelines to its own code, so that mismatches between repositories are caught.
24. As a person running a change, I want a review with a missing repository to say it was partial and keep the verdict at "not ready", so that an unreviewed part is never reported as ready.
25. As a person editing guidelines on a change, I want that change's review to use the guidelines in its own folder, so that my guideline edits apply to it.
26. As a team, I want to turn reviews off for the workspace, so that we can opt out entirely.
27. As a person running a docs-only change, I want to skip review for that change with the skip recorded, so that the escape hatch is visible to others.
28. As a person on an existing project, I want Weave's status to tell me reviews are available and how to install them, and I want the starter guidelines written only when I ask, so that nothing appears in my project unannounced.
29. As a person with a change already in progress when this ships, I want the next slice to finish to be reviewed and the final review to still run, without retroactive reviews of slices already finished.
30. As a person with a flat (unsliced) change, I want to run the whole-change review on demand, so that older changes can still be reviewed.
31. As a person working on a fix, chore, or refactor, I want the review to check against whatever planning documents the change has (findings, exploration, or architecture), so that every change built from slices is reviewed.
32. As a person using an agent client that cannot run a separate reviewer, I want the review to run in the same session with the record noting reduced independence, so that I still get a review and know its limits.
33. As one of several people on a change, I want to keep building independent slices while another slice waits on its owner, so that one plan problem does not stall unrelated work.

## Functional Requirements

### Triggers and sequencing

- FR1. The build session that finishes the last task of a slice should run that slice's review in the foreground before it moves on, and should wait for the review and its fixes.
- FR2. The system should never run reviews in the background.
- FR3. A slice whose tasks are all done without a review having run should show **tasks done, not reviewed**, and "what next" should recommend reviewing it.
- FR4. Tasks finished as "not tested" should count toward a slice being done. The slice should still be reviewed, and its untested tasks should be called out in the review record and the final verdict.
- FR5. The session that completes the last slice review (automatic or on demand) should start the final review straight away. If that session has ended, "what next" should recommend the final review.
- FR6. The final review should not start while any slice is waiting on a person, not reviewed, or out of date.
- FR7. The session that built a slice should wait for that slice's review before starting another slice. Other people or sessions may build other slices at the same time, unless those slices depend on one that is in review or waiting on a person.

### Reviewer inputs and behaviour

- FR8. Every reviewer should start with fresh context and see only:
  - the written slice or change and its acceptance criteria
  - the change's planning documents (PRD, architecture, exploration, or findings for fixes)
  - the recorded decisions that apply
  - the coding guidelines
  - the code under review, in every repository it touches
- FR9. Reviewers should treat recorded build evidence as claims to check, not as facts.
- FR10. Reviewers should not change code and should not bring in other reviewers.
- FR11. A slice reviewer should return:
  - what was done well
  - findings ranked Critical, Important, or Minor, each naming the place in the code and the requirement, decision, or guideline it fails, and each labelled a code problem or a plan problem
  - anything it chose not to judge, with the reason
  - a verdict
- FR12. The final reviewer should check:
  - the whole change against its planning documents
  - problems that only show across slices or repositories
  - that the change stays within recorded decisions
  - that the knowledge wiki will still describe the product once the change lands

  It should also sort the Minor findings and rulings saved from slice reviews into must-fix and can-wait.
- FR13. One reviewer should handle each review, including a slice that spans several repositories. That reviewer should apply each repository's guidelines to that repository's code.

### Acting on findings

- FR14. The build agent should check each finding against the code before acting. It should fix what holds up, explain and leave what does not, ask when a finding is unclear, and not add unused features because a reviewer suggested them.
- FR15. A slice review should allow up to 2 fix rounds. Each round should:
  1. fix the agreed Critical and Important findings in one batch
  2. re-run the slice's automatic checks
  3. have a fresh fix checker check only those fixes
- FR16. Anything still open after the last allowed round should become a ruling with the agent's written reasoning.
- FR17. Minor findings from slice reviews should not be fixed in the slice rounds. They should be saved for the final review.
- FR18. Review fixes should stay within the slice's own code. A fix that would need to change another slice's code should not be made. It should become a ruling and go to the final review.
- FR19. If a fix touches a slice whose verification includes a human-only step, the system should mark it **needs your check**. It should still run the automatic checks, list the human step in the review record and the verdict, and not block the slice.
- FR20. The final review should fix, in one batch, the agreed Critical and Important findings plus the must-fix Minor findings. A fresh fix checker should check them once, and anything still open should become a ruling.
- FR21. For a finding labelled a plan problem, the agent should not fix, build, or rule on it, and should stop for the person. Plan problems include:
  - a planning document or recorded decision is wrong
  - a planned requirement was built by no slice
- FR22. Only the reviewer should decide whether a finding is a plan problem. The agent may add its view but should be prevented from relabelling a plan problem as a code problem.
- FR23. Each fix in the review record should name the finding it addressed and exactly what it changed.
- FR24. Each ruling should state what it costs if it is wrong.

### Plan problems

- FR25. A plan problem on a slice should be decided by the slice's owner, or, if the slice has no owner, by whoever is working on the change.
- FR26. A slice waiting on a plan problem should not time out. Slices that depend on it should wait too.
- FR27. The person should be able to resolve a plan problem in either of two ways:
  - change the plan with Weave's existing tools. Planning work built on it is marked out of date, as today. The slice should then be reviewed again against the updated plan, and slices already built on the old plan should be flagged for review again.
  - dismiss the finding, which is recorded as the person's own ruling.

### Verdicts, records, and visibility

- FR28. At the end of the final review, the system should record on the change the verdict and the full list of rulings from every slice review and the final review.
- FR29. The verdict should be one of:
  - **ready to merge**: nothing is left open
  - **ready with parked items**: only can-wait Minor findings, rulings, or human checks still to do are left
  - **not ready**: a plan problem is waiting, part of the change could not be reviewed, or an agreed Critical finding is still unfixed
- FR30. Each slice should keep a review record holding:
  - findings
  - fixes, with what each changed
  - rulings
  - saved Minor findings
  - untested tasks
  - human checks
  - the history of every review run on the slice
- FR31. The change status and "what next" should show review progress (for example "slice 2 reviewed, 1 ruling" or "slice 3 waiting on you: plan problem"), the verdict, and the rulings.
- FR32. The system should never merge and should send no notifications.

### Staleness and re-review

- FR33. A slice's reviewed state, and the change's verdict, should show as **out of date** when the code they cover changes afterwards (hand edits, tasks added to the slice, newer work from the main branch). "What next" should recommend reviewing again.
- FR34. A later review should not raise again a finding that already has a ruling. The ruling should reopen if either of these changes:
  - the code it covers
  - the guideline, planning document, or recorded decision it relied on

### On-demand review

- FR35. The person should be able to run the review skill on one slice or on the whole change, at any time, as often as they like. It should behave like the automatic review for that scope and add the run to the history.
- FR36. An on-demand review run before all slices are done should review what exists and record that it was partial.
- FR37. A change with no slices should get no slice reviews, but the person should be able to run the whole-change review on demand.

### Coding guidelines

- FR38. The workspace should have one shared guidelines file. Setting up a new workspace should write a starter set. Weave upgrades should never overwrite it.
- FR39. Weave should read repository guidelines only from a fixed-name file at a known place in each repository, and from no other files in the repository.
- FR40. Shared and repository guidelines should both apply. Repository guidelines should win on conflict.
- FR41. A single-repository project should have one guidelines file, the project's own.
- FR42. If guidelines files are missing:
  - A repository without its own file should be reviewed against the shared guidelines only.
  - If the shared file is also missing, the review should still run, and the record should say no shared guidelines were found.
- FR43. A review should use the guidelines as they are in the change's own folder.
- FR44. If a repository the review needs is not available locally, the review should be marked partial, and the change's verdict should not be better than **not ready** until that part is reviewed.

### Running reviewers

- FR45. Reviewer instructions should live inside the review skill as fill-in-the-blank briefs (slice review, fix check, final review), each handed to a general-purpose reviewer with fresh context. The briefs should include the reviewer rules: read-only, no further reviewers, evidence is claims to check, and a fixed report format.
- FR46. Every review should state the model's capability level explicitly:
  - slice reviews: sized to the slice's size and risk, never below mid-level
  - fix checks: cheap to mid-level
  - final review: the most capable model available
- FR47. The review skill should describe actions in a client-neutral way so the same text works with every supported agent client.
- FR48. If an agent client cannot run a separate reviewer, the review should run in the same session, and the record should note that it was less independent.

### Coverage and switches

- FR49. Review should apply to every change type built from slices. It should check against whichever planning documents the change has, plus the slices' acceptance criteria and recorded decisions.
- FR50. Review should be on by default for new changes once the review skill is installed.
- FR51. A team should be able to turn reviews off for the workspace.
- FR52. A person should be able to skip review for one change, and the change should then record **review skipped**.

## Permissions and Access Control

Weave has no accounts or roles of its own. "Who can" means who is expected to act. The product does not enforce identity.

| Action | Who |
| --- | --- |
| Run a slice review automatically | The build session that finishes the slice's last task |
| Start the final review automatically | The session that completes the last slice review |
| Run a review on demand | Anyone working on the change |
| Fix findings, write rulings | The build agent, within the slice's own code only |
| Label a finding as a plan problem | The reviewer only. The agent cannot relabel it as a code problem |
| Decide a plan problem on a slice | The slice's owner, or, if there is none, whoever is working on the change |
| Decide a plan problem from the final review | Whoever is working on the change (assumption; see Assumptions) |
| Change code | Never the reviewer or the fix checker (asked for in the brief, not enforced by the client) |
| Edit shared guidelines | The team |
| Edit repository guidelines | The team owning that repository |
| Turn reviews off for the workspace | The team |
| Skip review for one change | The person running the change; the skip is recorded |
| Merge | The person only. Weave never merges |

## States and Lifecycle

### Slice review states

| State | Meaning |
| --- | --- |
| tasks done | All tasks are done. The review is about to run in the same session |
| tasks done, not reviewed | All tasks are done, but no review ran (finished by hand, or the session ended) |
| in review | A review, its fix rounds, or its fix checks are running |
| reviewed | Reviewed and nothing was set aside |
| reviewed with rulings | Reviewed, and one or more findings were set aside as rulings |
| waiting on you: plan problem | The reviewer found a plan problem, and the slice owner (or whoever is working on the change) must decide |
| reviewed, out of date | Reviewed, but the code it covers has changed since |
| review skipped | Applies to every slice when review was skipped for the change or turned off for the workspace (assumption; see Assumptions) |

Transitions:

- **tasks done to in review:** the build session that finished the last task starts the review.
- **tasks done to tasks done, not reviewed:** the last task was finished outside a build session, or the session ended first.
- **tasks done, not reviewed to in review:** the person runs the review skill on the slice.
- **in review to reviewed or reviewed with rulings:** the fix rounds end, and either nothing or something was set aside.
- **in review to waiting on you:** the reviewer labelled a finding a plan problem.
- **waiting on you to in review:** the person changed the plan, and the slice is reviewed against the updated plan.
- **waiting on you to reviewed with rulings:** the person dismissed the plan problem, which becomes their ruling, and nothing else is open.
- **reviewed or reviewed with rulings to reviewed, out of date:** the code the slice covers changes.
- **reviewed, out of date to in review:** the person (or "what next") runs the review again.
- **any reviewed state to in review:** an on-demand re-run.
- **reviewed state to flagged for review again:** a plan change resolved elsewhere affects a slice built on the old plan.

Invalid transitions:

- A slice cannot move from waiting on you to reviewed without a person's decision.
- The agent cannot move a slice out of waiting on you by relabelling the finding.
- Nothing times out.

### Change review states

| State | Meaning |
| --- | --- |
| final review not started | Not every slice is reviewed, or one is waiting or out of date |
| final review in progress | The final review, its fix batch, or its single fix check is running |
| ready to merge | Nothing is left open |
| ready with parked items | Only parked items are left |
| not ready | A plan problem is waiting, part of the change is unreviewed, or an agreed Critical finding is unfixed |
| verdict out of date | The covered code changed after the verdict was recorded |
| review skipped | Review was skipped for this change |

Final states: there are none in the strict sense. Any verdict can go out of date and be re-run. Merging happens outside Weave.

## Notifications and Visibility

- Weave sends no notifications: no in-app alerts, email, or chat messages.
- **Change status** shows:
  - each slice's review state
  - review progress (for example "slice 2 reviewed, 1 ruling" or "slice 3 waiting on you: plan problem")
  - the change's verdict
  - the full rulings list with the cost of each if wrong
  - parked items
  - "review skipped" where it applies
  - out-of-date markers
- **"What next"** recommends:
  - reviewing slices that are not reviewed or out of date
  - starting the final review when its session has ended
  - re-running after the code changes
  - deciding waiting plan problems
- **Each slice's review record** holds:
  - findings
  - fixes with what each changed
  - rulings
  - saved Minor findings
  - untested tasks
  - human checks ("needs your check")
  - partial-review notes (missing repository, missing shared guidelines, reduced independence, partial on-demand run)
  - the run history
- **Weave status for existing projects** tells the team that reviews are available and how to install them.
- **Visibility.** Everyone working on the change sees the same status and records. There is no per-person view.

## Edge Cases

- **Last task finished by hand, or the session ended before the review.** The slice shows tasks done, not reviewed, and "what next" recommends reviewing it. The final review waits.
- **Slice with "not tested" tasks.** The slice is still reviewed, and its untested tasks are called out in the record and the verdict.
- **Agent disagrees with a finding.** The agent declines with its reasoning. If the finding is still open after 2 rounds, it becomes a ruling, and the slice shows reviewed with rulings.
- **Unclear finding.** The agent asks rather than guessing. *(Assumption: in an unattended run, an unanswered question is recorded as a ruling rather than blocking. See Assumptions.)*
- **Fix needs another slice's code.** The fix is not made. It becomes a ruling and goes to the final review.
- **Fix touches a slice with a human-only verification step.** The fix is marked needs your check, appears as a parked item, and does not block.
- **Plan problem on a slice.** The slice waits on its owner. Independent slices continue, and dependent slices and the final review wait. Nothing times out.
- **Plan gap found by the final review** (a PRD requirement no slice built). The agent does not build it, and the change shows not ready: waiting on you. The person adds a slice or dismisses the finding.
- **Plan changed to resolve a problem.** Dependent planning work is marked out of date as today. The slice and any slices built on the old plan are flagged for review again.
- **Code changes after review** (hand edit, tasks added, main branch merged in). The slice and the verdict show out of date.
- **Guideline, planning document, or decision changes after a ruling.** The ruling reopens on the next review.
- **Repository missing locally.** That part is not reviewed, the record says partial, and the verdict is at best not ready.
- **No repository guidelines file.** The shared guidelines alone apply.
- **No shared guidelines file.** The review still runs, and the record notes that the shared guidelines were missing.
- **Shared and repository guidelines conflict.** The repository's guidelines win.
- **Guidelines edited on the change itself.** That change's review uses the edited guidelines.
- **On-demand review before all slices are done.** It reviews what exists and records that it was partial.
- **Flat change with no slices.** There are no slice reviews. The whole-change review is available on demand.
- **Change already in progress when this ships.** Earlier finished slices are not reviewed retroactively. The next finished slice is reviewed, and the final review runs.
- **Agent client cannot run a separate reviewer.** The review runs in the same session, and the record notes reduced independence.
- **Several people on one change.** Each owner decides their own slice's plan problems. Others keep building independent slices. The final review waits for every decision.
- **Two people editing the same files in one change folder.** Weave does not guard this today. Reviews only keep fixes inside the slice's own code.
- **Reviews turned off for the workspace, or skipped for a change.** No automatic reviews run. A per-change skip is recorded as "review skipped".
- **Repeated on-demand runs.** Each is added to the history. Rulings are not re-raised unless their basis changed.

## Acceptance Criteria

- [ ] Finishing a slice's last task in a build session runs a slice review in the foreground before the session moves on.
- [ ] No review ever runs in the background.
- [ ] A slice finished without a review shows "tasks done, not reviewed", and "what next" recommends reviewing it.
- [ ] Slices with "not tested" tasks are reviewed, and the untested tasks appear in the review record and the final verdict.
- [ ] The slice reviewer starts with fresh context and sees only the written slice, its acceptance criteria, the planning documents, the applicable recorded decisions, the guidelines, and the slice's code in every repository it touches.
- [ ] The reviewer's report contains strengths, findings ranked Critical, Important, or Minor (each with a location, the rule it fails, and a code-or-plan label), items not judged with reasons, and a verdict.
- [ ] The build agent fixes agreed Critical and Important findings in batches of at most 2 rounds, re-runs automatic checks each round, and has a fresh checker verify only the fixes.
- [ ] Findings still open after round 2 become rulings with written reasoning.
- [ ] Minor findings from slice reviews are saved for the final review and not fixed in slice rounds.
- [ ] A fix needing another slice's code is not made and is recorded as a ruling.
- [ ] A fix touching a slice with a human-only verification step is marked "needs your check" and does not block.
- [ ] A finding labelled a plan problem stops the agent. The slice shows "waiting on you: plan problem", and the agent cannot relabel it.
- [ ] A plan gap found by the final review stops for the person, and the change shows "not ready: waiting on you".
- [ ] A plan problem can be resolved by changing the plan, which triggers re-review of the slice and flags slices built on the old plan, or by dismissing it, which records it as the person's ruling.
- [ ] Slices that depend on a slice that is waiting or in review wait. Independent slices can be built in parallel.
- [ ] The final review starts automatically from the session that completes the last slice review, and never while a slice is waiting, not reviewed, or out of date.
- [ ] The final review runs on the most capable model available, sorts saved Minor findings into must-fix and can-wait, fixes agreed and must-fix findings in one batch, and has them checked once.
- [ ] The change records one of the three verdicts and the full rulings list, each ruling with what it costs if wrong.
- [ ] Each fix in a review record names its finding and exactly what it changed.
- [ ] A slice's reviewed state and the change's verdict show "out of date" after the covered code changes.
- [ ] A ruling is not re-raised unless its code, or the guideline, planning document, or decision it relied on, has changed.
- [ ] The person can run the review on one slice or the whole change at any time. Each run is added to the history, and early runs are marked partial.
- [ ] Flat changes can run the whole-change review on demand.
- [ ] Shared and repository guidelines both apply, and the repository wins on conflict. A single-repository project uses one file.
- [ ] Missing repository guidelines fall back to shared. Missing shared guidelines are noted in the record, and the review still runs.
- [ ] A review uses the guidelines in the change's own folder.
- [ ] A missing repository makes the review partial and holds the verdict at "not ready".
- [ ] A slice spanning repositories is reviewed by one reviewer applying each repository's guidelines to its own code.
- [ ] Every review states its capability level explicitly, and slice reviews are never below mid-level.
- [ ] On a client that cannot run a separate reviewer, the review runs in-session, and the record notes reduced independence.
- [ ] Review applies to every change type built from slices and checks against the planning documents that change has.
- [ ] Review is on by default once the skill is installed. It can be turned off per workspace and skipped per change, and the skip is recorded.
- [ ] New workspaces get the starter shared guidelines. Upgrades never overwrite them. Existing projects get them only on request.
- [ ] Weave status tells existing projects that reviews are available and how to install them.
- [ ] Weave never merges and sends no notifications.

## Rollout Considerations

- **Default.** Review is on by default for new changes once the review skill is installed.
- **Change types.** Review covers every change type built from slices (features, fixes, refactors, chores, and others). It checks against whichever planning documents exist: findings for fixes, exploration or architecture for chores and refactors, and always the slices' acceptance criteria and recorded decisions.
- **Changes already in progress.** Slices finished before this ships are not reviewed retroactively. The next slice to finish is reviewed, and the final review still runs.
- **Flat (unsliced) changes.** They get no slice reviews. The whole-change review is available on demand.
- **New workspaces.** They get the starter shared guidelines on set-up.
- **Existing projects.** Updating Weave does not add the review skill or the guidelines file by itself. Weave's status tells existing teams that reviews are available and how to install them. The starter guidelines file is written only when a person asks.
- **Opt-out.** Teams can turn reviews off for the workspace. A person can skip review for one change, and the skip is recorded.
- **Communication.** Release notes and Weave's status message should explain that reviews are available, how to install them, that they act on findings without asking (except for plan problems), and where to read verdicts and rulings.
- **Cost.** Reviews add time and model cost to each slice, plus one final review on the most capable model. Teams should be told this so they can choose the workspace opt-out.

## Analytics and Success Metrics

Weave runs locally and does not collect usage data (assumption). Success is judged from review records and team feedback:

- **Defects caught before merge:** Critical and Important findings fixed per change, from review records.
- **Early catches:** the share of findings caught in slice reviews rather than the final review.
- **Plan problems surfaced:** plan conflicts and gaps found per change that would otherwise have reached merge.
- **Agent-reviewer agreement:** the share of findings fixed versus turned into rulings. A high ruling rate suggests noisy reviewers.
- **Rulings overturned:** how often people reverse a fix or overturn a ruling after reading the list.
- **Unattended completion:** the share of slice reviews that finish without stopping for the person.
- **Opt-out rate:** workspaces that turn reviews off, and changes that skip review.
- **Guidelines adoption:** projects that keep and edit shared guidelines, and repositories that add their own file.

## Revision History

- 2026-11-09: Initial PRD generated from `exploration.md` (stress test verdict: holds-with-changes), including the stress-test answers on triggers, ownership, plan-gap handling, staleness, change-type coverage, and rollout.

## Assumptions

- Agent clients that cannot run a separate reviewer run the review in the same session, with less independence, and the record says so. This matches today's stress test rule.
- Execution's per-task verification stays as it is. Review adds to it and does not replace it.
- Mid-level is a sensible floor for slice reviewers, because cheaper models take more turns and end up costing more.
- Weave does not guard against two people editing the same files in one change folder. Reviews only keep fixes inside the slice's own code.
- Plan problems found by the final review are decided by whoever is working on the change, because the final review has no single slice owner.
- In an unattended run, a finding the agent finds unclear and cannot get answered is recorded as a ruling explaining the uncertainty, rather than blocking the review. Plan problems still always block.
- When reviews are turned off for the workspace or skipped for a change, its slices show "review skipped" rather than "not reviewed", and the final review does not run automatically. The person can still run a review on demand.
- Weave does not collect usage telemetry, so success metrics come from review records and team feedback.
- "Slice owner" means the owner already recorded on a slice in Weave's slice model.

## Open Questions

None of these block the PRD.

- What each capability level (cheap, mid-level, most capable) means for each supported agent client, and whether teams can override it. *(architecture)*
- The fixed file name and location for repository guidelines, and where the shared guidelines live in the workspace. *(architecture)*
- Can teams raise the number of slice fix rounds above 2?
- Should the person be able to choose which agent reviews, so that code written by one agent is reviewed by another?
- How "the code a slice changed" and "what each fix changed" are determined when execution does not commit, so that a review has a clear boundary and fixes can be reversed. *(architecture)*
- How Weave tells that a slice's code changed after its review, so it can show it as out of date. *(architecture)*

## Out of Scope

- Moving Weave's existing plan critic (the stress test) to the same reviewer-brief approach.
- Per-task reviews.
- Team-defined reviewer panels and parallel reviewers.
- Separately installed reviewer agents with enforced read-only access.
- Retroactive reviews of slices finished before this ships.
- Automatic merging, committing, or pull request creation.
- Notifications of any kind.
- Background or scheduled reviews.
- Reading repository convention files other than the fixed-name guidelines file.
- Writing guidelines files into existing projects during an update.
- Guarding against concurrent edits in one change folder.

## Further Notes

**Options considered and not chosen (background only, not requirements):**

- Review after every task: rejected as too fine-grained. Task verification already covers "does it work".
- Review only when the person runs it: kept as on-demand review, but not as the only way reviews happen.
- One whole-change review only at the end: rejected as too late. It is kept as the final review alongside slice reviews.
- Team-defined reviewer panels with parallel lenses: rejected because of duplicate and conflicting findings and rising cost. Team standards come from coding guidelines instead.
- Person walks through every final-review finding: rejected because it needs the person present to approve obvious fixes.
- Mixed final review (agent fixes clear-cut findings, person decides judgement calls): rejected in favour of the agent acting on everything and reporting rulings, with plan problems as the exception.
- Person reviews slice findings: rejected because slice reviews are frequent and that would be tiring.
- Findings become new tasks: rejected. Fixes are recorded in the review record instead.
- Separately installed reviewer agents: rejected in favour of briefs inside the review skill, so one skill text works with every client.

**For QA and Support:**

- The key promises are:
  - plan problems always stop for a person
  - every unattended fix is listed and reversible
  - a verdict never describes code that has since changed
- Rulings in the stress test session note for this change were made by the agent on the user's behalf. The user should review them alongside this PRD.

**Relation to existing behaviour:** reviews run as part of building. They are not a move between planning stages, so the rule that steps needing a person's decision never auto-advance is unaffected.
