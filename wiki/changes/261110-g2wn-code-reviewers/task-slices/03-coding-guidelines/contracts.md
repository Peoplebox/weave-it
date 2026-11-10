# Contracts: Coding guidelines files and seeding

See `architecture/index.md` (Guidelines, Seeding guidelines), `architecture/api-contract.md` § `weave review guidelines init`, and decision `261110-dtld`.

## Interfaces

- `src/lib/review/guidelines.ts`:
  - `resolveGuidelines(input: { checkoutRoot: string; mode: "repo" | "workspace"; repos: Array<{ id; path?: string }> }): Promise<GuidelineResolution>`

    ```ts
    type GuidelineResolution = {
      files: Array<{ scope: "shared" | "repo"; repo?: string; path: string; status: "present" | "absent" }>;
      missingRepos: string[];   // repo checkout not available locally -> package is partial
    };
    ```

    Paths are relative to the change's checkout folder. In repo mode the shared and repo paths are the same file and it is listed once with `scope: "shared"`.
  - `starterGuidelines(): string`: the starter shared file text.
  - `writeGuidelinesIfMissing(target): Promise<"created" | "unchanged">`.
- `weave review guidelines init [--repo <id>] [--json]` → `{status: "ok", path, result: "created" | "unchanged"}`.

## Data

- Shared file: `<workspace root>/.weave/coding-guidelines.md`.
- Repo file: `<repo root>/.weave/coding-guidelines.md`. Created empty apart from a one-line heading, so the team fills it.
- Starter content: short team-owned sections (error handling, security, testing expectations, naming and structure, documentation), each with one or two example rules, and a note that repo files win on conflict. It states rules in Weave's own words.

## State

- Never overwrite an existing file. `weave agent update` and every other command except `weave init` and `weave review guidelines init` never write it.

## Validation and errors

- `--repo` in repo mode → `invalid_arguments` (repo mode has one file).
- Unknown repo id → `repo_not_found`.
- A repo whose checkout is missing → `repo_missing`.

## Files and artifacts

- New: `src/lib/review/guidelines.ts`, `tests/review-guidelines.test.ts`, `tests/cli-review-guidelines.test.ts`.
- Modified: `src/lib/init-workspace.ts`, `src/commands/review.ts` (add `guidelines init`), `tests/init.test.ts`.
