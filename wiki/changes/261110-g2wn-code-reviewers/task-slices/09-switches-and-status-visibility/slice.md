# Review switches, status lines, and the reviews-available notice

## Outcome

People can see review progress and the verdict without reading files, turn review off for one change with a recorded reason, and learn that reviews exist. `weave change status` shows each slice's review state, the final review state, the verdict with parked-item count, rulings, out-of-date markers, and "review skipped". `weave status` shows a one-line review summary for the active change and a new `skills_available` notice naming bundled skills that a configured agent has not installed, with the command to install them. `weave review skip --reason` and `weave review unskip` record and clear a per-change skip.

## User flow

1. `weave change status` prints `review: slice 02 reviewed (1 ruling) · slice 03 waiting on you: plan problem · final: not started`.
2. After the final review it also prints `verdict: ready with parked items (4)`, and `out of date` markers where they apply.
3. For a docs-only change the person runs `weave review skip --reason "docs only"`. Status shows `review: skipped (docs only)`, `weave review status` returns `active: false`, and every slice shows `skipped`.
4. `weave review unskip` clears it.
5. In an existing project, `weave status` lists `[skills_available] Bundled skills not installed for claude: weave-review. Run 'weave agent install claude' to add them.`

## In scope

- `weave review skip --reason <text> [--json]` and `weave review unskip [--json]`.
- `skipped` effective state for every slice when the change is skipped or the workspace has review off.
- Review lines and a `review` object in `weave change status` text and JSON.
- A review summary line in `weave status` for the active change, when one resolves from the current folder.
- The `skills_available` notice kind.

## Out of scope

- Skill text that reacts to these (slice 11).
- Prune (slice 10).

## Acceptance criteria

- [ ] `skip` requires `--reason`, writes `review.skipped: {reason, at}` on the change, and `unskip` removes it.
- [ ] With the change skipped or the workspace off, slices read `skipped` and `active` is false; the gate passes only when the change is skipped.
- [ ] `weave change status` shows per-slice review states (including out of date with reason), the final review state, the verdict and parked count, the open rulings count, and "review skipped" with its reason.
- [ ] `weave change status --json` carries the same data under `review`.
- [ ] A change with no review data and review inactive shows no review lines, so existing output is unchanged.
- [ ] `weave status` shows `skills_available` when a bundled skill is missing from a configured agent's manifest, and not when all are installed or `WEAVE_NO_NOTICES=1`.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass.
