---
name: weave-knowledge
description: Update the repo's current-state knowledge specs under wiki/knowledge and record the change-local knowledge delta for the active Weave change, so the wiki describes how the product works once the change lands. Use after implementation, or when the user asks to update the knowledge base, wiki, or docs for a change. Not for change planning artifacts such as the PRD or architecture.
license: MIT
compatibility: Requires the weave CLI (npm package @weave-tools/weave-it) on PATH, run inside a git repo or workspace initialised with weave init.
metadata:
  author: weave-tools
  last_changed_in: "0.1.0"
---

# Weave Knowledge

Use this skill when the user wants to update the knowledge base after a completed change, bug fix, feature addition, removal, or behavior clarification.

Knowledge is current-state behavior. Historical provenance stays in `wiki/changes/**`.

# Behavior Rules

- Do not require Plan Mode.
- Do not create a new change unless the user explicitly asks for one.
- Do not hand-edit `status.yml`; use `weave change knowledge <status>`.
- Do not store raw transcripts.
- Do not silently move, rename, delete, or reorganize existing user-authored knowledge files.
- You may create missing standard folders and files when they are needed for the active knowledge update.
- Prefer current behavior over historical narrative.
- Keep source anchors specific enough for a future agent to verify behavior in code or tests.

# Resolve Context

Start by discovering the current Weave session and active change:

```bash
weave workspace --json
weave change current --json
weave change status --json
```

If no active change exists, stop and say:

```text
No active Weave change found. Knowledge updates normally need change provenance. Start or switch a change, then run `weave-knowledge` again.
```

# Read Context

For each active-change target, read:

```text
wiki/changes/<change-id>/status.yml
wiki/changes/<change-id>/exploration.md
wiki/changes/<change-id>/prd.md
wiki/changes/<change-id>/architecture.md
wiki/changes/<change-id>/architecture/index.md
wiki/changes/<change-id>/architecture/*.md
wiki/changes/<change-id>/tasks.md
wiki/changes/<change-id>/sessions/*.md
```

Architecture may be legacy file mode or folder mode. If `architecture/` exists, read `architecture/index.md` and direct child facet files as architecture context. If both `architecture.md` and `architecture/` exist, report the conflict and avoid treating either as the sole canonical architecture source.

Read relevant knowledge files when present:

```text
wiki/knowledge/index.md
wiki/knowledge/README.md
wiki/knowledge/domains/**/index.md
wiki/knowledge/domains/**/features/**/behavior.md
wiki/knowledge/domains/**/domain-wide/**
wiki/knowledge/shared/**/behavior.md
wiki/knowledge/**/source-map.md
```

Inspect source anchors, tests, config, jobs, and integrations only as needed to ground the behavior.

# Target Selection

Use `domains/` for product or system areas that users naturally name.

Use `features/` for independently understandable behavior inside a domain.

Use `domain-wide/` for behavior that coordinates multiple features inside one domain.

Use `shared/` for behavior reused across multiple domains.

If multiple targets are plausible, summarize the candidates and ask the user to choose before writing.

# Templates

Use the structures defined in `knowledge-templates.md` (sibling to this `SKILL.md`).

The template reference lives at `<agent-skills-dir>/weave-knowledge/knowledge-templates.md` after install. Read it as the canonical knowledge file structure when creating or revising knowledge artifacts. If the user has modified the template reference, follow the user's modified structures.

# Write Knowledge

Create or update:

```text
wiki/changes/<change-id>/knowledge-delta.md
wiki/knowledge/**
```

When there is durable behavior impact:

- update current-state specs under `wiki/knowledge/**`
- create or update `knowledge-delta.md`
- call `weave change knowledge updated`

Example:

```bash
weave change knowledge updated --domain performance-reviews --shared approvals --file wiki/knowledge/domains/performance-reviews/domain-wide/approvals.md --delta wiki/changes/<change-id>/knowledge-delta.md --reason "Updated current review approval behavior." --json
```

When there is no durable knowledge impact:

- write a no-impact rationale in `knowledge-delta.md`
- call `weave change knowledge none --delta wiki/changes/<change-id>/knowledge-delta.md --reason "<reason>" --json`

When knowledge impact cannot be resolved yet:

- explain the blocker
- call `weave change knowledge pending --reason "<reason>" --json` when useful

# Completion Response

Report:

```text
Knowledge delta: wiki/changes/<change-id>/knowledge-delta.md
Knowledge files updated: <files or none>
Knowledge status: <pending|stale|updated|none>
```

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
