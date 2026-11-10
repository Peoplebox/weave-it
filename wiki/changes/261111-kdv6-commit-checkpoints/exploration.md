---
artifact: exploration
status: draft
owner: product
created_at: 2026-11-10T19:48:06.988Z
updated_at: 2026-11-10T21:17:32.000Z
reviewed_at: null
approved_at: null
approved_by: null
source: discussion
---

# Commit Checkpoints

## Topic

Introduce checkpointing and commits at various stages of the whole pipeline.

## Problem

People run a change through Weave from questions to knowledge, but Weave never saves any of that work into git history. Planning documents, code, review fixes, and wiki updates all sit as uncommitted edits until someone remembers to commit them by hand. As a result:

- there is no clean point to go back to ("undo slice 3", "what did the PRD say before the stress test?")
- the history does not show which stage produced which work, or why
- planning work that was never committed is lost if the change's folder goes away
- other features have to work around the missing commits (reviews keep their own private save points)

## Existing Behavior

- Every Weave skill that writes plans or code states that it does not commit, push, or open pull requests. Committing is entirely the person's job.
- Each change has its own branch. Newer workspaces give each change its own folder; older workspaces switch the person's everyday folder to the change's branch.
- Skills write their documents with the agent's own file tools; Weave is not told about the write. Weave learns that a stage is done only when the skill runs a Weave command to record it: progress on a stage, a stress-test verdict, the knowledge status, or clearing an out-of-date flag. Recording can mark later documents out of date. Session-only captures record nothing.
- Code reviews take private save points of the working folder at the start and end of each slice and around each fix round. These live only on the person's machine, are never pushed, and were designed to be replaced by real commits "when checkpoint commits land". Older changes planned without slices get only a whole-change review.
- Phases that run unattended (auto-advance: research after questions, the PRD after a passing stress test) may only read git history, never change it, and Weave never runs a project's own commands without a person's approval.
- Many projects' commit checks are installed when a change folder is set up, which happens only after a person approves it, usually at execution.
- The change list's states (landed, closed, done, "no commits yet", recoverable folders) depend on what has been committed on the change's branch; uncommitted planning files cannot be recovered.
- Some project-level files (coding guidelines) are already left for the person to commit by hand.

## Options Considered

### A. Weave offers, the person decides — Rejected

- What it means for users: at the end of each stage the skill drafts a commit message and asks "commit this now?"; nothing is committed without a yes.
- Trade-offs: uneven history because people skip it; reviews cannot rely on commits, so private save points remain.
- Why rejected: leaves the core problem half-solved — the whole point is that nobody has to remember.

### B. Automatic checkpoints at every milestone, including every task — Rejected

- What it means for users: a commit at every recorded stage and every finished task, with an off switch.
- Trade-offs: noisy history, commits of half-finished work, and per-task commits that make "what did this slice change" span many commits.
- Why rejected: per-task granularity adds noise without helping reviews; slice-level commits give the useful boundaries.

### C. Two tiers: planning committed at every stage, code committed at slice boundaries — Chosen

- What it means for users: planning work is saved the moment a stage is recorded; each slice's code becomes a readable, revertable commit, with review fixes as their own commits.
- Trade-offs: no per-task granularity; slices built side by side in one folder can mix into each other's commits.
- Why chosen: never lose planning work, give reviews real commit boundaries, and keep history readable at the level people think in (stages and slices).

### D. Private restore points everywhere, real commits only on request — Rejected

- What it means for users: a "rewind to before slice 2" safety net at every stage without touching the branch.
- Trade-offs: restore points are machine-local and invisible to teammates; two concepts ("checkpoint" vs "commit") to explain.
- Why rejected: does not protect planning work if the folder is lost, and adds a confusing parallel concept.

### Commit trigger: detect file writes — Rejected (stress test)

- What it means for users: a commit whenever a stage's file is written, detected by per-agent hooks or a background watcher.
- Trade-offs: works differently (or not at all) per agent, needs an always-running process, and commits every half-finished rewrite of a document.
- Why rejected: the Weave command each skill runs right after writing is already the same in every agent and fires when the stage is finished.

## Chosen Direction

Weave commits work automatically on the change's own branch at two kinds of moment. The guiding principle is to keep it simple: a commit either happens or it doesn't, and when it doesn't, the person is told it failed and why. Nothing is ever blocked by a commit.

**Planning commits.** Whenever Weave records something in the change's status, it commits. That covers progress on any stage (questions, research, product shape, PRD, findings, architecture, slices, including revisions through clarify and document captures), a stress-test verdict, the knowledge status, clearing an out-of-date flag, and recording a review result. Because every skill runs one of these Weave commands right after writing its document, this works the same in every agent and needs no detection of file writes. A planning commit includes the change's own planning folder plus any shared documents that stage itself wrote (for example, recorded decisions drafted during architecture, or wiki pages updated by the knowledge stage), and any edits the person had staged. If the stage made other documents out of date, the commit still happens; the change's status goes in the same commit and the message names what is now out of date. Planning commits skip the project's own commit checks: they are plain documents and are never blocked. Unattended phases make planning commits too, because saving is part of recording the stage; the unattended session gains no general ability to commit.

**Catch-up save.** Before each planning commit, Weave first commits any leftover planning files from earlier — session notes, or a document from a skill that was interrupted before recording — as their own commit. Nothing is left uncommitted beyond the next recorded step.

**Code commits.** When a slice finishes building, Weave makes one build commit containing everything that changed in the slice's repos, including the slice's task notes and evidence, and tells the person which files it included. A slice that is only partly built keeps its code uncommitted until it finishes (its notes may ride along in planning commits). Each slice review fix round adds its own commit on top, and the final review's fix batch gets its own commit. Code commits always run the project's commit checks. Reviews use these commits as their boundaries instead of private save points. If a slice is finished again later (tasks added, or a "not tested" task completed), that is another build commit, and the existing out-of-date check asks for re-review. Before a new slice starts building, the catch-up save also applies to code: leftover code from the previous slice is committed as that slice's late build commit.

**Commit messages** explain intent, not just position. A slice commit's subject says what the slice is for in plain words; the body gives the slice's goal, the tasks completed, whether it is the build or fix round N (and which findings a round fixes), and the change ID and slice name. A planning commit's subject names the stage and its gist ("PRD: commit checkpoints at each pipeline stage"); the body summarises what was decided, what is now out of date, and the change ID. Messages are built from what is already written down (slice goals, task titles, findings, the stage's summary) so they stay consistent, including from unattended phases. When a project documents its own commit-message rules — a format, or things that must not appear in history — those win; Weave's styles are only the default.

**Controls.** On by default, including for projects that upgrade mid-change; the first time Weave commits in a project it says so once and how to turn it off. A project switch turns it off for everyone. With the project switch on, a person can turn it off for themselves in their own Weave settings, and any change can be skipped individually. With it off, Weave behaves exactly as today.

**Scope limits.** Weave only commits; it never pushes, never commits onto a branch other than the change's own, makes no empty commits, and adds no "undo" command (people undo with git as usual). Older changes planned without slices get planning commits only; their code is not committed automatically and their review keeps using private save points.

**Visible effects in the change list.** Because every change has commits from its first recorded stage: "no commits yet" and "planning files can't be recovered" largely disappear, and a deleted folder can always be recreated; a change abandoned during planning reads "closed, not landed" instead of "done"; and a planning save recorded after a merge marks the change "landed with newer commits".

**Follow-up (separate change).** After the knowledge stage, Weave offers — never automatically — to push the branch and open a pull request, with a PR-drafting skill that writes the title and description from the change's written record.

## Scenarios

1. Priya records the architecture for a change. Weave commits the architecture and the two decisions it drafted. The revision makes the slices out of date, so the commit message reads "Architecture: … — slices now out of date". Later she revises the slices through clarify; that is its own commit, and clearing the stale flag is recorded in it.
2. Research runs unattended after questions. When the session records research, Weave commits the research document without running any of the project's commit checks. Nobody had to be present, and the session could not commit anything else.
3. Sam finishes building slice 2. Weave commits everything that changed, titled with the slice's purpose, and lists the files it included. The review compares against that commit; recording the review is a planning commit ("Slice 2 review: 2 issues"). The fix round becomes its own commit that can be undone on its own.
4. Sam stops after three of five tasks in slice 3. The code stays uncommitted. A clarify recorded meanwhile commits the slice's task notes along with the revised document, but not the code.
5. The project's commit checks reject slice 4's build commit because of a lint failure. Weave reports the failure and its reason; the review still runs, using a private save point for that slice. Before slice 5 starts building, the catch-up save retries slice 4's leftover code as "slice 4: build (committed late)". If that fails again, Sam is told slice 5's review will include slice 4's leftovers.
6. During a long PRD discussion, Priya captures two session notes. Weave is not told. When the PRD is recorded, the catch-up save commits the notes first, then the PRD gets its own commit.
7. An agent writes `exploration.md` but the session crashes before recording progress. The file stays uncommitted until the next recorded step, when the catch-up save commits it.
8. A workspace change's slice touches two repos. Each repo gets its own build commit with the same message. If one repo's commit fails, the person is told which repo and why, that repo's review uses a private save point, and the catch-up save retries it before the next slice.
9. Git in the change's folder is on some other branch when a stage is recorded. Weave does not commit and tells the person why.
10. A team that only allows people to make commits turns the project switch off; Weave behaves as it does today. On a team that leaves it on, Alex turns it off in their own settings; Weave stops committing for Alex only.
11. A change was half-way through when this shipped. The first stage recorded afterwards announces the feature once and makes the first commit, with the catch-up save sweeping up earlier uncommitted planning files. No history is back-filled.
12. Sam undoes slice 3's build commit with git. The slice's task ticks return to not done, and its review is marked out of date by the existing check. Later slices that relied on that code are caught by their own reviews and tests.
13. An unattended research run saves at the same moment Priya records a capture in another session. One save fails with a reason; the catch-up save picks up anything it missed at the next recorded step.

## Decisions

- Two tiers: planning committed at every recorded stage; code committed at slice boundaries — planning is never lost, and slices are the unit people and reviews reason about.
- Keep it simple: a failed commit only tells the person it failed and why; nothing is blocked, retried in a loop, or queued — the feature must not complicate or stall the pipeline.
- A planning commit happens whenever Weave records something in the change's status (stage progress, verdict, knowledge status, clearing an out-of-date flag, review results) — Weave cannot see file writes, but every skill runs one of these commands right after writing, identically in every agent. (stress test C1)
- A catch-up save commits leftover planning files (session notes, interrupted skills' documents) as their own commit before each recorded commit — closes the gap for anything recorded nowhere, without hooks or watchers. Replaces the earlier decision that capturing a session note triggers its own commit. (stress test C1)
- The stress test produces two commits: the revised shape, then the verdict. (stress test C1)
- A slice is committed when building finishes, before review; each fix round is its own commit; the final review's fix batch is its own commit — reviews need a fixed "what was built" point, and separate fix commits keep reviewer-driven changes visible and individually undoable. (final review: stress test C6)
- Partly built slices keep their code uncommitted until the slice finishes; their notes may go into planning commits — one build commit per slice, while notes are planning documents. (stress test C4)
- Recording a review result is a recorded moment and makes a planning commit — otherwise a clean review's records stay unsaved. (stress test C4)
- The catch-up save also applies to code: before a new slice starts building, leftover code from the previous slice is committed as its late build commit — keeps one slice's work out of the next slice's commit and review. (stress test C4)
- A planning commit contains the change's own folder, shared documents that stage itself wrote, and any edits the person staged — simple, and nothing the person lined up is lost. (staged edits: stress test C5)
- Commit even when a stage makes other documents out of date, and name them in the message — a commit is a record of what happened, not a consistency guarantee.
- Planning commits skip the project's commit checks; code commits always run them — planning commits are plain documents and must never be blocked, and this avoids running project commands in folders not yet set up or with nobody present. (stress test C2)
- Unattended phases make their planning commit as part of recording the stage, without gaining general commit rights — accepted deliberately as a change to what recorded decision 261108-4z8l promises. (stress test C3)
- A slice's build commit includes everything changed in the slice's repos, in both kinds of checkout, and the person is told which files went in — simple, and stray files are noticed immediately. (stress test C5)
- Finishing an already-committed slice again makes another build commit; the existing out-of-date check asks for re-review. (stress test C7)
- No undo command; people undo with git, and existing out-of-date review detection handles the aftermath. (stress test C7)
- Older changes planned without slices get planning commits only; their review keeps private save points — they are legacy and never migrated. (stress test C6)
- The change-list effects (no "no commits yet", abandoned changes reading "closed, not landed", post-merge saves flagging newer commits) are intended and belong in the PRD as visible changes. (stress test C8)
- On by default, including on upgrade, with a one-time notice the first time Weave commits in a project. (stress test C9)
- Project switch off means off for everyone; with it on, a person can turn it off in their own Weave settings; the per-change skip still applies — personal preferences belong in personal settings (recorded decision 261109-a8k5). (stress test C9)
- Never commit onto a branch other than the change's own; no empty commits.
- Weave never pushes — pushing is outward-facing and the person's decision.
- In multi-repo workspaces, planning commits go to the workspace root; slice and fix commits go to each repo the slice changed, with the same message; a partial failure is handled per repo (commit where made, private save point elsewhere, catch-up retry before the next slice). (stress test C12)
- Commit messages carry intent drawn from written artifacts plus the change ID; a project's documented message rules (format and exclusions) win over Weave's default styles. (stress test C10)
- Two simultaneous saves are not coordinated; one may fail with a reason and the catch-up save recovers. (stress test C11)
- No migration for changes already in progress; the first commit after shipping sweeps up earlier planning files.
- Push and pull-request drafting are a separate, later change — this change is already medium–large, and the PR skill raises its own product questions.

## Assumptions

- Building two slices side by side in one folder is rare; when it happens, mixed commits are acceptable and reviews still label files outside a slice.
- People are willing to squash or tidy the change's history when merging if they want a shorter history.
- Keeping private save points as a review fallback (failed build commits, older changes without slices) is acceptable.
- Teams merge the whole change branch, planning files included, as Weave expects today; teams that keep planning files off main may never see a change read as landed.
- Agents reliably run the recording step after writing a document; when they do not, the catch-up save keeps the cost to a less precise history, never lost work.

## Open Questions

- Should recorded decision 261108-4z8l (auto-advance permissions) be superseded to state that unattended phases make planning commits through Weave? — blocks the PRD: no (for `weave-architect`).
- Should recorded decision 261110-wdfo (review boundaries) be superseded now that commits become the primary boundary with private save points as fallback? — blocks the PRD: no (for `weave-architect`).
- Decision 261108-kl3n's "Reconsider When" names planning commits: can a change's starting branch now be stored on the branch itself? — blocks the PRD: no (for `weave-architect`).
- Exactly which stage write-ups count as "shared documents the stage itself wrote" beyond decisions and knowledge pages (for example, coding guidelines drafted by their own skill)? — blocks the PRD: no.
- How an unattended phase whose commit failed is shown to the next person (run status wording, `weave-next` hint) — blocks the PRD: no.
- Whether the commit author should be the person, or the person with an agent co-author line — blocks the PRD: no.
- Where Weave finds a project's documented commit-message rules — blocks the PRD: no.
- Follow-up change: after the knowledge stage, offer to push and open a pull request with a PR-drafting skill (description contents, hosting services, one PR per repo in workspaces, draft vs ready) — blocks the PRD: no; out of scope here.

## PRD Readiness

Ready
