# Contracts: Background remote refresh and freshness

## Interfaces

- `weave change list --fetch`.
- Hidden `weave change refresh --root <path>`: always exits 0 and records results in `refresh.json`.

```ts
// src/lib/change-refresh.ts
export function maybeSpawnRefresh(root: ResolvedRoot, now: Date): Promise<{ spawned: boolean; running: boolean }>;
export function runRefresh(root: ResolvedRoot, opts: { timeoutMs: number; now: () => Date }): Promise<RefreshRecord>;
export function joinOrRunRefresh(root: ResolvedRoot, opts): Promise<{ finished: boolean }>;
// src/lib/git.ts
export function lsRemoteHeads(repo: string, opts): Promise<Set<string> | FetchFailure>;
export function fetchNoPrompt(repo: string, opts: { refspecs: string[]; timeoutMs: number }): Promise<FetchResult>;
```

## Data

- `refresh.json` (with `seen` and `absent`) and the `refs/weave/remotes/origin/*` namespace, exactly as in `../../architecture/schema.md`.

## State

- **Alive** means `running` is set, `kill(pid, 0)` succeeds, and the run is younger than `30 s × repos + 10 s`. Otherwise the run can be taken over.
- No spawn within 60 s of `last_started_at`.

## Validation and errors

- Auth classification comes from stderr, falling back to `error` with the raw message.
- `--fetch` that doesn't finish reports it in text and in `freshness`.

## Observability

- Per-repo `last_attempt_at`, `last_success_at`, `result`, and `message` in `refresh.json`, surfaced in the age line and `repos[].refresh`.
- Test seams: `WEAVE_NO_BACKGROUND_REFRESH=1`, and an injectable clock and timeout.
