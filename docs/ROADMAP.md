# Roadmap

Toaster core should stay small and local-first.

## Near term

- Harden native adapters with more public/synthetic fixtures.
- Improve OpenCode support beyond export-style JSON.
- Keep resume behavior explicit: write target-native sessions, launch only on request.
- Keep redaction local by default and document all read/write paths.

## Later

- External redaction detector protocol for optional sidecars.
- Optional OPF, Hugging Face, or Presidio detector sidecars outside core.
- Persistent detector workers for library-scale cloud-safe mirrors.
- More adapters as useful native session formats emerge.

## Non-goals for core

- No hosted service dependency.
- No telemetry.
- No bundled ML models or heavyweight redaction dependencies.
- No memory indexes, embeddings, or summaries inside the TOAST format.
