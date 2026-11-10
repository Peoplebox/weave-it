# Contracts: Fix rounds with reversible patches and fix checks

See `architecture/index.md` (Slice flow step 5, Resolving a plan problem), `architecture/schema.md` (Refs, Readable records, Resolution), `architecture/api-contract.md` (`snapshot --at round-start`, `package --fix-round`, fix-check report schema), and decision `261110-wdfo`.

## Interfaces

- `weave review snapshot --run <run> --at round-start --round <n> [--json]` → `{refs: {<repo>: <ref>}, merge_base}`.
- `weave review package --run <run> --fix-round <n> [--out <path>] [--json]` →
  `{run_id, round: n, package_path, patch_path, model_level: "cheap-mid", size_hint, files_touched: {<repo>: string[]}}`.
- `weave review package --run <run> [--json]` on a resumable run → `{run_id, resume_round: n}`; on any other run → `run_not_resumable`.
- `weave review record --run <run> --report -`: a JSON block with `checks` (and optional `new_findings`) is treated as the fix-check report for the latest round that has a package and no check yet.
- `weave review record --run <run> --resolve <finding> --as fixed --round <n> [--json]`.

## Data

- Refs: `refs/weave/reviews/<change>/<slice>/<rN>/round<N>-start` and `round<N>-end`, per slice repo.
- Patch: `task-slices/<slice>/review/r<N>-round<N>.patch`, built with `ReviewBoundary.patch` (binary-safe, excluded paths never included). In workspace mode, one patch section per repo, each headed with the repo id and its apply path.
- Round package: `<checkout>/.weave/tmp/reviews/<change>/<slice>/r<N>-round<N>.package.md` with the round diff, the findings the round set out to fix (open Critical and Important ids with detail), and the relevant guideline files.
- Check record: `task-slices/<slice>/review/r<N>-round<N>.check.md` (verbatim) and the round's `checks` merged into `r<N>.findings.json` under `rounds[]`.
- Fixed resolution: `{as: fixed, round, patch, files: string[], needs_your_check: boolean}`.

## State

- Rounds are numbered from 1 per run. `round-start` for round N requires round N-1 to have an end (or N = 1).
- `checks[].result: not_addressed` leaves the finding open.
- `new_findings` from a checker are stored with `source: fix_check, round: N`; their `kind` and `severity` are frozen like any other finding.
- Resumable run: state `in_review` after a `dismissed` plan finding, with open code findings; `resume_round` = last round + 1.

## Validation and errors

- `round_not_started`, `round_already_started` (round-start twice without `--force`), `round_not_found` (on `--as fixed`), `run_not_resumable`: exit 1.
- A fix-check report fails validation with exit 4 like any other report.

## Files and artifacts

- New: `tests/cli-review-fix-rounds.test.ts`.
- Modified: `src/commands/review.ts`, `src/lib/review/package.ts` (round package), `src/lib/review/record.ts` (fix-check schema, `fixed`, Fixes section, needs-your-check), `src/lib/review/boundary.ts` (round ref names, if not already generic), `tests/review-record.test.ts`.
