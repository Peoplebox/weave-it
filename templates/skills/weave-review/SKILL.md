---
name: weave-review
description: Review the active Weave change's code with fresh, independent reviewers. Runs the slice review when a slice's tasks are done (package, reviewer, up to the configured fix rounds with fresh fix checkers, rulings, saved Minors), stops for a person on plan problems, and runs the final review of the whole change on the most capable model, ending with a verdict and the full list of rulings. Use when weave-execute hands over a finished slice, when weave-next recommends a review, or when the user asks to review a slice or the whole change. Not for building the tasks (use weave-execute).
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init. Uses the agent's own sub-agent tool to start fresh reviewers when the agent supports sub-agents.
metadata:
  author: weave-tools
  last_changed_in: "0.1.13"
---

# Weave Review

Use this skill to review the code of the active Weave change. There are two reviews:

- **Slice review**: one slice's code, as soon as its tasks are done.
- **Final review**: the whole change, once every slice is reviewed.

Judgement lives here: when to review, which brief to hand over, how to receive findings, how many fix rounds to run, when to stop for a person, and which model level to use. Every mechanical step is a `weave review` command. Never edit `status.yml`, `review.md`, or anything under `review/` by hand; the CLI writes all review state.

Reviews always run in the foreground. Never run a review in the background, and never move on to other work while a review is running.

# Invocation

```text
weave-review slice <id>     review one slice (folder name or leading number)
weave-review change         final review of the whole change
weave-review                pick from the review status and the gate
```

With no argument, run `weave review status --json` and `weave review gate --change --json`, then:

- a slice whose `effective_state` is `not_reviewed`, `out_of_date`, or `review_failed` -> review the first such slice
- a slice that is `in_review` -> resume it (see **On Demand**)
- otherwise, a gate with `pass: true` and no `reason`, and a change review that is not finished or is out of date -> run the final review
- otherwise, say there is nothing to review and why

`weave-execute` hands over with: load the `weave-review` skill and run its slice review for `<id>`. Treat that exactly like `weave-review slice <id>`.

# Resolve Context

```bash
weave change current --json
weave review status --slice <id> --json      # for a slice review
weave review status --change --json          # for the final review
```

If there is no active change, stop and say the user needs `weave change new` or `weave change switch` first.

Read from the status result:

- `active`: when false, review is off. A hand-over from `weave-execute` or a run you started on your own does nothing. When the person asked for this review themselves, act on `inactive_cause`:
  - `workspace_off`: review is switched off for the workspace. Say so, then run the review anyway, adding `--force` to every `weave review package` command.
  - `change_skipped`: stop. Say the change was skipped and that `weave review unskip` turns review back on.
  - `skill_not_installed`: stop. Say `weave agent install <agent>` installs `weave-review`.
- `settings.slice_rounds`: the number of fix rounds a slice review may run (default 2).
- `settings.models`: per-agent model names that override the table in **Model Levels**.
- `review.latest_run`, `stored_state`, `effective_state`, `ready_for_review`.

Changes without `task-slices/` (flat mode) have no slice reviews. Only `weave-review change` runs on them.

# Model Levels

State the model level on every hand-over. Never leave it to the session default.

| Review | Level |
| --- | --- |
| Slice review | the package's `model_level` (`mid`, or `most_capable` for large slices). Raise `mid` to `most_capable` when the slice is risky: security, permissions, data migrations, money, concurrency, or a slice spanning several repos. Never below `mid`. |
| Fix check | `cheap` for a small round (a few files, no Critical finding), otherwise `mid`. Never above `mid`. |
| Final review | `most_capable`, always. |

Built-in model per level, by the agent you are running in:

| Agent | `cheap` | `mid` | `most_capable` |
| --- | --- | --- | --- |
| `claude` | `haiku` | `sonnet` | `opus` |
| `codex` | the fastest model the client offers | the client's standard coding model | the strongest model the client offers |
| `cursor` | the fastest model the client offers | the client's standard coding model | the strongest model the client offers |
| `opencode` | the fastest model the configured provider offers | the provider's standard coding model | the strongest model the provider offers |

When `settings.models.<agent>.<level>` is set, use that name instead. When the client's sub-agent tool cannot choose a model at all, the reviewer runs on the session model; say so in the final response.

# Handing a Brief to a Reviewer

The briefs sit beside this file:

- `slice-reviewer-brief.md`: the slice review
- `fix-check-brief.md`: one fix round's check (also the final review's fix check)
- `final-reviewer-brief.md`: the final review

To hand one over:

1. Read the brief and replace every placeholder:
   - `{PACKAGE_PATH}`: the `package_path` from the package command
   - `{SCOPE}`: `slice <slice-id> of change <change-id>`, or `the whole change <change-id>`
   - `{SLICE_OR_CHANGE_DOCS}`: the planning documents the reviewer must read, one path per line: for a slice, its `slice.md`, `contracts.md` (when present), and `tasks.md`; for the change, `prd.md` (or `findings.md` or `exploration.md`), the architecture files, and `task-slices/` (or `tasks.md` in flat mode)
   - `{MODEL_LEVEL}`: the level you chose, with the model name
   - `{ROUND}`: the run and what is being judged, for example `02-api/r1, first review` or `02-api/r1, fix round 2`
2. Hand the filled brief to a fresh reviewer sub-agent with your agent's own sub-agent tool: in the foreground, at the chosen model, with the filled brief as its only input. It is never a fork of this conversation. The reviewer must not know how the code was built. When the tool can limit the sub-agent to read-only tools, do so.
3. Wait for its response. Save the response, unchanged, beside the package: the `package_path` with `.package.md` replaced by `.response.md` (for a fix check, `.check-response.md`). Never edit a reviewer's response.
4. Record it:

   ```bash
   weave review record --run <run-id> --report - --json < <response-file>
   ```

5. If `record` fails with `report_invalid` (exit 4), hand the same filled brief to a fresh reviewer again, adding the schema errors from the result and asking for a complete response that ends with a valid JSON block. Record that response. If it fails a second time, close the run and stop retrying:

   ```bash
   weave review record --run <run-id> --failed --json
   ```

   Tell the person the review failed and that `weave-review slice <id>` (or `weave-review change`) starts a new run.

**Clients without separate reviewers.** If your agent cannot start a sub-agent, run the filled brief yourself in this session: read only what the brief lists, follow its rules, and write the response it asks for. Add `--independent false` to every `weave review record` command of that run, and say in the final response that the review was less independent.

Reviewers never run `weave` commands, never edit files, and never start further reviewers. You run every command.

# Slice Review

Follow these steps in order. `<run>` is the `run_id` the package returns, such as `02-api/r1`.

1. **Package.** `weave review package --slice <id> --json`. On demand, when the slice's tasks are not all `done` or `not_tested` (`slice_not_ready`), add `--partial`; the run is then recorded as partial. Note `run_id`, `package_path`, `model_level`, `partial`, and `warnings`.
2. **Review.** Hand `slice-reviewer-brief.md` to a fresh reviewer (see above) and record its response.
3. **Plan problems?** When the record result's `plan_findings_open` is not empty, the slice is `waiting_on_person`. Stop now (see **Plan Problems Always Stop**).
4. **Receive.** Read the run's findings (`findings_path` in the record result) and receive every open finding (see **Receiving Findings**).
5. **Fix rounds.** For round `N` from 1 to `settings.slice_rounds`, while any agreed Critical or Important code finding is open:
   1. `weave review snapshot --run <run> --at round-start --round <N> --json`, before you change anything.
   2. Fix every agreed Critical and Important finding in one batch, inside slice-owned files only (see **Fixes Stay Inside the Slice**).
   3. Re-run the slice's automatic checks: the commands in its tasks' `### Verification` sections. A failing check is part of the round: fix it inside the round or leave the finding open.
   4. `weave review package --run <run> --fix-round <N> --json`. It saves the round patch and returns the fix checker's `package_path` and `targets`.
   5. Hand `fix-check-brief.md` to a fresh fix checker (never the earlier reviewer) and record its response.
   6. For each finding in the result's `addressed` list:

      ```bash
      weave review record --run <run> --resolve <finding-id> --as fixed --round <N> --json
      ```

   7. Findings in `not_addressed` stay open for the next round. New findings in `new_findings` are received like any other: a new plan finding stops the review, a new Minor is parked, a new Critical or Important finding joins the next round.
6. **Rulings.** Every finding still open after the last round gets a ruling (see **Rulings**).
7. **Finalize.** `weave review record --run <run> --finalize --json`. The slice becomes `reviewed`, or `reviewed_with_rulings`. If it fails with `finalize_blocked`, resolve the findings it lists and finalize again.
8. **Gate.** `weave review gate --change --json`. When `pass` is true and there is no `reason`, start the **Final Review** in this session straight away. Otherwise return to the caller: `weave-execute` continues with its next slice.

A fix that touches a slice with a `Human check:` step is marked "needs your check" by the CLI. The automatic checks still run and the slice is not blocked; list the human steps in the final response.

# Receiving Findings

The reviewer can be wrong. Receive each finding on its merits, not on the reviewer's confidence.

- **Verify first.** Check each finding against the code before acting on it. Read the location, the requirement it cites, and the surrounding code.
- **Fix what holds up.** A Critical or Important code finding that holds up and can be fixed inside the slice's own files goes into the next fix round.
- **Push back with reasons.** A finding that does not hold up is not fixed. Record a ruling with `--agreed false` and the evidence: what the code does and why the finding is mistaken. Do this before the round is packaged, so the fix checker checks only the fixes you made.
- **Clarify everything unclear before fixing anything.** When a person is present, ask about every unclear finding in one message and wait for the answers before starting the round. When nobody can answer (an unattended or delegated run), record each unclear finding as a ruling with `--agreed false` whose reason starts with `Unclear, not acted on:` and states the question.
- **Nothing unused.** Do not add features, options, or abstractions that nothing uses because a reviewer suggested them. Fix the problem, not the suggestion.
- **No performative agreement.** Do not praise the review or agree before you have checked. Report what you verified and what you changed.
- **Minors are saved.** Do not fix Minor findings in slice rounds. Park each one for the final review:

  ```bash
  weave review record --run <run> --resolve <finding-id> --as parked --json
  ```

- **`kind` and `severity` are the reviewer's.** You cannot change them. You may disagree with a plan finding in your message to the person, but you never resolve it.

# Fixes Stay Inside the Slice

Fix only files the slice owns: files in the package's "Slice files" diff, in the slice's repos. Never fix files labelled "possibly another slice's work" or listed under "From main (ignore)".

When a real finding can only be fixed in another slice's code, do not make the fix. Record a ruling with `--agreed true`, saying which slice's code the fix needs, so the final review sees it.

# Rulings

A ruling is your written reasoning for leaving a finding open. Record one for every finding still open after the last round, and for each finding you push back on or cannot fix inside the slice:

```bash
weave review record --run <run> --resolve <finding-id> --as ruling --agreed <true|false> --reason "<reasoning>" --cost "<cost if this ruling is wrong>" --json
```

- `--agreed true`: the finding is real but was not fixed here (the fix crosses slices, or the rounds ran out). An agreed Critical ruling keeps the change verdict at not ready.
- `--agreed false`: you checked and disagree; give the evidence.
- `--cost`: what goes wrong, and for whom, if the ruling is wrong. Be concrete.

A fix counts only when the fix checker reports it `addressed`. Never mark a finding `fixed` that the checker reported `not_addressed`; it stays open or becomes a ruling.

# Plan Problems Always Stop

A finding with `kind: plan` says a planning document or recorded decision is wrong, or something the plan requires was built by no slice. Only a person decides it.

- Do not fix, build, or rule on it, and do not try another `--as` on it. If `record` ever returns `plan_finding_requires_person` (exit 5), that is expected: stop and explain. Never retry.
- Stop the review there. Do not run fix rounds for the run's other findings, and do not start the final review.
- Tell the person: the finding, the requirement or decision it names, where it shows in the code, and your own view if you have one. The slice owner decides; when the slice has no owner, whoever is working on the change decides.
- Tell them the two ways to resolve it:
  - **Change the plan**: revise the PRD, architecture, or slice with `weave-clarify`, or replace a decision with `weave adr new "<title>" --supersedes <id>`. The slice then needs a fresh review (`weave-review slice <id>`), and other reviewed slices built on the old plan show as out of date.
  - **Dismiss the finding** as their own ruling: `weave review record --run <run> --resolve <finding-id> --as dismissed --by <name>`, then run `weave-review slice <id>` to resume this run at its next fix round.
- Never run `--as dismissed` yourself, and never pass a name on the person's behalf.

Nothing times out. The slice waits as `waiting_on_person`, and slices that depend on it wait too.

# Final Review

The final review checks the whole change once every slice is reviewed. It starts straight away in the session that finished the last slice review, or when the person runs `weave-review change`.

1. **Gate.** `weave review gate --change --json`. Go on only when `pass` is true and there is no `reason`. When it fails, list the `blocking` slices and their reasons; on demand, the person may still run it as a partial review by adding `--partial` to the package command.
2. **Package.** `weave review package --change --json`. `<run>` is its `run_id`, such as `change/f1`.
3. **Review.** Hand `final-reviewer-brief.md` to a fresh reviewer at `most_capable` and record its response.
4. **Plan problems?** When `plan_findings_open` is not empty, stop (see **Plan Problems Always Stop**). The change shows not ready: waiting on you.
5. **Receive.** Receive every open finding as in **Receiving Findings**. The reviewer sorts the saved Minors and the slice reviews' rulings in `final_only.minor_sort`. Minors sorted `can_wait` are parked by the CLI, and slice rulings sorted `can_wait` stay parked. Minors and slice rulings sorted `must_fix` are open in the change run and join the fix batch. Park any Minor the reviewer left unsorted; a slice ruling left unsorted stays parked. At this level a fix may cross slices, but never touch files from main.
6. **One fix batch.** Only when the batch has something to fix:
   1. `weave review snapshot --run <run> --at round-start --round 1 --json`
   2. Fix the agreed Critical and Important findings, the `must_fix` Minors, and the `must_fix` slice rulings in one batch.
   3. Re-run the automatic checks of every slice the batch touched, or the project's full test suite.
   4. `weave review package --run <run> --fix-round 1 --json`
   5. Hand `fix-check-brief.md` to a fresh fix checker and record its response.
   6. Resolve each `addressed` finding with `--as fixed --round 1`.

   There is exactly one fix batch and one check. Do not start a round 2.
7. **Rulings.** Every finding still open gets a ruling, with its cost if wrong.
8. **Finalize.** `weave review record --run <run> --finalize --json`. It returns the `verdict`: `ready_to_merge`, `ready_with_parked_items`, or `not_ready`.
9. **Report.** Read `wiki/changes/<change-id>/review.md` and give the person the verdict and the full list of rulings from every slice review and the final review, each with what it costs if wrong. Weave never merges; the person decides.

# On Demand

The person can run `weave-review slice <id>` or `weave-review change` at any time, as often as they like, for example after editing code by hand or changing guidelines. Each run is added to the history and behaves like the automatic review for its scope.

- **Partial runs.** A slice whose tasks are not all done, or a final review while the gate fails, is packaged with `--partial` and recorded as partial. Say so in the final response.
- **Resuming.** When the slice is `in_review` with a `review.latest_run`, first run `weave review package --run <slice-id>/<latest_run> --json`. When it resumes (a person dismissed the plan problem), it returns `resume_round` and the `open` findings: receive them and continue the fix rounds from `resume_round`, up to `settings.slice_rounds`. When it fails with `run_not_resumable`, start a new run with `weave review package --slice <id> --json`.
- **Waiting on a person.** A slice that is `waiting_on_person` stays stopped until the person resolves the plan problem. Repeat what they need to decide and how.
- **After a plan change.** A slice whose plan changed shows `not_reviewed` or out of date (plan changed). A new run reviews it against the updated plan.
- **Flat changes.** Only `weave-review change` runs; the gate passes with nothing to wait for.

If an on-demand slice review completes the last outstanding slice review, the gate passes and the final review starts, as in step 8 of **Slice Review**.

# Checkpoint Commits

While checkpoint commits are on, `weave review package` points end boundaries at the slice's build commit and turns each fix round (and the final fix batch) into its own commit. Its result's `boundary` says `commit` or `snapshot` per repo, with the reason for a snapshot, and `checkpoints[]` lists fix commits. Report a fix commit's files, or its failure and reason; a failed commit never stops the review. Recording `--finalize`, `--failed`, or a plan problem commits the review records. Never run `git commit` yourself.

# Final Response

Keep it short:

- what was reviewed: slice or change, the run id, the model level used, and whether the run was partial or less independent
- the outcome: `reviewed`, `reviewed_with_rulings`, `waiting_on_person`, `review_failed`, or the change verdict
- fixes made, each with the finding it addressed and the round patch that undoes it
- rulings, each with its cost if wrong
- parked Minors, untested tasks, and human checks still to do
- for a plan problem: what the person must decide, and the two ways to resolve it
- the next step: the next slice, the final review, or the person's decision

---

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

Checkpoint commits (`checkpoint` or `checkpoints[]` in a result): say when one
failed, or was skipped for `wrong_branch`, `detached_head`, or
`operation_in_progress`, with its `reason` and `detail` (the step was still
recorded; never retry or block on it). List a build or fix commit's files. On
`notice: commits_enabled`, say once that Weave now commits each recorded stage
and finished slice, and `weave settings commits off` turns it off for you.

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.

`skills_available`: suppress it unless `weave-review` is one of the missing skills. Then say:
`Code reviews are available but the \`weave-review\` skill is not installed for <agent>. Run \`weave agent install <agent>\` to add it.`
