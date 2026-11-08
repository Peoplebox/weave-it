# Contracts: Attention line in weave status

## Interfaces

- `weave status [--json]`: as in `../../architecture/api-contract.md` "`weave status`".

## Data

- Reads `attention.json`. It never writes it.

## Validation and errors

- A missing or unreadable snapshot means no line and `changes_attention: null`. It's never an error.
