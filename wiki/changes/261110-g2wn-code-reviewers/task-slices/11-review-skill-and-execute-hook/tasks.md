---
artifact: tasks
slice: 11-review-skill-and-execute-hook
status: draft
owner: engineering
created_at: 2026-11-09T23:35:06.000Z
updated_at: 2026-11-09T23:35:06.000Z
source: architecture
---

# Tasks: The weave-review skill, the execute hook, and next-step recommendations

## Status Legend

- `todo`: ready when blockers are done
- `in_progress`: currently being implemented
- `blocked`: cannot proceed without listed blocker
- `done`: implemented and verified
- `not_tested`: implementation complete, automated verification incomplete
- `invalid`: no longer applies

## Active Task Index

| ID | Status | Execution | Repos | Owner | Title | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | done | afk | root | | Write the weave-review skill flow | None |
| T2 | done | afk | root | | Write the three reviewer briefs and the review-record template | None |
| T3 | done | afk | root | | Add the review hook to weave-execute and review recommendations to weave-next | T1 |
| T4 | done | afk | root | | Verify weave-review packaging and the execute and next text | T1, T2, T3 |
| T5 | done | afk | root | | Smoke-run the full review flow the skill drives in a temporary project | T4 |

## root

### T1: Write the weave-review skill flow

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-review/SKILL.md` (C)

### What to build

The skill per `contracts.md` § Interfaces, § Data, and § State, client-neutral ("hand this to a fresh reviewer with your agent's own sub-agent tool"). Include:
- the Silent Weave Command Output block verbatim
- activation through `weave review status`
- the slice flow, receiving rules (check each finding against the code first, fix what holds up, explain and leave what does not, ask when unclear and record an unanswered question as a ruling in unattended runs, add nothing unused), fixes only inside slice-owned files (otherwise a ruling for the final review)
- plan-problem stops and the two ways the person resolves them
- the final review and the on-demand forms (partial runs, flat changes `change` only)
- the model-level table and overrides
- the inline fallback with `--independent false`

### Acceptance Criteria

- [x] Every step of `architecture/index.md` § Slice flow and § Final review appears in order with its exact command.
- [x] The skill never tells the agent to edit `status.yml` or review files by hand.
- [x] No external product or project is named as a source of ideas.

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts` (the existing frontmatter test runs over every bundled skill, so it checks the new skill immediately; T4 adds skill-specific tests)
- Manual/smoke check: `npm run build`, then confirm every subcommand and flag the skill uses appears in `node dist/cli.js review --help` and `node dist/cli.js review <subcommand> --help`

- Evidence (2026-11-10): wrote `templates/skills/weave-review/SKILL.md` (277 lines): activation via `weave review status`, slice flow (package, review, plan stop, receive, rounds 1..`settings.slice_rounds`, rulings, finalize, gate), receiving rules, fixes only in slice-owned files, plan-problem stop with the two person-only resolutions, final review with one fix batch and one check, on-demand forms (partial, resume via `package --run`, flat `change` only), model-level table with `settings.models` overrides, inline fallback with `--independent false`, Silent Weave Command Output block plus the `skills_available` rule. Added `templates/opencode/commands/weave-review.md` like every other skill. `npm run build`, then every subcommand and flag the skill names was checked against `node dist/cli.js review <sub> --help` (status, snapshot, package, record, gate, unskip). `npx vitest run tests/agent-skills.test.ts` passed.
### T2: Write the three reviewer briefs and the review-record template

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: None
Files:
- `templates/skills/weave-review/slice-reviewer-brief.md` (C)
- `templates/skills/weave-review/fix-check-brief.md` (C)
- `templates/skills/weave-review/final-reviewer-brief.md` (C)
- `templates/skills/weave-review/review-record-template.md` (C)

### What to build

- **Slice brief:** read the package; judge against acceptance criteria, planning docs, decisions, and guidelines (repo file wins on conflict, applied per repo); treat evidence as claims; judge only slice-owned files; do not re-raise settled rulings; return strengths, findings, declined, verdict, and the JSON block from `api-contract.md`.
- **Fix-check brief:** check only the listed fixes in the round diff; return the fix-check JSON block.
- **Final brief:** whole change against the plan, cross-slice and cross-repo problems, decisions, knowledge wiki fit, plan gaps as `kind: plan`, and the `final_only.minor_sort` block.
- **Record template:** the `review.md` layout from `schema.md`.
- Every brief carries the reviewer rules and placeholders listed in `contracts.md`.

### Acceptance Criteria

- [x] Each brief contains all five placeholders it uses and every reviewer rule.
- [x] Each brief's JSON example validates against the slice 05 / 06 / 08 validators (checked in T5).
- [x] The record template headings match the sections `record` renders.

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts` (installs every bundled skill with its resources into temporary projects)
- `npm run build`; the briefs' JSON examples are validated by piping them through `record --report -` in T5

- Evidence (2026-11-10): wrote `slice-reviewer-brief.md`, `fix-check-brief.md`, `final-reviewer-brief.md` (each with all five placeholders, read-only, no sub-agents, no `weave` commands, evidence as claims, slice-owned files only with foreign files for integration, `code`/`plan` labels, declined-to-judge, ends with the JSON block) and `review-record-template.md` (slice and change `review.md` layouts). The JSON examples validate with `validateReport` / `validateFixCheckReport` (tests in T4) and were piped through `record --report -` in T5. Template headings are checked against `renderReviewRecord` / `renderChangeReviewRecord` output in T4.
- Post-slice fix (2026-11-10, PRD FR12): the final brief now has the reviewer sort the slice reviews' rulings as well as the saved Minors in `final_only.minor_sort` (section "Saved Minors and Slice Rulings"); its JSON example adds a slice ruling entry and still validates (`tests/agent-skills.test.ts`). `SKILL.md` final review steps and `review-record-template.md` (Minor sort, All rulings with dismissals) updated to match.
### T3: Add the review hook to weave-execute and review recommendations to weave-next

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1
Files:
- `templates/skills/weave-execute/SKILL.md` (M)
- `templates/skills/weave-next/SKILL.md` (M)
- `.claude/skills/weave-execute/SKILL.md` (M: keep aligned)
- `.claude/skills/weave-next/SKILL.md` (M: keep aligned)
- `.agents/skills/weave-execute/SKILL.md` (M: keep aligned)
- `.agents/skills/weave-next/SKILL.md` (M: keep aligned)

### What to build

- **weave-execute:**
  - when a slice's first task moves to `in_progress`, run `weave review status --slice <id> --json`; if `active`, run `weave review snapshot --slice <id> --at start`
  - after rollup reports the slice `ready_for_review`, hand over with the exact wording in `contracts.md` and wait for the review before starting another slice
  - choose slices from `ready_slices`
  - when inactive, change nothing
- **weave-next:** in slice mode, read `ready_slices` from `weave slice rollup --json` instead of computing from `depends_on`, and add the review recommendations (not reviewed, out of date, passing gate without final review, waiting plan problems, verdict out of date).
- Bump `last_changed_in` on both.
- Keep the repo-installed copies identical apart from volatile metadata. Do not install `weave-review` into this repository.

### Acceptance Criteria

- [x] Both skills contain the exact commands and hand-over wording.
- [x] The "keeps repo-installed Weave skill copies aligned" test passes.

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts`
- `npm run typecheck`

- Evidence (2026-11-10): `weave-execute` gains `# Code Review Hook` (status check, `snapshot --slice <slice-id> --at start` only while the slice is `pending`, hand-over wording from `contracts.md` after rollup reports `ready_for_review: true`, wait before another slice, end the run on `waiting_on_person`, nothing when `active: false`) and chooses slices from `ready_slices`. `weave-next` reads `ready_slices` from `weave slice rollup --all --check --json` (writes nothing) and adds the code review recommendations. Both bumped to `last_changed_in: "0.1.13"`; installed copies under `.claude/skills/` and `.agents/skills/` copied byte-identical and their `.weave/agents.yml` hashes refreshed (no `weave agent update`, which would have dropped orphan `weave-review` resources into this repo). `weave-review` is not installed here. `npm run typecheck` passed; the alignment test passed.
### T4: Verify weave-review packaging and the execute and next text

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T1, T2, T3
Files:
- `tests/agent-skills.test.ts` (M)

### What to build

- Add `weave-review` to `bundledSkillNames` and to the not-plan-mode-required list.
- Add tests that `weave-review` installs with its four resources for every agent, has the Silent Weave Command Output block, contains each `weave review` command it relies on, the five placeholders in each brief, and the plan-problem stop rule.
- Add tests that `weave-execute` contains the snapshot hook and hand-over wording and that `weave-next` reads `ready_slices`.

Then run the full suite, typecheck, and build.

### Acceptance Criteria

- [x] New and existing agent-skills tests pass.
- [x] The full suite, typecheck, and build pass.

### Verification

- Automated tests: `npx vitest run tests/agent-skills.test.ts`, then `npm test`
- `npm run typecheck && npm run build`

- Evidence (2026-11-10): `tests/agent-skills.test.ts`: `weave-review` added to `bundledSkillNames` and the not-plan-mode list; 7 new tests (commands, plan stop and slice-only fixes, model levels, brief placeholders/rules/JSON examples validated by the record validators, record template headings vs rendered `review.md`, install with four resources for claude/codex/cursor/opencode plus the opencode command, execute hook and next recommendations). `npx vitest run tests/agent-skills.test.ts`: 59 passed. `npm test`: 52 files, 735 tests passed. `npm run typecheck` and `npm run build` passed.
- Post-slice fix (2026-11-10): `weave agent update` no longer installs new resource files (such as the `weave-review` briefs) for a skill the agent has not installed; it adds new resources only for skills in the manifest (`updateArtifact` in `src/lib/agent-skills.ts`). Regression test: "never creates resource files for a skill the agent has not installed during update". `npm test`: 52 files, 739 tests passed.
### T5: Smoke-run the full review flow the skill drives in a temporary project

Status: done
Owner:
Repos: root
Execution: afk
Blocked by: T4
Files:
- None (temporary project outside the repo; results recorded in this task)

### What to build

A mechanical run of the CLI sequence the skill text prescribes, using the built CLI, with canned reviewer responses taken from the brief examples.

### Acceptance Criteria

- [x] Every step in the manual check below succeeds with the expected state.

### Verification

- Manual/smoke check (mechanical, agent-run):
  1. `npm run build`. In a new temporary folder: `git init`, an initial commit, then `node <repo>/dist/cli.js init`, and `node <repo>/dist/cli.js agent install claude`.
  2. Create a change with two slices (02 depends on 01) through `weave change new` and hand-written slice files.
  3. Follow the `weave-execute` hook text: `review status --slice 01 --json` (expect `active: true`), `snapshot --slice 01 --at start`, edit files, mark tasks done, `weave slice rollup --json` (expect 01 `ready_for_review`, 02 not in `ready_slices`).
  4. Follow `weave-review`: `package --slice 01`, pipe the slice brief's example response into `record --report -`, run one fix round with the fix-check brief's example response, record a ruling, `--finalize` (expect `reviewed_with_rulings`), then rollup (expect 02 in `ready_slices`).
  5. Repeat for slice 02, then `gate --change` (expect `pass: true`), `package --change`, pipe the final brief's example response, run the fix batch, `--finalize`.
  6. `weave change status` shows a verdict line; `wiki/changes/<id>/review.md` lists all rulings.
  7. Expected result: every command exits 0 (except an intentional exit 5 check on a plan finding), and the verdict matches the example findings.

- Evidence (2026-11-10, temporary project in the session scratchpad, built CLI): `git init`, `weave init --yes --mode repo`, `weave agent install claude` (installed `weave-review` + 4 resources), `weave change new` (worktree), slices 01-alpha and 02-beta (depends on 01). `review status --slice 01` -> `active: true`; `snapshot --slice 01-alpha --at start`; rollup -> 01 `ready_for_review: true`, `ready_slices: []`. `package --slice 01-alpha` -> `01-alpha/r1`, mid; slice brief example recorded (F1 important, F2 minor); F2 parked; round 1 snapshot, fix, `package --fix-round 1` (targets F1); verbatim fix-check example exited 4 (`report_invalid`: its ids belong to another run), adapted ids recorded (F1 addressed, new F3); F1 `--as fixed --round 1`; F3 ruling; `--finalize` -> `reviewed_with_rulings`; rollup -> `ready_slices: [02-beta]`. Slice 02: snapshot, package, report with an added plan finding -> `waiting_on_person`; `--as ruling` on it exited 5; gate blocked; person `--as dismissed --by`; `package --run 02-beta/r1` resumed (`resume_round: 1`); F2 parked, F1 agreed ruling, finalize -> `reviewed_with_rulings`. `gate --change` -> `pass: true`; `package --change` -> `change/f1`, most_capable, 2 saved Minors; final brief example recorded (minor_sort over both slice Minors + own F2); fix batch snapshot/fix/`package --fix-round 1`; round 2 refused (`round_limit`); fix check recorded, F1 and F2 fixed; finalize -> `ready_with_parked_items` (2 rulings, 4 parked items). `weave change status` shows `Verdict: ready with parked items (4) · 2 rulings`; `wiki/changes/<id>/review.md` lists both rulings under `## All rulings`. Response files stayed git-ignored under `.weave/tmp/`.
## QA Findings

| ID | Status | Severity | Source | Related Task | Summary |
| --- | --- | --- | --- | --- | --- |

None.

## Refactors

| ID | Status | Scope | Related Tasks | Summary |
| --- | --- | --- | --- | --- |

None.

## Verification

- 2026-11-10: `npm run typecheck` passed; `npm test` 52 files / 735 tests passed; `npm run build` passed; T5 smoke run of the full CLI flow ended with a recorded `ready_with_parked_items` verdict.
