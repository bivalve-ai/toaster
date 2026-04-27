# TOAST Standard v0.1

TOAST means **Transferable Open Agent Session Trace**.

TOAST is a universal standard format for persisted AI agent sessions. It exists because agent sessions are already local files, but every agent writes a different shape. TOAST gives those traces one shared schema.

This file is the short, agent-readable standard summary. The canonical detailed spec is [`spec/toast-v0.1.md`](./spec/toast-v0.1.md).

## Scope

TOAST represents saved agent session history:

- conversation turns
- tool calls
- tool results
- non-conversation events
- provenance
- usage and model metadata
- explicit translation losses

TOAST does **not** define:

- an agent runtime
- a tool execution protocol
- memory, summaries, embeddings, indexes, or relevance scores
- a cloud service

## Required top-level shape

A TOAST object is one JSON object:

```json
{
  "traceVersion": 1,
  "id": "string",
  "cwd": "string | optional",
  "createdAt": "ISO-8601 string | optional",
  "parentTraceId": "string | optional",
  "source": { "agent": "pi | claude | codex | opencode" },
  "agents": [{ "agent": "pi | claude | codex | opencode" }],
  "turns": [],
  "events": [],
  "metadata": {},
  "losses": []
}
```

## Core invariants

Adapters and tools MUST:

1. Preserve turn order.
2. Preserve tool-call to tool-result linkage when present.
3. Preserve provenance where possible.
4. Record losses instead of silently dropping data.
5. Keep unknown/native data in `metadata`, `events`, or `unknown` blocks when practical.
6. Keep TOAST lean; do not add derived memory/search fields to the standard.

Adapters and tools SHOULD:

1. Preserve source session ids when target formats allow it.
2. Preserve original tool ids in `rawId` / `rawToolCallId` when sanitized ids are needed.
3. Treat TOAST files as sensitive artifacts because sessions may contain source code, prompts, tool outputs, paths, and secrets.

## Turn model

Each turn has:

```json
{
  "id": "string",
  "parentId": "string | null | optional",
  "role": "system | developer | user | assistant | tool",
  "timestamp": "ISO-8601 string | optional",
  "content": [],
  "model": "string | optional",
  "provider": "string | optional",
  "stopReason": "stop | tool_use | length | error | cancelled | unknown | optional",
  "usage": {},
  "provenance": {},
  "metadata": {},
  "losses": []
}
```

`role: "tool"` is the normalized role for tool-result turns even when the native agent encodes tool results differently.

## Content block types

TOAST v0.1 content blocks are:

- `text`
- `thinking`
- `note`
- `tool_call`
- `tool_result`
- `unknown`

See [`spec/toast-v0.1.md`](./spec/toast-v0.1.md) for exact fields.

## Loss records

A loss record means an adapter could not preserve some source detail exactly:

```json
{
  "severity": "info | warning | error",
  "path": "turns[3].content[1]",
  "reason": "human-readable reason",
  "value": "optional original value"
}
```

Losses are part of the standard. They are how TOAST stays transparent when native formats differ.

## Minimal valid example

```json
{
  "traceVersion": 1,
  "id": "example-session",
  "source": { "agent": "pi", "path": "/tmp/session.jsonl" },
  "agents": [{ "agent": "pi" }],
  "turns": [
    {
      "id": "turn-1",
      "role": "user",
      "content": [{ "type": "text", "text": "continue this work" }],
      "provenance": { "agent": "pi", "path": "/tmp/session.jsonl", "line": 2 },
      "metadata": {}
    }
  ],
  "events": [],
  "metadata": {},
  "losses": []
}
```

## Agent implementation checklist

When adding or reviewing an adapter:

- [ ] Can it detect native files without writing?
- [ ] Can it read native files into TOAST?
- [ ] Can it write TOAST into the target native format?
- [ ] Can it validate write compatibility before writing?
- [ ] Does it record every lossy downgrade?
- [ ] Does it preserve provenance?
- [ ] Does it have synthetic fixtures for important native shapes?
- [ ] Does `npm test` pass?

## Versioning

This standard defines TOAST v0.1 with `traceVersion: 1`.

Future incompatible changes must bump `traceVersion`.
