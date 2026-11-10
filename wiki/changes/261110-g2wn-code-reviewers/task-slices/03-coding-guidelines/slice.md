# Coding guidelines files and seeding

## Outcome

Teams have a place to write their coding standards. A new workspace gets a starter `.weave/coding-guidelines.md` from `weave init`. Existing projects get it only when they run `weave review guidelines init`. Each registered repo may have its own `.weave/coding-guidelines.md`. The CLI can resolve, for a set of repos, which guideline files apply and whether each is present or absent, which the review package uses in slice 04.

## User flow

1. A team runs `weave init` in a new project. `.weave/coding-guidelines.md` appears with starter sections the team owns.
2. In an existing project, `weave change new`, `weave doctor`, and `weave agent update` write nothing new.
3. The team runs `weave review guidelines init` and gets the starter file. Running it again changes nothing.
4. In a workspace, `weave review guidelines init --repo api` writes an empty `.weave/coding-guidelines.md` in the `api` repo, only if it is absent.

## In scope

- `src/lib/review/guidelines.ts`: path resolution (shared file at the workspace root, repo file at each repo root, read from the change's own checkout folder, the two paths collapsing to one file in repo mode, `absent` files, missing repo checkouts) and the starter template text.
- `weave review guidelines init [--repo <id>] [--json]`.
- `weave init` seeding in `src/lib/init-workspace.ts` only (not in `ensureWeaveScaffold`, which `weave change new`, `weave doctor`, and `weave add` also call).

## Out of scope

- Using the resolved files in a package (slice 04).
- Ruling basis hashes of guideline files (slice 05).
- Merging shared and repo rules. The reviewer applies precedence by judgement (decision `261110-dtld`).

## Acceptance criteria

- [ ] `weave init` in a new project writes the starter shared file. Re-running `weave init` leaves an edited file untouched.
- [ ] `weave change new`, `weave doctor`, `weave add`, and `weave agent update` never create the file in an existing project.
- [ ] `weave review guidelines init` writes the starter only when absent and reports `created` or `unchanged`.
- [ ] `--repo <id>` writes an empty repo file in that repo only when absent, and rejects an unknown repo id.
- [ ] Resolution in repo mode returns one file; in workspace mode it returns the shared file plus one entry per repo, each `present` or `absent`, and flags repos whose checkout is missing.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
