# Testing

Toaster's test philosophy is simple: unit tests protect the format mechanics, and agent-to-end tests protect the user journey.

TOAST is only useful if a real agent session can move through the whole path without surprising the user. For this project, that path is:

```text
native session -> TOAST library -> list/export/redact/mirror/resume
```

## Automated tests

Run the full local suite with:

```bash
npm run check
```

That runs:

```text
npm run build
npm test
npm pack --dry-run
```

The current test suite covers the core adapter and library mechanics:

- Codex native read/write behavior, including function calls and custom tool calls.
- Pi, Claude, and Codex round trips through TOAST.
- OpenCode export-style JSON read/write behavior.
- Preflight validation for target-native writes.
- Preservation or explicit downgrade of non-portable thinking, unknown blocks, and events.
- Local TOAST library writes.
- Corpus read/validate/write/reread reports.
- Local redaction and sanitized redaction reports.

These tests use synthetic fixtures. Do not commit private real sessions as fixtures.

## A2E testing

A2E means agent-to-end. It is an end-to-end test where a fresh agent tries to use Toaster from the public docs and CLI help, not from hidden maintainer context.

The purpose is to catch Norman doors: places where the software technically works, but the commands, warnings, or read/write boundaries are confusing to a new agent or user.

A good A2E run uses a clean temp project, an installed package or packed tarball, and a temporary TOAST library. The agent should use only `README.md`, `toaster --help`, and command output.

Run the optional cleanroom harness with:

```bash
npm run a2e:cleanroom
```

It is not part of normal CI because it depends on local session stores, provider auth, model availability, and quota. The harness lives in [`a2e/`](../a2e/README.md).

The minimal flow is:

```bash
toaster scan --limit 1
toaster ingest --all --dry-run --limit 1 --dir ./toast-library
toaster ingest --all --yes --limit 1 --dir ./toast-library
toaster list --saved --dir ./toast-library
toaster redact <saved-session> --dry-run --dir ./toast-library
toaster redact <saved-session> --alias --out ./safe.toast.json --dir ./toast-library
toaster mirror --cloud-safe-local --alias --yes --limit 1 --dir ./toast-library --out ./toast-library-cloud
toaster resume <saved-session> --in claude --dir ./toast-library
```

The run should record:

- every command attempted
- whether each command succeeded
- every read location and write location reported by Toaster
- any moment where the agent guessed, stalled, or misunderstood the command model
- whether raw, redacted, and alias-vault boundaries were clear

A2E traces may be useful internally, but they should not be committed unless they are synthetic and reviewed. Real traces can contain prompts, source code, tool output, local paths, and secrets.

## What counts as a regression

A change is risky if it breaks one of these expectations:

- `scan` is read-only.
- `ingest --dry-run` writes nothing.
- `ingest --all --yes` updates the raw local TOAST library.
- `list --saved` reads the TOAST library, not native stores.
- redaction writes derived artifacts, not replacements for the raw library.
- alias mappings stay local under `~/.config/toaster`.
- `mirror --cloud-safe-local` does not upload.
- `resume` writes target-native files but does not launch without `--launch`.
- adapters record lossy behavior instead of silently dropping source data.

When in doubt, prefer a small synthetic fixture plus an A2E smoke run over a large committed trace.
