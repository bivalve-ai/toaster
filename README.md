# toaster

A local-first universal session store for AI agents.

Toaster ingests sessions from local agent tools into TOAST: Transferable Open Agent Session Trace, a universal standard format for preserving agent histories, tool calls, tool results, metadata, provenance, and known losses.

Once sessions are in your TOAST library, you can list them, keep them in git, resume them in supported agents, export them, or browse them with local tools.

Current native session sources:

- pi
- Claude Code
- Codex CLI
- OpenCode export JSON

The standard summary lives at [STANDARD.md](./STANDARD.md). The canonical detailed format spec lives at [spec/toast-v0.1.md](./spec/toast-v0.1.md). Adapter authors should start with [docs/adapters.md](./docs/adapters.md). Testing philosophy and A2E guidance live in [docs/testing.md](./docs/testing.md).

## Privacy / local-first

Toaster runs locally. There is no account, cloud service, telemetry, analytics, or API upload in the CLI/library.

By default, Toaster only:

- reads local session files from supported agent tools
- writes local TOAST artifacts and translated session files
- writes temporary files during corpus tests
- prints JSON/results to stdout/stderr

Your session contents can include source code, prompts, tool outputs, local paths, secrets, model responses, and private context. Treat TOAST files like sensitive source artifacts.

Two important boundaries:

- Installing packages with npm may contact the npm registry, but Toaster itself does not upload your sessions.
- If you resume or launch another agent from a translated session, that agent may send context to its model provider according to that agent's own behavior. Toaster's part is local file conversion.

## Status

This is early software.

The supported native stores are inferred from real session files, not stable public specs. Upstream changes may break ingestion or resume targets. Some sessions will preserve cleanly. Some will be lossy.

Losses are tracked in TOAST and returned to the caller.

## Install

```bash
npm i -g toaster-cli
```

Or:

```bash
npx toaster-cli scan
```

Requires Node 22+.

## CLI

Scan native sessions, without writing anything:

```bash
toaster scan
toaster scan --app pi
toaster scan --app claude
toaster scan --app codex
```

`toaster list --saved` lists your TOAST library. `toaster list` is kept as a legacy native-session listing; prefer `scan` for native stores.

### Create a TOAST library

A TOAST library is the local store of portable agent sessions. It is plain files and git-friendly. By default it lives at:

```text
~/toast-library
```

Each saved session is written as:

```text
~/toast-library/sessions/<agent>/<session-slug>/
  toast.json   # canonical Transferable Open Agent Session Trace
  meta.json    # save metadata
  README.md    # human summary and resume commands
```

Bulk saving is sensitive: agent sessions can include source code, prompts, tool outputs, local paths, secrets, model responses, and private context. Use `--dry-run` first, then explicitly confirm with `--yes`:

```bash
# See what Toaster can find without writing anything.
toaster ingest --all --dry-run

# Pull every new/changed local agent session into ~/toast-library.
toaster ingest --all --yes

# Pull only one app's new/changed sessions.
toaster ingest --all --app pi --yes

# Pull one specific session.
toaster ingest <session-id-or-path> --name my-session

# List saved TOAST artifacts.
toaster list --saved
```

`toaster ingest --all` is incremental: it skips sessions whose native source mtime and byte size have not changed. Use `--force` to rewrite everything. `toaster save ...` is still supported as a legacy alias for `toaster ingest ...`.

You can put `~/toast-library` in git if you want history and remotes, but do not push it publicly unless you have reviewed or redacted the contents.

### Redaction and cloud-safe mirrors

Toaster can create redacted TOAST artifacts and redacted/aliased mirrors for safer cloud storage.

```bash
# Inspect default config.
toaster config get

# Configure redaction. `local` is regex-only and offline.
toaster config set redaction.provider local
toaster config set redaction.alias true

# Optional: inspect local redaction setup and OPF checkpoint status.
toaster redaction doctor

# Optional: use OpenAI Privacy Filter if `opf` is installed locally.
toaster config set redaction.provider opf
toaster config set redaction.device cpu

# Preview redactions without writing a redacted artifact.
toaster redact <session-id-or-saved-name> --dry-run

# Write a redacted copy and sanitized report.
toaster redact <session-id-or-saved-name> --alias --out safe.toast.json

# Create a local redacted/aliased mirror of the whole library. This does not upload.
toaster mirror --cloud-safe-local --alias --yes --out ~/toast-library-cloud

# Try a small mirror first.
toaster mirror --cloud-safe-local --alias --yes --limit 3 --out ~/toast-library-cloud-test
```

Raw sessions stay in `~/toast-library`. Cloud-safe mirrors should contain only redacted TOAST files and sanitized redaction reports. Alias mappings are local-only under `~/.config/toaster/`; do not sync that directory. Commands using `--alias` print this write location explicitly.

### Resume a saved or native session

```bash
toaster resume <session-id-or-path-or-saved-name> --in claude
toaster resume <session-id-or-path-or-saved-name> --in pi
toaster resume <session-id-or-path-or-saved-name> --in codex
toaster resume <session-id-or-path-or-saved-name> --in opencode
```

Resume writes a target-native session file, then prints a launch command. It does not launch the target app unless you pass `--launch`.

When the target has a known launch command, Toaster prints it. For example:

```bash
cd /path/to/project && claude --resume <new-session-id>
```

Export one session as raw TOAST JSON:

```bash
toaster export <session-id-or-path-or-saved-name> --to toast --out session.toast.json
```

Run a local corpus directory through read/validate/write/reread:

```bash
toaster corpus --dir ./corpus
toaster corpus --dir ./corpus --to claude
toaster corpus --dir ./corpus --thinking-policy drop
```

Low-level translate primitive:

```bash
toaster translate --to claude <path-or-id>
toaster translate --to pi <path-or-id>
toaster translate --to codex <path-or-id>
toaster translate --to opencode <path-or-id>
toaster translate --strict --to claude <path-or-id>
toaster translate --thinking-policy drop --to claude <path-or-id>
```

Source format is auto-detected from the file or session id. If a hand-written or unusual file cannot be detected, pass `--from <agent>` as a fallback:

```bash
toaster translate --to claude --from pi <path-or-id>
```

Legacy aliases:

```bash
toaster pi-to-claude <path-or-id>
toaster claude-to-pi <path-or-id>
```

Commands print JSON with the target path, session id, and basic stats.
The corpus command emits one report covering detection, read success, validation warnings/errors, write success, reread success, and simple model/usage presence.

`--strict` fails early on preflight validation errors. By default, non-portable thinking is preserved as imported context when writing target formats that cannot store it natively. Use `--thinking-policy drop` to discard it instead.

The library also exposes `validateToast(agent, toast, options)` or `adapter.validateWrite(toast, options)` for preflight checks without writing.

## Session locations

By default, toaster reads and writes sessions in the locations used by each supported agent.

pi:

```text
~/.pi/agent/sessions/--<cwd-encoded>--/<timestamp>_<id>.jsonl
```

Claude Code:

```text
~/.claude/projects/<cwd-encoded>/<id>.jsonl
```

Codex:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<local-timestamp>-<id>.jsonl
```

OpenCode:

```text
<cwd>/<session-id>.opencode.json
```

OpenCode support currently reads and writes export-style JSON files rather than discovering OpenCode's native session store.

## Library

```ts
import { discoverSessions, translate } from "toaster-cli";

const sessions = await discoverSessions("pi");
const latest = sessions[0];
const result = await translate("claude", latest.path);

console.log(result.target);
console.log(result.sessionId);
```

Lower-level API:

```ts
import { readToast, validateToast, writeToast } from "toaster-cli";

const toast = await readToast("pi", "/path/to/session.jsonl");
const preflight = validateToast("claude", toast);
if (!preflight.ok) throw new Error(preflight.errors.join("; "));
const result = await writeToast("codex", toast);
```

## Caveats

Toaster tries to preserve:

- conversation turns
- tool calls
- tool results
- cwd
- some model metadata

But translation is not perfect. Known problems:

- agent-specific events may be dropped or downgraded to generic events
- some block types have no equivalent in the target format
- tool names do not imply equivalent runtime tools across agents
- non-object tool inputs may need wrapping in object-only formats
- structured or binary tool output may be stringified
- thinking and signature formats are not portable across all agents

## Development

```bash
npm run build
npm test
npm run toaster -- list
```

Before sharing a branch or opening a PR, run the full local check:

```bash
npm run check
```

See [docs/testing.md](./docs/testing.md) for the test philosophy, current coverage, and A2E smoke flow.

`npm pack` runs a clean build via `prepack`, so the tarball does not include stale build output.

## Contributing

PRs are welcome, especially for:

- new agent adapters
- synthetic fixtures based on real session shapes
- translation failures
- upstream format changes

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first. Adapter authors should also read [docs/adapters.md](./docs/adapters.md). The short version: open an issue before a first PR, keep proposals concise, and make sure you understand the code you submit.

For support, see [SUPPORT.md](./SUPPORT.md). For security issues, see [SECURITY.md](./SECURITY.md).

MIT licensed.
