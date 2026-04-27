# TOAST v0.1

TOAST stands for Transferable Open Agent Session Trace.

TOAST is a universal standard format for persisted AI agent sessions. Agent sessions are already local files; TOAST standardizes the shape so sessions can be portable, reusable, and transparent across tools.

This document defines the shared session format used by toaster adapters. It is the canonical shape that native agent session formats are read into and written from.

This is a format spec, not a product manifesto. It describes what data a TOAST trace carries, what adapters are expected to preserve, and what must be recorded when translation is lossy.

For a shorter agent-readable summary, see [`../STANDARD.md`](../STANDARD.md).

## Agent quick facts

- Current `traceVersion`: `1`
- Current spec version: TOAST v0.1
- Serialization: one JSON object per TOAST artifact
- Current agent enum: `pi | claude | codex | opencode`
- Required arrays: `agents`, `turns`, `events`, `losses`
- Required object fields: `source`, `metadata`
- Losses are first-class; adapters must not silently drop source data.
- TOAST is local data; treat artifacts as sensitive because sessions may contain code, prompts, tool output, paths, and secrets.

## Scope

TOAST is for persisted agent session history.

It is meant to carry:

- conversation turns
- tool calls
- tool results
- non-conversation events
- provenance
- explicit translation losses

It is not meant to carry derived data such as:

- summaries
- embeddings
- relevance scores
- topic labels
- indexes

## Serialization

TOAST v0.1 is defined as a JSON object. The current toaster code uses this shape as an internal representation named `Toast`.

A TOAST file must contain exactly one top-level object.

No file extension is required by this spec.

## Top-level object

A TOAST object has these fields:

```json
{
  "traceVersion": 1,
  "id": "string",
  "cwd": "string | optional",
  "createdAt": "ISO-8601 string | optional",
  "parentTraceId": "string | optional",
  "source": { "...": "Provenance" },
  "agents": [{ "...": "AgentFingerprint" }],
  "turns": [{ "...": "ToastTurn" }],
  "events": [{ "...": "ToastEvent" }],
  "metadata": {},
  "losses": [{ "...": "ToastLoss" }]
}
```

### `traceVersion`

Version of the TOAST format.

For this spec it must be `1`.

### `id`

Stable trace identifier.

Adapters should preserve the source session id when they can. Writers may mint a new id when the target agent requires one.

### `cwd`

Working directory associated with the session.

Optional because some source formats may not persist it.

### `createdAt`

Toast creation timestamp in ISO-8601 format.

Optional because some source formats may not provide a single canonical creation time.

### `parentTraceId`

Optional id of the trace this one forked from.

This is trace-level lineage, not per-turn parentage.

### `source`

Provenance for the overall trace. See `Provenance` below.

### `agents`

List of agent fingerprints observed in the source trace.

Usually this contains one entry, but the format allows more than one.

### `turns`

Ordered conversation turns.

### `events`

Ordered non-conversation records that do not fit the turn model cleanly.

Examples:

- permission mode changes
- model changes
- token count updates
- turn context records
- reasoning summaries when the full reasoning text is unavailable

### `metadata`

Unstructured top-level metadata preserved from the source format.

Adapters may use this for native fields that do not belong in a first-class TOAST field.

### `losses`

Tracked lossy choices made while reading or writing.

Nothing should be dropped silently.

## Agent fingerprint

```json
{
  "agent": "pi | claude | codex | opencode",
  "version": "string | optional",
  "model": "string | optional",
  "provider": "string | optional"
}
```

## Turn

A turn has these fields:

```json
{
  "id": "string",
  "parentId": "string | null | optional",
  "role": "system | developer | user | assistant | tool",
  "timestamp": "ISO-8601 string | optional",
  "content": [{ "...": "ToastContentBlock" }],
  "model": "string | optional",
  "provider": "string | optional",
  "stopReason": "stop | tool_use | length | error | cancelled | unknown | optional",
  "usage": { "...": "ToastUsage | optional" },
  "provenance": { "...": "Provenance" },
  "metadata": {},
  "losses": [{ "...": "ToastLoss" }] 
}
```

`role: "tool"` is the normalized form for tool-result turns, even if the source agent encodes tool results under another role.

## Content blocks

A turn contains an ordered list of content blocks.

### Text block

```json
{ "type": "text", "text": "string" }
```

### Thinking block

```json
{
  "type": "thinking",
  "text": "string",
  "signature": "string | optional",
  "format": "pi | anthropic | codex-reasoning | opencode-reasoning | optional",
  "metadata": {}
}
```

The `signature` field is preserved when the source provides it. A target adapter may still have to drop the block if the target agent requires a signature format it cannot validate.

### Note block

```json
{
  "type": "note",
  "kind": "string",
  "text": "string",
  "metadata": {}
}
```

A note block is an explicit downgrade target for content that cannot be preserved natively in another agent format.

A note block may preserve useful context from the source, including reasoning text, summaries, or adapter-generated annotations. Adapters should use metadata to record where the note came from and what was downgraded.

### Tool call block

```json
{
  "type": "tool_call",
  "id": "string",
  "rawId": "string | optional",
  "name": "string",
  "arguments": "any JSON-compatible value",
  "metadata": {}
}
```

Notes:

- `id` is the canonical tool call id. It should be safe for any target that validates ids.
- `rawId` preserves the source id when the source id has to be sanitized.
- `arguments` is intentionally not restricted to an object. Most tools use an object. Some agents persist raw strings or other JSON values.

### Tool result block

```json
{
  "type": "tool_result",
  "toolCallId": "string",
  "rawToolCallId": "string | optional",
  "toolName": "string | optional",
  "content": [{ "...": "ToastContentBlock" }],
  "isError": "boolean | optional",
  "metadata": {}
}
```

`toolCallId` must match the canonical id of the corresponding tool call when the tool call is present in the trace.

### Unknown block

```json
{
  "type": "unknown",
  "originalType": "string | optional",
  "value": "any JSON value",
  "metadata": {}
}
```

Unknown blocks exist so schema drift does not force silent data loss.

## Event

```json
{
  "id": "string",
  "type": "string",
  "timestamp": "ISO-8601 string | optional",
  "parentId": "string | null | optional",
  "value": "any JSON value",
  "provenance": { "...": "Provenance" },
  "metadata": {}
}
```

Event types are adapter-defined strings. When possible, adapters should preserve the source event type verbatim.

## Usage

```json
{
  "inputTokens": "number | optional",
  "outputTokens": "number | optional",
  "cacheReadTokens": "number | optional",
  "cacheWriteTokens": "number | optional",
  "totalTokens": "number | optional",
  "costUsd": "number | optional",
  "metadata": {}
}
```

## Provenance

```json
{
  "agent": "pi | claude | codex | opencode",
  "path": "string | optional",
  "line": "number | optional",
  "rawType": "string | optional",
  "rawId": "string | optional",
  "rawParentId": "string | null | optional",
  "schemaVersion": "string | number | optional"
}
```

Every trace, turn, and event should carry provenance where possible.

## Losses

```json
{
  "severity": "info | warning | error",
  "path": "string",
  "reason": "string",
  "value": "any JSON value | optional"
}
```

A loss record means the adapter could not preserve some source detail exactly.

Guidance:

- `info`: expected degradation because the target lacks an equivalent concept
- `warning`: surprising degradation or fallback behavior
- `error`: materially unsafe or incomplete translation

Loss paths should be stable, human-readable strings such as `turns[3].content[1]`.

## Adapter rules

Adapters implementing TOAST v0.1 should follow these rules.

1. Preserve turn order.
2. Preserve tool-call to tool-result linkage.
3. Preserve unknown content and events when practical.
4. Record losses instead of silently dropping data.
5. Preserve provenance to the source file and line when possible.
6. Sanitize tool ids only when required by the target format, and preserve the original in `rawId` or `rawToolCallId`.
7. Keep TOAST lean. Do not introduce summary or memory-specific fields into the core format.

## Compatibility

This spec defines TOAST v0.1. Future incompatible changes must bump `traceVersion`.
