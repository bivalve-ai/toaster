# Contributing to Toaster

Thanks for wanting to contribute. This guide exists to save everyone time and keep the project useful.

## The One Rule

**You must understand your code.** If you can't explain what your changes do and how they interact with the rest of the system, your PR may be closed.

Using AI to write code is fine. You can gain understanding by interrogating an agent with access to the codebase until you understand the edge cases and effects of your changes. What's not fine is submitting agent-generated slop without that understanding.

If you use an agent, run it from the repository root so it sees the whole project context.

## First-Time Contributors

We use an approval gate for new contributors:

1. Open an issue describing what you want to change and why.
2. Keep it concise. If it doesn't fit on one screen, it's too long.
3. Write in your own voice, at least for the intro.
4. A maintainer will comment `lgtm` if approved.
5. Once approved, you can submit a PR.

This exists because AI makes it trivial to generate plausible-looking but low-quality contributions. The issue step lets us filter early.

## Before Submitting a PR

Run the checks:

```bash
npm run check
```

For the current coverage map and agent-to-end smoke flow, see [docs/testing.md](./docs/testing.md).

Or run the same steps manually:

```bash
npm run build
npm test
npm pack --dry-run
```

Do not commit generated artifacts or local data:

- `dist/`
- `dist-tests/`
- `node_modules/`
- `*.tgz`
- local session corpora or private agent sessions

Do not publish the package from a PR branch. Maintainers handle releases.

## Adapter Contributions

New agent adapters are welcome, but they need to be grounded in real session files and small synthetic fixtures.

Adapters should translate through TOAST. Do not add pairwise translators like `agent-a-to-agent-b` unless they are thin backwards-compatibility wrappers over the adapter path.

See [docs/adapters.md](./docs/adapters.md) for the adapter contract, expected files, loss-record guidance, and a small implementation checklist.

## Privacy and Fixtures

Agent sessions often contain source code, prompts, tool outputs, local paths, secrets, and private context.

Do not submit real private session files as fixtures. Reduce them to small synthetic examples that preserve the shape needed for the test without including sensitive content.

## Philosophy

Toaster's core should stay small and local-first.

If a feature belongs in downstream tooling rather than the TOAST format or adapter layer, keep it out of core. PRs that bloat the format, add network dependencies, or weaken local-first behavior will likely be rejected.

## Questions

Open an issue with the smallest useful description of the question or proposed change.
