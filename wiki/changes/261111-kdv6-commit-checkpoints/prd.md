---
artifact: prd
status: draft
owner: product
created_at: 2026-11-10T21:19:50.000Z
updated_at: 2026-11-10T21:19:50.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: exploration.md
---

# Commit Checkpoints PRD

## Problem Statement

People take a change through Weave from questions to knowledge, but Weave never saves any of that work into git history. Planning documents, code, review fixes, and wiki updates stay as uncommitted edits until someone remembers to commit them by hand. Developers and the agents working for them both feel the effects:

- **No clean point to return to.** "Undo slice 3" and "what did the PRD say before the stress test?" have no commit to go back to.
- **History says nothing about the work.** It does not show which stage produced which work, or why.
- **Planning work can be lost.** Planning files that were never committed are gone if the change's folder goes away, and the change list can only report that they "can't be recovered".
- **Other features work around the gap.** Code reviews keep their own private save points because there are no commits to measure against.

This matters because Weave's promise is a recorded, traceable path from idea to merged code. Without commits, that record lives only in one folder on one machine and depends on a person remembering to save it.

## Goals

- Planning work is never lost. Every recorded stage is saved in git on the change's own branch, and nobody has to remember to do it.
- The history reads at the level people think in. There is one commit per recorded stage, one build commit per slice, and one commit per review fix round, each with a message that says what it is for.
- Reviews get real commit boundaries. A slice's build and each fix round are separate commits that can be undone on their own.
- Nothing is ever blocked. A commit either happens or it doesn't. When it doesn't, the person is told it failed and why, and the pipeline carries on.
- It works the same in every agent, including phases that run with nobody present, and needs no hooks or background processes.
- Teams and individuals can turn it off. With it off, Weave behaves exactly as it does today.

## Non-Goals

- Pushing branches or opening pull requests. Weave only commits; pushing is the person's decision.
- An "undo" command. People undo with git as usual.
- A commit for every finished task.
- Committing code for older changes planned without slices.
- Back-filling history for changes already in progress when this ships.
- Coordinating or queueing two saves that happen at the same moment.
- Retrying failed commits in a loop, or holding the pipeline until a commit succeeds.

## Actors

- **Developer (person running the change).** Records stages, builds slices, runs reviews, and reads the history. Can turn commits off for themselves or skip a change.
- **Team / project maintainer.** Owns the project's settings, its commit checks, and any documented commit-message rules. Can turn commits off for the whole project.
- **Agent session (attended).** Runs Weave skills on the developer's behalf. Writes documents and code, then runs the Weave command that records the stage.
- **Unattended phase.** A phase that auto-advance runs with nobody present, such as research after questions or the PRD after a passing stress test. It may record its own stage but has no general ability to change git history.
- **Code reviewers.** Fresh, independent reviewers who measure a slice or fix round against fixed boundaries.
- **Weave.** Records stages, makes the commits, runs or skips the project's commit checks, and reports what happened.

## Current Behavior

- **Weave never commits.** Every Weave skill that writes plans or code states that it does not commit, push, or open pull requests. Committing is entirely the person's job.
- **Each change has its own branch.** Newer workspaces give each change its own folder. Older workspaces switch the person's everyday folder to the change's branch.
- **Weave learns about work only when a stage is recorded.** Skills write documents with the agent's own file tools, so Weave is not told about the write. Weave learns a stage is done only when the skill runs a Weave command to record it: progress on a stage, a stress-test verdict, the knowledge status, or clearing an out-of-date flag. Recording can mark later documents out of date. Session-only captures record nothing.
- **Reviews use private save points.** Code reviews take private save points of the working folder at the start and end of each slice and around each fix round. They live only on the person's machine, are never pushed, and were designed to be replaced by real commits once checkpoint commits exist. Older changes planned without slices get only a whole-change review.
- **Unattended phases are read-only for git.** Phases that run unattended may only read git history, never change it. Weave never runs a project's own commands without a person's approval.
- **Commit checks arrive late.** Many projects' commit checks are installed when a change folder is set up. That happens only after a person approves it, usually at execution.
- **The change list depends on commits.** Its states (landed, closed, done, "no commits yet", recoverable folders) depend on what has been committed on the change's branch. Uncommitted planning files cannot be recovered.
- **Some files are already left to the person.** Some project-level files, such as coding guidelines, are left for the person to commit by hand.

**Today's workarounds:** people commit by hand at points they choose, often only at the end. Reviews rely on machine-local save points. A lost folder means lost planning work.

## Proposed Product Behavior

Weave commits work automatically on the change's own branch at two kinds of moment. The guiding principle is to keep it simple: a commit either happens or it doesn't. When it doesn't, the person is told it failed and why. Nothing is ever blocked by a commit.

### Planning commits

Weave commits whenever it records something in the change's status. That covers:

- progress on any stage: questions, research, product shape, PRD, findings, architecture, and slices, including revisions through clarify and document captures
- a stress-test verdict
- the knowledge status
- clearing an out-of-date flag
- recording a review result

Every skill already runs one of these Weave commands right after writing its document, so this works the same in every agent and needs no detection of file writes.

A planning commit includes:

- the change's own planning folder
- any shared documents that stage itself wrote, such as decisions drafted during architecture or wiki pages updated by the knowledge stage
- any edits the person had staged

If the stage made other documents out of date, the commit still happens. The change's status goes into the same commit, and the message names what is now out of date.

Planning commits skip the project's own commit checks. They are plain documents and are never blocked by them.

Unattended phases make planning commits too, because saving is part of recording the stage. The unattended session gains no general ability to commit.

### Catch-up save

Before each planning commit, Weave first commits any leftover planning files from earlier as a separate commit. Leftovers include session notes, or a document from a skill that was interrupted before it recorded its stage. Nothing stays uncommitted beyond the next recorded step.

The catch-up save also applies to code. Before a new slice starts building, leftover code from the previous slice is committed as that slice's late build commit.

### Code commits

When a slice finishes building, Weave makes one build commit containing everything that changed in the slice's repos, including the slice's task notes and evidence. It tells the person which files went in.

- **Partly built slices.** The slice's code stays uncommitted until it finishes. Its notes may go into planning commits.
- **Fix rounds.** Each slice review fix round adds its own commit on top. The final review's fix batch gets its own commit.
- **Commit checks.** Code commits always run the project's commit checks.
- **Review boundaries.** Reviews use these commits as their boundaries instead of private save points.
- **Finishing a slice again.** If a slice is finished again later (tasks were added, or a "not tested" task was completed), Weave makes another build commit, and the existing out-of-date check asks for re-review.

### Commit messages

Messages explain intent, not just position. They are built from what is already written down (slice goals, task titles, findings, the stage's summary), so they stay consistent, including from unattended phases.

- **Slice commits.** The subject says what the slice is for in plain words. The body gives the slice's goal, the tasks completed, whether this is the build or fix round N (and which findings that round fixes), and the change ID and slice name.
- **Planning commits.** The subject names the stage and its gist, for example "PRD: commit checkpoints at each pipeline stage". The body summarises what was decided, what is now out of date, and the change ID.
- **Project rules win.** When a project documents its own commit-message rules, such as a format or things that must not appear in history, those rules win. Weave's styles are only the default.

### Controls

- **Default.** On by default, including for projects that upgrade in the middle of a change. The first time Weave commits in a project, it says so once and explains how to turn it off.
- **Project switch.** Turns commits off for everyone on the project.
- **Personal switch.** With the project switch on, a person can turn commits off for themselves in their own Weave settings.
- **Per-change skip.** Any single change can be skipped.
- **Off means today's behavior.** With commits off, Weave behaves exactly as it does today, including private save points for reviews.

### Scope limits

- Weave only commits. It never pushes, never commits onto a branch other than the change's own, and makes no empty commits.
- There is no undo command. People undo with git as usual.
- Older changes planned without slices get planning commits only. Their code is not committed automatically, and their review keeps using private save points.

### Visible effects in the change list

Every change now has commits from its first recorded stage, so:

- "no commits yet" and "planning files can't be recovered" largely disappear, and a deleted folder can always be recreated from the branch
- a change abandoned during planning reads "closed, not landed" instead of "done"
- a planning save recorded after a merge marks the change "landed with newer commits"

## User Workflows

### Workflow: Developer records a planning stage

1. The developer runs a planning skill, such as architecture, and the agent writes the stage's documents.
2. The skill runs the Weave command that records the stage.
3. Weave makes a catch-up save first if it finds leftover planning files, such as session notes, as a separate commit.
4. Weave commits the change's planning folder, the shared documents the stage wrote (for example, two drafted decisions), the change's status, and anything the developer had staged.
5. If the stage made other documents out of date, the commit message names them, for example "Architecture: … — slices now out of date".
6. Weave reports the commit. If it could not commit, it says why, and the stage is still recorded.

### Workflow: An unattended phase records its stage

1. Auto-advance hands research (or the PRD) to an unattended phase.
2. The phase writes its document and records its stage.
3. Weave commits the document as part of recording, without running any of the project's commit checks.
4. The phase never commits anything else and gains no other way to change git history.

### Workflow: Developer finishes building a slice

1. The developer (through the agent) completes the slice's last task.
2. Weave makes the slice's build commit with everything changed in the slice's repos, titled with the slice's purpose, and lists the files it included.
3. The project's commit checks run on that commit.
4. The slice review measures against that commit. When the review is recorded, Weave makes a planning commit, for example "Slice 2 review: 2 issues".
5. Each fix round becomes its own commit, which can be undone on its own.

### Workflow: A slice's build commit is rejected by the project's checks

1. The project's commit checks reject slice 4's build commit, for example because of a lint failure.
2. Weave reports the failure and the reason. Nothing is blocked.
3. The review still runs, using a private save point for that slice.
4. Before slice 5 starts building, the catch-up save retries slice 4's leftover code as "slice 4: build (committed late)".
5. If that fails again, the developer is told that slice 5's review will include slice 4's leftovers.

### Workflow: Multi-repo workspace slice

1. A slice changes two repos in a workspace.
2. Each repo gets its own build commit with the same message. Planning commits go to the workspace root.
3. If one repo's commit fails, the developer is told which repo and why. That repo's review uses a private save point, and the catch-up save retries it before the next slice.

### Workflow: Team or person turns commits off

1. A team that only allows people to make commits turns the project switch off. Weave behaves as it does today for everyone.
2. On a team that leaves it on, Alex turns commits off in their own Weave settings. Weave stops committing for Alex only.
3. Anyone can skip a single change. Weave does not commit for that change.

### Workflow: Change in progress when the feature ships

1. A change is half-way through when this ships.
2. The first stage recorded afterwards announces the feature once and makes the first commit.
3. The catch-up save sweeps up earlier uncommitted planning files. No history is back-filled.

## User Stories

1. As a developer, I want each recorded planning stage committed automatically, so that I never lose planning work and never have to remember to commit it.
2. As a developer, I want each slice's code committed when the slice finishes, so that I can see and undo what each slice changed.
3. As a developer, I want each review fix round to be its own commit, so that reviewer-driven changes are visible and can be undone on their own.
4. As a developer, I want commit messages that say what a stage decided or what a slice is for, so that history explains the work and not only its position.
5. As a developer, I want the commit message to name documents the stage made out of date, so that the history shows where the plan became inconsistent.
6. As a developer, I want session notes and documents from interrupted skills saved at the next recorded step, so that nothing is left uncommitted for long.
7. As a developer, I want to be told which files went into a build commit, so that I notice stray files immediately.
8. As a developer, I want a failed commit to tell me it failed and why without stopping my work, so that the pipeline never stalls on saving.
9. As a developer whose build commit was rejected by the project's checks, I want the next slice's start to retry it, and to be told if it fails again, so that one slice's work does not silently mix into the next slice's review.
10. As a developer, I want Weave to refuse to commit when git in the change's folder is on another branch, and tell me why, so that work never lands on the wrong branch.
11. As a team maintainer, I want planning commits to skip our commit checks and code commits to always run them, so that plain documents are never blocked and code is always checked.
12. As a team maintainer, I want a project switch that turns commits off for everyone, so that teams who only allow people to commit keep today's behavior.
13. As a developer on a project where commits are on, I want to turn them off for myself in my own Weave settings, so that my preference does not affect teammates.
14. As a developer, I want to skip commits for one change, so that I can handle an unusual change by hand.
15. As a team maintainer, I want our documented commit-message rules (format and things that must not appear in history) to win over Weave's default styles, so that Weave's commits follow our conventions.
16. As a developer running unattended phases, I want those phases to save their own stage without being able to commit anything else, so that unattended work is saved while staying contained.
17. As a developer in a multi-repo workspace, I want each repo a slice touched to get its own commit with the same message, and per-repo failure reporting, so that I know exactly which repo needs attention.
18. As a developer upgrading mid-change, I want a one-time notice and a first commit that sweeps up earlier planning files, so that I know what changed and nothing earlier is lost.
19. As a developer who undoes a slice's commit with git, I want the slice's task ticks to return to not done and its review to be marked out of date, so that Weave's view matches the code.
20. As a developer working on an older change planned without slices, I want planning commits to keep working while my code and review behave as before, so that nothing breaks for legacy changes.
21. As a developer reading the change list, I want abandoned and post-merge changes to show states that reflect their commits, so that the list stays accurate now that every change has commits.

## Functional Requirements

### Planning commits

- **FR1.** The system should make a planning commit on the change's own branch whenever it records something in the change's status. This covers stage progress (questions, research, product shape, PRD, findings, architecture, and slices, including revisions through clarify and document captures), a stress-test verdict, the knowledge status, clearing an out-of-date flag, and recording a review result.
- **FR2.** A planning commit should contain the change's planning folder, any shared documents the stage itself wrote (for example, decisions drafted during architecture or wiki pages updated by the knowledge stage), the change's updated status, and any edits the person had staged.
- **FR3.** The system should still commit when recording a stage makes other documents out of date, and the commit message should name those documents.
- **FR4.** Planning commits should skip the project's own commit checks.
- **FR5.** Recording a stage should succeed whether or not its planning commit succeeds. A failed planning commit should be reported with its reason.
- **FR6.** A stress test should produce two commits: the revised shape first, then the verdict.
- **FR7.** Unattended phases should make their planning commit as part of recording their stage, and should gain no other ability to commit or change git history.

### Catch-up save

- **FR8.** Before each planning commit, the system should commit any leftover planning files in the change's planning folder as a separate commit. Leftovers include session notes and documents from skills that were interrupted before recording.
- **FR9.** Before a new slice starts building, the system should commit any leftover code from the previous slice as that slice's late build commit.
- **FR10.** If the late build commit fails, the system should tell the person that the next slice's review will include the previous slice's leftovers.

### Code commits

- **FR11.** When a slice finishes building, the system should make one build commit containing everything changed in the slice's repos, including the slice's task notes and evidence, in both kinds of checkout (own folder and everyday folder).
- **FR12.** After each build commit, the system should tell the person which files the commit included.
- **FR13.** A partly built slice's code should stay uncommitted until the slice finishes. Its notes may go into planning commits.
- **FR14.** Each slice review fix round should be its own commit on top of the build commit. The final review's fix batch should be its own commit.
- **FR15.** Code commits should always run the project's commit checks.
- **FR16.** Code reviews should use build and fix commits as their boundaries. They should fall back to private save points only when a build or fix commit failed, or for older changes planned without slices.
- **FR17.** Finishing an already-committed slice again should make another build commit. The existing out-of-date check should then ask for re-review.
- **FR18.** Older changes planned without slices should get planning commits only. Their code should not be committed automatically, and their review should keep using private save points.

### Multi-repo workspaces

- **FR19.** In multi-repo workspaces, planning commits should go to the workspace root.
- **FR20.** Slice and fix commits should go to each repo the slice changed, with the same message in each.
- **FR21.** A partial failure should be handled per repo. The commit stays where it was made, a private save point is used for the failed repo's review, the person is told which repo failed and why, and the catch-up save retries it before the next slice.

### Commit messages

- **FR22.** Slice commit subjects should say what the slice is for in plain words. Bodies should give the slice's goal, the tasks completed, build or fix round N (with the findings that round fixes), and the change ID and slice name.
- **FR23.** Planning commit subjects should name the stage and its gist. Bodies should summarise what was decided, what is now out of date, and the change ID.
- **FR24.** Messages should be built from what is already written in the change's artifacts (slice goals, task titles, findings, the stage's summary), including in unattended phases.
- **FR25.** When a project documents its own commit-message rules (format, or things that must not appear in history), those rules should win over Weave's default styles.

### Safety limits

- **FR26.** The system should never push.
- **FR27.** The system should never commit onto a branch other than the change's own. When git in the change's folder is on another branch, the system should not commit and should tell the person why.
- **FR28.** The system should never make empty commits.
- **FR29.** The system should not provide an undo command.
- **FR30.** The system should not coordinate simultaneous saves. If two saves collide, one may fail with a reason, and the catch-up save should recover what it missed at the next recorded step.
- **FR31.** No failed commit should block, loop, or queue any pipeline step.

### Controls

- **FR32.** Commits should be on by default, including for projects that upgrade in the middle of a change.
- **FR33.** The first time Weave commits in a project, it should say so once and explain how to turn commits off.
- **FR34.** A project switch should turn commits off for everyone on the project.
- **FR35.** With the project switch on, a person should be able to turn commits off for themselves in their own Weave settings. Those settings are never stored in the project.
- **FR36.** A person should be able to skip commits for an individual change.
- **FR37.** With commits off by any of these switches, Weave should behave exactly as it does today, including private save points for reviews.

### Rollout of existing changes

- **FR38.** Changes already in progress should not be migrated or back-filled. The first recorded stage after shipping should make the first commit, and its catch-up save should sweep up earlier uncommitted planning files.

## Permissions and Access Control

- **Who commits.** Weave makes all automatic commits, on behalf of whoever records the stage or finishes the slice.
- **Unattended phases.** They may make planning commits only as part of recording their own stage, through Weave. They gain no general permission to commit, change branches, or run other git write commands. This deliberately changes what recorded decision `261108-4z8l` promises; see Open Questions.
- **Project commands.** Planning commits never run the project's commit checks, so no project command runs without a person's approval during planning or unattended phases. Code commits run the checks during execution, where a person is present.
- **Who can turn it off:**
  - the project switch is a shared project setting that the team controls
  - the personal switch belongs to one person, lives in their own Weave settings, and never affects teammates
  - the per-change skip applies to one change
- **Precedence.** Project off means off for everyone, whatever the personal settings say. With the project on, a personal off or a per-change skip turns commits off for that person or that change.
- **Branches.** Weave never commits to any branch other than the change's own, and never pushes.

## States and Lifecycle

### Commit moments in a change's life

| Moment | Trigger | Commit made | Project commit checks |
| --- | --- | --- | --- |
| Leftover planning files found | Any recording, before its own commit | Catch-up save (separate commit) | Skipped |
| Stage recorded (progress, verdict, knowledge status, stale flag cleared) | The Weave recording command | Planning commit | Skipped |
| Review result recorded | Recording the review | Planning commit | Skipped |
| Slice finishes building | Last task of the slice completed | Build commit, per repo changed | Run |
| Slice review fix round | Fix round completed | Fix commit, per repo changed | Run |
| Final review fix batch | Final review fixes completed | Fix commit | Run |
| Next slice starts with leftover code | Start of the next slice's build | Late build commit for the previous slice | Run |
| Slice finished again | Added or completed tasks finish the slice again | Another build commit; review marked out of date | Run |

### Outcome of each attempted commit

- **Committed.** The person is told what was committed. For build commits, they are told which files went in.
- **Failed.** The person is told it failed and why, for example: the project's checks rejected it, git is on another branch, or another save collided. Nothing is blocked. A later catch-up save may retry it.
- **Not attempted.** Commits are off by a switch or skip, the change is an older change without slices (code only), or there is nothing to commit (no empty commits).

### Change list states (visible changes)

- "no commits yet" and "nothing was committed, so its planning files can't be recovered" largely disappear, because every change has commits from its first recorded stage. A missing folder can always be recreated from the branch.
- A change abandoned during planning, with its folder closed, reads **closed, not landed** instead of **done**, because its branch now has commits.
- A planning save recorded after the change merged marks it **landed with newer commits**.

## Notifications and Visibility

Weave sends no email, chat, or other external notifications. All visibility is in the command output of the session that triggered the commit.

- **After each commit,** Weave reports the commit. For build commits, it lists the files included.
- **After a failure,** Weave states that the commit failed and the reason.
- **On a branch mismatch,** Weave states that it did not commit because git is on another branch.
- **On a partial multi-repo failure,** Weave names which repo failed and why.
- **When a late build commit fails again,** Weave says the next slice's review will include the earlier slice's leftovers.
- **First commit in a project:** a one-time notice that Weave now commits automatically, and how to turn it off.
- **Commit messages** name documents made out of date by the stage, so the history itself shows plan inconsistencies.
- **Unattended phases'** commit outcomes are reported in their run output. How a failure is shown to the next person is an open question.

## Edge Cases

- **A stage makes other documents out of date.** Weave still commits, and the message names them.
- **A slice is partly built when a planning stage is recorded.** Its code stays uncommitted and its notes go into the planning commit. If the person has staged some of that code, it goes into the planning commit, because staged edits are always included.
- **Session notes captured without recording.** They are swept up by the next catch-up save as their own commit.
- **An agent writes a document and crashes before recording.** The file stays uncommitted until the next recorded step, when the catch-up save commits it.
- **The project's checks reject a build commit.** Weave reports it, the review uses a private save point, and the catch-up save retries before the next slice. If that fails again, the person is warned that the next review will include the leftovers.
- **Git is on another branch in the change's folder.** Weave does not commit and says why.
- **Nothing changed.** No empty commit is made.
- **Two saves at once,** such as an unattended research run and a capture in another session. One may fail with a reason, and the catch-up save picks up what it missed at the next recorded step.
- **Multi-repo partial failure.** Commits stay where they were made. The failed repo uses a private save point and is retried before the next slice.
- **Slices built side by side in one folder.** Their changes may mix into each other's build commits. Reviews still label files outside a slice.
- **The person undoes a slice's build commit with git.** The slice's task ticks return to not done, and its review is marked out of date by the existing check. Later slices that relied on that code are caught by their own reviews and tests.
- **A slice is finished a second time.** Weave makes another build commit, and re-review is requested by the existing out-of-date check.
- **An older change planned without slices.** It gets planning commits only. Its code is not auto-committed, and its review uses private save points.
- **A change in progress when the feature ships.** There is a one-time notice, the first commit happens at the next recorded stage, the catch-up save sweeps up earlier planning files, and nothing is back-filled.
- **A save recorded after the change merged.** The change list shows "landed with newer commits".
- **A change abandoned during planning.** The change list shows "closed, not landed" instead of "done".
- **Commits turned off part-way through a change.** Weave stops committing from that point and behaves as today. Earlier commits stay.

## Acceptance Criteria

### Planning commits

- [ ] Recording progress on any stage (questions, research, product shape, PRD, findings, architecture, slices, including clarify revisions and document captures) makes a planning commit on the change's branch.
- [ ] Recording a stress-test verdict, the knowledge status, clearing an out-of-date flag, and recording a review result each make a planning commit.
- [ ] A stress test produces two commits: the revised shape, then the verdict.
- [ ] A planning commit includes the change's planning folder, the shared documents the stage wrote, the change's status, and the person's staged edits.
- [ ] When recording marks other documents out of date, the commit still happens and its message names them.
- [ ] Planning commits never run the project's commit checks.
- [ ] An unattended phase's planning commit is made through recording its stage, and the phase cannot commit anything else.
- [ ] A failed planning commit is reported with its reason, and the stage is still recorded.

### Catch-up save

- [ ] Leftover planning files (session notes, interrupted skills' documents) are committed as their own commit before the next planning commit.
- [ ] Leftover code from the previous slice is committed as its late build commit before the next slice starts building.
- [ ] If the late build commit fails, the person is told the next slice's review will include the leftovers.

### Code commits

- [ ] A finished slice gets one build commit with everything changed in its repos, including task notes and evidence, in both kinds of checkout.
- [ ] After each build commit, the person sees the list of files it included.
- [ ] A partly built slice's code is not committed until the slice finishes.
- [ ] Each slice review fix round, and the final review's fix batch, is its own commit.
- [ ] Code commits run the project's commit checks. A rejection is reported with its reason, and the review proceeds on a private save point.
- [ ] Reviews use build and fix commits as boundaries when those commits succeeded.
- [ ] Finishing an already-committed slice again makes another build commit, and the review is marked out of date.
- [ ] Older changes planned without slices get planning commits only, and their review keeps private save points.

### Multi-repo

- [ ] Planning commits go to the workspace root.
- [ ] Slice and fix commits go to each repo the slice changed, with the same message.
- [ ] A per-repo failure names the repo and reason, uses a private save point for that repo, and is retried before the next slice.

### Messages

- [ ] Slice commit subjects state the slice's purpose. Bodies include its goal, completed tasks, build or fix round N with findings fixed, and the change ID and slice name.
- [ ] Planning commit subjects name the stage and its gist. Bodies include what was decided, what is out of date, and the change ID.
- [ ] A project's documented commit-message rules (format and exclusions) override Weave's default styles.

### Safety

- [ ] Weave never pushes.
- [ ] Weave never commits when git in the change's folder is on a branch other than the change's own, and says why.
- [ ] Weave never makes an empty commit.
- [ ] No commit failure blocks, loops, or queues a pipeline step.
- [ ] Colliding saves result in at most one failure with a reason, and the next catch-up save recovers the missed files.

### Controls and rollout

- [ ] Commits are on by default for new and upgraded projects.
- [ ] The first commit in a project shows a one-time notice explaining how to turn commits off.
- [ ] The project switch turns commits off for everyone.
- [ ] With the project on, a personal setting turns commits off for that person only, and nothing personal is written to the project.
- [ ] A single change can be skipped.
- [ ] With commits off, Weave behaves exactly as today, including private save points for reviews.
- [ ] A change in progress at upgrade gets its first commit at the next recorded stage, with earlier planning files swept up and no back-filled history.

### Change list

- [ ] A change with recorded stages no longer shows "no commits yet" or "planning files can't be recovered", and its missing folder can be recreated.
- [ ] A change abandoned during planning reads "closed, not landed".
- [ ] A planning save after merge shows "landed with newer commits".

## Rollout Considerations

- **Default on, including upgrades.** Existing projects start committing as soon as they upgrade Weave, even in the middle of a change.
- **One-time notice.** The first commit in a project announces the feature and how to turn it off. No other announcement is needed in the product.
- **No migration.** Changes in progress are not back-filled. The first recorded stage after upgrading makes the first commit, and the catch-up save sweeps up earlier planning files.
- **Teams that only allow people to commit** should turn the project switch off before or right after upgrading.
- **Change-list behavior shifts.** These shifts are intended and should be called out in release notes:
  - "no commits yet" largely disappears
  - abandoned-in-planning changes read "closed, not landed"
  - saves after merge show "landed with newer commits"
- **Teams that keep planning files off their main branch** may never see a change read as landed. Release notes should mention this.
- **History length.** Changes now carry many small commits. Teams that want a shorter history can squash when merging.
- **Communication.** The README and the knowledge base should describe the commit moments, the switches, and the change-list effects.

## Analytics and Success Metrics

Weave has no product telemetry, so success is judged from observable outcomes:

- **No lost planning work.** After this ships, changes with a recorded stage no longer show "planning files can't be recovered" in the change list.
- **Reviews use commits.** Slice and fix-round reviews measure against commits in the normal case. Private save points appear only on failures and for older changes.
- **Commits rarely fail.** Failed commits are uncommon and always come with a reason, and the catch-up save recovers them at the next step.
- **Low opt-out.** Few projects or people turn the feature off, and those that do report a clear reason, such as a policy that only people may commit.
- **No stalled pipelines.** No issues report the pipeline blocked or stalled by a commit.

## Revision History

- 2026-11-11: Initial PRD generated from `exploration.md` (stress test verdict: holds-with-changes) and its stress test session note.

## Assumptions

- **Simultaneous slices are rare.** Building two slices side by side in one folder is rare. When it happens, mixed commits are acceptable, and reviews still label files outside a slice.
- **Squashing is acceptable.** People are willing to squash or tidy the change's history when merging if they want a shorter history.
- **Private save points remain as a fallback.** Keeping them for review is acceptable after failed build commits and for older changes without slices.
- **Teams merge the whole branch.** Teams merge the whole change branch, planning files included, as Weave expects today. Teams that keep planning files off main may never see a change read as landed.
- **Agents usually record their stage.** Agents reliably run the recording step after writing a document. When they do not, the catch-up save limits the cost to a less precise history, never lost work.
- **Code commits do not depend on review.** Code commits happen when a slice finishes building, whether or not code review is active for the change.
- **"Recording a review result" means the end of a review run.** A review run that finishes, fails, or waits on a person is the recorded moment. Intermediate review bookkeeping is saved by that commit or by the next catch-up save.
- **The personal switch follows existing personal settings.** It can apply to all of a person's projects or to one project, like other personal preferences.
- **The per-change skip is reversible.** Turning it back on resumes commits from the next recorded moment.
- **Commit states that are unsafe for any git commit are failures.** These include a detached checkout, or a merge or rebase in progress in the change's folder. Weave does not commit and reports the reason, as with a branch mismatch.
- **"Shared documents the stage wrote" means recorded decisions and knowledge pages.** Other project-level files, such as coding guidelines, stay with the person for now; see Open Questions.

## Open Questions

- **Should recorded decision `261108-4z8l` (auto-advance permissions) be superseded?** The new version would state that unattended phases make planning commits through Weave. This is a deliberate change accepted in the shape. Does not block the PRD; for `weave-architect`.
- **Should recorded decision `261110-wdfo` (review boundaries) be superseded?** Commits become the primary boundary, with private save points as the fallback. Does not block the PRD; for `weave-architect`.
- **Can a change's starting branch now be stored on the branch itself?** Decision `261108-kl3n`'s "Reconsider When" names planning commits. Does not block the PRD; for `weave-architect`.
- **Which stage write-ups count as "shared documents the stage itself wrote"?** Recorded decisions and knowledge pages are covered. Coding guidelines drafted by their own skill are not decided. Does not block the PRD.
- **How is an unattended phase's failed commit shown to the next person?** Options include the run status wording and a hint from `weave-next`. Does not block the PRD.
- **Who is the commit author?** The person alone, or the person with an agent co-author line. Does not block the PRD.
- **Where does Weave find a project's documented commit-message rules?** Does not block the PRD.

## Out of Scope

- Pushing the change's branch, and opening or drafting pull requests. This is a separate, later change: after the knowledge stage, Weave would offer (never automatically) to push and open a PR, with a PR-drafting skill. That raises its own questions about description contents, hosting services, one PR per repo in workspaces, and draft versus ready.
- Per-task commits.
- An undo command.
- Migrating or back-filling history for changes in progress.
- Code commits for older changes planned without slices.
- Coordinating, queueing, or retrying concurrent saves beyond the catch-up save.
- Detecting file writes through agent hooks or background watchers.

## Further Notes

Background on options considered and rejected:

- **Weave offers, the person decides.** Rejected: people skip it, so history is uneven and reviews still cannot rely on commits.
- **Automatic commits at every milestone, including every task.** Rejected: noisy history, commits of half-finished work, and slices spread over many commits.
- **Private restore points everywhere, real commits only on request.** Rejected: machine-local, does not protect planning work if the folder is lost, and adds a confusing second concept.
- **Commit trigger from detecting file writes.** Rejected in the stress test: it works differently, or not at all, per agent, needs an always-running process, and commits half-finished rewrites. The recording command each skill already runs is identical in every agent and fires when the stage is finished.

Recorded decisions that relate to this change:

- `261108-4z8l`: auto-advance permissions; planning commits from unattended phases change what it promises
- `261110-wdfo`: review boundaries; it names checkpoint commits as its reconsider trigger
- `261108-kl3n`: what "landed" means; its reconsider condition names planning commits
- `261109-a8k5`: personal settings live in the person's own Weave folder; the personal switch follows it

For QA: the main risks are commits landing in the wrong place. Watch for one slice's code in another slice's commit, staged edits swept into planning commits, and commits made on the wrong branch. Also confirm that no failure path ever blocks recording or building.
