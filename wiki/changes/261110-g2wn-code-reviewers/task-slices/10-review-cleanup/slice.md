# Clean up snapshot refs and packages for finished changes

## Outcome

Snapshot refs and local review packages do not pile up forever. `weave review prune` deletes `refs/weave/reviews/<change>/` in every repo, and the change's local packages, for changes that have fully landed or no longer exist. Weave's background refresh runs it after its landed check. Closing a change does not prune, because closed changes can be reopened.

## User flow

1. Change A has landed (per the shared landed definition). Change B is still open. Change C's folder and branches are gone.
2. `weave review prune --json` reports refs and packages removed for A and C, and nothing for B.
3. `weave review prune --change B --json` removes nothing, because B has not landed and still exists.
4. On the next `weave change list`, the background refresh runs prune after its landed check, quietly.
5. `weave change close A` leaves A's review refs in place.

## In scope

- `src/lib/review/prune.ts`: decide which changes to prune, delete their refs per repo and their packages.
- `weave review prune [--change <id>] [--json]`.
- A call from `runRefresh` in `src/lib/change-refresh.ts` after facts are gathered, never failing the refresh.

## Out of scope

- A future `weave change discard` (it will call prune when it exists).
- Pruning on close (deliberately not done).

## Acceptance criteria

- [ ] Only changes whose landed result is exactly `landed`, or that no longer exist, are pruned; `landed_with_newer_commits`, `not_landed`, `no_commits`, and `unchecked` are kept.
- [ ] Prune deletes refs in every registered repo that has them and the change's package folder when its checkout folder still exists.
- [ ] `--change <id>` limits pruning to that change and still applies the same rule.
- [ ] The background refresh runs prune after its landed check, and a prune error never fails or slows the refresh beyond its existing timeouts.
- [ ] `weave change close` leaves review refs untouched.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
