# CLI Distribution

This domain captures how `weave-it` (the npm package) and its bundled agent skills are versioned, drift-checked, and surfaced to two distinct audiences:

- Human developers running `weave` in a terminal.
- AI agents (Claude, Cursor, Codex, opencode) invoking `weave` programmatically through installed Weave skills.

The package version (`package.json.version`) and per-skill version (`SKILL.md` frontmatter field `metadata.last_changed_in`) evolve together but are reported independently. Staleness is detected for two cases without performing automatic upgrades: a newer `weave-it` on the npm registry, and per-repo skill drift (`outdated`, `modified`, `modified+outdated`, `missing`).

## Features

- [notices](features/notices/behavior.md): structured staleness messages surfaced through a stable `--json notices` array on Tier 1 commands, a one-line interactive stderr footer, and the `# Silent Weave Command Output` skill contract.
- [skill-resources](features/skill-resources/behavior.md): direct child resource files installed beside skills, including template resources and user-modification preservation.
- [skill-versioning](features/skill-versioning/behavior.md): the `last_changed_in` frontmatter contract, the `.weave/agents.yml installed_from` manifest field, and the release script that maintains them.
- [weave-status](features/weave-status/behavior.md): the read-only top-level `weave status` command, the canonical detailed view of package version, skill drift, and notices.

## Glossary

- **Package version**: the published `weave-it` npm version (single number per release, e.g., `0.1.0`).
- **Skill version**: the package version in which a given `SKILL.md` last meaningfully changed. Recorded as `last_changed_in: <package-version>` in the YAML frontmatter.
- **installed_from**: the package version that was bundling the skill at the time it was installed into this repo. Recorded per skill in `.weave/agents.yml`.
- **Skill drift**: a per-repo, per-skill condition where the installed copy does not match what the currently installed package bundles. Sub-states: `outdated` (installed_from != current last_changed_in, content otherwise unmodified), `modified` (disk hash != manifest installed_hash), `modified+outdated` (both), `missing` (manifest entry exists, file deleted), `current` (no drift).
- **Skill resource**: a managed direct child file beside `SKILL.md`, such as `prd-template.md`, `knowledge-templates.md`, or an architecture `*-template.md`.
- **Notice**: a single staleness message with `kind` and `message` (and an optional `details` payload). v1 kinds: `package_outdated`, `skills_modified`, `skills_outdated`.
- **Tier 1 commands**: the five commands that emit notices: `weave workspace`, `weave change current`, `weave change status`, `weave change new`, `weave status`. Non-Tier-1 commands never include `notices` in their `--json` output.
- **Skill contract block**: a byte-identical prose section embedded in shipped `SKILL.md` files. Current examples include `# Silent Weave Command Output` (all skills) and `# Lifecycle Staleness Verification` (progress-calling skills).

## Source Map

See each feature's own `Source Anchors`. The domain does not yet have a top-level `source-map.md`.
