# weave-execute

## Purpose

`weave-execute` is the agent-first local task execution workflow for an active Weave change. It carries selected `T#` tasks through branch preparation, implementation, verification, and local task evidence updates.

## Current Behavior

The opencode slash wrapper `/weave-execute` loads the `weave-execute` skill. The skill resolves the active Weave context, detects execution mode, resolves the user's selector, expands dependencies from `Blocked by:`, runs branch prepare for the final task set, implements eligible tasks, verifies them, and updates task-local evidence.

### Execution modes

**Slice mode** (when `wiki/changes/<change-id>/task-slices/` exists):

- Reads tasks from the selected slice's `tasks.md` (or walks slices for `all`).
- Selector: `<slice-id> <task-id>` (e.g. `01 T1`) or `all`.
- Runs `weave slice rollup` at episode boundaries (start and end of execution) for the affected slice(s).
- Chooses slices from `ready_slices` in `weave slice rollup --all --json` instead of working out readiness from `depends_on`. A selected `pending` slice must be listed there; otherwise the skill names the `depends_on` slices holding it back (not done yet, or, while code review is active, not reviewed yet or waiting on a person) and stops before prepare. A slice already `in_progress` can continue.
- Branch prep uses the selected slice's `status.yml.repos` and passes those repo ids to `weave task prepare --repo <id>`. Registered workspace repos outside the selected slice are not switched or blocked.

**Flat legacy mode** (when only change-root `tasks.md` exists):

- Reads `wiki/changes/<change-id>/tasks.md`.
- Selector: task ids (`T3`), scope (`backend`), or `all`.

Supported invocation shapes:

```text
/weave-execute
/weave-execute T3
/weave-execute T1 T3 T7
/weave-execute backend
/weave-execute all
/weave-execute 01 T1
/weave-execute 02 all
```

When invoked without arguments, the skill asks for slice+task or flat-mode selectors based on detected mode. It does not default to `all`.

Branch preparation is built into `weave-execute` (via `weave task prepare`); `/weave-prepare` is deprecated.

## Domain Model

Selection modes:

- explicit task ids: `T1`, `T1 T3`
- scope: a single non-task, non-`all` value matched against task `Scope`
- all: `all`, meaning all executable `T#` tasks in `tasks.md`

Executable statuses:

- `todo`
- `in_progress`
- `not_tested`

Conditionally executable:

- `blocked` only after all listed blockers are resolved in the same run or are already `done`

Skipped by default:

- `done`
- `invalid`

Only `T#` tasks execute directly. `QF#` findings and `R#` refactor records are source context for related tasks, not execution targets.

## Behavioral Rules

- `Blocked by:` is the dependency source of truth.
- For explicit task id selectors, incomplete blockers outside the explicit selection require user confirmation before expanding the run.
- For scope and `all` selectors, required incomplete blockers are included automatically and run before dependents.
- Missing dependency ids, unclear dependency values, and dependency cycles stop execution before prepare or implementation.
- Prepare always runs before implementation (absorbed from deprecated `weave-prepare`).
- Prepare uses `weave task prepare ... --json`, with `npm run dev -- task prepare ... --json` as the local development fallback when the global `weave` command is unavailable.
- In slice mode, prepare is scoped to the selected slice's `status.yml.repos` using repeatable `--repo <id>` flags. In repo mode and flat mode, prepare runs without repo filters.
- In slice mode, rollup runs before and after the execution episode for affected slices.
- Prepare blockers stop execution before implementation.
- Each task moves to `in_progress` when task work begins.
- A task moves to `done` only when implementation is complete and verification passes.
- A task moves to `not_tested` only when implementation appears complete but verification could not run.
- A failed or incomplete task remains `in_progress` with concise notes.
- Independent tasks may continue after an unrelated failure.
- Downstream tasks whose dependencies failed are skipped and summarized.
- HITL tasks are included in `all`, but the agent pauses before each HITL task for required human input.

## Code Review Hook

In slice mode, finishing a slice includes its code review (see [code-reviews](../code-reviews/behavior.md)). `weave-execute` only records where the slice started and hands over; `weave-review` does the reviewing.

- Before the first task of a slice moves to `in_progress`, it runs `weave review status --slice <slice-id> --json`.
- `active: false` (`inactive_cause`: `change_skipped`, `workspace_off`, or `skill_not_installed`): every review step is skipped and the run is otherwise unchanged. This covers projects that updated `weave-execute` but never installed `weave-review`.
- `active: true` and the slice is still `pending`: it records the start snapshot before changing any file with `weave review snapshot --slice <slice-id> --at start --json` (an existing start snapshot is kept). A slice already `in_progress` without `review.start_ref` gets no late snapshot; its review then measures from the change base.
- After the slice's last task in the run it runs `weave slice rollup --all --json`. When review is active and the slice reports `ready_for_review: true` (every active task `done` or `not_tested`), it hands over in the same session, in the foreground: load the `weave-review` skill and run its slice review for `<id>`, reading it from one of `skill_paths` if it cannot be loaded by name.
- It waits for the review, fix rounds, and rulings before starting another slice, and never runs a review in the background.
- When the review stops on a plan problem (`waiting_on_person`), the run ends there and the user is told what to decide.
- After the review it rolls up again and takes any next slice from `ready_slices`. It does not change task statuses because of review fixes or rulings.
- The final summary lists slice reviews handed to `weave-review` and their outcome, or that review was inactive.

The skill also handles the `skills_available` notice: it is suppressed unless `weave-review` is among the missing skills, and then the user is told how to install it.

## Task Evidence

`weave-execute` updates `tasks.md` narrowly:

- active task index status for affected tasks
- detail section `Status:` for affected tasks
- acceptance criteria checkboxes that were actually satisfied
- concise verification notes under each affected task's `### Verification` section

It does not rewrite unrelated task wording, unrelated sections, `QF#` entries, `R#` entries, invalid task history, or global task sections unless a selected task's own evidence requires a narrow local note.

## Non-Goals And Side Effects

`weave-execute` is local-only. It does not:

- add `weave task execute`
- run `git commit` itself (Weave's `weave slice rollup` makes the slice's build commit and review packaging makes fix commits; see [checkpoint-commits](../checkpoint-commits/behavior.md))
- push
- open pull requests
- create remote branches
- stash, discard, force-checkout, or otherwise resolve dirty work automatically
- publish external issue tracker updates
- create per-repo task artifacts
- create a separate execution run-history artifact or `status.yml` execution log

## Source Anchors

- Skill: `templates/skills/weave-execute/SKILL.md` (`# Code Review Hook`)
- Review commands used by the hook: `src/commands/review/status.ts`, `src/commands/review/snapshot.ts`; readiness: `src/lib/review/rules.ts` (`isReadyForReview`, `satisfiesDependents`)
- Wrapper: `templates/opencode/commands/weave-execute.md`
- Installed copies: `.agents/skills/weave-execute/SKILL.md`, `.claude/skills/weave-execute/SKILL.md`, `.opencode/commands/weave-execute.md`
- Prepare: `src/commands/task.ts`, `src/lib/task-prepare.ts`
- Slice rollup: `src/lib/sliceRollup.ts`, `src/commands/slice.ts`
- Task parsing: `src/lib/tasks.ts`
- Tests: `tests/agent-skills.test.ts`, `tests/slice-rollup.test.ts`

## Change History

- 2026-06-07 (change `260607-bbam-task-execution-workflow`): introduced `/weave-execute` as a bundled agent skill and opencode wrapper for local task execution, prepare delegation, dependency handling, HITL pauses, verification, and narrow `tasks.md` evidence updates.
- 2026-11-11 (change `261111-kdv6-commit-checkpoints`): runs `weave slice rollup --all --json` before each slice's first task (retrying an earlier slice's build commit) and after its last, reports build commits from `checkpoints[]`, and names the checkpoint commits in its final summary instead of claiming it never commits.
- 2026-06-09 (change `260609-rrsq-weave-slice`): dual-mode slice vs flat legacy execution; built-in branch prep; rollup episode boundaries; slice selector `/<slice-id> <task-id>`.
- 2026-06-12 (change `260611-cuvh-slices-execution-default-afk`): slice-mode prepare now passes the selected slice's `status.yml.repos` to `weave task prepare --repo <id>`, so workspace repos outside the selected slice are not switched or blocked.
- 2026-11-01 (branch `change/questions-research-skills`): checks recorded decisions before changing code, stops on a conflict, and reports decisions consulted and candidate ADRs.
- 2026-11-10 (change `261110-g2wn-code-reviewers`): added the code review hook (activation check, start snapshot, hand-over to `weave-review` when a slice is ready for review, wait before the next slice) and slice selection from rollup's `ready_slices`.

## Open Questions

- Whether future versions should add a deterministic task-evidence update helper or `weave task execute` command. V1 keeps execution in the agent skill.
