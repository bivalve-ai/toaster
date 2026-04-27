# Vision

Agents are multiplying. Claude Code, pi, Codex, OpenCode, Cursor, aider, Continue, Gemini CLI, and others all have different strengths, but each tends to trap useful context in its own session store.

Toaster exists so conversations become portable files instead of app-specific history.

## The problem

Developers often switch agents depending on the task. The cost is context loss:

- re-explaining the codebase
- re-pasting constraints
- restating failed attempts
- losing tool outputs and decisions from earlier sessions

That friction keeps people in the first tool they opened instead of the best tool for the next step.

## The approach

Toaster ingests native local sessions into TOAST: Transferable Open Agent Session Trace.

```text
pi session       ┐
Claude session   ├── read adapter ──> TOAST ── write adapter ──> resumable session
Codex session    │
OpenCode export  ┘
```

Native formats do not translate directly to each other. Every source and target goes through the same middle format.

## Files over silos

The model is simple: your session is a file. You can inspect it, commit it, move it, archive it, or resume it in another supported agent.

The CLI stays local-first:

- no account
- no telemetry
- no required cloud service
- no session upload

If users later choose to sync, index, or share their TOAST library, that should be their explicit choice.

## What TOAST unlocks

1. **Portability** — resume useful context in another supported agent.
2. **Archival** — keep durable records of important agent sessions.
3. **Reviewability** — diff and inspect sessions as plain files.
4. **Corpus testing** — run real session shapes through adapters and catch drift.
5. **Future memory layers** — build search, pre-warming, and cross-agent memory on top of a common local format.

The first feature is translation. The larger prize is compounding context: every useful session can become part of a personal, portable memory layer without tying that memory to one agent vendor.

## Current state

The project currently supports local ingestion/resume paths for:

- pi
- Claude Code
- Codex CLI
- OpenCode export JSON

The format is documented in `spec/toast-v0.1.md`. The adapters are tested with synthetic fixtures, and losses are surfaced instead of silently hidden.

## Near-term direction

- Exercise the adapters against more real-world session corpora.
- Tighten resume behavior and loss reporting.
- Add adapters for more agents where the local formats are discoverable.
- Keep the local TOAST library git-friendly and easy to inspect.
- Share the project early with agent users who can provide real edge cases.

## What this is not

- Not an agent runtime.
- Not a cloud memory service.
- Not a telemetry product.
- Not a claim that every agent-specific detail can be translated perfectly.

Toaster is the local, open portability layer. Other products can build on top of that, but the foundation should stay boring, inspectable, and owned by the user.
