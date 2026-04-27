# A2E cleanroom testing

A2E means agent-to-end. It is Toaster's fresh-eyes test: a new agent, with no hidden project context, tries to use the public docs and CLI help to complete the real workflow.

This is intentionally not part of normal CI. It depends on local agent session stores, provider auth, model availability, and quota. Run it when changing CLI UX, README instructions, ingest/resume behavior, redaction messaging, or library layout.

## Run

```bash
npm run a2e:cleanroom
```

By default the runner uses Pi with the `openai-codex` provider and `gpt-5.4-mini` model:

```bash
pi --provider openai-codex --model gpt-5.4-mini --no-context-files --no-skills --tools read,bash
```

Override those defaults with environment variables:

```bash
A2E_PROVIDER=openai-codex A2E_MODEL=gpt-5.4-mini npm run a2e:cleanroom
```

The fresh-agent step is a real model call. Some providers do not stream output in this mode, so the harness prints a heartbeat while it waits. The default timeout is 12 minutes; override it with `A2E_TIMEOUT_MS` if needed.

The runner creates a temp project under `/tmp`, packs and installs the local Toaster package there, copies the public README and scenario, and asks the fresh agent to work only from those materials plus `toaster --help`.

## Outputs

The runner prints the temp directory and writes local artifacts there:

```text
/tmp/toaster-a2e-*/
  README.md
  SCENARIO.md
  FRESH_AGENT_PROMPT.md
  stdout.txt
  stderr.txt
  A2E_RUN.json
  A2E_REPORT.md          # written by the fresh agent, if successful
  toast-library/
  toast-library-cloud/
  safe.toast.json
```

Do not commit these artifacts unless they are synthetic and manually reviewed. Real A2E traces can contain prompts, source code, local paths, tool output, and secrets.

## Pass condition

A good run is not just green commands. It should show that a fresh agent understood the product model:

- `scan` is read-only.
- `ingest --dry-run` writes nothing.
- `ingest --all --yes` writes the raw local TOAST library.
- `list --saved` reads the TOAST library.
- redaction writes derived artifacts.
- alias mappings stay local.
- `mirror --cloud-safe-local` does not upload.
- `resume` writes target-native files and does not launch without `--launch`.

If the agent succeeds only after guessing, that is still useful signal. Fix the CLI copy or README before blaming the agent.
