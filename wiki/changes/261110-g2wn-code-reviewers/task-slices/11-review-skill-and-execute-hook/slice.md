# The weave-review skill, the execute hook, and next-step recommendations

## Outcome

Reviews happen without the person asking. A new bundled `weave-review` skill holds all review judgement: the slice review flow, how findings are received, fix-round limits, rulings, plan-problem stops, the final review, on-demand runs, model levels per client, and the inline fallback for clients without separate reviewers. Its three fill-in briefs (slice review, fix check, final review) and the review-record template ship beside it. `weave-execute` takes the start snapshot when a slice's first task begins and, when the slice becomes ready for review, hands over to `weave-review` in the same session before starting another slice. `weave-next` uses `ready_slices` and recommends reviews, final reviews, and plan-problem decisions. All mechanics go through the `weave review` commands from slices 01 to 10.

## User flow

1. A project runs `weave agent install claude`, which now includes `weave-review`.
2. `/weave-execute 02 T1`: the skill checks `weave review status --slice 02 --json`; review is active, so it runs `weave review snapshot --slice 02 --at start`.
3. After the last task, `weave slice rollup --json` reports slice 02 `ready_for_review`. The execute skill loads `weave-review` (or reads it from `skill_paths`) and runs its slice review in the foreground.
4. `weave-review` packages the slice, hands the filled slice brief to a fresh reviewer at the stated model level, records the report, runs up to `slice_rounds` fix rounds with fresh fix checkers, records rulings, finalizes, and, if the gate passes, starts the final review in the same session.
5. A plan problem stops the flow, and the skill tells the person what to decide and how (change the plan with `weave-clarify` or `weave adr new --supersedes`, or dismiss with `weave review record --resolve <id> --as dismissed --by <name>`).
6. In a later session, `/weave-next` recommends `weave-review slice 03` for a slice that shows "tasks done, not reviewed", and `weave-review change` when the gate passes with no final review.

## In scope

- `templates/skills/weave-review/SKILL.md`, `slice-reviewer-brief.md`, `fix-check-brief.md`, `final-reviewer-brief.md`, `review-record-template.md`.
- `templates/skills/weave-execute/SKILL.md`: the start-snapshot hook, the hand-over, waiting for the slice review before another slice, reading `ready_slices`.
- `templates/skills/weave-next/SKILL.md`: `ready_slices` instead of computing readiness from `depends_on`, and the review recommendations.
- `tests/agent-skills.test.ts` updates, and the repo-installed copies of `weave-execute` and `weave-next` kept aligned.
- A mechanical end-to-end smoke run of the CLI flow the skill drives.

## Out of scope

- Installing `weave-review` into this repository's own agents (it would turn review on for changes being built here; that is the team's choice after release).
- Cross-agent reviewer selection (deferred in the architecture).
- Knowledge wiki updates (done by `weave-knowledge` after implementation).

## Acceptance criteria

- [ ] `weave-review` installs for every agent like other bundled skills, with all four resources copied, spec-compliant frontmatter, and the Silent Weave Command Output block.
- [ ] Each brief has the placeholders `{PACKAGE_PATH} {SCOPE} {SLICE_OR_CHANGE_DOCS} {MODEL_LEVEL} {ROUND}` and the reviewer rules: read-only, no sub-agents, build evidence is claims to verify, judge only slice-owned files and use foreign files only for integration, label every finding `code` or `plan`, end with the fixed JSON block.
- [ ] The skill states the model level on every dispatch, never below mid for slice reviews, cheap to mid for fix checks, most capable for the final review, with a built-in table for each supported agent and `review.models` overrides.
- [ ] The skill never resolves a plan finding, keeps fixes inside slice-owned files, saves Minors for the final review, records unanswered unclear findings as rulings, and runs inline with `--independent false` when the client cannot start a separate reviewer.
- [ ] `weave-execute` does nothing review-related when `active` is false, and otherwise snapshots at the first task and hands over with the auto-advance wording.
- [ ] `weave-next` reads `ready_slices` and recommends `weave-review` for `not_reviewed`, out of date, a passing gate with no final review, and tells the person about waiting plan problems.
- [ ] The smoke run of the full CLI flow in a temporary project ends with a recorded verdict.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
