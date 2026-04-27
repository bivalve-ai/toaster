# Core A2E flow

You are testing whether a fresh agent can use Toaster from public docs and CLI help only.

Use the local package installed in this temp project. Do not inspect the Toaster source repository, private notes, old transcripts, or hidden maintainer context.

Use these paths:

```text
TOAST library: ./toast-library
Cloud-safe local mirror: ./toast-library-cloud
Redacted artifact: ./safe.toast.json
Report: ./A2E_REPORT.md
```

Complete this workflow:

```bash
./node_modules/.bin/toaster scan --limit 1
./node_modules/.bin/toaster ingest --all --dry-run --limit 1 --dir ./toast-library
./node_modules/.bin/toaster ingest --all --yes --limit 1 --dir ./toast-library
./node_modules/.bin/toaster list --saved --dir ./toast-library
./node_modules/.bin/toaster redact <saved-session> --dry-run --dir ./toast-library
./node_modules/.bin/toaster redact <saved-session> --alias --out ./safe.toast.json --dir ./toast-library
./node_modules/.bin/toaster mirror --cloud-safe-local --alias --yes --limit 1 --dir ./toast-library --out ./toast-library-cloud
./node_modules/.bin/toaster resume <saved-session> --in claude --dir ./toast-library
```

Do not pass `--launch`.

If a command fails, use `./node_modules/.bin/toaster --help` or the relevant command help and continue if safe. Record the failure and your interpretation in the report.

Write `A2E_REPORT.md` with:

- every command attempted
- whether each command succeeded
- the saved session name/id you used
- every important read location and write location reported by Toaster
- any confusing moment, guess, or misleading instruction
- whether raw, redacted, mirror, and alias-vault boundaries were clear
- final pass/fail judgment
