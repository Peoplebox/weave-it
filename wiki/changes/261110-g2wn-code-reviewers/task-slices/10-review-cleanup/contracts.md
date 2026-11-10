# Contracts: Clean up snapshot refs and packages for finished changes

See `architecture/index.md` (Packages, snapshots and cleanup), `architecture/api-contract.md` (`weave review prune`, Consumers), and decisions `261110-wdfo`, `261108-4ko1` (background refresh), `261108-kl3n` (only fully `landed` is safe to delete).

## Interfaces

- `weave review prune [--change <id>] [--json]` → `{status: "ok", pruned: [{change, reason: "landed" | "missing", refs_deleted: {<repo>: n}, packages_deleted: boolean}], kept: [{change, reason}]}`.
- `src/lib/review/prune.ts`: `pruneReviews(mainRoot, opts: { change?: string; facts?: GatherResult }): Promise<PruneResult>`. When `facts` is passed (from the refresh), it reuses those landed results instead of recomputing.

## Data

- Candidates: change ids found under `refs/weave/reviews/*` in any registered repo (`git for-each-ref --format=%(refname) refs/weave/reviews/`).
- "No longer exists": not among the local change ids (`listLocalChangeIds`), no `wiki/changes/<id>/` in the main checkout, and no `change/<id>` branch locally or under `refs/weave/remotes/origin/`.
- Deletion: `git update-ref -d` for each ref under the prefix (or one `update-ref --stdin` transaction). Packages: `<change checkout>/.weave/tmp/reviews/<id>/` when that folder exists.

## State

- The refresh calls `pruneReviews` after `gatherFacts` inside `runRefresh`, inside a `try` that ignores errors, like the existing attention snapshot write.
- Prune never touches `refs/weave/remotes/*`, `refs/heads/*`, or anything under `wiki/changes/`.

## Validation and errors

- Unknown `--change` id with no refs → `status: "ok"` with empty lists.
- Git failures per repo are reported in `kept` with `reason: "error"` and the message; prune continues with other repos.

## Files and artifacts

- New: `src/lib/review/prune.ts`, `tests/review-prune.test.ts`.
- Modified: `src/commands/review.ts` (`prune`), `src/lib/change-refresh.ts` (call after facts), `tests/change-refresh.test.ts`.
