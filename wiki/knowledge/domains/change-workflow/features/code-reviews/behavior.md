# Code Reviews

## Purpose

Code reviews check a change's code with fresh, independent reviewers before the person decides to merge. Each slice is reviewed as soon as its tasks are done, and the whole change gets one final review once every slice is reviewed. The final review ends with a verdict and the full list of rulings.

Two parts work together (decision `261110-dbm2`):

- The **`weave-review` skill** holds every judgement: when to review, the three reviewer briefs, how findings are received, how many fix rounds to run, when to stop for a person, and which model level to use. The skill folder holds only markdown.
- The **`weave review` command group** holds every mechanical step: snapshots, review packages, recording, the gate, switches, cleanup, and guideline seeding. It writes all review state. Agents never edit `status.yml`, `review.md`, or `review/` files by hand.

Weave never merges and sends no notifications. Review is not a lifecycle lane: it never enters `changeStages` and never marks lanes stale.

## Current Behavior

### When reviews run

- **Automatically, in slice mode.** `weave-execute` checks `weave review status --slice <id> --json` before a slice's first task starts. While review is active it records the slice's start snapshot. When rollup reports the slice `ready_for_review`, it hands over in the same session, in the foreground: "load the `weave-review` skill and run its slice review for `<id>`; if you cannot load it by name, read it from one of `skill_paths`". It waits for the review before starting another slice. See [weave-execute](../weave-execute/behavior.md).
- **Final review straight after the last slice review.** After every slice review finalizes, the skill runs `weave review gate --change --json`. When the gate passes (and has no `reason`), it starts the final review in the same session.
- **On demand.** `weave-review slice <id>`, `weave-review change`, or `weave-review` with no argument (which picks from `weave review status` and the gate). On-demand runs behave like automatic ones and add a run to the history. A slice not yet ready, or a final review while the gate fails, is packaged with `--partial` and recorded as partial.
- **Recommended by `weave-next`.** It reads `review` from `weave change status --json` and the gate, and recommends `weave-review` for a slice that is not reviewed, out of date, `in_review`, or `review_failed`; the final review when the gate passes and the final review has not started; and a re-run when the verdict is out of date. A waiting plan problem is surfaced to the person with the two ways to resolve it. Review recommendations come before starting another slice and before `weave-knowledge`; a stale lane still comes first.
- **Flat changes** (no `task-slices/`) get no slice reviews. Only `weave-review change` runs; the gate passes with nothing to wait for.

Reviews always run in the foreground; the skill never runs one in the background.

### Activation

Review is **active** for a change when all three hold (`reviewActivation`):

- the workspace has not switched it off (`review.enabled` in `.weave/workspace.yml` is not `false`; absent means on)
- the change is not skipped (`weave review skip`)
- `weave-review` is installed for at least one agent in `.weave/agents.yml`

`inactive_cause` reports why it is off, in priority order: `change_skipped`, `workspace_off`, `skill_not_installed`. While inactive:

- `weave-execute` skips every review step and changes nothing else about the run.
- Dependency readiness falls back to rollup's `done` (see [task-slices](../task-slices/behavior.md)).
- The gate passes with `reason: "inactive"`.
- With the change skipped or the workspace off, every slice reads `skipped` (an overlay, never written); unskipping or switching review back on restores the stored states. With only the skill missing, slices carry no derived review state at all, so nothing ever shows "not reviewed".
- Nothing is adopted (see Adoption below).

When the person asks for a review themselves while the workspace is off, the skill runs it anyway with `--force` on every `package` command. A skipped change stops and points at `weave review unskip`; a missing skill points at `weave agent install <agent>`.

### Adoption and slices finished before review

The first time a review-aware command touches a change **while review is active** (`weave review status`, `snapshot --slice`, `package --slice`, `package --change`, or `gate`, or `weave slice rollup` without `--check`), it stamps `review.adopted_at` on the change and `state: predates_review` on every slice that is already ready for review and has no `review` block. This runs once; later calls write nothing. While review is inactive, adoption writes nothing, so a project that upgrades Weave before installing `weave-review` is adopted only once the skill is installed. A slice that becomes ready after adoption reads `not_reviewed` until it is reviewed. `predates_review` passes the gate and lets dependents start; there is no retroactive review.

Read-only views (`weave change status`, `weave status`) never adopt. They show a ready slice with no block as `predates_review` when the change has not been adopted yet, which is what adoption would stamp.

### Slice review flow

The skill follows these steps; `<run>` is a run id such as `02-api/r1`.

1. `weave review package --slice <id> --json` allocates the run, takes the end snapshot, writes the package, and sets the slice `in_review`.
2. A fresh reviewer gets `slice-reviewer-brief.md` with its placeholders filled (`{PACKAGE_PATH}`, `{SCOPE}`, `{SLICE_OR_CHANGE_DOCS}`, `{MODEL_LEVEL}`, `{ROUND}`). Its response is saved unchanged beside the package as `.response.md` and piped to `weave review record --run <run> --report -`.
3. If any plan finding is open, the slice becomes `waiting_on_person` and the review stops.
4. The agent receives each finding (see Receiving findings).
5. Up to `settings.slice_rounds` fix rounds (default 2), while an agreed Critical or Important code finding is open: `snapshot --run <run> --at round-start --round N`, fix in one batch inside slice-owned files, re-run the slice's automatic checks, `package --run <run> --fix-round N` (saves the round patch and the fix checker's package), a fresh fix checker with `fix-check-brief.md`, `record --report -`, then `record --resolve <F> --as fixed --round N` for each finding the checker reported `addressed`.
6. Every finding still open gets a ruling.
7. `record --run <run> --finalize` ends the run `reviewed` or `reviewed_with_rulings`.
8. `gate --change`: on a pass, the final review starts.

A reviewer response that fails validation is handed to a fresh reviewer once more with the schema errors. A second failure closes the run with `record --run <run> --failed` (`review_failed`); a new run starts with `package --slice` again.

### Receiving findings (skill rules)

- Verify each finding against the code before acting; fix what holds up; push back on what does not with a ruling `--agreed false` and the evidence.
- Ask about every unclear finding in one message before fixing anything. In unattended runs, record each as a ruling `--agreed false` whose reason starts `Unclear, not acted on:`.
- Add nothing unused because a reviewer suggested it; no performative agreement.
- Minor findings are never fixed in slice rounds. They are parked (`--as parked`) for the final review.
- Fixes stay inside slice-owned files. Never fix files labelled "possibly another slice's work" or "From main (ignore)". A real finding whose fix needs another slice's code becomes a ruling `--agreed true` naming that slice.
- A fix counts only when the fix checker reports it `addressed`.
- `kind` and `severity` belong to the reviewer. The CLI stores them immutably.

### Plan problems

A finding with `kind: plan` says a planning document or decision is wrong, or something the plan requires was built by no slice. Only a person decides it:

- Resolving a plan finding any way other than `--as dismissed --by <name>` fails with `plan_finding_requires_person` (exit 5) and leaves the slice `waiting_on_person`. The skill never retries and never dismisses on the person's behalf.
- The review stops: no fix rounds for the run's other findings and no final review. Nothing times out; dependent slices wait too.
- The person resolves it in one of two ways:
  - **Change the plan** (`weave-clarify`, or `weave adr new --supersedes`). The waiting run's `plan_basis` no longer matches, so the slice reads `not_reviewed` (reason `plan_changed`), and the next `package --slice` starts a fresh run.
  - **Dismiss it** as their own ruling: `weave review record --run <run> --resolve <F> --as dismissed --by <name>`. The slice returns to `in_review`, and `weave-review slice <id>` resumes the same run: `package --run <run>` (no `--fix-round`) returns `resume_round` and the open code findings. No new run id is allocated.
- A dismissal counts as the person's ruling everywhere: the run finalizes `reviewed_with_rulings`, it is counted in `open_rulings`, the change verdict counts it as a parked ruling, and the change `review.md` lists it under "All rulings" with who dismissed it.

On the final review, an open plan finding puts the change at `not_ready` (shown "not ready: waiting on you").

### Final review flow

1. `gate --change` must pass (no `reason`); otherwise only an on-demand `--partial` run is possible.
2. `package --change` allocates `change/f<N>`, sets the change review `in_progress`, and writes the change package.
3. A fresh reviewer gets `final-reviewer-brief.md` at `most_capable`. It judges the change against its plan, cross-slice and cross-repo problems, recorded decisions, whether knowledge pages stay correct (a page the change makes wrong is a `code` finding with `fails.type: knowledge`), correctness including untested tasks, and plan and docs edits as documents.
4. The reviewer sorts the saved Minors **and the slice reviews' rulings** in `final_only.minor_sort` (`must_fix` or `can_wait`). Minors sorted `can_wait` are parked; slice rulings sorted `can_wait` stay parked as the slice's ruling. A slice Minor or ruling sorted `must_fix` is copied into the change run's findings unresolved (`source: minor_sort`; the slice's own files are never rewritten) and joins the fix batch.
5. Exactly one fix batch (round 1 only; round 2 gives `round_limit`) covers agreed Critical and Important findings, `must_fix` Minors, and `must_fix` slice rulings. At this level a fix may cross slices but never touch files from main. One fix check follows.
6. Every finding still open gets a ruling. Unlike slice runs, open findings do not block finalize: they make the verdict `not_ready`.
7. `record --run change/f<N> --finalize` derives the verdict and stores it on the change. The skill reports the verdict and the full ruling list from `wiki/changes/<id>/review.md`.

A failed change run leaves the change review `not_started`; a new run starts with `package --change`.

### Verdict

`deriveVerdict` over what is still open across every slice's latest run and the change run:

- `not_ready`: an open plan problem, a partial run, a Critical ruling with `agreed: true`, or any other unresolved finding.
- `ready_with_parked_items`: only can-wait Minors, other rulings (every ruling except an agreed Critical one, including the person's dismissals), or human checks.
- `ready_to_merge`: nothing open.

Change counts: `open_rulings` (agreed Critical + parked rulings), `parked_items` (can-wait Minors + parked rulings + human checks), `plan_problems_open`. A slice Minor the final reviewer sorted is counted once, from the change run.

### Out of date (derived, never stored)

Every reader recomputes out-of-date state; rollup never writes it, so `weave slice rollup --check` is unaffected. Only `reviewed` and `reviewed_with_rulings` slices (and a change with a verdict) can be out of date. The stored state is kept, so reverting the edit makes the review current again. Reasons:

- `code_changed`: a fingerprinted file's blob hash (or `absent`) differs from the working tree.
- `tasks_added`: the active task count rose above `reviewed_task_total`.
- `plan_changed`: a `plan_basis` document's body hash changed, or a planning document appeared or vanished. Slice `plan_basis` covers the change's planning document (PRD for `feat`, `findings.md` for `fix`, `exploration.md` otherwise), every architecture file, the slice's `slice.md` and `contracts.md`, and the applicable and cited decisions. The change `plan_basis` covers every slice's documents too, so a new slice also counts.

Status shows `reviewed, out of date (code changed)`; the change shows `verdict out of date`. Repos not checked out here are skipped with a `repo_missing:<repo>` warning, never a reason. A `waiting_on_person` slice is checked for `plan_changed` only, and then reads `not_reviewed`.

**Hashing.** Documents are hashed with YAML frontmatter stripped, so lifecycle-only edits (a PRD's `updated_at`, a decision's `status`) change nothing. A decision's hash also covers its `superseded_by` value: superseding a decision is a plan change, so it reopens rulings and marks reviews that cite it `plan_changed`.

**File ownership.** A file belongs to the latest review that covered it. When a slice run or the change run finalizes, every file it covered leaves every other slice's fingerprint, so an edit to a shared file marks only the latest review out of date. After the final review, the change fingerprint owns everything it covered, taken after the fix batch. Foreign files, `wiki/changes/**`, plan and docs edits, and files from main are never fingerprinted.

### Rulings and re-review

A ruling records `agreed`, `reason`, `cost_if_wrong`, and a `basis`: the blob of the finding's file, the run's guideline files, the documents the finding cites (falling back to the PRD, `architecture/index.md`, or `slice.md` by `fails.type`), and cited decisions. Packages list "Settled rulings (do not raise again)" and "Reopened rulings" (any basis hash changed), with `settled_rulings` and `reopened_rulings` counts. `review.md` marks a reopened ruling "ruling (reopened)". De-duplicating new findings against settled rulings is the reviewer's job; the CLI does not match them.

### Review packages and boundaries

Boundaries are working-tree **snapshots** (decision `261110-wdfo`): parentless commit objects created from a temporary index (a copy of the real index, keeping its timestamps, then `git add -A`, so `.gitignore` is honoured and untracked files are included), stored under Weave-only refs. They never touch HEAD, the branch, the index, or the stash. They sit behind a `ReviewBoundary` interface so real commits can replace them later.

```text
refs/weave/reviews/<change>/<slice>/start
refs/weave/reviews/<change>/<slice>/r<N>/end
refs/weave/reviews/<change>/<slice>/r<N>/round<n>-start | round<n>-end
refs/weave/reviews/<change>/_change/f<N>/end | fix-start | fix-end
```

In a workspace each repo gets its own refs in its own object store. Snapshot refs are machine-local and outside `refs/heads` and `refs/tags`, so normal pushes skip them.

A **slice package** diffs the slice's start snapshot (or, without one, the diff base) against the end snapshot, per slice repo, with 10 lines of context:

- Files inside the slice's repos that match a task `Files:` anchor (exact file or path prefix) are "Slice files"; everything else is labelled "possibly another slice's work".
- `wiki/changes/**` is excluded from every diff, patch, and fingerprint.
- When the merge-base moved between the start and end snapshots (a rebase or merging main), files that changed only on main are listed under "From main (ignore)" and kept out of the diff and fingerprint. A file both main and the slice changed stays the slice's own.
- The context manifest lists the planning documents (by change type), accepted decisions whose `applies_to` matches a diffed file, guideline files per repo (present or absent), settled and reopened rulings, task evidence (as claims to verify), untested tasks, and human checks.

The **diff base** is the merge-base of HEAD with the change's target branch (resolved as the landed check does), else `checkout.repos.<repo>.base_commit`, else unknown. Merging main into the change moves it forward, so main's work drops out. A start ref named in `status.yml` but missing on this machine gives the warning `start_ref_missing_on_this_machine` and a labelled fallback ("fallback base: change base … earlier slices' work may be included"). No base at all gives `base_unknown` and a partial package.

A **change package** diffs the diff base against a fresh end snapshot for every repo the change touches (root, checkout repos, every slice's `repos:`, or flat `Repos:` lines), lists commits on the change branch, and puts `wiki/knowledge/**`, `wiki/decisions/**`, and `.weave/coding-guidelines.md` edits under a separate "Plan and docs edits" section. Its context adds every slice's saved Minors, settled and reopened rulings, untested tasks, and human checks.

A **fix-round package** diffs `round<n>-start` against a new `round<n>-end`, lists only the open Critical and Important findings the round targets, and saves the round patch to the slice's `review/` folder. `git apply -R <patch>` from the Weave root undoes the round.

Packages are written to `<change folder>/.weave/tmp/reviews/<change>/<slice>/r<N>.package.md` (`r<N>-round<n>.package.md` for rounds, `_change/f<N>.package.md` for the change), or to `--out`. `weave review` creates `.weave/tmp/.gitignore` containing `*`, so packages and saved responses are never committed or snapshotted.

**Model level hint.** Slice packages return `mid`, raised to `most_capable` above 1500 changed lines; fix rounds return `cheap-mid`; change packages return `most_capable`. The skill states a level on every hand-over: slice reviews never below `mid` and raised to `most_capable` for risky slices (security, permissions, migrations, money, concurrency, multi-repo); fix checks `cheap` for small rounds, otherwise `mid`; final review always `most_capable`. Built-in model names per agent (for example `haiku`, `sonnet`, `opus` for Claude) are overridden by `review.models.<agent>.<level>`.

### Reviewers

Reviewers start fresh (never a fork of the building conversation) and see only the filled brief and what it lists. Every brief tells them: read-only on the checkout, no sub-agents, no `weave` commands, build evidence is a claim, judge only the scope's own files (foreign files only for integration), never review files from main, do not re-raise settled rulings, label every finding `code` or `plan`, and end with one fenced `json` block. When the agent client cannot start a sub-agent, the skill runs the brief inline and passes `--independent false`; the record shows "less independent".

### Coding guidelines

Guidelines live in `.weave/coding-guidelines.md` (decision `261110-dtld`): one shared file at the workspace root, and an optional file at each registered repo's root. Both apply to that repo's code and the repo file wins on conflict; the reviewer weighs them, the CLI only resolves files. A repo-mode project has one file. Packages read them from the change's own checkout folder, so a change's guideline edits apply to its own review. A missing file is listed as absent ("no shared guidelines found"); a registered repo with no checkout makes the package partial.

A guidelines file can act as an index that links to more guideline files anywhere in its repo (for example one for models and one for controllers). The CLI still lists only the `.weave/coding-guidelines.md` files; following links is the reviewer's job. Slice and final reviewers read each listed file, follow its links (relative to the linking file) to the files that cover code in their diff, treat a more specific linked file as winning over the index that links to it, and cite the linked file in `fails.ref`. Each report has a **Guidelines read** section listing the files read and any linked file skipped or missing; a broken link is not a code finding. Fix checkers follow links to the files that cover the round diff. Only `.weave/coding-guidelines.md` edits go under a change package's "Plan and docs edits"; edits to linked files appear in the ordinary diff, and the final reviewer judges them as documents too.

`weave init` writes the starter shared file when absent (sections for error handling, security, testing expectations, naming and structure, and documentation). `weave review guidelines init` writes it for existing projects; `--repo <id>` (workspace mode only) writes a heading-only repo file. Neither ever overwrites, and no other command (`weave change new`, `weave doctor`, `weave add`, `weave agent update`) creates the file.

### Visibility

- `weave change status` adds a `Review:` line after the stress-test lines, for example `Review: slice 02 reviewed (1 ruling) · slice 03 waiting on you: plan problem · final: not started`, and after the final review a `Verdict:` line such as `Verdict: ready with parked items (4) · 2 rulings`. Slice phrases: `tasks open`, `tasks done, not reviewed`, `in review`, `reviewed`, `reviewed (N rulings)`, `waiting on you: plan problem`, `reviewed, out of date (<reasons>)`, `review skipped`, `predates review`, `review failed`. A skipped change shows `Review: skipped (<reason>)`; workspace off shows `Review: skipped (review is off for this workspace)`. JSON carries `change.review` with `active`, `inactive_cause`, `skipped`, `slices[]`, and `final` (`state`, `verdict`, `out_of_date`, reasons, `counts`, `latest_run`, `partial`).
- `weave status` prints one line for the change the current folder resolves, `Review (<id>): verdict: …` or slice counts by state plus the final state, and `review` in JSON (`null` outside a change or with nothing to show).
- Changes with no review data while review is inactive show no review lines and no `review` key, exactly as before. Unreadable review data shows `Review: unreadable` and never fails either command.
- `weave slice rollup --json` exposes `ready_for_review` per slice and `ready_slices`.

## Domain Model

**Run ids.** Slice runs are `<slice-id>/r<N>` (the slice part also accepts a unique leading number, such as `02/r1`); change runs are `change/f<N>`. Finding ids are `<run>-F<n>`. Run numbers are allocated under the per-change lock and reserved by creating the package file, so concurrent calls never share one; numbering continues past any existing ref, record file, package, or `latest_run`.

**Slice `status.yml` `review:` block.** Written only by `weave review`. Fields: `state`, `start_ref`, `latest_run`, `reviewed_task_total`, `merge_base`, `plan_basis`, `fingerprint` (per repo: path to blob hash or `absent`), `counts` (`open_rulings`, `parked_minors`, `human_checks`, `untested_tasks`), `independent`, `partial`, `updated_at`. Stored states: `in_review`, `reviewed`, `reviewed_with_rulings`, `waiting_on_person`, `skipped`, `review_failed`, `predates_review`. Derived only: `not_reviewed` (ready for review, no state) and `not_ready_for_review` (tasks still open). A malformed block reads as absent.

**Change `status.yml` `review:` block.** Fields: `state` (`not_started`, `in_progress`, `ready_to_merge`, `ready_with_parked_items`, `not_ready`), `adopted_at`, `latest_run`, `skipped: {reason, at}`, `fingerprint`, `plan_basis`, `merge_base`, `reviewed_task_total`, `counts` (`open_rulings`, `parked_items`, `plan_problems_open`), `partial`, `updated_at`. `skipped` as a change state is derived from `review.skipped`, not stored.

**Readable records** (regenerated by `record` on every write; never edited by hand):

```text
wiki/changes/<id>/task-slices/<slice>/review.md     one section per run, newest first
wiki/changes/<id>/task-slices/<slice>/review/
  r<N>.report.md  r<N>.findings.json  r<N>-round<n>.patch  r<N>-round<n>.check.md
wiki/changes/<id>/review.md                         verdict, change runs, Minor sort, All rulings
wiki/changes/<id>/review/
  f<N>.report.md  f<N>.findings.json  f<N>-fix.patch  f<N>-fix.check.md
```

A run section shows its header (scope, state, verdict, model level, independent, partial, start and end), Strengths, Findings (id, severity, kind, location, fails, status), Fixes (finding, round, patch, files, undo, needs your check), Rulings (reasoning, cost if wrong, reopened), Declined to judge, Saved Minors, Untested tasks, and Human checks. The change record's "All rulings" lists every slice and change ruling, the person's dismissals, and how the latest change run sorted each slice ruling.

**Resolutions** (`record --resolve <F> --as …`): `fixed` (`--round <n>`; the round must have been packaged; marked `needs_your_check` when the slice's tasks carry a `Human check:` line), `ruling` (`--agreed true|false --reason --cost` all required), `parked` (Minors only), `dismissed` (`--by <person>`; the only resolution for a plan finding).

**Reviewer report schema.** The last fenced `json` block of the response: `strengths[]`, `findings[]` (`id`, `severity: critical|important|minor`, `kind: code|plan`, `location {repo, path, line}`, `fails {type: acceptance|prd|architecture|decision|guideline|knowledge|correctness, ref}`, `detail`, `fix_hint`), `declined[]`, `verdict: ready|with_fixes|not_ready`, and for the final review `final_only.minor_sort[] {finding, class: must_fix|can_wait}`. A fix-check report has `checks[] {finding, result: addressed|not_addressed}` and optional `new_findings[]`; its `checks` must name the run's own findings by full id. Unknown fields are dropped; missing fields, bad enums, and paths that are absolute, contain `..`, or name an unknown repo are rejected.

## Configuration Dimensions

`.weave/workspace.yml` (team settings, all optional):

```yaml
review:
  enabled: true        # absent means true; false turns automatic reviews off and slices read skipped
  slice_rounds: 2      # fix rounds per slice review; a whole number >= 0, otherwise 2
  models:              # optional per-agent model names per level
    claude: { cheap: haiku, mid: sonnet, most_capable: opus }
```

`slice_rounds` is enforced by the skill; the CLI does not cap slice rounds. The change run's single fix batch is enforced by the CLI (`round_limit`).

Per change: `weave review skip --reason "<why>"` and `weave review unskip`.

## Behavioral Rules

- All review writes, and rollup's slice writes, run under a per-change lock: a directory `<git-common-dir>/weave/locks/change-<id>` shared by every worktree, with a 30-second stale rule. Each write re-reads the file, replaces only the `review` key, and writes atomically. Outside a git repo there is no lock.
- Other writers of the change `status.yml` (lifecycle commands) stay unlocked; review writes merge only their own key.
- `kind` and `severity` never change after a finding is first stored; a later report refreshes only wording and location.
- A finalized or failed run, or a run that is no longer the latest, refuses writes with `run_closed`.
- Slice finalize refuses with `finalize_blocked` while any finding is unresolved. `reviewed` needs zero open findings and no ruling or dismissal; parked Minors alone still give `reviewed`. `reviewed_with_rulings` needs every open finding ruled or dismissed.
- `human_checks` counts each `Human check:` line under a task's `### Verification` (the only marker the CLI reads) plus every fix marked "needs your check".
- Untested tasks (`not_tested`) count toward a slice being ready for review and are listed in packages and records.

## Integrations And Side Effects

- **Cleanup.** `weave review prune [--change <id>]` deletes `refs/weave/reviews/<change>/` (one `update-ref --stdin` transaction per repo) and the change's packages in the change folder and main checkout, only for changes that have fully landed (every repo with commits exactly `landed`) or that no longer exist anywhere on this machine. `not_landed`, `landed_with_newer_commits`, `no_commits`, and `unchecked` changes are kept. A repo whose deletion fails is reported as `kept` with `reason: "error"` while the others are pruned. `weave change close` never prunes, because closed changes can be reopened. The background refresh started by `weave change list` runs prune after its landed check, using local git only and ignoring failures (see [change-folder-states](../change-folder-states/behavior.md)). `refs/weave/remotes/*` is never touched.
- **Repair.** `weave review status --repair` rebuilds slice `review:` blocks from `review/*.findings.json` (for example after an older Weave's rollup dropped them). Fingerprint and `plan_basis` are recomputed from the current tree only when the latest run was finalized, and the result says so.
- **Notice.** A `skills_available` notice names bundled skills a configured agent has not installed (see [notices](../../../cli-distribution/features/notices/behavior.md)). Skills mention it only when `weave-review` is missing.
- **Packaging.** `weave-review` ships `SKILL.md` plus four resources: `slice-reviewer-brief.md`, `fix-check-brief.md`, `final-reviewer-brief.md`, `review-record-template.md`, and an opencode command wrapper.

## Edge Cases

- **Slice already in progress without a start snapshot.** `weave-execute` does not take one late; the package falls back to the diff base, so earlier slices' work may be included and is labelled foreign.
- **Second machine.** Snapshot refs are machine-local; a review on another machine gets a labelled fallback diff.
- **Missing repo checkout.** Snapshots list it in `missing_repos` and succeed for the others; packages are partial; the verdict is at best `not_ready`.
- **Whole-file fingerprints** mark a review out of date for unrelated or formatting-only edits to a reviewed file; this errs towards re-review.
- **Plan edits** to the PRD or architecture body mark every reviewed slice "out of date (plan changed)".
- **Report integrity** is requested, not enforced: an agent could edit a response before `record`.
- **Pushing** with `git push --mirror` or an explicit `refs/*` refspec would push snapshot refs; this is documented, not prevented.

## Invariants

- Snapshots never run `checkout`, `reset`, `stash`, or anything that moves HEAD; the temporary index is removed in a `finally` block.
- Out-of-date and reopened rulings are always derived at read time and never stored.
- No command other than `weave review` writes a `review:` block; rollup carries it through unchanged.
- Exit codes 4 (`report_invalid`) and 5 (`plan_finding_requires_person`) are used only by `weave review record`.

## Source Anchors

- Commands: `src/commands/review.ts` (registers subcommands), `src/commands/review/{status,snapshot,package,record,gate,skip,prune,guidelines,shared}.ts`, `src/cli.ts`
- Rules: `src/lib/review/rules.ts` (`isReadyForReview`, `satisfiesDependents`, `effectiveState`, `deriveVerdict`, `excludedPathspecs`, `planAndDocsPaths`, `bodyHash`, `decisionHash`)
- State and activation: `src/lib/review/state.ts` (`reviewActivation`, `inactiveReviewCause`, `skippedOverlayApplies`, `adoptChange`, `updateSliceReview`, `updateChangeReview`, `skipChangeReview`, `changeRepoIds`); lock in `src/lib/local-state.ts` (`withChangeLock`)
- Boundaries: `src/lib/review/boundary.ts` (`SnapshotBoundary`, `reviewRefPrefix`, ref helpers); diff base: `src/lib/review/base.ts` (`resolveDiffBase`, `filesFromMain`)
- Packages: `src/lib/review/package.ts` (`buildSlicePackage`, `buildChangePackage`, `parseTaskEvidence`, `labelForeignFiles`, `mostCapableLineThreshold`, `ensureTmpIgnored`); rounds: `src/lib/review/rounds.ts` (`startFixRound`, `buildFixRoundPackage`, `resumeRun`)
- Recording: `src/lib/review/record.ts` (`recordExitCodes`, `validateReport`, `applyResolution`, `deriveSliceState`, `finalizeRun`, `resolveMinorSort`, `applyMinorSort`, `changeVerdictSummary`, `renderReviewRecord`, `repairSliceReviews`)
- Out of date: `src/lib/review/fingerprint.ts` (`evaluateOutOfDate`, `evaluateChangeOutOfDate`, `computePlanBasis`, `computeRulingBasis`, `releaseOwnership`, `classifyRulings`)
- Gate: `src/lib/review/gate.ts`; status views: `src/lib/review/summary.ts`; cleanup: `src/lib/review/prune.ts`; guidelines: `src/lib/review/guidelines.ts`
- Settings: `src/lib/workspace-repos.ts` (`parseReviewSettings`)
- Skill: `templates/skills/weave-review/*`, `templates/opencode/commands/weave-review.md`
- Tests: `tests/review-*.test.ts`, `tests/cli-review-*.test.ts`, `tests/cli-change-status-review.test.ts`, `tests/slice-rollup.test.ts`, `tests/agent-skills.test.ts`
- Decisions: `261110-wdfo`, `261110-dbm2`, `261110-dtld`

## Change History

- 2026-11-10 (change `261110-g2wn-code-reviewers`): introduced slice and final code reviews, the `weave-review` skill and briefs, the `weave review` command group, snapshot boundaries, review records, out-of-date detection, rulings with reopen, the final-review gate and verdicts, coding guidelines files, workspace review settings, and per-change skip.
- 2026-11-10 (direct edit on main): guidelines files can link to more guideline files; reviewer briefs follow the links and list the files they read under **Guidelines read**.

## Open Questions

- Choosing which agent reviews (cross-agent review) is deferred; `review.models` leaves room for it.
- When checkpoint commits arrive, a commit-based boundary is expected to replace snapshots behind the same interface.
- Snapshot cost on very large repos is unmeasured.
