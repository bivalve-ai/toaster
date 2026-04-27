# Philosophy

The non-negotiables. If a change breaks one of these, it probably should not land.

## 1. Local-first is the trust contract

Toaster reads local session files and writes local files. No account, telemetry, cloud upload, or API call should be required for the CLI/library to work.

If a feature needs network access, it belongs outside the core unless users explicitly opt in and the boundary is documented.

## 2. Portability is the north star

Every decision is weighed against: does this make agent sessions more portable?

Portability means:

- a saved session is understandable without the original app
- the data lives in plain files the user controls
- adapters can be added without asking permission
- moving between supported agents does not require pairwise translators

## 3. TOAST stays lean

TOAST is the raw, agent-agnostic shape of a conversation: turns, content blocks, tool calls, tool results, events, provenance, metadata, usage, and losses.

We should not add derived data to the core format:

- summaries
- embeddings
- topic tags
- relevance scores
- search indexes
- precomputed memories

Those belong in tools built on top of TOAST.

## 4. Nothing is silently dropped

Translation can be lossy. When it is, record the loss with severity, path, and reason.

If an adapter finds data it does not understand, it should preserve it in metadata, an unknown block, an event, or an explicit note whenever practical. Silent deletion is the failure mode to avoid.

## 5. Adapters are first-class

Supporting a new agent means adding an adapter, not a fork and not a new pairwise translator.

The intended path is always:

```text
native agent session -> TOAST -> native agent session
```

Backwards-compatibility helpers may exist, but they should be thin wrappers around the adapter path.

## 6. Provenance is table stakes

Every trace, turn, and event should carry enough provenance to answer: where did this come from?

When a round-trip fails, a format changes, or a resume behaves unexpectedly, provenance lets us trace back to the source file, line, raw type, and agent.

## 7. Users own their data

TOAST artifacts are plain JSON. They should be readable, greppable, diffable, committable, and portable.

We will not gate the user's own session data behind a service, proprietary binary format, or hosted-only workflow.

## 8. Be honest about resume semantics

Toaster writes session files. It does not execute sessions and it does not control what another agent does after resume.

If a generated session can preserve context but not perfect native semantics, say so and record losses. The user should know what changed before they rely on the result.

## 9. Versioning matters

TOAST files carry `traceVersion`. Breaking format changes should be explicit, rare, and documented. Readers should reject unsupported versions loudly instead of guessing.

## 10. Keep the core small

The core should be the format, adapters, local library, CLI primitives, and validation. Features that are really memory products, search products, sync products, or hosted workflows should layer on top.

## Not goals

- Building an agent runtime
- Replacing any agent's own resume behavior
- Becoming an observability SaaS
- Baking cloud sync or memory into the core format
- Pretending translation is perfect when it is not
