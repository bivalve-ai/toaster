# Adding an adapter

Adapters teach Toaster how to read and write one native agent session format. They should translate through TOAST, not directly to another agent.

The shape is:

```text
native session -> adapter.read() -> TOAST -> adapter.write() -> native session
```

That keeps the system at one adapter per agent instead of pairwise translators between every agent pair.

## Files to add

A typical adapter touches these files:

```text
src/adapters/<agent>.ts        # read/write/validate/default paths
src/schemas/<agent>.ts         # native TypeScript types, if useful
src/adapters/index.ts          # registration
src/adapters/types.ts          # AgentKind, if adding a new enum value
tests/<agent>.test.ts          # synthetic fixtures and round trips
spec/toast-v0.1.md             # only if TOAST itself must change
```

If the native format is simple, a separate schema file is optional. If the native format has many event types, keep those native types out of the adapter body.

## Adapter contract

Adapters implement the shared `AgentAdapter` interface from `src/adapters/types.ts`.

At minimum, an adapter should provide:

```ts
export const myAgentAdapter: AgentAdapter = {
  agent: "my-agent",
  defaultSessionDirs() {
    return [join(homedir(), ".my-agent", "sessions")];
  },
  async detect(path) {
    // Return true when this adapter can read the file.
  },
  async read(path) {
    // Parse native format into Toast.
  },
  async write(toast, options) {
    // Write Toast into this agent's native format.
  },
  validateWrite(toast, options) {
    // Report errors/warnings before writing, when possible.
  },
};
```

Then register it in `src/adapters/index.ts` so discovery, translation, resume, corpus tests, and library ingest can find it.

## Reading into TOAST

When reading a native file, preserve what you can directly and record what you cannot.

Use TOAST turns for conversation history. Use content blocks for text, thinking, tool calls, tool results, notes, and unknown native blocks. Use `events` for records that are not really conversation turns, such as model changes, permission changes, token-count updates, or session metadata records.

Every turn should carry provenance when possible:

```ts
provenance: {
  agent: "my-agent",
  path,
  line,
  nativeId,
}
```

If the source has data that TOAST does not model directly, prefer preserving it in `metadata`, `events`, or an `unknown` block before dropping it.

## Writing from TOAST

When writing, make the target agent able to resume or inspect the session using its own native files.

Some TOAST content will not map perfectly. For example, one agent may require object-only tool inputs while another persisted a string. One agent may support signed thinking blocks while another cannot validate those signatures. In those cases, adapt conservatively and record a loss.

A write result should include the target path, target agent, session id, cwd, turn count, event count, and losses.

## Loss records

Never silently drop source data. Use a loss record when an adapter cannot preserve something exactly:

```ts
{
  severity: "warning",
  path: "turns[3].content[1]",
  reason: "Target agent does not support this thinking signature format",
  value: originalValue,
}
```

Use `info` for harmless normalization, `warning` for lossy downgrades, and `error` for issues that make a strict write unsafe.

## Detection and discovery

Detection should be conservative. It is better to return false than to parse an unrelated JSON file as a session.

Discovery should read from the agent's normal local session store when one exists. If an agent only has export files, document that clearly in README and tests.

`toaster scan` must remain read-only. Discovery should never write files.

## Tests

Do not commit private real sessions. Build small synthetic fixtures that preserve the native shape needed for the test.

Good adapter tests cover:

- detection of native files
- reading important native event/content shapes
- writing TOAST into the native format
- reading the written file back
- tool-call/tool-result linkage
- non-object tool inputs, if the native format allows them
- unknown or unsupported native records becoming losses, events, notes, or unknown blocks

Run:

```bash
npm run build
npm test
npm run check
```

## Example workflow

For a new agent named `acme`:

```text
1. Add `acme` to AgentKind.
2. Add native types in `src/schemas/acme.ts` if needed.
3. Implement `src/adapters/acme.ts`.
4. Register it in `src/adapters/index.ts`.
5. Add `tests/acme.test.ts` with synthetic native sessions.
6. Update README's supported sources.
7. Run `npm run check`.
```

Keep the first adapter PR small. A reader should be able to inspect the fixture, understand the native shape, and see exactly how it maps into TOAST.
