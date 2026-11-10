# Contracts: Slice review package

See `architecture/index.md` (Slice flow steps 1, Guidelines, Packages), `architecture/schema.md` (Local packages, Human checks), and `architecture/api-contract.md` § `weave review package`.

## Interfaces

- `weave review package --slice <id> [--partial] [--force] [--out <path>] [--json]` →

  ```text
  {status: "ok", run_id: "<slice>/r<N>", package_path, scope: {kind: "slice", slice},
   partial, fallback_base: null | "change_base" | "merge_base", foreign_files: n,
   model_level: "mid" | "most_capable", size_hint: {files, lines},
   settled_rulings: 0, reopened_rulings: 0, warnings: string[]}
  ```

  `settled_rulings` and `reopened_rulings` stay 0 until slice 07.
- `model_level`: `mid` for slice runs, raised to `most_capable` when `size_hint.lines` exceeds a threshold constant in `package.ts` (start at 1500 changed lines).
- `src/lib/review/package.ts`: `buildSlicePackage(ctx, sliceId, opts): Promise<PackageResult>`, `labelForeignFiles(paths, slice): { owned; foreign }`, `parseTaskEvidence(tasksMd): { untested: TaskRef[]; humanChecks: Array<{ task; step }>; evidence: Array<{ task; lines: string[] }> }`.

## Data

- Run id `<slice>/r<N>`, allocated under the change lock as one more than the highest `r<N>` seen in the slice's refs and `review/` folder.
- End ref per repo: `refs/weave/reviews/<change>/<slice>/r<N>/end`.
- Slice `review:` after packaging: `state: in_review`, `latest_run: r<N>`, `partial`, `updated_at`.
- Package file: `<checkout>/.weave/tmp/reviews/<change>/<slice>/r<N>.package.md`, or `--out`. `<checkout>/.weave/tmp/.gitignore` containing `*` is created when absent.
- Package layout: header (run id, scope, repos, start and end refs or fallback base, partial reasons, warnings), commit list (`n/a` for snapshots), diff stat, per-repo `git diff -U10` with owned files first and foreign files under "Possibly another slice's work", then the context manifest: planning docs with paths, `slice.md`, applicable decisions with paths, guideline files per repo (present or absent; "no shared guidelines found" when absent), task evidence (labelled "claims to verify"), untested tasks, human-check steps.
- `templates/skills/weave-slices/tasks-template.md`: under `### Verification`, add an optional `- Human check: <step a person must do>` line with a one-line comment that it is only for steps an agent cannot perform.

## State

- `package --slice` adopts the change, then: allocate run → end snapshot → set `in_review` → write package. A failure after the snapshot leaves the ref and reports the error; the slice state is set only after the package is written.

## Validation and errors

- `review_disabled` (workspace `review.enabled: false`, no `--force`), `change_review_skipped`, `no_slices`, `slice_not_found`, `slice_not_ready` (unless `--partial`), `base_unknown` (package written, `partial: true`, `status: "ok"` with the code in `warnings`), `start_ref_missing_on_this_machine` (warning).
- Paths in the package are relative to each repo root and prefixed by repo id in workspace mode.

## Files and artifacts

- New: `src/lib/review/package.ts`, `tests/review-package.test.ts`, `tests/cli-review-package.test.ts`.
- Modified: `src/commands/review.ts` (add `package --slice`), `templates/skills/weave-slices/tasks-template.md`.
