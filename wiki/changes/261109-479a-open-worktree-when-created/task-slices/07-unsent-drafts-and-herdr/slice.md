# Unsent drafts where supported, and herdr bring-forward

## Outcome

Where a tool can hold a first message without sending it, the new session opens with the next step filled in but not sent (`draft: "unsent"`). Every other tool stays `draft: "shown"`. If herdr can list its tabs with their folders, an existing herdr tab in the change folder is brought forward the same way as tmux. If it can't, this is recorded as a known limitation.

## User flow

1. The person has a herdr + Claude default and creates a change with `--skill weave-explore`.
2. If herdr's `task` (or Claude's own option) is confirmed to hold an unsent message, the tab opens with `use the weave-explore skill for change …` typed in but not sent, and the original session says "(filled in, not sent)".
3. Otherwise the tab opens empty and the original session shows the step to paste.
4. Switching to a change already open in a herdr tab brings that tab forward, if herdr supports listing tabs.

## In scope

- A manual check of each candidate's draft behaviour: herdr `tab.new` `task`; Claude, Codex, opencode `--prompt`, and Cursor's agent prompt options; Claude desktop (using slice 04's T2 findings).
- Switching verified entries to `draft: "unsent"` and wiring the draft into their argv or JSON as one element.
- A herdr tab-listing spike, then bring-forward if it is supported.
- Recording the results in the registry comments and in the architecture's Risks section.

## Out of scope

- Any tool whose draft would be sent automatically. These stay `shown`, because Weave never sends a step.

## Acceptance criteria

- [ ] Every entry marked `unsent` has a recorded manual check showing the message is not sent.
- [ ] `open.draft` and the "(filled in, not sent)" text match the registry.
- [ ] herdr bring-forward works if supported. Otherwise the limitation is recorded and herdr opens a new tab.
