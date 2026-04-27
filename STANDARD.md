# TOAST Standard

TOAST means **Transferable Open Agent Session Trace**.

TOAST is a portable JSON format for persisted AI agent sessions. It captures conversation history, tool calls/results, provenance, metadata, and explicit translation losses so sessions can move between agent tools without silent data loss.

The canonical detailed spec is [`spec/toast-v0.1.md`](./spec/toast-v0.1.md).

## In one screen

```json
{
  "traceVersion": 1,
  "id": "session-id",
  "cwd": "/path/to/project",
  "source": { "agent": "pi", "path": "/path/to/native-session.jsonl" },
  "agents": [{ "agent": "pi" }],
  "turns": [],
  "events": [],
  "metadata": {},
  "losses": []
}
```

## What TOAST represents

TOAST carries:

- ordered conversation turns
- text, thinking, notes, tool calls, tool results, and unknown blocks
- non-conversation events
- source provenance
- usage/model metadata when available
- explicit `losses[]` when an adapter cannot preserve something exactly

TOAST does not define:

- an agent runtime
- a tool execution protocol
- memory, summaries, embeddings, indexes, or relevance scores
- a cloud service

## Core invariants

Adapters and tools must:

1. Preserve turn order.
2. Preserve tool-call/tool-result linkage when present.
3. Preserve provenance where possible.
4. Record losses instead of silently dropping source data.
5. Keep unknown/native data in `metadata`, `events`, or `unknown` blocks when practical.
6. Treat TOAST files as sensitive local artifacts.

## Current version

- Spec: TOAST v0.1
- `traceVersion`: `1`
- Current agent enum: `pi | claude | codex | opencode`

For exact field definitions, block schemas, loss records, and adapter expectations, read [`spec/toast-v0.1.md`](./spec/toast-v0.1.md).
