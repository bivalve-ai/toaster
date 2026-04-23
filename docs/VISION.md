# Vision

## The moment

We're in a Cambrian explosion of agents. Claude Code, pi, OpenAI Codex, Cursor, aider, Continue, Amp, Gemini CLI — each great at different things, each shipping weekly, each trapping your conversations inside its own session format.

Every dev trying more than one tool knows the feeling: you build up context in one agent, you switch to another for the next task, and you start from zero. Re-explain the codebase. Re-describe the constraints. Re-paste the thing you already tried. That friction is the silent tax on using the best tool for each job.

## Observability ≠ portability

A generation of tools has emerged to *watch* agents — LangSmith, Phoenix, Braintrust, Langfuse, OpenTelemetry's LLM semconv. They all call their records "traces."

That's necessary work, but it's a different problem. Observability is about inspecting what happened. **Portability is about moving what happened to another tool.** Watching isn't moving.

The category we care about doesn't exist yet. There's no standard, no shared format, no convention for "a conversation, agent-independent, reloadable anywhere." We think there should be.

## Files over formats

Think about Obsidian. Your notes are plain markdown files on your disk. The application is a reader. If Obsidian disappears tomorrow, your notes don't. The files are the substance; the tools come and go.

That's the model we want for agent conversations. Your session is a file. Any agent can read it. Any tool can read it. It lives on your disk, in your git repo, in your cloud drive — wherever you keep files. The agent is a runtime; the file is the truth.

Session data trapped inside vendor databases is the opposite of this. Proprietary resume formats that only one CLI can decode is the opposite of this. A cloud dashboard that shows you "your history" but doesn't let you take it with you is the opposite of this.

**TOAST is how we make files-over-formats real for agent sessions.**

## Compounding learning

The hidden cost of locked-in sessions isn't just friction. It's that **learning doesn't compound.**

Today's best answer to "how does my agent remember?" is CLAUDE.md — a markdown file you hand-edit with things you want your agent to remember. It's static. It's single-agent. It's per-project. It requires you to decide, in advance, what's worth remembering.

The actual valuable shape is the opposite:
- **Dynamic** (updated by usage, not by hand).
- **Cross-agent** (what you figured out in pi helps you the next time in claude).
- **Cross-modality** (what you decided in chat informs what happens in the terminal).
- **Cross-project** (patterns and preferences follow you across codebases).

A CLAUDE.md is a local maximum. The real prize is a **personal memory that compounds across every session, every agent, every context.**

And here's the part that makes this tractable: compounding learning is only hard without a portable format. With one — with TOAST — a memory service can consume all your sessions uniformly, build one index, and serve relevant context to any agent. Without it, you'd need N memory services (one per agent format). Nobody builds that.

## What TOAST unlocks

```
                                      ┌──────────────┐
                                      │   Agents     │
                                      │ pi, claude,  │
                                      │ codex, …     │
                                      └──────┬───────┘
                                             │ sessions
                                             ▼
                                      ┌──────────────┐
                                      │    TOAST     │
                                      │   (files)    │
                                      └──────┬───────┘
                      ┌──────────────────────┼──────────────────────┐
                      ▼                      ▼                      ▼
               ┌────────────┐        ┌────────────┐          ┌────────────┐
               │ portability│        │   memory   │          │observability│
               │ (switching)│        │(pre-warming)│          │ (existing) │
               └────────────┘        └────────────┘          └────────────┘
```

A portable format turns "what happened" into something many layers can consume:

1. **Portability** — switch agents without losing context. Today's first feature.
2. **Memory / pre-warming** — your next session, in any agent, starts with relevant context from every prior session automatically. *This is what compounds.*
3. **Observability** — existing tools can ingest TOAST too. Not our focus, but not mutually exclusive.
4. **Sharing and collaboration** — a conversation becomes a file you can send to a teammate, commit to git, review in a PR, archive.
5. **Personal search** — "what did I discuss about auth six months ago?" across every agent you've ever used.

Each layer is its own product. All of them depend on the format.

## Why we think we can win this

Someone is going to define the portable agent session format. The first credible implementation with real adoption sets the convention. A few things in our favor:

- **We're building from the trenches.** Toaster was extracted from a real product (bivalve) that needed cross-agent portability for shared terminals. The format wasn't designed in a vacuum.
- **We're starting open.** Open-source implementation, open format, no proprietary extensions. The adopters' risk is low; the contributors' surface is wide.
- **We're pointing at memory, not just translation.** Most projects in this space are either format translators (boring) or memory services tied to one agent (narrow). Both together is a product.
- **The name is right.** TOAST is memorable, the metaphor is coherent, and the acronym is load-bearing: Transferable, Open, Agent, Session, Trace. Each word justifies itself.

## The arc

- **Today** — toaster-cli translates pi ↔ Claude Code end-to-end. Format works. Resume works. Losses tracked.
- **Soon** — Codex adapter, then aider / cursor / gemini. "N agents" becomes credible.
- **Next** — `toaster watch` tails active sessions and emits TOAST continuously. Sessions become real-time files, not after-the-fact exports.
- **Then** — memory layer (tide generalized to consume TOAST). Cross-agent pre-warming. The compounding-learning primitive made real, first as a local tool, then as an optional cloud service.
- **Eventually** — a cloud offering adds sync, hosted memory, search, and a web UI. The open-source tool keeps working standalone forever. Two tiers, one format.

## What this is not

- Not an agent. We don't execute sessions; we move them.
- Not an observability tool. We don't compete with LangSmith or Phoenix. They inspect; we port.
- Not a vendor play. The format is open; the data stays with the user. The paid product earns its keep on top, not by gatekeeping what's underneath.
- Not a year-long roadmap masquerading as a format. TOAST ships today, works today, has real users today. Everything else is layered onto a format that already exists.

## The short version

Agents are multiplying. Your conversations are being trapped inside each one. Toaster makes them files. Files are portable. Portable conversations enable memory that compounds across every tool you use.

*Files over formats. Memory over moments. Learning that compounds.*
