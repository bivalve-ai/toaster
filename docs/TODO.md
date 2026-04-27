# TODO

Core Toaster should stay small: local-first TOAST library, native ingestion, list/export/resume, local redaction, aliasing, and local cloud-safe mirrors.

## Parked redaction-provider work

Experimental worktree:

```text
/Users/austinesecson/Development/toaster-redaction-spike
```

Do not pull provider-specific ML dependencies into `toaster-cli` core.

Future redaction-provider ideas:

- Universal local detector endpoint / JSONL stdio protocol.
- OPF provider as an optional external sidecar, not a bundled dependency.
- Hugging Face provider as an optional external sidecar, not a bundled dependency.
- Presidio or other enterprise detector sidecars.
- Persistent worker lifecycle for mirror runs so models load once per command, not once per field.
- Session-level/chunk-level batching and progress reporting.
- Clear preflight/doctor output for model downloads, checkpoint paths, CPU/CUDA, and local-only guarantees.

Design boundary:

```text
external detector: returns sensitive spans only
Toaster core: applies replacements, aliases, reports, and writes artifacts
```

No hosted upload redaction by default. If ever supported, it must be explicit opt-in and should only operate on artifacts the user intentionally sends.
