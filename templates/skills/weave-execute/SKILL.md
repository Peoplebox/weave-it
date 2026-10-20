---
name: weave-execute
description: Implement selected tasks of the active Weave change locally. Resolves task dependencies, prepares branches, writes the code, runs verification, and records evidence in tasks.md, without committing, pushing, or opening PRs. Use when the user says implement, execute, build, or work on specific tasks (for example T1 to T3) or the next ready slice. Not for planning the work (use weave-slices).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.11"
---

# Weave Execute

Use this skill when the user wants an agent to execute selected `T#` tasks in an active Weave change.

Execution means: resolve the active change, read `tasks.md`, resolve the user's selector, expand dependencies from `Blocked by:`, run prepare for the final task set, implement each eligible task, run appropriate verification, update local task evidence, and summarize outcomes.

Execution is local-only. It must not commit, push, open pull requests, create remote branches, stash, discard changes, force-checkout, publish external issue updates, or create a separate execution run-history artifact.

# Silent Weave Command Output

Weave skills run Weave CLI commands silently by default. Use command results
as internal context, not response content.

Do not show raw stdout, JSON payloads, command echoes, lifecycle payloads,
internal state-write confirmations, or verbatim notice text unless the user
explicitly asks for diagnostic output.

Surface only information that changes what the user or agent should do next:
blockers, failures, missing relevant repos, branch or task outcomes,
lifecycle failures, package-outdated notices, relevant outdated or modified
skills, and user-required actions.

Notice handling:

- `package_outdated`: show only when present. Say exactly:
  `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. If the invoked skill is outdated, say:
  `The installed \`<skill-name>\` skill appears older than the bundled template. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh installed skills.`
- `skills_outdated`: if multiple skills used in this workflow are outdated, say:
  `Some installed skills used in this workflow appear older than the bundled templates: \`<skill-a>\`, \`<skill-b>\`. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh them.`
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. If the invoked skill is modified, say:
  `The installed \`<skill-name>\` skill has local edits, so its behavior may differ from the bundled template. Run \`weave status\` or \`weave agent diff\` if you want to inspect the difference.`
- `skills_modified`: if the user asks to update skills and installed skills have local edits, say:
  `Some installed skills have local edits. \`weave agent update\` may skip or protect them; run \`weave status\` or \`weave agent diff\` before updating.`

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.

# Resolve Context

Start with Tier 1 context commands:

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If there is no active change, stop and say that the user needs `weave change new` or `weave change switch` first.

Detect task mode before reading tasks:

```text
wiki/changes/<change-id>/task-slices/   -> slice mode
wiki/changes/<change-id>/tasks.md       -> flat mode (legacy)
```

**Slice mode:** read `task-slices/<slice-id>/tasks.md`. Accept `<slice-id> <task-id>` selectors (e.g. `/weave-execute 01 T1`). Enforce within-slice-only `Blocked by:` deps. Call `weave slice rollup --all --json` at episode boundaries (end, HITL pause, error exit).

**Flat mode:** read change-root `tasks.md`. Use legacy selectors (`T#`, `all`, scope). Today's behavior unchanged.

If neither mode has tasks, stop and tell the user to run `weave-slices` first.

# Selector Handling

Resolve the user's selector before preparing or implementing anything.

Supported invocation shapes:

```text
/weave-execute
/weave-execute T3
/weave-execute T1 T3 T7
/weave-execute backend
/weave-execute all
/weave-execute 01 T1
```

Map user input as follows:

- `all` -> all executable `T#` tasks in the active task artifact (flat `tasks.md` or selected slice)
- Slice mode: `<slice-id> <task-id>` -> that task in the named slice
- Task ids such as `T1` or `T1 T3` -> those explicit task ids
- A single non-task, non-`all` value such as `backend` -> tasks whose `Scope` matches that value

If invoked without arguments, ask:

```text
What should I execute: all tasks, a scope like backend, or specific task ids like T1 T3?
```

When asking, derive available examples from `tasks.md`: include `all`, available `Scope` values, and available `T#` task ids. Do not default to `all`.

If no tasks match the selector, or an explicit task id is missing, stop before prepare or implementation.

# Task Eligibility

Only execute `T#` tasks. Do not execute `QF#` findings or `R#` refactor records directly.

Executable statuses:

- `todo`
- `in_progress`
- `not_tested`

Conditionally executable:

- `blocked` only after all listed `Blocked by:` dependencies are resolved in the same run or are already `done`

Skip by default:

- `done`
- `invalid`

# Dependency Ordering

Use `Blocked by:` as the source of dependency truth.

For explicit task id selectors, if a selected task depends on incomplete tasks outside the explicit selection, tell the user which blockers must be executed first and ask before expanding the run.

For scope and `all` selectors, automatically include required incomplete blocking tasks and execute them before dependent selected tasks.

Stop before prepare or implementation when:

- a dependency references a missing task id
- a dependency value is unclear and cannot be interpreted as `None` or `T#` ids
- dependencies form a cycle

If a task fails, continue independent later tasks. Skip downstream tasks whose dependencies failed, and summarize those skips at the end.

# Run Prepare Before Implementation

Run exactly one prepare command before implementing anything.

Use the deterministic prepare CLI. The CLI owns branch readiness and `status.yml.execution` writes for the active repo or workspace. Do not hand-edit `status.yml` and do not run git checkout commands yourself for this workflow.

Task and slice selection stays inside `/weave-execute`; prepare is only a branch-readiness preflight.

In slice mode, read the selected slice's `task-slices/<slice-id>/status.yml` `repos:` value and pass each repo id to prepare:

```bash
weave task prepare --repo <repo-id> --repo <repo-id> --json
```

If the selected slice has no repos, or when running in repo mode / flat mode, call:

```bash
weave task prepare --json
```

If the global `weave` command is unavailable in this repo, use the local development form:

```bash
npm run dev -- task prepare --repo <repo-id> --repo <repo-id> --json
```

Use the same repo flags with the local development form. Omit them when using the bare prepare form.

If prepare reports blockers, stop before implementation. State that no selected implementation repo branches were moved when the prepare result is blocked.

Dirty work already on the expected branch is allowed when prepare succeeds. Dirty work on another branch must be resolved by the user; do not stash, discard, or force-checkout it.

# Execute Tasks

Execute tasks in dependency order.

Before starting each task:

1. Patch only that task's active index row and detail `Status:` to `in_progress`.
2. Do not rewrite unrelated task wording or unrelated task sections.
3. For HITL tasks, pause for the required human input before proceeding. `/weave-execute all` includes HITL tasks, but still pauses before each HITL task.

During implementation:

- Use the task's `### What to build`, acceptance criteria, verification guidance, architecture refs, and repo anchors as the implementation contract.
- Keep edits scoped to the task.
- If the task exposes missing or ambiguous instructions, ask before guessing.

# Verification

Run task-listed checks first. Then run the smallest relevant broader checks when the task's blast radius warrants it.

Examples:

- a skill packaging change should usually run the relevant `tests/agent-skills.test.ts` tests
- a CLI or library behavior change should usually run targeted tests plus typecheck when practical
- final cross-cutting verification may run `npm run typecheck`, `npm test`, and `npm run build`

If verification cannot run, explain why. Mark a task `not_tested` only when implementation appears complete but verification could not be completed.

# Task Artifact Updates

Update `tasks.md` directly and narrowly.

Allowed updates for affected tasks:

- active task index status
- detail section `Status:`
- acceptance criteria checkboxes that were actually satisfied
- concise verification notes under the affected task's `### Verification` section

Status rules:

- set `in_progress` when work begins for a task
- set `done` only when implementation is complete and verification passes
- set `not_tested` when implementation appears complete but verification could not run
- leave or set `in_progress` with notes when implementation is incomplete or verification fails
- skip `done` and `invalid` tasks by default

Do not rewrite unrelated task wording, unrelated task sections, `QF#` entries, `R#` entries, invalid task history, or global task sections unless the selected task's own evidence requires a narrow local note.

# Final Summary

Finish with a grouped outcome summary:

- completed tasks
- tasks left `not_tested`
- failed or still-`in_progress` tasks
- skipped tasks, including `done`, `invalid`, or dependency-blocked tasks
- prepare blockers, if any
- verification commands or checks that passed, failed, or could not run
- next steps for anything unresolved

Always state that `/weave-execute` did not commit, push, open a PR, create remote branches, stash, discard changes, or publish external issue updates.
