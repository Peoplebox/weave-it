# Contracts: weave settings open

## Interfaces

- `weave settings open [--in <place>] [--agent <agent>] [--clear] [--project] [--json]`
- JSON: `{ status: "ok", scope: "default" | "project", project?: <main checkout>, saved?: Choice, cleared?: true, current: { default?, project? }, choices }`

## Data

- Writes `open.default` or `open.projects[<main checkout realpath>]` through `user-settings.ts`.

## State

- Never calls `openChange` or any `open()`.
- `--clear` together with `--in` → a usage error.

## Validation and errors

- `unknown_place`, `unknown_agent`, `agent_not_for_app` (same codes as `change open`).
- `--project` outside a Weave project → `no_weave_context`.

## Files and artifacts

- New: `src/commands/settings.ts`, `tests/cli-settings.test.ts`.
- Modified: `src/cli.ts`.
