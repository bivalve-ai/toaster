# Philosophy

The non-negotiables. If a change breaks one of these, it probably shouldn't land.

---

## 1. Portability is the north star.

Every decision is weighed against: does this make TOAST more or less portable?

Portability means:
- A TOAST file written today is readable by every supported agent today, and readable by the same agents next year.
- A TOAST file moved to another machine Just Works — no server, no account, no daemon required.
- Anyone can write a new adapter without asking us for permission.

We chose *"trace"* as the format name partly because it's the term LLM tooling is converging on, and partly because it carries no brand. It belongs to the category, not to us.

## 2. TOAST stays lean.

TOAST is the raw, agent-agnostic shape of a conversation — turns, content blocks, tool calls, tool results, provenance. Nothing else.

**We will not** add to TOAST:
- Summaries
- Embeddings
- Topic tags
- Relevance scores
- Search indices
- Precomputed "memories"
- Anything that could be derived later from the raw conversation

Those are jobs for tools built *on top of* TOAST. A memory service reads TOAST files and produces its own index. A search tool reads TOAST files and builds its own database. The format stays the same whether or not those tools exist.

**Why this matters:** the moment TOAST bakes in someone's idea of what "memory" looks like, it stops being portable. Every downstream tool would need to implement a specific memory shape. Better to let a hundred memory services bloom — all reading the same raw format.

## 3. Nothing is silently dropped.

When a translation is lossy (it will be), record the loss in `losses[]` with a severity, a JSON path, and a human-readable reason. Users should always be able to see what was dropped on the way to their target agent.

If an adapter finds a field it doesn't understand, it preserves it in `metadata` or an unknown block. It doesn't throw it away.

## 4. Agent adapters are first-class, not forks.

Supporting a new agent is done by writing one more adapter in `src/adapters/`, not by forking the project. The adapter interface is the extension point.

Every supported agent has:
- A schema file that documents the on-disk format as we've reverse-engineered it
- An adapter that implements `read → Trace` and `write(Trace) → native`
- Round-trip fixtures so schema drift is caught early
- A section in `docs/SCHEMA.md` (eventually) explaining the mapping

Community PRs adding new adapters are welcome and valuable. The format itself doesn't need to grow; it needs to demonstrate breadth.

## 5. Users own their data. Always.

TOAST files are plain JSON. Every field is documented. Readable by a human with a text editor, parseable by `jq`, greppable, diffable, committable to git.

We will not:
- Encrypt TOAST files as a value-add
- Add proprietary binary encodings
- Require a server to interpret them
- Use vendor-specific schemas that only our tools can read

If the user wants to walk away from our tooling tomorrow, their data goes with them unchanged. This is the trust contract.

## 6. Provenance is table stakes, not an extra.

Every `Turn`, `Event`, and `Trace` carries a `Provenance` block. When a round-trip fails, when a format change breaks something, when a cross-agent replay does something unexpected — the user can trace the offending bytes back to the source file, line, and agent.

Debugging without provenance is guessing. We don't guess.

## 7. The translator is an honest broker.

Translators do not silently "fix" user intent. They do not merge content. They do not smooth over edge cases in a way the user hasn't approved.

If a thinking block can't be carried across agents (pi's `thinkingSignature` is not an Anthropic signature), it is *dropped and logged*, not synthesized. If a tool_result references an unknown tool_call, it is *preserved as-is*, not reattached to something plausible. The user gets a clear record of what happened and decides what to do.

## 8. N + N, never N × N.

Adapters talk to TOAST, never directly to each other. The moment someone writes `pi-to-codex.ts` we've lost. The orchestrator pairs any source adapter with any target adapter through the IR.

This is non-negotiable architecturally. Pairwise adapters are a trap that makes the project harder to evolve as agents come and go.

## 9. Versioning matters.

TOAST files carry `traceVersion`. When the format evolves (it will), adapters check the version and know how to handle it. We keep v1 stable for a long time, then ship v2 when absolutely necessary, then support reading both.

Silent schema changes are worse than loud ones. Version liberally. Break reading backward-compat rarely.

## 10. Don't bake in the cloud.

`toaster-cli` is local-first and will remain local-first. A user with no internet, no account, and no service dependency can translate, read, write, and resume sessions.

The cloud product is a separate thing that consumes TOAST files. It sits *on top of* the CLI. The CLI never depends on it.

---

## Things that are explicitly NOT goals

- Implementing agent runtimes. We translate; we don't execute.
- Being a drop-in replacement for any agent's resume behavior. We produce session files; the agent's own `--resume` does the work.
- Caring about message rendering / markdown / display. That's the agent's UI concern.
- Being perfect at day one. Lossy translation with tracked losses is far more useful than no translation.

If you catch yourself writing code that violates one of the above, stop and ask whether the feature belongs here at all.
