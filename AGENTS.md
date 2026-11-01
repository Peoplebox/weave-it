---
description: 
alwaysApply: true
---

# Agent instructions

## Codebase context lookup

This repository may have an indexed codebase context provider available, such as codebase-memory-mcp.

Before using broad glob, rg, grep, or reading many files, check whether a codebase context MCP/tool is available.

If available, prefer it for:
- architecture discovery
- symbol, class, method, route, and module lookup
- caller/callee tracing
- impact analysis
- locating relevant files before reading source

If no such tool is available, or if it is stale/insufficient, fall back to normal repo exploration using glob, rg, grep, and file reads.

Always verify important findings against the actual source files before making code changes.

<!-- weave:decisions -->
## Recorded engineering decisions

This project records long-lived engineering decisions as ADRs. Before planning or changing code:

1. Run `weave adr list --path <file> --json` for the files you expect to touch, and read the accepted decisions it returns.
2. Work inside those decisions. If a task would conflict with one, stop and say so; propose a superseding decision with `weave adr new "<title>" --supersedes <id>` rather than changing it quietly.
3. If a decision's `Reconsider When` condition seems to apply, raise it. It may be out of date, but that is a choice for the team, not the agent.
4. When you finish, name the decisions you consulted. `weave adr check` lists any decisions the current branch touches.
