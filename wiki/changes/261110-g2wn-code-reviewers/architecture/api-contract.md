---
facet: api-contract
description: The weave review command group, reviewer report schema, and consumers of review state.
---

# API Contract Design

## Consumers And Producers

- **Producers:**
  - `weave-review` skill: all subcommands.
  - `weave-execute` skill: `snapshot --at start`, then hands over to `weave-review` when rollup reports the slice done.
  - `weave init`: guideline seeding.
- **Consumers:**
  - `weave slice rollup`: preserves the `review` block and evaluates out-of-date state.
  - `weave change status` and `weave status`: show review state, the verdict, and the `skills_available` notice.
  - `weave-next` skill: recommends `weave-review` from `weave review status --json` and `weave review gate --change --json`.
  - Background refresh: runs `weave review prune` after its landed check. `weave change close` does not delete review refs, because closed changes can be reopened.
- **Reviewer sub-agents** read the package file and return a report. They never call `weave`.

## Contract Shape

Every subcommand accepts `--json`, resolves the active change the same way other `weave change` commands do, and returns `{status: "ok" | "error", code?, message, ...}`.

### `weave review snapshot (--slice <id> --at start | --run <run> --at round-start --round <n>) [--force] [--json]`

- `--at start` creates `refs/weave/reviews/<change>/<id>/start` in every repo the slice lists in `repos[]`, or `root` in repo mode. It is idempotent: an existing start ref is kept unless `--force`.
- `--at round-start` records the round's start boundary before any fixes. It owns that boundary, so `package --fix-round` requires it to exist.
- Each snapshot records the merge-base it was taken against.
- Returns `{refs: {<repo>: <ref>}, merge_base: {<repo>: <sha>}}`.

### `weave review package (--slice <id> | --change | --run <run> --fix-round <n>) [--partial] [--force] [--out <path>] [--json]`

- **Slice or change mode:**
  1. Allocate a run id (`r<N>` for slices, `f<N>` for the change).
  2. Snapshot the end point.
  3. Mark the slice or change `in_review` / `in_progress`.
  4. Write the package.
- **`--fix-round <n>`:** snapshot the round end and diff it against the round-start ref, which must already exist (otherwise error `round_not_started`). It also saves the round patch to the change folder. Excluded paths never enter the patch.
- **`--run` on a `waiting_on_person` run whose plan finding was dismissed:** resumes at the next fix round.
- **Run on a `review_failed` run:** start a new run with `--slice` again. The failed run stays in the history.
- **Returns:**

  ```text
  {run_id, package_path, scope, partial, fallback_base, foreign_files: n,
   model_level: "mid" | "most_capable" | "cheap-mid", size_hint: {files, lines},
   settled_rulings: n, reopened_rulings: n}
  ```

- `model_level` is a hint derived from scope: change → `most_capable`, fix round → `cheap-mid`, slice → `mid`, raised to `most_capable` when the diff exceeds a size threshold. The skill states it explicitly on dispatch.
- **Errors:**
  - `review_disabled`: the workspace has review off and `--force` is not given.
  - `change_review_skipped`
  - `no_slices` (`--slice` used in flat mode)
  - `slice_not_ready`: some active task is neither `done` nor `not_tested`. On-demand runs pass `--partial`, which records `partial: true`.
  - `base_unknown`: no target branch and no `base_commit`. The package is still written, marked partial.
  - `start_ref_missing_on_this_machine`: a warning, not an error. The package falls back to the merge-base and is labelled.

### `weave review record --run <run> (--report - | --resolve <finding> --as <as> [...] | --finalize | --failed) [--independent false] [--json]`

All writes run under the per-change lock, re-read the file first, and write atomically.

- **`--report -`** reads the reviewer response from stdin, then:
  1. Extracts the last fenced `json` block and validates it against the report schema.
  2. Writes `<run>.report.md` and `<run>.findings.json`, or appends fix-check verdicts to the round.
  3. Regenerates `review.md`.
  4. Updates the `review` state.
- Validation failure gives exit 4 (`report_invalid`) with the schema errors, and nothing is written. On a second failure, the skill calls `record --run <run> --failed`, which sets `state: review_failed`.
- **`--resolve`** options:

  | `--as` | Required options |
  | --- | --- |
  | `fixed` | `--round <n>` |
  | `ruling` | `--agreed true\|false --reason <text> --cost <text>`; the CLI computes `basis` (frontmatter-stripped hashes) from the finding location, the run's guideline files, and the documents or decisions in `fails` |
  | `parked` | none; minors only |
  | `dismissed` | `--by <person>`; the only way to resolve `kind: plan` |

- Resolving a `kind: plan` finding with any other `--as` gives exit 5 (`plan_finding_requires_person`), and the state becomes `waiting_on_person`.
- **`--finalize`** derives the final state and verdict, and stores the fingerprint, `plan_basis`, `merge_base`, and `reviewed_task_total`. For a change run it also takes ownership of every covered file. The final fix batch is inside the run, so its edits are part of the baseline.
- **`--failed`** marks the run `review_failed` after the second invalid report.

### `weave review gate --change [--json]`

Returns `{pass: bool, blocking: [{slice, effective_state}]}`. It passes when every slice's effective state is `reviewed`, `reviewed_with_rulings`, or `predates_review`, and none is out of date (FR6). Skipped slices count as passing only when the change itself is skipped.

### `weave review status [--slice <id> | --change] [--repair] [--json]`

- Returns:

  ```text
  {active, skill_paths, stored_state, effective_state, out_of_date_reasons: [code_changed | plan_changed | tasks_added],
   ready_for_review, counts}
  ```

- It does not write, except to stamp `adopted_at` and `predates_review` on first contact, and when `--repair` is given, which rebuilds `review` blocks from `review/*.findings.json`.

### `weave review skip --reason <text> [--json]` and `weave review unskip`

Sets or clears `review.skipped` on the change.

### `weave review prune [--change <id>] [--json]`

Deletes `refs/weave/reviews/<change>/` and the local packages for changes that have landed (per `landed.ts`) or no longer exist. The background refresh calls it after its landed check.

### `weave review guidelines init [--repo <id>] [--json]`

Writes the starter shared file, or an empty repo file, only when it is absent.

### Reviewer report schema

This is the last fenced `json` block in the reviewer response.

```json
{
  "strengths": ["..."],
  "findings": [{
    "id": "F1",
    "severity": "critical|important|minor",
    "kind": "code|plan",
    "location": {"repo": "root", "path": "src/x.ts", "line": 10},
    "fails": {"type": "acceptance|prd|architecture|decision|guideline|knowledge|correctness", "ref": "..."},
    "detail": "...", "fix_hint": "..."
  }],
  "declined": [{"behavior": "...", "reason": "..."}],
  "verdict": "ready|with_fixes|not_ready",
  "final_only": {"minor_sort": [{"finding": "r2-F4", "class": "must_fix|can_wait"}]}
}
```

The fix-check report has a different shape:

```json
{"checks": [{"finding": "r1-F3", "result": "addressed|not_addressed"}], "new_findings": [<finding>...]}
```

Its new Critical or Important findings join the open list for the next round. Finding references in `minor_sort` and `checks` use fully scoped ids, such as `02/r1-F3`.

### Brief contract (skill side)

Each brief file has placeholders that the skill fills:

```text
{PACKAGE_PATH} {SCOPE} {SLICE_OR_CHANGE_DOCS} {MODEL_LEVEL} {ROUND}
```

Each brief includes these rules:

- read-only on the checkout
- no sub-agents
- build evidence is claims to verify
- judge only slice-owned files and use foreign files only for integration
- label every finding `code` or `plan`
- end with the JSON block

### Status and notices

- `weave change status` lines:
  - `review: slice 02 reviewed (1 ruling) · slice 03 waiting on you: plan problem · final: not started`
  - after the final review: `verdict: ready with parked items (4)`
- New notice kind `skills_available` in `src/lib/notices.ts`: a bundled skill appears in `listDefaultSkills` but not in the manifest for a configured agent. The message names `weave agent install <skill>`.

## Versioning And Compatibility

- This is a new command group with no existing contract to break.
- The report schema carries an implicit `v1`. Unknown fields are ignored and missing required fields are rejected.
- Rollup's change to preserve `review` is backward compatible. Old CLIs drop the block, and `status --repair` restores it.

## Authorization And Validation

- **Trust boundary:** the reviewer response is untrusted model output. It is parsed only as data, the schema is validated, paths in `location` are normalised and must sit inside a known repo, and nothing in a report is executed.
- `record` never lets the build agent change a finding's `kind` or `severity`. Plan findings resolve only through `dismissed --by`.
- An agent can still edit a report before piping it in. This is a known limit, accepted with reviewer read-only being requested rather than enforced.
- Snapshot creation uses a temporary index file in the local state directory, removed in a `finally` block. It never runs `checkout`, `reset`, `stash`, or anything else that touches HEAD.

## Observability And Testing

- Every run appends to the `review.md` history. `weave review status --json` is the machine-readable view.
- **Tests:**
  - **`boundary`:** in temporary git repos, snapshots leave the index, HEAD, branch, and stash untouched; include untracked files; honour `.gitignore`; work across worktrees and in a workspace with two repos.
  - **`package`:** foreign-file labelling, `base_commit` fallback, partial packages when a repo is missing, and guideline resolution in repo mode versus workspace mode.
  - **`record`:** schema accept and reject, immutability, plan-resolution refusal (exit 5), state transitions, and verdict derivation over all combinations.
  - **`fingerprint`:** an edit inside the reviewed set gives `out_of_date`, an edit outside it does not, and a rising task count gives `out_of_date`. A ruling basis change reopens the ruling.
  - **`sliceRollup`:** preserves the `review` block under concurrent `record` writes, and `ready_slices` respects review state, regression-tested.
- **`rules`:** `isReadyForReview` with `not_tested` tasks, adoption stamping `predates_review` exactly once, ownership handoff (no cascade when slices share a file), plan-basis out-of-date, the frontmatter-only edit not reopening, the reverted edit returning to current, and `agreed` Critical forcing `not_ready`.
- **`base`:** in-place change with no `base_commit`, merging main into the change, and a rebase between start and end.
  - **`notices`:** `skills_available`.
  - **`tests/agent-skills.test.ts`:** packaging for the `weave-review` resources, and for the `weave-execute` hook text.
