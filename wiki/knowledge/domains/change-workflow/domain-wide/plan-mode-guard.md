# Plan Mode Guard (retired)

## Current Behavior

No bundled Weave skill requires Plan Mode. The guard that used to make `weave-explore` and `weave-architect` refuse entry outside Plan Mode, and forbid them from writing artifacts, was removed when both skills moved to an options-first flow that writes a shape only after the user confirms a direction. See [research-shapes-and-stress-tests](research-shapes-and-stress-tests.md).

Design skills still write only their own lane's artifact. Discussions can be checkpointed without a decision through `weave-capture session <lane>`.

## Source Anchors

- `tests/agent-skills.test.ts` ("does not require Plan Mode in any bundled skill")

## Change History

- 2026-06-03 (change `260603-piln-npm-and-skill-versioning-and-updates`): initial design landed a two-phase `# Plan Mode Protocol` in all four design-discussion skills, deferring `weave artifact current set` until post-acceptance Phase 2. That design collided with the pre-existing Plan Mode Guard in `weave-explore` and `weave-architect` and inverted the actually-correct rule. Recovery (QF1/T12 in the same change): the Plan Mode Protocol was removed from all four skills; the Plan Mode Guard was strengthened to explicitly authorize `weave artifact current set <lane>` in Plan Mode (because it writes session state only); the guard was kept on exactly the two plan-mode-required skills (`weave-explore`, `weave-architect`); `weave-prd` and `weave-clarify` were confirmed as Agent Mode skills and left without the guard.
- 2026-06-06 (change `260606-k0l6-architecture-folder`): `weave-architect` stayed plan-mode-required but became read-only; architecture persistence moved to `weave-capture`, and structural architecture changes are handled by `weave-clarify`.
- 2026-06-11 (change `260610-l397-removing-local-cache`): removed local artifact lane commits from the guard. Guarded skills now resolve the branch-derived active change and use explicit lane targets.
- 2026-10-20 (branch `change/questions-research-skills`): retired. `weave-explore` and `weave-architect` now write their own shapes after the user confirms a direction, so no bundled skill requires Plan Mode. `EXPECTED_PLAN_MODE_GUARD` was removed and a test asserts no skill carries the guard.
