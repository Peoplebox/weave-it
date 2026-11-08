# Contracts: Change states in weave change list

## Interfaces

- **CLI:** `weave change list [--all] [--json]`. `--fetch` is added in slice 04.
- **Text and JSON:** exactly as in `../../architecture/api-contract.md` "`weave change list`", minus `freshness` (slice 04 adds it; until then `freshness` is `{ "refreshing": false, "as_of": null }`).

```ts
// src/lib/change-facts.ts
export function gatherFacts(root: ResolvedRoot, opts: { inlineBudgetMs: number; now: Date }): Promise<ChangeFacts[]>;
// src/lib/change-states.ts (pure, no I/O)
export function deriveStates(facts: ChangeFacts[]): ChangeView[];
export function attentionCounts(views: ChangeView[]): { total: number; counts: Record<string, number> };
```

## Data

- `changes/<id>.yml` gains optional `repos: [<repo-id>]`.
- `attention.json` with `facts_at` (`../../architecture/schema.md`).

## State

- Precedence is folder missing → landed with newer commits → landed → in progress. Closed and done apply only without a folder.
- `needs_attention` is true only for `landed` and `folder_missing`.
- `attention.json` is replaced only when the writer's `facts_at` is newer.

## Validation and errors

- `next.commands` contain only `weave change close|switch <validated id>`.
- The landed check is wrapped so that one change's failure gives `couldnt_check` and never fails the list.

## Files and artifacts

- New: `src/lib/change-facts.ts`, `src/lib/change-states.ts`.
- Modified: `src/lib/git.ts` (`listGitWorktrees`), `src/lib/changes.ts` (`listChanges`, `formatListMessage`, `ChangeSummary` extension), `src/lib/worktrees.ts` (`repos` field), `src/commands/change.ts`.
