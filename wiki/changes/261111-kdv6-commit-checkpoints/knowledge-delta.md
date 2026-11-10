# Knowledge Delta

## Durable Behavior Changes

- Weave now commits a change's work on its own branch:
  - planning commits from every status-recording command (`progress`, `verdict`, `clear-stale`, `knowledge`, review results), with a separate catch-up commit for leftovers and no project hooks
  - build commits from `weave slice rollup` keyed by task coverage, with project hooks and a retry window
  - fix commits from review fix-round and final-fix packaging
- Review end boundaries point at build and fix commits (`CommitBoundary`), with snapshots as the fallback and for start boundaries. Packages and `review status --slice` report the boundary kind.
- New switches: `commits.enabled` (project, main checkout or change folder), `weave settings commits on|off [--project]` (personal), and `weave change skip-commits|unskip-commits` (per change). New project settings: `commits.subject_template` and `commits.code_timeout_seconds`.
- Weave-launched sessions carry `WEAVE_UNATTENDED=1`. Under it, code commits refuse and the first-commit notice is not marked delivered. Handoff briefs tell sub-agents not to commit.
- Skills:
  - `weave-execute` rolls up before and after each slice and reports build commits.
  - Fix, slices, review, next, and knowledge mention checkpoint commits.
  - The shared silent-output block surfaces checkpoint failures and the notice.
  - The lifecycle block asks for `--summary`.

## Affected Knowledge Areas

- change-workflow: new feature `checkpoint-commits`; updates to `code-reviews`, `weave-execute`, `auto-advance-launch`, and the domain index.
- cli-commands: `core-command-reference`.

## Knowledge Files Updated

- `wiki/knowledge/domains/change-workflow/features/checkpoint-commits/behavior.md` (new)
- `wiki/knowledge/domains/change-workflow/features/code-reviews/behavior.md`
- `wiki/knowledge/domains/change-workflow/features/weave-execute/behavior.md`
- `wiki/knowledge/domains/change-workflow/domain-wide/auto-advance-launch.md`
- `wiki/knowledge/domains/change-workflow/index.md`
- `wiki/knowledge/domains/cli-commands/features/core-command-reference/behavior.md`

## No-Impact Rationale

Not applicable.

## Source Evidence

- Code: `src/lib/checkpoints.ts`, `src/lib/build-checkpoints.ts`, `src/lib/review/commit-boundary.ts`, `src/lib/changes.ts`, `src/commands/{change,slice,settings}.ts`, `src/commands/review/{record,package,status}.ts`, `src/lib/agent-launchers.ts`, `src/lib/advance.ts`
- Tests: `tests/checkpoints-planning.test.ts`, `tests/checkpoints-controls.test.ts`, `tests/checkpoints-build.test.ts`, `tests/checkpoints-review.test.ts`, `tests/agent-skills.test.ts`
- Decisions: `261111-htho`, `261111-kx9x` (supersedes `261110-wdfo`), `261111-7orw` (supersedes `261108-4z8l`)

## Follow-Up Knowledge Work

- A separate change will add pushing and pull-request drafting after the knowledge stage.
