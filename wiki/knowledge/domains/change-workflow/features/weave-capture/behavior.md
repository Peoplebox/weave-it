# weave-capture

## Purpose

`weave-capture` captures the current discussion into the active Weave change without storing a raw transcript. It runs in two modes:

- **Artifact capture** (bare `weave-capture`): creates a structured session note, promotes pending session context for the selected lane, and merges durable content into the corresponding live artifact (`exploration.md`, `prd.md`, legacy `architecture.md`, or folder-mode `architecture/index.md` plus facets).
- **Session-only capture** (`weave-capture session [exploration|prd|architecture]`): creates a lane-aware structured session note only, never updating live artifacts.

`weave-capture` is the only v1 flow that promotes pending session-only context into live artifacts.

## Current Behavior

Step order:

1. Discover session and active change via `weave workspace --json` and `weave change current --json`.
2. Resolve capture mode (artifact vs session-only) and resolve the lane.
3. **Defensive Lane Verification** (see below). If the resolved lane and conversation substance disagree, stop and ask the user to confirm the lane before any write.
4. Identify the active change folder, ensure `sessions/` exists, generate a timestamped session filename `YYYYMMDD-HHMMSS-<4-char-id>-<artifact>.md`.
5. Write the structured session note with `artifact`, `capture_mode`, `captured_at`, and `facets` frontmatter and the standard section list (Summary, Decisions Made, Options Considered, Rejected Approaches, User Preferences, Agent Recommendations, Unresolved Points, Live Artifact Updates Applied, Next Resume Point). For architecture captures, `facets` lists affected architecture concerns such as `index`, `schema`, `api-contract`, `frontend-backend`, or user-defined facet slugs; non-architecture captures use `facets: []`.
6. For artifact-capture mode, merge durable content into the selected live artifact (preserving template structure and lifecycle frontmatter); apply the Lifecycle Staleness Verification Protocol before calling `weave change progress <lane>`.
7. For session-only mode, skip step 6 entirely; do not call lifecycle progress.

## Defensive Lane Verification

Before any write (session note or live artifact), `weave-capture` compares the resolved lane against the dominant subject of the conversation being captured:

- `exploration`: product discovery and stress-tested requirements.
- `prd`: user-facing requirements, acceptance criteria, scope, open questions.
- `architecture`: engineering design, module boundaries, tradeoffs, technical risks.

When the resolved lane (from explicit user input or `weave-capture session <lane>`) and the dominant subject clearly disagree, capture stops and asks the user:

```text
Selected lane is <lane>, but the conversation reads as <observed-lane>.
Capture this into: <lane>, <observed-lane>, or another lane?
```

The user's reply becomes the resolved lane for the rest of the invocation. The skill never silently overrides the explicit selection. When the lane and the conversation are aligned, or when the conversation is too short or mixed to judge, the skill proceeds with the resolved lane without asking.

Bare `weave-capture` asks for an explicit target when none is provided. Session-only capture without an explicit lane asks for the session lane before writing.

## Behavioral Rules

- Session-only capture must not create or update `exploration.md`, `prd.md`, `architecture.md`, or `architecture/`.
- Session-only capture does not require the selected live artifact to exist and does not enforce upstream prerequisite artifacts.
- Artifact capture must not create `exploration.md`, `prd.md`, `architecture.md`, or `architecture/` without a valid active change, valid target context, and enough selected-lane context. When the artifact does not exist, all matching lane session notes are considered; when it exists, only session notes newer than `updated_at` are considered.
- For architecture artifact capture, existing legacy `architecture.md` stays in file mode unless the user explicitly requests folder mode or a separate facet. If no architecture artifact exists, new architecture capture creates folder mode at `architecture/index.md` by default.
- If both `architecture.md` and `architecture/` exist, capture stops before writing and asks the user how to resolve the shape conflict.
- Folder-mode architecture capture treats `architecture/index.md` as the entry point and direct child `architecture/*.md` files as facets.
- Capture discovers architecture templates from direct child resources in the installed `weave-architect` skill folder by `<facet>-template.md` convention. Template-backed facets use the matching template; no-template content is merged into existing architecture docs unless the user explicitly asks for a separate facet file.
- The capture session file is a continuation aid; live artifacts remain the durable current truth.
- `weave-capture` never reads cross-lane session notes (e.g. a PRD capture does not consider exploration sessions).
- The raw conversation transcript is never copied or stored.

## Integrations And Side Effects

- After a successful artifact-capture write, `weave-capture` calls `weave change progress <lane> --source <ids>` honoring the Lifecycle Staleness Verification Protocol: it may pass `--no-invalidate` or `--invalidate=<lanes>` based on content-sync verification, and may follow up with `weave change clear-stale <lane> --reason ...` for previously-stale dependents now in sync.
- Session-only mode never calls lifecycle progress.
- Both modes follow the shared `# Silent Weave Command Output` contract: discovery command output is internal by default, and only blockers, failures, relevant notices, lifecycle failures, or user-required actions are summarized.

## Source Anchors

- Canonical skill: `templates/skills/weave-capture/SKILL.md`
- Architecture artifact shape: `wiki/knowledge/domains/change-workflow/domain-wide/architecture-artifacts.md`
- Architecture template resources: `templates/skills/weave-architect/*-template.md`
- Installed copies: `.agents/skills/weave-capture/SKILL.md`, `.claude/skills/weave-capture/SKILL.md`
- Opencode wrapper: `templates/opencode/commands/weave-capture.md`
- Design skills that write their own shapes (capture is used for checkpoints and promoting pending session notes): `templates/skills/weave-explore/SKILL.md`, `templates/skills/weave-architect/SKILL.md`; product shape structure: `templates/skills/weave-explore/shape-template.md`
- Lifecycle CLI: `src/commands/change.ts` (`weave change progress`, `weave change clear-stale`)
- Tests: `tests/agent-skills.test.ts` (defensive verification anchors, byte-identity of embedded protocol blocks)

## Change History

- 2026-06-03 (change `260603-piln-npm-and-skill-versioning-and-updates`): added the `# Defensive Lane Verification` step (lane vs conversation-substance comparison with explicit user ask on mismatch); embedded the byte-identical `# Lifecycle Staleness Verification` and original notice-surfacing blocks.
- 2026-06-06 (change `260606-k0l6-architecture-folder`): architecture capture learned folder-mode architecture, `facets` session frontmatter, direct child architecture template resources, and no-template facet creation only on explicit user request.
- 2026-06-07 (change `260607-1mo4-fixes-around-existing-commands`): replaced verbatim notice surfacing with the shared `# Silent Weave Command Output` contract.
- 2026-10-20 (branch `change/questions-research-skills`): `weave-explore` and `weave-architect` now write their own shapes, so capture is mainly for checkpoints and promoting pending session notes; exploration captures use the product shape template.

## Open Questions

- Whether to expose lane-mismatch ambiguity decisions in `wiki/changes/<change-id>/sessions/*.md` (current behavior: only the resolved lane is recorded, not the prompt-and-answer).
