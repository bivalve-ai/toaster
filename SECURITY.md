# Security Policy

Toaster is local-first software. The CLI/library does not require an account, does not include telemetry, and does not upload session data.

## Sensitive session data

Agent sessions and TOAST artifacts can contain source code, prompts, tool outputs, file paths, secrets, API keys, model responses, and private project context.

Please do not paste private session files into public issues, PRs, Discord, or other shared channels. If you need to report a parser or translation bug, reduce the session to a minimal synthetic fixture that preserves the shape of the problem without exposing sensitive content.

## Reporting vulnerabilities

If you find a security issue, please report it privately to the maintainers rather than opening a public issue with exploit details.

Until a dedicated security contact is published for this repository, open a minimal public issue saying you have a security report and need a private contact. Do not include secrets, private session data, or exploit payloads in the issue.

## Scope

Security-sensitive areas include:

- accidental network access or telemetry
- unsafe handling of local files
- generated sessions that could cause unexpected agent behavior on resume
- leaks of local paths, secrets, or private tool output in fixtures/logs
- package scripts or release steps that execute unexpected code

## Local-first boundary

Toaster reads and writes local files. If you resume a translated session in another agent, that agent may contact its model provider according to its own behavior. That provider traffic is outside Toaster's control.
