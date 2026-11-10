---
id: 261110-dbm2-review-judgement-lives-in-the-skill-review-mechanics-in-the-weave-cli
title: Review judgement lives in the skill, review mechanics in the weave CLI
status: accepted
date: 2026-11-10
owner: arpit016
change: 261110-g2wn-code-reviewers
applies_to:
  - templates/skills/weave-review/**
  - templates/skills/weave-execute/SKILL.md
  - templates/skills/weave-next/SKILL.md
  - src/commands/review.ts
  - src/lib/review/**
  - src/lib/sliceRollup.ts
supersedes: []
superseded_by: null
---

# Review judgement lives in the skill, review mechanics in the weave CLI

## Context

The review flow mixes judgement (what to review, how to treat findings, when to stop for a person) with mechanics (snapshots, diffs, records, state, out-of-date checks). Mechanics could ship as bash scripts inside the skill or as CLI commands. Review state must also appear in `weave change status`, `weave slice rollup`, and `weave-next`.

## Decision

The `weave-review` skill holds only markdown: the flow, the three reviewer briefs (slice, fix check, final), receiving rules, round limits, rulings, and model levels. Every mechanical step is a `weave review` subcommand with `--json` output: `snapshot`, `package`, `record`, `gate`, `skip`, `status`, and `guidelines init`. Review state is written only by `weave review` subcommands, under a per-change lock with re-read and atomic write, never by hand. Rollup only preserves the `review` block and never writes it. Out-of-date is derived at read time and never stored. Readiness, dependent-slice satisfaction, verdicts, and exclusions are pure functions in `src/lib/review/rules.ts` that rollup, the gate, and skills consume through `--json`. The agent pipes reviewer reports to `record` on stdin. Reviewers stay read-only and never write files. Reviews are handed to fresh sub-agents by the skill, not through `weave advance`.

## Alternatives Rejected

- **Bash scripts bundled in the skill:** they need bash, installs drop exec bits, and they would duplicate the snapshot and diff logic the CLI needs for out-of-date checks.
- **Skill-only with hand-written state:** rollup drops unknown fields, and state written by hand is untrusted.
- **Reviewers write their report straight to a file:** that breaks their read-only rule. Piping through the agent keeps the only writer the CLI, and the integrity limit is stated.
- **CLI-owned briefs handed off like auto-advance:** contradicts the product requirement that briefs live in the skill, and `runs[]` is lane-oriented.

## Consequences

- There is one tested implementation of each mechanical step, with no bash dependency.
- A future edit to `sliceRollup.ts` must keep carrying the `review` block and the lock.
- The agent names a slice, never a commit range.
- The CLI surface grows by one command group.
- Skill text stays client-neutral.

## Reconsider When

Weave needs to run reviews without the CLI installed, or a supported client cannot run CLI commands from skills.
