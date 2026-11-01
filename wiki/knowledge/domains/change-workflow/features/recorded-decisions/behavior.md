# Recorded Decisions (ADRs)

## Purpose

Keep the reasons behind long-lived engineering decisions where every agent and developer can find them, so a later change does not undo something deliberate because it looks odd. `wiki/knowledge/` says how things work, `wiki/changes/` holds the history of each change, and `wiki/decisions/` says why the system is built this way.

## Current Behavior

- `weave adr new "<title>"` creates a `proposed` decision and updates the generated `index.md`. It records the active change when there is one.
- `weave adr list` filters by `--status` and by `--path <file>`, matched against each decision's `applies_to`.
- `weave adr status <decision> <status>` moves a decision through its lifecycle. Accepting a decision also retires the decisions it names in `supersedes`.
- `weave adr check` lists live decisions whose `applies_to` matches files changed against the default branch or `--base`, including uncommitted and untracked files. In workspace mode it also checks registered repos. It reports only and never blocks.

## Domain Model

- **Location**: `wiki/decisions/`, unless the repo already has `docs/decisions/`, `docs/adr/`, or `adr/`.
- **Id**: `<YYMMDD>-<4 random characters>-<slug>`; commands accept any unique part of it.
- **Status**: `proposed`, `accepted`, `superseded`. `unknown` is reported for ADRs written outside Weave whose status cannot be read.
- **Managed vs unmanaged**: files Weave wrote have frontmatter it can update. Others are listed read-only, and a hand-written `index.md` is left alone.

## Behavioral Rules

- Write one only when a future developer could reasonably undo the decision without knowing why it was made. Most changes record none.
- An accepted decision is never rewritten; a replacement supersedes it and the old file stays. `proposed` cannot come back from `accepted`, and `superseded` is final.
- Engineering decisions only for now. Product decisions stay in `exploration.md` and `prd.md`.
- Decisions are not a lane: they have no `status.yml` entry, no staleness, and no gate. They travel on the change's branch, so an abandoned change's decisions never reach the default branch.

## Who Does What

| Part | Job |
|---|---|
| `weave-research` | Reports decisions that apply to the researched areas, and where code differs from them |
| `weave-architect` | Works inside accepted decisions, flags conflicts in its options, and drafts lasting decisions as `proposed` |
| `weave-challenger` | Checks the shape against accepted decisions and challenges proposed ones |
| `weave-stress-test` | On a passing `architecture` verdict, accepts proposed decisions. `waived` accepts nothing, and `needs-reshaping` leaves them proposed |
| `weave-fix`, `weave-execute` | Check before changing code, stop on a conflict, name what was consulted, and flag candidates |
| `weave-next` | Mentions proposed decisions waiting for confirmation |
| `AGENTS.md` | A marked section added by `weave init` and the first `weave adr new`, append-only, for agents outside a Weave skill |

## Source Anchors

- `src/lib/decisions.ts`, `src/commands/adr.ts`, `src/lib/init-workspace.ts`
- Skills listed above under `templates/skills/`, and `templates/agents/weave-challenger.md`
- Tests: `tests/decisions.test.ts`, `tests/agent-skills.test.ts`
- This repo's own decisions: `wiki/decisions/`

## Change History

- 2026-11-01 (branch `change/questions-research-skills`): added `weave adr`, the append-only `AGENTS.md` guidance, and decision checks across the skills; backfilled this repo's first decisions.

## Open Questions

- Whether `weave adr check` should feed a reviewer step or a blocking check once one exists.
- Whether product decisions get lost the same way and need the same treatment.
