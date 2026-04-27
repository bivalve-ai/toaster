# Agent guide for Toaster

This repository builds **Toaster**, a local-first CLI/library for converting native AI agent sessions through **TOAST**: Transferable Open Agent Session Trace.

TOAST is a universal standard format for persisted AI agent sessions. Agent sessions are already local files; the problem is that every agent writes a different shape.

## Start here

Read these files first, in order:

1. [`README.md`](./README.md) — product overview and CLI usage
2. [`STANDARD.md`](./STANDARD.md) — short agent-readable TOAST standard summary
3. [`spec/toast-v0.1.md`](./spec/toast-v0.1.md) — canonical detailed format spec
4. [`docs/adapters.md`](./docs/adapters.md) — adapter implementation guide
5. [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution policy
6. [`SECURITY.md`](./SECURITY.md) — privacy/security boundaries

## Commands

Use Node 22+.

```bash
npm run build
npm test
npm run check
npm run toaster -- --help
```

`npm run check` runs build, tests, and package dry-run.

## Local-first boundary

The core CLI/library must stay local-first:

- no account requirement
- no telemetry
- no cloud upload
- no hidden network calls
- no reading/uploading private session data outside explicit user commands

Agent sessions can contain source code, secrets, prompts, tool outputs, local paths, and private context. Treat fixtures and logs as sensitive.

## Architecture

Translation path:

```text
native session -> adapter.read() -> TOAST -> adapter.write() -> native session
```

Do not add new pairwise translators. Add adapters under `src/adapters/` and register them in `src/adapters/index.ts`.

Current agents:

- `pi`
- `claude`
- `codex`
- `opencode`

Canonical schema/type lives in:

```text
src/schemas/toast.ts
```

Detailed standard lives in:

```text
spec/toast-v0.1.md
```

## TOAST invariants

Adapters must:

1. Preserve turn order.
2. Preserve tool-call to tool-result linkage when present.
3. Preserve provenance where possible.
4. Record losses instead of silently dropping data.
5. Preserve unknown/native data in `metadata`, `events`, or `unknown` blocks when practical.
6. Keep TOAST lean: do not add summaries, embeddings, indexes, or memory fields to the standard.

## Packaging

Published package contents are controlled by `package.json#files`.

`prepack` runs a clean build so stale `dist/` files do not ship.

Do not commit:

- `node_modules/`
- `dist/`
- `dist-tests/`
- `*.tgz`
- local session corpora
- private agent sessions

