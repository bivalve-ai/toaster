# A2E Cleanroom Fix Report

Date: 2026-04-26

## Summary

Fixed the highest-risk Norman-door issues found in the A2E plan and ran a clean temp-project smoke test from a packed tarball.

## Fixes Applied

### 1. Native scan vs library list

Added:

```bash
toaster scan [--app <agent>] [--limit <n>]
```

`scan` is explicitly read-only and prints JSON with:

- `localOnly: true`
- `reads`
- `writes: []`
- `byAgent`
- discovered sessions

`toaster list` remains as a legacy native listing. Docs now teach:

```bash
toaster scan
toaster list --saved
```

### 2. Ingest wording

Added preferred command:

```bash
toaster ingest ...
toaster ingest --all --dry-run
toaster ingest --all --yes
```

`toaster save ...` remains as a legacy alias.

`ingest --all --dry-run` now prints explicit `reads` and `writes: []`.

`ingest --all --yes` prints explicit raw library write location and now behaves as an incremental update: unchanged sessions are skipped by source mtime/bytes unless `--force` is used.

### 3. Cloud-safe mirror sounds like upload

Added preferred flag:

```bash
toaster mirror --cloud-safe-local
```

`--cloud-safe` remains as an alias.

Mirror output now includes:

```json
{
  "localOnly": true,
  "uploads": false,
  "writes": [{ "kind": "redacted-aliased-local-mirror", "path": "..." }]
}
```

### 4. Resume writes target native files

`toaster resume` output now includes explicit read/write map and note:

```json
{
  "action": "resume",
  "writes": [{ "kind": "claude-native-session", "path": "..." }],
  "note": "resume writes a target-native session file; it does not launch unless --launch is passed"
}
```

### 5. Redaction/alias hidden writes

`toaster redact` output now includes explicit writes:

- redacted TOAST path
- sanitized report path
- local alias vault path when `--alias` is used

Dry-run alias previews no longer create/read the real alias vault.

### 6. Docs/test plan updated

Updated:

- README command framing
- `docs/A2E_CLEANROOM_TEST_PLAN.md`
- CLI help text

## A2E Smoke Test From Packed Tarball

Tarball:

```text
/Users/austinesecson/Development/toaster/toaster-cli-0.0.1.tgz
```

Temp project:

```text
/tmp/toaster-a2e-fix.k1xhqS
```

Test library:

```text
/tmp/toaster-a2e-fix.k1xhqS/toast-library
```

Test mirror:

```text
/tmp/toaster-a2e-fix.k1xhqS/toast-library-cloud
```

Commands run through installed package:

```bash
toaster --help
toaster scan --limit 2
toaster ingest --all --dry-run --limit 2 --dir "$LIB"
toaster ingest --all --limit 1 --dir "$LIB"        # expected failure without --yes
toaster ingest --all --yes --limit 2 --dir "$LIB"
toaster list --saved --dir "$LIB"
toaster redact "$SAVED" --dir "$LIB" --dry-run --alias
toaster redact "$SAVED" --dir "$LIB" --alias --out "$TMP/safe.toast.json"
toaster mirror --cloud-safe-local --dir "$LIB" --out "$MIRROR" --alias --yes --limit 1
toaster resume "$SAVED" --dir "$LIB" --in claude
```

Observed:

```text
no_yes_exit: 1
library toast files: 2
mirror toast files: 1
redaction report span text leaks: 0
```

Read/write map observed:

```text
scan:        writes=[]
ingest dry:  writes=[]
ingest:      writes raw-toast-library; second run skips unchanged sessions
redact dry:  writes=[]
redact:      writes redacted-toast, sanitized-redaction-report, local-alias-vault
mirror:      writes redacted-aliased-local-mirror, uploads=false
resume:      writes claude-native-session
```

Resume wrote this test Claude session:

```text
/Users/austinesecson/.claude/projects/-Users-austinesecson-Development/fe2ae132-2aaf-455f-aea7-89266d3c3341.jsonl
```

Claude was not launched.

## Validation

```text
npm run build: passed
npm test: passed, 18/18
```

## Remaining Open Issues

### P2: OPF first-use warning

`--provider opf` can trigger a large first-use download through OPF if the checkpoint is missing. We should add a dedicated command:

```bash
toaster redaction doctor
```

or preflight warning before OPF use.

### P2: Fresh-agent findings to fix

The true fresh-agent trace has now run. Remaining findings are minor wording/help issues listed below in the True Fresh-Agent A2E Run section.

### P3: `toaster list` legacy ambiguity

Docs now steer users to `scan` and `list --saved`, but `toaster list` still lists native sessions for backwards compatibility. Later we may flip default or add a deprecation warning.

## True Fresh-Agent A2E Run

Provider/model:

```text
pi --provider openai-codex --model gpt-5.4-mini
```

Temp project:

```text
/tmp/toaster-fresh-agent.CFEGfF
```

Fresh-agent trace saved in test library:

```text
/tmp/toaster-fresh-agent.CFEGfF/toast-library/sessions/pi/a2e-cleanroom-agent-trace/toast.json
```

Exported trace:

```text
/tmp/toaster-fresh-agent.CFEGfF/a2e-cleanroom-agent-trace.toast.json
```

Trace summary:

```text
turns: 22
events: 2
size: 94K
```

Result: pass.

The fresh agent completed the README-only flow without intervention:

```bash
toaster scan --limit 1
toaster ingest --all --limit 1 --dry-run --dir <LIB>
toaster ingest --all --limit 1 --yes --dir <LIB>
toaster list --saved --dir <LIB>
toaster redact <saved> --dry-run --dir <LIB>
toaster redact <saved> --alias --out <safe.toast.json> --dir <LIB>
toaster mirror --cloud-safe-local --alias --yes --dir <LIB> --out <MIRROR>
toaster resume <saved> --in claude --dir <LIB>
```

Observed Norman-door/confusion points from the fresh-agent final report:

1. README says default library is `~/toast-library`, while help expands it as `/Users/austinesecson/toast-library`. This is correct but slightly inconsistent.
2. `mirror` help did not mention `--limit`; the agent kept mirror small by ingesting only one session instead.
3. `redact --alias` writes `~/.config/toaster/aliases.json`, which the agent called out as easy to miss.

No observed confusion about:

- `scan` vs `list --saved`
- dry-run vs confirmed ingest
- cloud-safe mirror being local-only
- resume not launching Claude

Read/write map was correctly reported by the fresh agent.
