# Skill Resources

## Purpose

Describe how non-`SKILL.md` files shipped beside a Weave skill are installed, tracked, updated, reset, and preserved.

## Current Behavior

Bundled skill resources are direct child files beside `templates/skills/<skill>/SKILL.md`. They are installed into the matching installed skill folder for each supported agent.

Examples:

- `templates/skills/weave-prd/prd-template.md`
- `templates/skills/weave-knowledge/knowledge-templates.md`
- `templates/skills/weave-architect/index-template.md`
- `templates/skills/weave-architect/schema-template.md`
- `templates/skills/weave-architect/api-contract-template.md`
- `templates/skills/weave-architect/frontend-backend-template.md`

Resource discovery is non-recursive. Nested folders under a skill directory are not managed resources in v1.

## Domain Model

`.weave/agents.yml` records resources separately from skills:

```yaml
installed:
  claude:
    resources:
      weave-architect/index-template.md:
        path: .claude/skills/weave-architect/index-template.md
        source_hash: sha256:...
        installed_hash: sha256:...
        installed_at: 2026-06-06T18:25:42.468Z
        installed_from: 0.1.0
```

The resource key is `<skill>/<resource-file>`.

## Behavioral Rules

- `weave agent install <agent>` installs missing resources and records manifest entries.
- `weave agent update <agent>` updates resources only when the installed file still matches the prior manifest hash.
- User-modified resources are preserved during install and update; the operation reports them as `modified`.
- `weave agent reset <agent> [skill]` overwrites managed resources from bundled defaults and refreshes the manifest.
- `weave agent diff <agent> [skill]` includes resource diffs as `resource:<skill>/<resource-file>`.
- Resource filenames are validated by the same direct child resource naming rules used by the installer.

## Sub-Agents

Bundled sub-agents live in `templates/agents/<name>.md` (frontmatter `name`, `description`, `tools`). For Claude Code they install to `.claude/agents/<name>.md` and are tracked under `agents` in `.weave/agents.yml` with the same install, update, diff, and reset protection as skills; other agents do not receive them. Current sub-agents: `weave-locator`, `weave-analyzer`, `weave-pattern-finder`, `weave-web-researcher`, and `weave-challenger`, all limited to read-only tools.

New resources include `weave-questions/questions-template.md`, `weave-research/research-template.md`, `weave-explore/shape-template.md`, and `weave-clarify/target-rules.md`.

## Architecture Template Resources

Architecture templates are skill resources under `weave-architect/`, not files nested under `weave-architect/templates/`.

The bundled architecture template resources are:

- `index-template.md`
- `schema-template.md`
- `api-contract-template.md`
- `frontend-backend-template.md`

Each template has frontmatter with `facet` and `description`. Users can add custom direct child files such as `cache-strategy-template.md` to installed skill folders without editing `SKILL.md`; modified or user-owned resource files are preserved by the normal install/update behavior.

## Source Anchors

- Resource discovery and operations: `src/lib/agent-skills.ts` (`listDefaultSkillResources`, `installArtifact`, `updateArtifact`, `resetArtifact`, `diffAgentSkills`)
- Bundled resources: `templates/skills/weave-prd/prd-template.md`, `templates/skills/weave-knowledge/knowledge-templates.md`, `templates/skills/weave-architect/*-template.md`
- Manifest: `.weave/agents.yml`
- Tests: `tests/agent-skills.test.ts`

## Change History

- 2026-06-05 (change `260605-wohe-customizable-prd-template`): established direct child PRD template resources.
- 2026-06-06 (change `260606-k0l6-architecture-folder`): added direct child architecture template resources and tests covering install, update, reset, diff, and user modification preservation.
- 2026-10-20 (branch `change/questions-research-skills`): added sub-agent templates installed to `.claude/agents/`, and new skill resources for questions, research, the product shape, and clarify target rules; the architecture index template gained Options Considered and Slices Readiness.

## Open Questions

- Whether future resource support should allow nested managed folders. v1 resource discovery is direct-child only.
