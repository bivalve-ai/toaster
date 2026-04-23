# toaster

> Your agent sessions don't have to be agent-specific.

Toaster translates AI-agent session files between formats so you can keep a conversation going across tools. Today it handles **pi ↔ Claude Code**. More formats coming (OpenAI Codex, aider, gemini-cli — PRs welcome).

Every session becomes **TOAST** — the portable intermediary every agent's format translates to and from.

The name is the anagram of Rosetta; the metaphor is the same.

---

## TOAST

> **T**ransferable **O**pen **A**gent **S**ession **T**race

- **Transferable** — portability is the value prop. Move conversations across agents without re-explaining yourself.
- **Open** — open-source implementation, open format, open to any agent.
- **Agent** — what it's about. Session data from AI agents, not generic chat logs.
- **Session** — what it *is*. One conversation = one TOAST. The unit of data.
- **Trace** — the terminology agent tooling and LLM observability are converging on. A TOAST is a trace you can resume, not just inspect.

Data flow:

```
pi session  ──read──▶  TOAST  ──write──▶  claude session
claude session  ──read──▶  TOAST  ──write──▶  pi session
codex session  ──read──▶  TOAST  ──write──▶  (any supported agent)
```

Native formats never talk to each other directly. Everything routes through TOAST.

---

## Why

You're mid-conversation with one agent, the other agent is better at what you need next, but switching means you re-explain everything — the files you're in, the thing you tried, the thing it almost worked. That friction keeps people locked into whichever tool they started the day with.

Toaster fixes that by moving the conversation, not the human.

---

## Install

```
npm i -g toaster-cli
```

Or ephemeral:

```
npx toaster-cli list
```

The binary is `toaster` either way.

Requires Node 22+.

---

## Use

### See what sessions you have

```
toaster list
toaster list --pi
toaster list --claude
```

Prints one row per session: id, agent, age, size, cwd. Most-recent first.

### Pi → Claude Code

```
toaster pi-to-claude <session-id-or-path>
```

Writes a claude-format JSONL at `~/.claude/projects/<cwd>/<new-id>.jsonl` and prints the resume command:

```
→ claude --resume <new-id>   (from /your/project)
```

`cd` into the cwd, run it. The conversation picks up where you left off.

### Claude Code → Pi

```
toaster claude-to-pi <session-id-or-path>
```

Writes a pi-format JSONL at `~/.pi/agent/sessions/--<cwd-encoded>--/<ts>_<id>.jsonl` and prints the pi resume command.

---

## What it actually does

Agent session files are JSONL — one event per line — but the schemas differ:

| | pi | Claude Code |
|---|---|---|
| location | `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` | `~/.claude/projects/<cwd>/<id>.jsonl` |
| cwd encoding | `--a-b-c--` | `-a-b-c` |
| event types | `session`, `message`, `model_change`, … | `user`, `assistant`, `permission-mode`, `file-history-snapshot`, … |
| tool call block | `{type:"toolCall", id, name, arguments}` | `{type:"tool_use", id, name, input}` |
| tool result | role="toolResult" message | role="user" with `tool_result` block inside |
| tool id format | pi composite (can contain `|`) | must match `/^[a-zA-Z0-9_-]+$/` (Anthropic API requirement) |

Toaster reads the source format, maps events + sanitizes ids, and writes the target format with a new id in the right place on disk. The receiving agent's `--resume <id>` picks it up as if it had written the file itself.

---

## Library use

```ts
import { migratePiSessionToClaude, discoverSessions } from "toaster-cli";

const sessions = await discoverSessions("pi");
const latest = sessions[0];
const result = await migratePiSessionToClaude(latest.path);
console.log(result.sessionId); // → resume via `claude --resume ${result.sessionId}`
```

Full exports: `migratePiSessionToClaude`, `translatePiToClaudeSession`, `migrateClaudeSessionToPi`, `normalizeClaudeJSONL`, `discoverSessions`, plus the schema types.

---

## Honest caveats

- **Lossy.** Pi meta-events (model changes, thinking-level changes) and Claude's file-history snapshots are dropped by default. Tool results are preserved as text; any binary payloads get stringified.
- **Tool-name collisions.** Pi's `bash` ≠ Claude Code's `Bash`. Resume works (the receiving agent reads the result and continues); live re-invocation of the same tool would need a name-mapping layer that isn't here yet.
- **Schema-reverse-engineered.** Neither pi nor Claude Code publishes its session format as a public contract. A patch release could break this. Pin agent versions in your workflow until we add version detection.
- **Security: arbitrary content.** A hand-crafted session could inject prompts or fake tool results on resume. Don't run `toaster` on untrusted JSONL files from strangers without review.

---

## Roadmap

- Aider, codex, gemini-cli translators.
- Canonical intermediate representation (IR) — today toaster does pairwise translation. N-agent support needs normalize-in-the-middle.
- Fidelity scoring — tell the user before they resume how much of the source was preserved.
- `toaster inspect <session>` — human-readable turn-by-turn view.
- `toaster watch` — auto-mirror new pi sessions as claude sessions (for people who want both to stay in sync).

---

## Contributing

The two things that move this project forward fastest are:

1. **A session dump from an agent we don't yet support**, plus enough context on the format that we can write a translator.
2. **Round-trip failures on real long sessions.** Attach the session, describe what broke. These drive the hard fixes.

PRs welcome. MIT license.
