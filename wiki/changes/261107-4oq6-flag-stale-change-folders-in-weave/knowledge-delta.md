# Knowledge Delta

## Durable Behavior Changes

- **States in `weave change list`.** In worktree checkouts, each change gets one state (`folder_unavailable`, `folder_missing`, `folder_missing_kept`, `landed_with_newer_commits`, `landed`, `in_progress`, `closed_not_landed`, `closed_unchecked`, `done`), with labels and a runnable next step, in text and additive `--json`. Past changes move behind `--all`, and `--fetch` waits for fresh remote facts. Hand-made `change/*` branches are ignored.
- **One landed check** (`src/lib/landed.ts`, ADR `261108-kl3n`). It counts merge, rebase, and squash, measured against the remembered starting branch, and uses only remote-derived refs when there's an `origin`. `contained` covers ambiguous fast-forwards, and the newer-commits walk finds `landed_with_newer_commits`.
- **Remembered starting branches** in `.git/weave/bases/<id>.yml`. They are written at creation, recovered from `status.yml` or the reflog for older changes, and kept after `close`.
- **A detached background refresh** (ADR `261108-4ko1`). It fetches only known branches into `refs/weave/remotes/origin/*`, never prompts, and never moves the user's refs, `FETCH_HEAD`, or tags (`--refmap=`). It runs at most once a minute, with about 30 seconds per repo.
- **Missing folders in `close` and `switch`:**
  - `close` clears this change's leftovers only, warns about moved folders, and refuses for locked entries or unavailable change folders.
  - `switch` recreates the folder, handling slot collisions and resetting setup.
  - `change status <id>` says `folder_missing`.
- **`weave status`** shows `N change(s) need attention (…)` and `changes_attention` from the saved snapshot.
- **`weave-next`** checks `weave change list --fetch --json` and decides on `state.id` before recommending cleanup.

## Affected Knowledge Areas

- change-workflow, the new feature: change-folder-states
- change-workflow, domain-wide: change-checkouts
- cli-distribution: weave-status
- cli-commands: core-command-reference

## Knowledge Files Updated

- `wiki/knowledge/domains/change-workflow/features/change-folder-states/behavior.md` (new)
- `wiki/knowledge/domains/change-workflow/domain-wide/change-checkouts.md`
- `wiki/knowledge/domains/change-workflow/index.md`
- `wiki/knowledge/domains/cli-distribution/features/weave-status/behavior.md`
- `wiki/knowledge/domains/cli-commands/features/core-command-reference/behavior.md`

## No-Impact Rationale

None. The change has durable behavior impact.

## Source Evidence

- Code:
  - `src/lib/landed.ts`
  - `src/lib/change-bases.ts`
  - `src/lib/change-facts.ts`
  - `src/lib/change-states.ts`
  - `src/lib/change-refresh.ts`
  - `src/lib/change-attention.ts`
  - `src/lib/local-state.ts`
  - `src/lib/git.ts`
  - `src/lib/changes.ts`
  - `src/lib/worktrees.ts`
  - `src/lib/status.ts`
  - `src/commands/change.ts`
  - `templates/skills/weave-next/SKILL.md`
- Tests:
  - `tests/landed.test.ts`
  - `tests/change-states.test.ts`
  - `tests/cli-change-list.test.ts`
  - `tests/change-refresh.test.ts`
  - `tests/worktrees.test.ts`
  - `tests/cli-status.test.ts`
  - `tests/agent-skills.test.ts`

  The full suite passed (405 tests).
- Task evidence: `task-slices/01` to `06` `tasks.md`.

## Follow-Up Knowledge Work

- **PRD wording.** Run `weave-clarify prd` to record the visible wording added during the stress test and implementation:
  - "nothing left to merge…"
  - `folder_unavailable`
  - the `git worktree add` recovery hint
  - "still checking"
  - the git 2.38 line
- **One-commit squashes.** These report as `rebased` because the patches are identical. That's documented in the feature page, not in the PRD.
- **State-id contract.** Consider a decision record for the state-id and label-id contract.
