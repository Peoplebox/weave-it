# Notices

## Purpose

Surface package and skill staleness, and bundled skills that are not installed, to both human developers and AI agents in a single structured shape that travels through the same commands without corrupting machine-readable output.

## Current Behavior

Six Tier 1 commands compute notices in parallel with their normal work and return them in two channels:

- `--json` output gains a top-level `notices` array (always present, possibly empty).
- Non-JSON interactive output prints a one-line summary footer to **stderr** after the normal stdout body, only when stdout is a TTY and no opt-out is set.

Non-Tier-1 commands do not gain a `notices` field; their `--json` shape is unchanged.

Notices are computed from local manifest state plus a cached npm registry lookup. All sources degrade silently on failure: network error → no `package_outdated` notice; unreadable `~/.weave/cache/` → cache treated as cold; corrupted manifest entry → entry ignored; missing `templates/` for the bundled `last_changed_in` lookup → that skill is skipped.

## Notice Kinds

| kind               | trigger                                                                                                  | message shape                                                                                                       | details payload                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `package_outdated` | cached npm latest > installed `weave-it` package version                                                 | `weave-it <latest> is available (installed <installed>). Run 'weave status' for details.`                           | `{installed, latest}`                                    |
| `skills_modified`  | one or more installed `SKILL.md` files have a disk hash that differs from the manifest `installed_hash`  | `<N> installed skill file(s) have been modified locally. Run 'weave status' for details.`                           | `{skills: [{agent, name, kind}]}`                        |
| `skills_outdated`  | one or more installed skills' `installed_from` differs from the currently bundled `last_changed_in`      | `<N> installed skill file(s) are out of date. Run 'weave agent update --all' or 'weave status' for details.`        | `{skills: [{agent, name, kind, installed_from, current}]}` |
| `skills_available` | a configured agent (one whose manifest entry already holds skills) lacks one or more bundled skills     | `Bundled skills not installed for <agent>: <skill>, ...[; <agent>: ...]. Run 'weave agent install <agent>'[ and ...] to add them.` | `{agents: {<agent>: [<skill>, ...]}}`                    |

`skills_modified` wins over `skills_outdated` for the same skill: if the disk file was edited, the skill is reported as `modified` and `skills_outdated` is suppressed for that entry.

`skills_available` is one notice for all agents, listing missing skills per agent in sorted order. It is not emitted without a manifest, for an agent with no installed skills, or when every configured agent has every bundled skill. It exists because `weave agent update` never installs new skills, so a newly bundled skill (such as `weave-review`) would otherwise go unnoticed.

## Tier 1 Commands

The notice contract applies to exactly these six commands:

- `weave workspace`
- `weave change current`
- `weave change status`
- `weave change new`
- `weave status`
- `weave doctor`

All six share the same implementation path: a `withNotices()` helper wraps the action, computes notices in parallel, and merges them into the rendered output. Adding another Tier 1 command is a deliberate change; the rest of the CLI stays notice-free to keep `--json` payloads stable.

## Footer Suppression Rules

The interactive stderr footer is **only** emitted when ALL of these hold:

- `notices.length > 0`
- `process.stdout.isTTY` is true
- `WEAVE_NO_NOTICES` is not `"1"`
- `CI` env var is unset, empty, `"false"`, or `"0"`

`--json` output is never affected by these checks (other than the explicit `WEAVE_NO_NOTICES=1` opt-out, which short-circuits notice computation to `[]`).

## Opt-Out

Two equivalent environment variables suppress all notice work:

- `NO_UPDATE_NOTIFIER=1` (standard convention)
- `WEAVE_NO_NOTICES=1` (Weave-specific)

When either is set:

- The npm registry check is skipped entirely (no fetch, no cache write).
- `gatherNotices()` returns `[]` before any drift detection runs.
- The footer is not rendered.

## Skill Contract: `# Silent Weave Command Output`

Every bundled `SKILL.md` contains a byte-identical `# Silent Weave Command Output` section. The block tells agents to treat Weave CLI command output as internal context by default and to avoid showing raw stdout, JSON payloads, command echoes, lifecycle payloads, internal state-write confirmations, or verbatim notice text unless the user explicitly asks for diagnostic output.

Skills surface only information that changes what the user or agent should do next: blockers, failures, missing relevant repos, branch or task outcomes, lifecycle failures, package-outdated notices, relevant outdated or modified skills, and user-required actions.

Notice handling in skill responses is intentionally not the same as the raw CLI notice message:

- `package_outdated`: show only when present, with the user-facing copy `A newer Weave version is available. Run \`weave status\` for details, then upgrade Weave when convenient.`
- `skills_outdated`: suppress unrelated skills. Mention only the invoked skill or multiple skills used in the current workflow, with user-facing copy that points to `weave status` and `weave agent update --all`.
- `skills_modified`: suppress unless the invoked skill is modified locally or the user is asking about skill updates. Mention local edits with user-facing copy that points to `weave status` or `weave agent diff`.
- `skills_available`: `weave-execute`, `weave-next`, and `weave-review` carry an extra rule after the shared block: suppress it unless `weave-review` is one of the missing skills, then say `Code reviews are available but the \`weave-review\` skill is not installed for <agent>. Run \`weave agent install <agent>\` to add it.` Other skills carry no rule for it, and the shared block does not name it.

Skills should not say `Notices: ...`, `The command returned notices`, raw `notices[].message`, full notice JSON, or full skill lists unless the user asks for diagnostics.

Byte identity is enforced by a test against `EXPECTED_SILENT_COMMAND_OUTPUT` in `src/lib/skill-template-checks.ts`. The same tests assert that shipped skills no longer contain `# Surface Weave Notices` or instructions to surface notices verbatim.

## Concurrency And Performance

Notice gathering runs in `Promise.all` with the wrapped command's main action. The npm registry check has a 3-second `AbortController` timeout; if it does not return in time, the in-flight request is aborted and notices for that call use whatever the cache already had (possibly `null`).

The npm cache file lives at `~/.weave/cache/npm-version.json` and has a 24-hour TTL. A stale (or absent) cache schedules a background fetch; the current invocation does not block on the network.

## Source Anchors

- Notice types and gathering: `src/lib/notices.ts` (`gatherNotices`, `detectSkillDrift`, `detectAvailableSkills`, `isNewerVersion`)
- npm version check + cache: `src/lib/npm-version.ts` (`getNpmVersionInfo`)
- Tier 1 wiring: `src/lib/with-notices.ts` (`withNotices`)
- Tier 1 commands: `src/commands/workspace.ts`, `src/commands/status.ts`, `src/commands/doctor.ts`, `src/commands/change.ts` (`new`, `current`, `status` subcommands)
- Skill contract source: `EXPECTED_SILENT_COMMAND_OUTPUT` in `src/lib/skill-template-checks.ts`
- Templates: `templates/skills/<name>/SKILL.md` (every shipped skill carries the block)
- Tests: `tests/notices.test.ts`, `tests/with-notices.test.ts`, `tests/cli-status.test.ts`, `tests/cli-tier1-notices.test.ts`, `tests/agent-skills.test.ts` (byte-identity and old-notice-guidance absence)

## Change History

- 2026-06-03 (change `260603-piln-npm-and-skill-versioning-and-updates`): notices introduced; Tier 1 set of five commands defined; `--json notices` contract and stderr footer rules established; `WEAVE_NO_NOTICES` and `NO_UPDATE_NOTIFIER` opt-outs added; `# Surface Weave Notices` byte-identical block embedded in all 10 bundled skills.
- 2026-06-07 (change `260607-1mo4-fixes-around-existing-commands`): bundled skills replaced `# Surface Weave Notices` with `# Silent Weave Command Output`; Tier 1 command JSON notices remain available for automation, but skills now suppress raw command output and summarize only user-relevant notices or blockers.
- 2026-06-07 (change `260607-vuwa-architecture-skill-update`): `weave doctor` became the sixth Tier 1 command and includes notices in `--json` output through `withNotices()`.
- 2026-11-10 (change `261110-g2wn-code-reviewers`): added the `skills_available` notice kind for bundled skills a configured agent has not installed.

## Open Questions

- Resolved: a brand-new bundled skill is announced by the separate `skills_available` notice kind rather than rolled into `skills_outdated`.
