---
name: weave-next
description: Tell the user what to do next on the active Weave change. Reads status.yml, the change artifacts, stale flags, and resume notes, then recommends exactly one next skill with the reason. Read-only, it never changes files. Use when the user asks what's next, where are we, what should I run, or seems unsure how to continue a Weave change.
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.9"
---

# Weave Next

Use this skill when the user wants to know what command to run next for an active Weave change.

`weave-next` is read-only advisory. It orients the user; it does not perform the recommended work.

# Behavior Rules

- Do not require Plan Mode.
- Do not write repo-tracked artifacts.
- Do not create, revise, capture, approve, or advance artifacts.
- Do not set, clear, or read artifact context.
- Do not invoke or delegate to `weave-explore`, `weave-prd`, `weave-architect`, `weave-slices`, `weave-knowledge`, `weave-capture`, or `weave-clarify`.
- Do not document or rely on formal target arguments such as `weave-next prd` in v1.
- Use live artifacts as canonical current truth.
- Use session notes only for resume points, rationale, unresolved context, and newer explicit user decisions.
- Mention `weave-capture` only as an optional checkpoint when there is useful current discussion context to preserve.

# Resolve Context

Start by discovering the current Weave session:

```bash
weave workspace --json
```

Resolve the active change for the current cwd-dispatched workspace or repo context:

```bash
weave change current --json
weave change status --json
```

If no active change exists, stop and say:

```text
No active Weave change found. Run `weave change new` or `weave change switch`, then run `weave-next` again.
```

# Scope

Inspect only the resolved workspace or repo context whose current change matches the active change.

Do not summarize unrelated repos from the same Weave session. In workspace mode, treat registered sub-repos as implementation locations inside the single workspace change context, not as separate artifact targets.

If the current branch does not match the active change branch, include that branch mismatch before recommending the next command.

# Required Read Order

For the active change, read live artifacts first:

```text
wiki/changes/<change-id>/status.yml
wiki/changes/<change-id>/questions.md
wiki/changes/<change-id>/research.md
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
wiki/changes/<change-id>/tasks.md
wiki/changes/<change-id>/task-slices/
wiki/changes/<change-id>/task-slices/dependency-graph.md
wiki/changes/<change-id>/findings.md
```

**Dual mode:** when `task-slices/` exists, walk slice `status.yml` files, compute ready set from `depends_on`, and suggest next slice + task (bias toward critical-path slices). Support `/weave-next afk` to surface ready `Execution: afk` tasks across slices. When only flat `tasks.md` exists, use legacy flat-mode recommendations.

Architecture may be legacy file mode or folder mode. If `architecture/` exists, treat `architecture/index.md` as the entry point and direct child facet files as part of the architecture lane. If both `architecture.md` and `architecture/` exist, mention the conflict before recommending the next step.

Then read relevant recent session notes newest-first:

```text
wiki/changes/<change-id>/sessions/*-exploration.md
wiki/changes/<change-id>/sessions/*-prd.md
wiki/changes/<change-id>/sessions/*-architecture.md
```

Prefer the latest relevant `## Next Resume Point` for resume guidance. Avoid a full history audit unless the latest notes are ambiguous or conflict with live artifacts.

If a session note conflicts with the live artifact, prefer the live artifact unless the latest session records an explicit newer user decision.

# Artifact State Signals

Classify each artifact conservatively.

Treat an artifact as missing when its file or folder shape does not exist.

Treat an artifact as not usable when it is blank, whitespace-only, scaffold-only with headings but no substantive content, or explicitly marked not ready for the next lane.

For `exploration.md`, use `PRD Readiness` when present:

- `Ready` means the exploration can support PRD work.
- `Not ready` means recommend exploration work before PRD work.

For `prd.md`, open product questions or unresolved PRD session context can make PRD resume work primary even when architecture exists.

For the architecture artifact, open technical questions, unresolved architecture session context, missing folder index, or substantive facet-only context can make architecture resume work primary before issues.

For issue evidence, use conservative v1 heuristics only:

- populated `tasks.md`
- obvious issue URLs in artifacts
- `#123`-style issue references in artifacts

Do not treat an empty or scaffold-only `tasks.md` as issue breakdown evidence.

# Recommendation Rules

Source-aware stale-first recommendation:

- If `status.yml.stale` contains one or more lanes, recommend refreshing stale lanes before forward progress.
- stale `questions` -> run `weave-questions`
- stale `research` -> run `weave-research`
- stale `prd` -> run `weave-prd`
- outdated stress test (`stress_tests.<lane>.outdated` in `weave change status --json`) -> run `weave-stress-test <lane>` again before the next lane relies on it
- stale `architecture` -> run `weave-architect`
- stale `slices` -> run `weave-slices`
- Explain which upstream lane invalidated the recommendation when `invalidated_by` is present.
- Treat stale entries as source-aware dependency invalidation from `status.yml.artifacts`, not proof that every earlier pipeline lane was completed.

Knowledge freshness recommendation:

- If `status.yml.knowledge.status` is `pending`, recommend `weave-knowledge` after any stale artifact lanes are resolved.
- If `status.yml.knowledge.status` is `stale`, recommend `weave-knowledge` after the invalidating upstream context is resolved.
- If knowledge was previously `updated` or `none` and artifact stale lanes exist afterward, report knowledge as effectively stale without writing `status.yml`.
- Explain that `weave-next` is read-only and does not mutate knowledge status.

Research lane recommendation (the `questions` and `research` lanes are optional current-state evidence and never move `stage`):

- usable `questions.md` plus missing or scaffold-only `research.md` -> run `weave-research`, in a fresh session
- missing `questions.md` and `research.md` on a change that touches existing behaviour, with exploration, PRD, or architecture not yet usable -> show `weave-questions` as the `Alternate Pipeline Step`; do not make it primary over a valid resume point
- `research.md` with open questions -> mention them in `Reason`; do not block forward progress on them

Stress test gate (`status.yml.stress_tests`, verdicts `holds`, `holds-with-changes`, `needs-reshaping`, `waived`):

- For `feat`, a ready `exploration.md` needs a current `exploration` verdict of `holds`, `holds-with-changes`, or `waived` before `weave-prd`. Without one, recommend `weave-stress-test exploration`, in a fresh session.
- For `feat`, a usable architecture artifact needs a current `architecture` verdict of `holds`, `holds-with-changes`, or `waived` before `weave-slices`. Without one, recommend `weave-stress-test architecture`.
- A `needs-reshaping` verdict -> run `weave-explore` (exploration) or `weave-architect` (architecture), starting from the session note named in `stress_tests.<lane>.session`.
- For other change types the stress test is optional: mention it as the `Alternate Pipeline Step`, never as a blocker.
- Mention that `weave change verdict <lane> waived --reason "..."` skips the gate only when the user asks how to skip it.

Type-aware forward recommendation:

- missing, scaffold-only, or not-ready `exploration.md` -> run `weave-explore`
- ready `exploration.md` with a passing or waived stress test (or a non-`feat` change) plus missing `prd.md` -> run `weave-prd`
- usable `prd.md` plus missing `architecture.md` -> run `weave-architect`
- usable `architecture.md` with a passing or waived stress test (or a non-`feat` change) plus no slice evidence -> run `weave-slices`
- populated `tasks.md` or obvious issue references -> implementation handoff ready
- For `fix`, `refactor`, `docs`, `test`, `ci`, and `chore`, prefer architecture or issues when product behavior is already clear; do not require PRD just to advance.
- For `feat`, prefer exploration or PRD when product behavior, scope, requirements, or acceptance remain unclear.

Resume recommendation:

- latest relevant `sessions/*-exploration.md` with unresolved resume work -> run `weave-explore`
- latest relevant `sessions/*-prd.md` with unresolved resume work -> run `weave-prd`
- latest relevant `sessions/*-architecture.md` with unresolved resume work -> run `weave-architect`

When resume and forward recommendations differ, make the resume command primary and show the forward recommendation as `Alternate Pipeline Step`.

When there is no valid resume context, make the type-aware recommendation primary.

# Output Format

Use these headings when relevant and keep them easy to scan:

```text
Current Change
Artifact State
Resume Context
Recommended Next Step
Alternate Pipeline Step
Reason
Optional Checkpoint
```

Omit empty sections when they would add noise.

In `Current Change`, include change id, title when available, target repo or repos, and branch health.

In `Artifact State`, summarize `questions.md` and `research.md` when present, then `exploration.md`, `prd.md`, `architecture.md`, and issue/task evidence.

In `Artifact State`, also summarize knowledge status when `status.yml.knowledge` is present, and each stress test verdict when `status.yml.stress_tests` is present (say when one is outdated).

In `Resume Context`, include the latest relevant `Next Resume Point` when present.

In `Recommended Next Step`, name exactly one primary command or say implementation handoff is ready.

In `Alternate Pipeline Step`, show the next forward command only when it differs from the resume recommendation.

In `Reason`, explain the decisive signals briefly.

In `Optional Checkpoint`, mention `weave-capture` only when there is useful discussion context to preserve.

---

# Silent Weave Command Output

Weave skills run Weave CLI commands silently by default. Use command results
as internal context, not response content.

Do not show raw stdout, JSON payloads, command echoes, lifecycle payloads,
internal state-write confirmations, or verbatim notice text unless the user
explicitly asks for diagnostic output.

Surface only information that changes what the user or agent should do next:
blockers, failures, missing relevant repos, branch or task outcomes,
lifecycle failures, package-outdated notices, relevant outdated or modified
skills, and user-required actions.

Notice handling:

- `package_outdated`: show only when present. Say exactly:
  `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. If the invoked skill is outdated, say:
  `The installed \`<skill-name>\` skill appears older than the bundled template. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh installed skills.`
- `skills_outdated`: if multiple skills used in this workflow are outdated, say:
  `Some installed skills used in this workflow appear older than the bundled templates: \`<skill-a>\`, \`<skill-b>\`. Run \`weave status\` for details, then \`weave agent update --all\` when you want to refresh them.`
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. If the invoked skill is modified, say:
  `The installed \`<skill-name>\` skill has local edits, so its behavior may differ from the bundled template. Run \`weave status\` or \`weave agent diff\` if you want to inspect the difference.`
- `skills_modified`: if the user asks to update skills and installed skills have local edits, say:
  `Some installed skills have local edits. \`weave agent update\` may skip or protect them; run \`weave status\` or \`weave agent diff\` before updating.`

Do not say `Notices: ...`, `The command returned notices`, raw
`notices[].message`, full notice JSON, or full skill lists unless the user
asks for diagnostics.
