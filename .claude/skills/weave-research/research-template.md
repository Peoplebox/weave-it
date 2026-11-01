---
artifact: research
status: draft
owner: engineering
created_at: <ISO timestamp>
updated_at: <ISO timestamp>
source: questions.md
git_commit: <short sha of each researched repo>
branch: <branch of each researched repo>
---

# Research: <change title>

## Summary

<!-- Three to six sentences: how the researched area works today, in plain language. -->

## <Takeaway header: a sentence that states a finding, e.g. "Change status lives in status.yml and only the CLI writes it">

<!-- Short prose explaining the finding, with path:line citations woven in.
     Put a diagram, call tree, table, file tree, signature, or pseudocode right next to the prose it supports. -->

**Tested by:** <test files, style (unit/integration/e2e), fixtures and mocks used — or "no tests found">

## <Next takeaway header>

...

## Recorded Decisions

<!-- Accepted decisions that apply to the researched areas: id, what they decided, and where the code differs, if it does. Delete the section if there are none. -->

## External Dependencies

<!-- Only when the questions covered libraries or services. One entry per dependency:
     what the project relies on, the version in use, what the docs say, and source links. -->

## Code References

<!-- Grouped by area. Say whether each group is exhaustive or covers only the key files. -->

- `path/to/file.ts:12-80` — <what it does>
- `path/to/dir/` — <what lives here>

## Open Questions

<!-- Questions the research could not answer, and why. Delete the section if none remain. -->
