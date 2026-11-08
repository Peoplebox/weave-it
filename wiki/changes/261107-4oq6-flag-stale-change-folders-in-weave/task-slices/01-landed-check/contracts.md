# Contracts: Shared landed check and starting-branch memory

## Interfaces

```ts
// src/lib/landed.ts
type LandedResult = "landed" | "landed_with_newer_commits" | "not_landed" | "no_commits" | "unchecked";
type LandedMethod = "merged" | "contained" | "rebased" | "squashed" | null;
interface LandedInput { repoPath: string; repoId: string; changeId: string; tip: string;
  base: { ref: string | null; commit: string | null; source: "created" | "reflog" | "unknown" };
  defaultBranch: string; hasOrigin: boolean; goneTargets?: Set<string>; }
interface LandedOutcome { result: LandedResult; method: LandedMethod; reason: string | null;
  target: { branch: string; ref: string; sha: string } | null; localViewOlder: boolean; cached: boolean; }
export function checkLanded(input: LandedInput, opts?: { cache?: LandedCache }): Promise<LandedOutcome>;

// src/lib/change-bases.ts (or inside landed.ts)
export function readBase(gitCommonDir, changeId, repoId): Promise<BaseRecord | null>;
export function writeBase(gitCommonDir, changeId, repoId, rec): Promise<void>;   // under withStateLock, atomic
export function recoverBase(...): Promise<BaseRecord>;                          // status.yml → reflog → unknown
```

## Data

- `bases/<id>.yml` and `landed.json`, exactly as in `../../architecture/schema.md`.
- `bases/` is never deleted by Weave.

## State

- The cache is a pure function of `(repo, tip, target sha, base_commit, git_caps)`.
- `unknown` base records are retried from `status.yml` when a folder appears, and the reflog is never re-read.

## Validation and errors

- Any git failure gives `unchecked` with a reason string. The library never throws for git errors.
- Reflog rejection rule: a value matching `^[0-9a-f]{7,40}$`, `HEAD`, `change/<id>`, or `origin/change/<id>` is rejected.

## Observability

- Test seam: `WEAVE_TEST_GIT_NO_MERGE_TREE=1` forces the pre-2.38 path.
