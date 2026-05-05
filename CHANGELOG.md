# Changelog

All notable changes to Toaster will be documented here.

## Unreleased

## 0.0.3

- Fix opencode round-trip so `native -> TOAST -> native` is structurally idempotent.
  - Tool parts no longer duplicate into a `pending` stub plus a `completed` copy on rewrite; a single native tool part now carries both input and output.
  - `step-start`, `step-finish`, and unknown forward-compat parts round-trip back as native parts on the assistant message they originated from, instead of being flattened into a synthetic user "imported context" turn.
  - Tool turns are emitted after their parent assistant turn on read, preserving causal ordering.
  - Synthetic ids (`msg_a1:tool:3`) no longer accrete `:tool:N` suffixes on each rewrite.
  - User messages no longer get a synthesized `model` field, so the `agents[]` fingerprint array stays bounded across hops.
- Add structural-idempotency round-trip test for opencode covering text, reasoning, tool input+output, step markers, and unknown part types.

## 0.0.2

- Initial public Toaster/TOAST work.
- Read-only `pi-durable` adapter: one conversation of a @earendil-works/pi-durable SQLite file as TOAST, from its context projection.
- pi adapter: string message content, pi-ai stop reasons (`toolUse`, `aborted`), assistant `api` and message timestamps, a leaf that reaches every turn, and developer turns as custom messages; checked by loading written sessions with pi-coding-agent 1.0.0's SessionManager.
