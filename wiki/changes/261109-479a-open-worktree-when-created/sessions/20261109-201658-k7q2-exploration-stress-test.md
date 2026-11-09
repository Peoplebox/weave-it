---
artifact: exploration
capture_mode: stress-test
captured_at: 2026-11-09T14:46:58.000Z
---

# Stress Test: Exploration - 2026-11-09

## Challenges

### C1 — blocking — Uncovered scenario / unowned assumption
- Challenge: The shape opens with a saved default when an agent creates a change, but never when a script does. Weave cannot tell the two apart (only Claude Code is detectable).
- Answer: No need to tell them apart. A saved default fires on every create or switch, whoever runs it, including scripts. Several changes in a row opening several windows is fine.
- Outcome: decided

### C2 — blocking — Inner conflict / contradiction with evidence
- Challenge: "Filled in but not sent" is promised, but the evidence shows Claude acts on a first message immediately, and herdr, Codex, and opencode drafts are unconfirmed.
- Answer: Where a tool can't hold an unsent draft, open the session empty and show the step for the person to type or paste.
- Outcome: decided

### C3 — major — Uncovered scenario (fix flow)
- Challenge: The fix flow writes findings and a slice after creating the change. Opening at creation would hand over a half-written change. The first step for fix changes is undefined.
- Answer: The fix flow is left for a later change.
- Outcome: out of scope (the fix flow keeps today's behaviour and asks Weave not to open its change)

### C4 — major — Concurrency / reversal
- Challenge: Switching to a change already open elsewhere, from inside its own folder, or to recreate a missing folder would open another window.
- Answer: Inside the folder, open nothing and show the step. Recreated folder: open as normal. Already open: bring forward a tmux or herdr tab that Weave can recognise in the folder, otherwise open anyway (duplicate is a known limitation).
- Outcome: decided

### C5 — major — Conflict with recorded decisions
- Challenge: Decisions 261107-ohne and 261108-4z8l conflict with the shape, and no replacement or companion decision is drafted. The personal settings store isn't recorded.
- Answer: The PRD goes ahead. The technical design step drafts the records.
- Outcome: deferred (does not block the PRD)

### C6 — major — Unowned assumption (detection)
- Challenge: "Only offer what works" depends on detection Weave lacks (T3 Code, Cursor vs VS Code, herdr markers, the `code` command).
- Answer: A fixed list of supported tools with fixed checks (known commands and usual install locations), with no run-time discovery. herdr and tmux need the person inside them. Hard-to-check places shown with a hint. The menu returns only when a tool is gone. Personal settings can add the person's own agents and custom locations for listed tools.
- Outcome: decided

### C7 — major — Existing users (mixed versions)
- Challenge: Upgraded Weave with old installed guided flows gives undefined behaviour.
- Answer: Acceptable. With a default the change opens (the old message is redundant). Without one, today's message. The existing out-of-date notice prompts an update.
- Outcome: decided

### C8 — major — Inner conflict (two agent settings)
- Challenge: The project's hand-off agent setting and the new personal default don't know about each other.
- Answer: Deliberately separate for this change, and documented as independent.
- Outcome: decided

### C9 — major — Uncovered failure (opened but unusable)
- Challenge: A window may open but nothing usable starts, after the original session has stopped.
- Answer: The original session's message always includes the folder and step. It stops editing but can reopen on request. Weave doesn't watch the new session.
- Outcome: decided

### C10 — minor — One-off override at a terminal
- Challenge: A person at a terminal with a saved default can't skip or redirect opening.
- Answer: An option on the command for "don't open" or "open in X instead".
- Outcome: decided

### C11 — minor — Scale and environment
- Challenge: Batches and SSH sessions.
- Answer: Batches settled in C1. Over SSH, skip Mac windows and apps, show the folder and step, and keep herdr and tmux.
- Outcome: decided

### C12 — minor — Menu inconsistencies
- Challenge: The menu differs between sections. pi is missing, the Linux apps are unnamed, and the VS Code workaround is machine-specific.
- Answer: The fixed list is the menu everywhere. pi goes through the person's own agents. Linux offers VS Code, Cursor, and T3 Code when found. VS Code is found by its own install location.
- Outcome: decided

## Verdict

holds-with-changes — The direction stands, but scope and rules changed: the default fires for every caller, unsent drafts only where supported, a fixed tool list, the fix flow out of scope, and new switching and SSH rules.

## Next Resume Point

Write the PRD from exploration.md. Then, in weave-architect, draft the decision records noted in Open Questions (replace 261107-ohne's consequence, a companion to 261108-4z8l, and the personal settings store) and settle the per-tool draft and herdr-listing questions.
