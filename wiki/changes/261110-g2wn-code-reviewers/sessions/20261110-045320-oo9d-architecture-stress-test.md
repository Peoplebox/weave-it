---
artifact: architecture
capture_mode: stress-test
captured_at: 2026-11-09T23:23:20.000Z
---

# Stress Test: Architecture - 2026-11-10

The user asked the agent to answer the challenges itself and escalate only if absolutely needed. None needed escalation. Each answer below is the agent's ruling, written into the architecture.

## Challenges

### C1 — blocking — contradiction with reality
- Challenge: rollup calls a slice `done` only when every task is `done`, so slices with `not_tested` tasks never triggered review (FR4).
- Answer: a separate pure rule, `isReadyForReview` (every active task is `done` or `not_tested`), in `src/lib/review/rules.ts`. It drives the hook, the `not_reviewed` derivation, the package and the gate. Rollup's `done` is unchanged.
- Outcome: decided

### C2 — blocking — migration
- Challenge: slices finished before this ships would block the gate forever.
- Answer: on first contact the change records `review.adopted_at`. Slices already ready then are stamped `predates_review` once, and that state passes the gate. Slices finished later read as `not_reviewed`.
- Outcome: decided

### C3 — blocking — uncovered requirement (FR7/FR26)
- Challenge: dependent-slice readiness ignored review state.
- Answer: `satisfiesDependents` in rules.ts is used by `renderSliceDisplayStatus` and `dependency-graph.md`, and is exposed as `ready_slices` in `weave slice rollup --json`. The `weave-next` and `weave-execute` skills read `ready_slices` instead of computing from `depends_on`.
- Outcome: decided

### C4 — blocking — diff scope
- Challenge: whole-tree diffs included `wiki/changes/**`, so rollup churn would put reviews out of date and patches would revert Weave state.
- Answer: `wiki/changes/**` is excluded from diffs, patches and fingerprints by pathspec. Other documentation edits appear in change packages as a separate "plan and docs edits" section.
- Outcome: decided

### C5 — major — fingerprint cascade, stored vs derived
- Challenge: shared files caused cascades, final fixes invalidated slice reviews, and out-of-date was both stored and derived.
- Answer: out-of-date is derived only, as an overlay on the stored state. The latest review that covered a file owns it. Foreign files are never fingerprinted. The final run owns every file it covered and re-baselines after its fix batch.
- Outcome: decided

### C6 — major — plan-problem resolution
- Challenge: there was no mechanism to leave `waiting_on_person`, no FR27 flagging, and raw hashes included frontmatter.
- Answer:
  - Dismissal is `--as dismissed --by`, and the run resumes at its next fix round.
  - A plan change is detected through `plan_basis` body hashes, which turn the waiting slice to `not_reviewed (plan changed)` and mark other reviewed slices out of date.
  - All document hashes strip frontmatter.
- Outcome: decided

### C7 — major — API gaps
- Challenge: run ids were ambiguous, round-start ownership was undefined, flags were undocumented, names were inconsistent, and there was no re-run path from `review_failed`.
- Answer:
  - Run ids are scoped `<slice>/rN` and `change/fN`, and finding ids are `<run>-Fn`.
  - `snapshot --run --at round-start --round` owns the round start.
  - The flag lists are completed.
  - The resolution name is `dismissed` everywhere.
  - A `review_failed` run is followed by a new run.
- Outcome: decided

### C8 — major — verdict inputs
- Challenge: "agreed Critical unfixed" was not derivable, and human checks had no marker.
- Answer: rulings carry `agreed: true|false`, and a Critical ruling with `agreed: true` forces `not_ready`. A `Human check:` line under `### Verification` in the tasks template is the only marker for human checks.
- Outcome: decided

### C9 — major — change base
- Challenge: `base_commit` exists only in worktree mode, and merges or rebases skew the diffs.
- Answer: the diff base is the merge-base with the target branch (resolved as `landed.ts` does), then `base_commit`, then `base_unknown` with a partial package. Snapshots record their merge-base. Files that changed between an old and new merge-base are labelled "from main" and not fingerprinted.
- Outcome: decided

### C10 — major — concurrency
- Challenge: unlocked read-modify-write of `status.yml` by rollup and review would lose updates.
- Answer: a per-change lock (the `withStateLock` pattern) covers every review write and rollup's slice write, with re-read and atomic rename. Run ids are allocated under the lock. Other writers in `changes.ts` stay unlocked, recorded as a residual risk.
- Outcome: decided (residual risk recorded)

### C11 — major — boundaries across people, machines and lifetimes
- Challenge: refs are machine-local, close is reversible, and in-place changes never close.
- Answer:
  - Machine-local boundaries are accepted, and packages report `start_ref_missing_on_this_machine` with a labelled fallback.
  - Cleanup moves to `weave review prune`, for landed or missing changes, called by the background refresh. Close does not clean up.
- Outcome: decided

### C12 — major — stalls in unattended flow
- Challenge: the hook ran without the skill installed, skill hand-off was not client-neutral, and packages lived outside the session folder.
- Answer:
  - `weave review status --json` returns `active` (enabled, not skipped, skill in the manifest) and `skill_paths`. The hook is a no-op when review is inactive.
  - The hand-off uses the auto-advance wording: "load by name or read from these paths".
  - Packages default to `<change folder>/.weave/tmp/reviews/`, which has a self-ignoring `.gitignore`.
- Outcome: decided

### Decision critiques
- `261110-wdfo`:
  - widened `applies_to` (execute skill, rollup)
  - added consequences: machine-local refs, prune instead of close, the push-mirror caveat, exclusions, seeded index
  - added Reconsider When conditions: several machines, disk cost
- `261110-dbm2`:
  - widened `applies_to` (rollup, the weave-next skill)
  - Decision now states derived out-of-date, the lock, and rules.ts
  - dropped the Windows claim, which conflicted with `261109-mn61`
  - added the "reviewer writes the report file" alternative
- `261110-dtld`:
  - widened `applies_to` (package.ts, review.ts)
  - clarifies that precedence is applied by the reviewer, not merged by the CLI
  - records absent files and missing repos

## Verdict

holds-with-changes — the chosen approach (skill for judgement, CLI for mechanics, snapshot refs) stands. The answers added shared rules, exclusions, a merge-base diff base, locking, migration and cleanup, and tightened the API and decisions.

## Next Resume Point

Run `weave-slices`. The rules module, the rollup changes and the boundary module are natural first tracer-bullet slices.
