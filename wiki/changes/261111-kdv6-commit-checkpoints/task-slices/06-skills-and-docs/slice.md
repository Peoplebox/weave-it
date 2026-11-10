# Skills and docs describe and drive checkpoints

## Outcome

Skills pass summaries, run rollup before each slice, surface checkpoint failures and the notice, and no longer claim they never commit; README documents the feature.

## User flow

1. A skill records progress with `--summary`.
2. Execute runs rollup before and after each slice and reports build commit files.
3. Failures and the first-commit notice are shown; other output stays silent.

## In scope

- Skill templates under `templates/skills/*/SKILL.md` (progress-calling skills, execute, review, next, fix, slices, prepare, the shared silent-output block, handoff brief note).
- README section on commits.
- Installed copies refreshed with `weave agent update`-equivalent (repo-local copies).
- Template tests.

## Out of scope

- Push and PR drafting.

## Acceptance criteria

- [ ] Every progress-calling skill passes `--summary`.
- [ ] Execute runs rollup before a slice's first task and reports build commit outcomes and `leftovers_from`.
- [ ] The shared silent-output block surfaces checkpoint failures and the `commits_enabled` notice.
- [ ] No skill claims it never commits; they still never push or open PRs.
- [ ] README documents commit moments, switches, and change-list effects.
- [ ] `tests/agent-skills.test.ts` covers the new obligations.
