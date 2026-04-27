# Toaster A2E Cleanroom Test Plan

Goal: prove that a fresh agent, with only the public docs and a locally installed `toaster-cli` package, can create and use a full TOAST library without hidden context.

This plan is designed to expose Norman-door failures: places where the CLI wording, docs, or output invite the agent to push when it should pull, write when it should inspect, or confuse native stores with the TOAST library.

## Definitions

- **Native store**: app-owned local session history, e.g. `~/.pi`, `~/.claude`, `~/.codex`.
- **Raw TOAST library**: private local store, default `~/toast-library`.
- **Cloud-safe mirror**: local redacted/aliased copy, default `~/toast-library-cloud`; it is not uploaded by Toaster.
- **Alias vault**: local-only mapping under `~/.config/toaster`; never sync this.
- **Fresh agent**: an agent with no conversation context, given only the repo README and test prompt.

## Pass Criteria

A fresh agent must be able to complete these flows using only docs:

1. Install or run Toaster locally without publishing/global install requirements.
2. Discover native sessions without writing anything.
3. Ingest all local native sessions into a TOAST library with explicit consent.
4. List saved TOAST library sessions.
5. Redact one saved session.
6. Create a cloud-safe local mirror.
7. Resume one saved session into Claude or Pi.
8. Correctly explain where every command reads from and writes to.
9. Avoid claiming that Toaster uploads anything to cloud.
10. Avoid syncing raw `~/toast-library` or `~/.config/toaster`.

## Test Matrix

| Area | Command(s) | Expected affordance |
| --- | --- | --- |
| Help | `toaster --help` | Store-first framing; clear native/library/mirror split |
| Config | `toaster config get` | Shows defaults without requiring setup |
| Scan | `toaster scan` and `toaster ingest --all --dry-run` | Reads native stores, writes nothing |
| Ingest/update | `toaster ingest --all --yes` | Writes new/changed sessions to raw TOAST library; skips unchanged |
| Library list | `toaster list --saved` | Reads TOAST library, not native stores |
| Redact | `toaster redact <saved> --dry-run` | Writes nothing; no alias vault writes |
| Redact output | `toaster redact <saved> --alias --out safe.toast.json` | Writes redacted artifact + sanitized report; alias vault local only |
| Mirror | `toaster mirror --cloud-safe-local --alias --yes --out <dir>` | Writes local redacted mirror; no remote push |
| Resume | `toaster resume <saved> --in claude` | Writes target app native session and prints launch command |
| OPF | `toaster redact <saved> --provider opf` | Warns/handles missing `opf`/checkpoint; no API calls |

## Cleanroom Environment

Use a separate temp project for install testing and a separate library/mirror path to avoid mutating the developer's real library.

```bash
REPO=/Users/austinesecson/Development/toaster
TMP=$(mktemp -d /tmp/toaster-a2e-cleanroom.XXXXXX)
LIB=$TMP/toast-library
MIRROR=$TMP/toast-library-cloud
cd "$REPO"
```

Build/package locally:

```bash
npm run build
npm test
npm pack --json
```

Install package into clean project:

```bash
cd "$TMP"
npm init -y
npm install "$REPO"/toaster-cli-*.tgz
export TOASTER="$TMP/node_modules/.bin/toaster"
```

Note: if the package tarball name differs, use the actual `npm pack --json` filename.

## Fresh Agent Prompt

Give the fresh agent only this prompt and the README path/content:

```text
You are testing toaster-cli as a new user. Use only the README and CLI help.
Do not publish. Do not install globally. Do not modify source. Do not use prior context.

Tasks:
1. Explain what Toaster is.
2. Show where it reads native sessions from.
3. Dry-run ingestion into a temporary TOAST library.
4. Ingest native sessions into that temporary library.
5. List saved sessions from that library.
6. Redact one saved session with dry-run first, then write a redacted artifact.
7. Create a cloud-safe local mirror in a temporary directory.
8. Resume one saved session into Claude if possible, but do not launch Claude.
9. Report every read/write location touched.
10. Report any confusing docs or CLI wording.

Use:
  TOAST library: <LIB>
  cloud-safe mirror: <MIRROR>
```

## Instrumentation / Trace Capture

Run the fresh-agent session in an agent that Toaster can later ingest, preferably Pi. Capture:

```bash
$TOASTER list --app pi | head
```

After the A2E run, ingest the trace into the test library:

```bash
$TOASTER save <fresh-agent-session-id> --dir "$LIB" --name a2e-cleanroom-agent-trace
```

Export the trace for review:

```bash
$TOASTER export a2e-cleanroom-agent-trace --dir "$LIB" --to toast --out "$TMP/a2e-cleanroom-agent-trace.toast.json"
```

Review the trace for:

- commands the agent tried before finding the correct one
- incorrect assumptions about cloud upload
- native-vs-library confusion
- raw-vs-redacted confusion
- surprise writes
- missing `--yes` or `--dry-run` understanding
- whether it used `list` vs `list --saved` correctly
- whether it understood `mirror --cloud-safe-local` is local only

## Detailed Test Cases

### TC1: README comprehension

Agent should answer:

- Toaster is a local-first universal session store.
- TOAST means Transferable Open Agent Session Trace.
- `~/toast-library` is raw/private.
- `~/toast-library-cloud` is redacted/aliased/local mirror.
- Toaster does not upload by itself.

Failure if agent calls it primarily a conversion app or says mirror uploads.

### TC2: Help comprehension

Commands:

```bash
$TOASTER --help
$TOASTER config get
```

Expected:

- agent identifies `ingest --all --dry-run` before `ingest --all --yes`
- agent identifies `list --saved --dir <LIB>` for saved sessions

Potential Norman door: `list` defaults to native sessions, not saved sessions.

### TC3: Dry-run ingestion

Command:

```bash
$TOASTER ingest --all --dry-run --dir "$LIB"
```

Expected:

- exit 0
- JSON includes `action: save-all-dry-run`
- no `$LIB/sessions` created or no `toast.json` files written

Failure if dry run writes library sessions.

### TC4: Consent-gated ingestion

Command without consent:

```bash
$TOASTER ingest --all --dir "$LIB"
```

Expected in non-interactive mode:

- exit non-zero
- says cancelled / use `--yes`
- no sessions written

Command with consent:

```bash
$TOASTER ingest --all --yes --dir "$LIB"
```

Expected:

- writes `$LIB/index.json`
- writes `$LIB/sessions/<agent>/<slug>/toast.json`
- reports saved, skipped, and failed counts
- a second run should skip unchanged sessions

Run update again:

```bash
$TOASTER ingest --all --yes --dir "$LIB"
```

Expected:

- unchanged sessions are reported as `skipped`
- no duplicate session directories for the same source session
- use `--force` only when intentionally rewriting all saved artifacts

### TC5: Saved list

Command:

```bash
$TOASTER list --saved --dir "$LIB" | head
```

Expected:

- lists saved session names
- does not list native sessions unless `--saved` omitted

Norman door: agent may run `list` and think ingest failed because it sees native rows.

### TC6: Redaction dry-run

Pick first saved name:

```bash
SAVED=$($TOASTER list --saved --dir "$LIB" | head -1 | awk '{print $1}')
$TOASTER redact "$SAVED" --dir "$LIB" --dry-run
```

Expected:

- JSON includes `dryRun: true`
- no redacted output file written
- no alias vault created by dry-run alias previews

Also test:

```bash
before=$(find ~/.config/toaster -name aliases.json 2>/dev/null | wc -l)
$TOASTER redact "$SAVED" --dir "$LIB" --dry-run --alias
```

Expected: dry-run should not create/modify alias vault.

### TC7: Redacted artifact

Command:

```bash
$TOASTER redact "$SAVED" --dir "$LIB" --alias --out "$TMP/safe.toast.json"
```

Expected:

- writes `$TMP/safe.toast.json`
- writes `$TMP/safe.toast.redaction-report.json` or documented report path
- report has no original span text
- alias vault exists locally only if `--alias` used

Check:

```bash
node -e 'const r=require(process.argv[1]); for (const f of r.fields) for (const s of f.spans) if (s.text) throw new Error("report leaks span text")' "$TMP/safe.toast.redaction-report.json"
```

### TC8: Cloud-safe mirror

Command without consent:

```bash
$TOASTER mirror --cloud-safe-local --dir "$LIB" --out "$MIRROR"
```

Expected:

- non-zero in non-interactive mode
- no mirror written or no session files

Command with consent:

```bash
$TOASTER mirror --cloud-safe-local --dir "$LIB" --out "$MIRROR" --alias --yes --limit 3
```

Expected:

- writes `$MIRROR/index.json`
- writes redacted `$MIRROR/sessions/.../toast.json`
- writes sanitized `redaction-report.json`
- does not include raw `sourcePath` in mirror metadata

### TC9: Resume saved session

Command:

```bash
$TOASTER resume "$SAVED" --dir "$LIB" --in claude
```

Expected:

- writes Claude native session under `~/.claude/projects/...`
- prints launch hint
- does not launch unless `--launch`

Failure if agent believes this only previews.

### TC10: OPF provider preflight

If `opf` is installed:

```bash
$TOASTER redact "$SAVED" --dir "$LIB" --provider opf --device cpu --dry-run
```

Expected:

- works, or falls back clearly if OPF errors
- no network after checkpoint is cached

If `opf` missing:

Expected:

- clear warning/error explaining install
- local fallback should be visible if used

Potential gap: current implementation falls back to local with warning; docs should say that.

## Error Ledger Format

Every issue found gets logged as:

```text
ID:
Severity: P0/P1/P2/P3
Area: docs/help/CLI/output/safety
Observed:
Expected:
Repro:
Fix:
Owner:
Status:
```

Severity:

- **P0**: can leak raw data/cloud confusion/silent unsafe write
- **P1**: blocks cleanroom completion
- **P2**: causes wrong command/extra failed attempts
- **P3**: wording/polish

## Expected Norman-Door Findings To Watch

1. `toaster list` vs `toaster list --saved`
   - likely confusion: native list vs library list
   - fix: add `toaster scan`; keep `toaster list` as legacy native listing for now

2. `save --all` wording
   - likely confusion: save from where?
   - fix: add preferred alias `toaster ingest --all`; keep `save` as legacy alias

3. `mirror --cloud-safe`
   - likely confusion: sounds like upload
   - fix: prefer `mirror --cloud-safe-local`; keep `--cloud-safe` as alias and output `uploads: false`

4. `resume`
   - likely confusion: writes target native files
   - possible fix: output `Wrote native Claude session:` before launch hint

5. `--alias`
   - likely hidden write to alias vault
   - possible fix: first-use warning and `toaster alias path`

6. OPF first use
   - likely surprise 2.6GB download and latency
   - possible fix: `toaster redaction doctor`; warn before download

7. Config defaults
   - likely absent config file but `config get` shows defaults
   - possible fix: `toaster config init`

## EOD Flush Plan

### By midday

- Run cleanroom A2E with temp library/mirror.
- Save fresh-agent trace as TOAST.
- Fill error ledger.
- Classify P0/P1/P2/P3.

### By afternoon

Fix all P0/P1:

- doc ambiguity that could cause raw sync/cloud confusion
- commands that write unexpectedly
- dry-run side effects
- consent gate failures

Fix quick P2s:

- help text
- command aliases
- output wording

### By EOD

Run full A2E again from scratch:

```bash
npm run build
npm test
npm pack --json
# install tarball into clean temp project
# run README-only prompt
# ingest/list/redact/mirror/resume
```

Exit criteria:

- cleanroom agent completes without external hints
- no P0/P1 open
- all command outputs identify read/write locations
- `--dry-run` writes nothing
- cloud-safe mirror is local-only and sanitized
- raw library remains local-only
- final report includes trace path and error ledger

## Final A2E Report Template

```text
A2E run id:
Date:
Package/tarball:
Temp project:
Raw test library:
Cloud-safe mirror:
Fresh-agent trace:

Result: pass/fail

Completed:
- install:
- dry-run ingest:
- confirmed ingest:
- list saved:
- redact dry-run:
- redact write:
- mirror:
- resume:

Read/write map observed:

Confusions/stalls:

Errors fixed:

Open issues:
```
