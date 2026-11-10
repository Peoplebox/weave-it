# Contracts: The weave-review skill, the execute hook, and next-step recommendations

See `architecture/index.md` (Decision Summary, Components, Activation and locating the skill, Slice flow, Resolving a plan problem, Final review, On demand, Clients without separate reviewers), `architecture/api-contract.md` (Brief contract, Reviewer report schema), PRD § Handling findings and § How reviewers are run, and decisions `261110-dbm2`, `261110-wdfo`, `261101-qcgh` (critics see only what is written), `261108-4z8l` (fresh foreground sub-agents).

## Interfaces

- Skill invocations: `weave-review slice <id>`, `weave-review change`. With no argument, the skill picks from `weave review status --json` and `weave review gate --change --json`.
- Commands the skill uses, exactly as in `api-contract.md`: `review status`, `snapshot`, `package`, `record`, `gate`. The reviewer sub-agents never call `weave`; the agent pipes their response to `record --report -`.
- Hand-over wording in `weave-execute`: "load the `weave-review` skill and run its slice review for `<id>`; if you cannot load it by name, read it from one of `skill_paths`".
- Brief placeholders: `{PACKAGE_PATH} {SCOPE} {SLICE_OR_CHANGE_DOCS} {MODEL_LEVEL} {ROUND}`.

## Data

- Skill frontmatter: `name: weave-review`, a description containing "Use when", `license: MIT`, `compatibility` naming the weave CLI, `metadata.author: weave-tools`, `metadata.last_changed_in` set to the current package version.
- Built-in model-level table, one row per supported agent (`claude`, `codex`, `cursor`, `opencode`), columns `cheap`, `mid`, `most_capable`. Exact model names are chosen at implementation time. `settings.models` from `weave review status --json` overrides a row.
- `slice_rounds` comes from `settings.slice_rounds` (default 2).
- `review-record-template.md` documents the `review.md` layout that `record` renders (slice 05), with the same section headings.

## State

- Slice flow (skill): status → package → dispatch → record → plan finding? stop → rounds 1..`slice_rounds` (round-start snapshot, fix agreed Critical and Important inside slice-owned files, re-run the slice's automatic checks, package fix round, dispatch fix checker, record check, resolve fixed) → remaining open → rulings (`--agreed`, `--reason`, `--cost`) or parked Minors → finalize → gate → final review if it passes.
- Report invalid twice → `record --failed`, and the skill reports the failure without retrying further.
- Final flow: gate → package `--change` → dispatch at most capable level → record → plan finding? stop → one fix batch (agreed Critical and Important plus must-fix Minors) → one fix check → rulings → finalize.
- Execute: never runs reviews in the background, waits for the slice review before starting another slice, and leaves the session after a plan-problem stop with the slice `waiting_on_person`.

## Validation and errors

- Inactive review (`active: false`) → execute and next skip all review steps.
- Exit 5 from `record` is expected for plan findings: the skill stops and explains; it never retries with another `--as`.
- Skill text names no external product or project as a source of ideas.

## Files and artifacts

- New: `templates/skills/weave-review/SKILL.md`, `templates/skills/weave-review/slice-reviewer-brief.md`, `templates/skills/weave-review/fix-check-brief.md`, `templates/skills/weave-review/final-reviewer-brief.md`, `templates/skills/weave-review/review-record-template.md`.
- Modified: `templates/skills/weave-execute/SKILL.md`, `templates/skills/weave-next/SKILL.md`, `tests/agent-skills.test.ts`, the repo-installed copies `.claude/skills/weave-execute/SKILL.md`, `.claude/skills/weave-next/SKILL.md`, `.agents/skills/weave-execute/SKILL.md`, `.agents/skills/weave-next/SKILL.md` (and `.weave/agents.yml` hashes if refreshed through `weave agent update`).
