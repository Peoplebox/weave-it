# Contracts: Snapshot boundaries and the diff base

See `architecture/index.md` (Diff base; Packages, snapshots and cleanup), `architecture/schema.md` § Refs, `architecture/api-contract.md` § `weave review snapshot`, and decision `261110-wdfo`.

## Interfaces

- `src/lib/review/base.ts`:
  - `resolveDiffBase(input: { repoPath; repoId; changeStatus; mainRoot }): Promise<{ sha?: string; source: "merge_base" | "base_commit" | "unknown"; target?: string }>`.
  - Target resolution reuses `landed.ts` (`targetBranchName`, the private `resolveTarget`, exported for reuse, and `resolveDefaultBase`) and the recorded starting branch from `change-bases.ts`.
  - `filesBetween(repoPath, oldBase, newBase): Promise<string[]>`.
- `src/lib/review/boundary.ts`:

  ```ts
  interface ReviewBoundary {
    create(input: { repoPath; ref: string; mergeBase?: string; force?: boolean }): Promise<{ ref; sha; mergeBase?: string; created: boolean }>;
    read(repoPath, ref): Promise<{ sha; mergeBase?: string } | undefined>;
    diff(repoPath, from: string, to: string, opts: { context: number; exclude: string[] }): Promise<string>;
    diffStat(repoPath, from, to, opts): Promise<{ files: number; lines: number; paths: string[] }>;
    patch(repoPath, from, to, opts): Promise<string>;   // binary-safe, reversible with git apply -R
  }
  ```

  `from` may be a ref or a commit sha (the diff base). `SnapshotBoundary` implements it. A future commit-based implementation can replace it without skill changes.
- `weave review snapshot --slice <id> --at start [--force] [--json]` → `{status: "ok", refs: {<repo>: <ref>}, merge_base: {<repo>: <sha | null>}, created: {<repo>: boolean}}`.

## Data

- Ref: `refs/weave/reviews/<change>/<slice>/start`, one per repo in the slice's `repos[]` (or `root` in repo mode).
- Snapshot commit: parentless, tree from the temporary index, message `weave review snapshot\n\nmerge-base: <sha|unknown>`.
- Slice `review.start_ref` = the ref name. Written through `updateSliceReview` from slice 01.
- Temporary index: `<local state dir>/review-index-<pid>-<random>`, removed in `finally`.

## State

- Idempotent: an existing start ref is kept unless `--force`.
- Snapshots never run `checkout`, `reset`, `stash`, `add` against the real index, or anything else that touches HEAD or the index.
- The command adopts the change on first contact (slice 01 `adoptChange`).

## Validation and errors

- Unknown slice → `slice_not_found`. Flat mode → `no_slices`.
- A slice repo that is not checked out locally → reported in `refs` as `null` with a `missing_repos` list. The command still succeeds for the repos it can snapshot.
- Git failures → `snapshot_failed` with the git stderr in `details`, and the temporary index is still removed.

## Files and artifacts

- New: `src/lib/review/base.ts`, `src/lib/review/boundary.ts`, `tests/review-base.test.ts`, `tests/review-boundary.test.ts`, `tests/cli-review-snapshot.test.ts`.
- Modified: `src/lib/landed.ts` (export the target resolver only), `src/commands/review.ts` (add `snapshot`).
