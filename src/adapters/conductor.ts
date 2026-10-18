// Conductor adapter — reads one session of Conductor's SQLite store
// (~/Library/Application Support/com.conductor.app/conductor.db) as a Toast.
// Read-only: the file belongs to the running Conductor app; this adapter opens
// its own read-only connection, never writes, and refuses `write()`.
//
// Path: `/path/conductor.db#<sessionId>` (Conductor's session id, not the
// agent's). A database holds every session of every workspace, so the fragment
// is required.
//
// Conductor keeps a session as rows of `session_messages`, oldest first:
//
//   - role=user: the prompt as plain text, exactly as the person sent it.
//   - role=assistant: one Claude Agent SDK stream message as JSON. Conductor
//     runs Codex through the same shape, so one mapping covers both agents.
//
// Stream messages map like Claude Code transcripts: `assistant` messages
// (several per reply, sharing message.id) coalesce into one turn, `user`
// messages carrying tool_result blocks become tool turns, and messages with a
// parent_tool_use_id belong to that tool call's subagent. `result` messages and
// the system messages that carry content (init, hook output, task
// notifications, compaction, retries) are kept as events. The rest of the stream
// is progress ticks (thinking tokens, task and hook progress, state changes);
// each kind is counted into one info loss rather than carried.
//
// This store can outlive an agent's own transcripts (Claude Code prunes
// ~/.claude/projects after cleanupPeriodDays), so the same conversation may be
// discoverable here and in the agent's adapter. `metadata.nativeSessionId` holds
// the agent's own session id for matching them up.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Provenance, Toast, ToastEvent, ToastLoss, ToastTurn } from "../schemas/toast.js";
import type { AgentAdapter, AgentCompat, DiscoveredSession, ReadOptions, WriteResult } from "./types.js";
import { inferProvider, mapClaudeStopReason, mapClaudeUsage, stringifyToolContent } from "./claude.js";
import { makeLoss, sanitizeToolId } from "./shared.js";

const AGENT = "conductor" as const;
const KEPT_SYSTEM_SUBTYPES = new Set(["init", "compact_boundary", "api_retry", "status", "hook_response", "task_notification"]);

export const conductorCompat: AgentCompat = {
  assistantUsage: "optional",
  toolInput: "object-only",
  writeCanonicalToolIds: false,
  thinking: "not-written",
};

/** Default location of Conductor's store; override with CONDUCTOR_DB. */
export function defaultConductorPath(): string {
  return process.env.CONDUCTOR_DB ?? join(homedir(), "Library", "Application Support", "com.conductor.app", "conductor.db");
}

// ------- storage access (read-only) -------

type Row = Record<string, unknown>;
type Statement = { all(...params: unknown[]): Row[]; get(...params: unknown[]): Row | undefined; iterate?(...params: unknown[]): Iterable<Row> };
type Db = { prepare(sql: string): Statement; close(): void };

async function openReadOnly(file: string): Promise<Db> {
  let sqlite: { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Db };
  try {
    sqlite = (await import("node:sqlite")) as unknown as typeof sqlite;
  } catch {
    throw new Error("the conductor adapter needs node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite)");
  }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

function rows(db: Db, sql: string, ...params: unknown[]): Iterable<Row> {
  const statement = db.prepare(sql);
  return statement.iterate ? statement.iterate(...params) : statement.all(...params);
}

function splitPath(path: string): { file: string; sessionId: string } {
  const hash = path.lastIndexOf("#");
  if (hash < 0) throw new Error(`conductor path needs a session: ${path}#<sessionId>`);
  return { file: path.slice(0, hash), sessionId: path.slice(hash + 1) };
}

/** Conductor writes ISO strings for messages but SQLite datetime('now') for some defaults. */
function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// ------- stream messages → turns -------

type StreamBlock = { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type StreamMessage = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; role?: string; model?: string; content?: string | StreamBlock[]; stop_reason?: string | null; usage?: unknown };
  [key: string]: unknown;
};

class SessionReader {
  turns: ToastTurn[] = [];
  events: ToastEvent[] = [];
  losses: ToastLoss[] = [];
  model?: string;
  cwd?: string;
  private assistantByMessageId = new Map<string, { turn: ToastTurn; seen: Set<string> }>();
  private toolCalls = new Map<string, { name: string; turnId: string }>();
  private skipped = new Map<string, number>();

  constructor(private path: string) {}

  user(row: Row): void {
    const id = String(row.id);
    if (row.cancelled_at) {
      this.losses.push(makeLoss("info", `messages[${id}]`, "prompt was cancelled before it was sent"));
      return;
    }
    if (!row.sent_at) {
      this.losses.push(makeLoss("info", `messages[${id}]`, "prompt is still queued and has not been sent"));
      return;
    }
    const text = String(row.content ?? "");
    this.turns.push({
      id,
      parentId: this.turns.at(-1)?.id ?? null,
      role: "user",
      timestamp: iso(row.created_at),
      content: text ? [{ type: "text", text }] : [],
      provenance: this.provenance(row, "user"),
      metadata: { sentAt: iso(row.sent_at) },
    });
  }

  stream(row: Row): void {
    let message: StreamMessage;
    try {
      message = JSON.parse(String(row.content));
    } catch {
      this.losses.push(makeLoss("warning", `messages[${row.id}]`, "stream message is not valid JSON; skipped"));
      return;
    }
    if (message.type === "assistant" && message.message) this.assistant(row, message);
    else if (message.type === "user" && message.message) this.toolResults(row, message);
    else if (message.type === "result") this.event(row, message, "result", withoutResultText(message));
    else if (message.type === "error") this.event(row, message, "error", message);
    else if (message.type === "system" && KEPT_SYSTEM_SUBTYPES.has(String(message.subtype))) {
      if (message.subtype === "init") {
        this.cwd ??= str(message.cwd);
        this.model ??= str(message.model);
      }
      this.event(row, message, `system:${message.subtype}`, message);
    } else {
      const kind = message.subtype ? `${message.type}:${message.subtype}` : String(message.type);
      this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + 1);
    }
  }

  finish(): void {
    for (const [kind, count] of this.skipped) {
      this.losses.push(makeLoss("info", "messages[]", `${count} ${kind} stream message(s) are progress ticks; not carried`));
    }
  }

  private assistant(row: Row, message: StreamMessage): void {
    const msg = message.message!;
    const key = msg.id ?? message.uuid ?? String(row.id);
    let state = this.assistantByMessageId.get(key);
    if (!state) {
      const turn: ToastTurn = {
        id: message.uuid ?? String(row.id),
        parentId: this.turns.at(-1)?.id ?? null,
        role: "assistant",
        timestamp: iso(row.created_at),
        content: [],
        model: msg.model,
        provider: inferProvider(msg.model),
        stopReason: mapClaudeStopReason(msg.stop_reason),
        usage: mapClaudeUsage(msg.usage),
        provenance: this.provenance(row, "assistant"),
        metadata: { messageId: msg.id },
        ...this.subagent(message),
      };
      state = { turn, seen: new Set() };
      this.assistantByMessageId.set(key, state);
      this.turns.push(turn);
      this.model ??= msg.model;
    } else {
      state.turn.stopReason ??= mapClaudeStopReason(msg.stop_reason);
      state.turn.usage = mapClaudeUsage(msg.usage) ?? state.turn.usage;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : msg.content ? [{ type: "text", text: msg.content }] : [];
    for (const b of blocks) {
      const blockKey = b.type === "tool_use" ? `tool:${b.id}` : `${b.type}:${b.text ?? b.thinking ?? JSON.stringify(b)}`;
      if (state.seen.has(blockKey)) continue;
      state.seen.add(blockKey);
      const path = `turns[${this.turns.indexOf(state.turn)}].content[${state.turn.content.length}]`;
      if (b.type === "text") state.turn.content.push({ type: "text", text: b.text ?? "" });
      else if (b.type === "thinking") state.turn.content.push({ type: "thinking", text: b.thinking ?? "", ...(b.signature ? { signature: b.signature } : {}), format: "anthropic" });
      else if (b.type === "tool_use" && b.id && b.name) {
        state.turn.content.push({ type: "tool_call", id: sanitizeToolId(b.id), rawId: b.id, name: b.name, arguments: b.input ?? {} });
        this.toolCalls.set(b.id, { name: b.name, turnId: state.turn.id });
      } else {
        state.turn.content.push({ type: "unknown", originalType: b.type, value: b });
        this.losses.push(makeLoss("info", path, `${b.type} content has no TOAST block`));
      }
    }
  }

  private toolResults(row: Row, message: StreamMessage): void {
    const content = message.message!.content;
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b.type === "tool_result");
    results.forEach((b, i) => {
      const rawId = String(b.tool_use_id);
      this.turns.push({
        id: i === 0 ? message.uuid ?? String(row.id) : `${message.uuid ?? row.id}-${i}`,
        parentId: this.turns.at(-1)?.id ?? null,
        role: "tool",
        timestamp: iso(row.created_at),
        content: [{
          type: "tool_result",
          toolCallId: sanitizeToolId(rawId),
          rawToolCallId: rawId,
          toolName: this.toolCalls.get(rawId)?.name,
          content: [{ type: "text", text: stringifyToolContent(b.content) }],
          isError: Boolean(b.is_error),
        }],
        provenance: this.provenance(row, "user"),
        metadata: {},
        ...this.subagent(message),
      });
    });
    const text = typeof content === "string" ? content : blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (text) {
      // The SDK echoes text the harness injected (skill bodies, interrupts); the person's own prompt is the role=user row.
      this.turns.push({
        id: `${message.uuid ?? row.id}-text`,
        parentId: this.turns.at(-1)?.id ?? null,
        role: "user",
        timestamp: iso(row.created_at),
        content: [{ type: "text", text }],
        provenance: this.provenance(row, "user"),
        metadata: { injected: true },
        ...this.subagent(message),
      });
    }
  }

  private subagent(message: StreamMessage): Pick<ToastTurn, "subagent"> | Record<string, never> {
    const parent = message.parent_tool_use_id;
    if (!parent) return {};
    return { subagent: { id: parent, spawnedByTurnId: this.toolCalls.get(parent)?.turnId ?? parent, origin: "claude-sidechain" } };
  }

  private event(row: Row, message: StreamMessage, type: string, value: unknown): void {
    this.events.push({ id: message.uuid ?? String(row.id), type, timestamp: iso(row.created_at), value, provenance: this.provenance(row, type) });
  }

  private provenance(row: Row, rawType: string): Provenance {
    return { agent: AGENT, path: this.path, rawType, rawId: String(row.id) };
  }
}

/** A result message repeats the reply's final text in `result`; the assistant turn already carries it. */
function withoutResultText(message: StreamMessage): Record<string, unknown> {
  const { result: _duplicate, ...rest } = message;
  return rest;
}

function providerForAgentType(agentType: unknown, model: string | undefined): string | undefined {
  if (agentType === "claude") return "anthropic";
  if (agentType === "codex") return "openai";
  return inferProvider(model);
}

// ------- adapter -------

const SESSION_SQL = `
  SELECT s.id, s.title, s.model, s.agent_type, s.claude_session_id, s.created_at,
         w.workspace_path, w.directory_name, w.branch, w.state, r.name AS repo_name, r.remote_url
  FROM sessions s
  LEFT JOIN workspaces w ON w.id = s.workspace_id
  LEFT JOIN repos r ON r.id = w.repository_id`;

export const conductorAdapter: AgentAdapter = {
  kind: AGENT,
  compat: conductorCompat,

  async detect(path: string): Promise<boolean> {
    const hash = path.lastIndexOf("#");
    const file = hash < 0 ? path : path.slice(0, hash);
    if (!existsSync(file)) return false;
    let db: Db | undefined;
    try {
      db = await openReadOnly(file);
      const found = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('session_messages', 'sessions', 'workspaces', 'repos')").get();
      return Number(found?.n) === 4;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  },

  async list(): Promise<DiscoveredSession[]> {
    const file = defaultConductorPath();
    if (!existsSync(file)) return [];
    const db = await openReadOnly(file);
    try {
      const out: DiscoveredSession[] = [];
      const sql = `
        SELECT s.id, w.workspace_path, MAX(m.created_at) AS last_at, SUM(LENGTH(m.content)) AS bytes
        FROM sessions s
        JOIN session_messages m ON m.session_id = s.id
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        GROUP BY s.id`;
      for (const row of rows(db, sql)) {
        const cwd = str(row.workspace_path);
        out.push({ agent: AGENT, path: `${file}#${row.id}`, id: String(row.id), mtime: new Date(iso(row.last_at) ?? 0), bytes: Number(row.bytes ?? 0), ...(cwd ? { cwd } : {}) });
      }
      return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    } finally {
      db.close();
    }
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Toast> {
    const { file, sessionId } = splitPath(path);
    const db = await openReadOnly(file);
    try {
      const session = db.prepare(`${SESSION_SQL} WHERE s.id = ?`).get(sessionId);
      if (!session) throw new Error(`no conductor session ${sessionId} in ${file}`);
      const reader = new SessionReader(path);
      for (const row of rows(db, "SELECT id, role, content, created_at, sent_at, cancelled_at FROM session_messages WHERE session_id = ? ORDER BY created_at, rowid", sessionId)) {
        if (row.role === "user") reader.user(row);
        else if (row.role === "assistant") reader.stream(row);
        else reader.losses.push(makeLoss("warning", `messages[${row.id}]`, `message role ${row.role} has no TOAST role; dropped`));
      }
      reader.finish();

      const model = reader.model ?? str(session.model);
      const cwd = reader.cwd ?? str(session.workspace_path);
      return {
        traceVersion: 1,
        id: sessionId,
        ...(cwd ? { cwd } : {}),
        createdAt: iso(session.created_at) ?? reader.turns[0]?.timestamp,
        source: { agent: AGENT, path },
        agents: [{ agent: AGENT, ...(model ? { model } : {}), provider: providerForAgentType(session.agent_type, model) }],
        turns: reader.turns,
        events: reader.events,
        metadata: {
          title: str(session.title),
          agentType: str(session.agent_type),
          nativeSessionId: str(session.claude_session_id),
          workspace: { name: str(session.directory_name), branch: str(session.branch), state: str(session.state), path: str(session.workspace_path) },
          repo: { name: str(session.repo_name), remoteUrl: str(session.remote_url) },
        },
        losses: reader.losses,
      };
    } finally {
      db.close();
    }
  },

  async write(): Promise<WriteResult> {
    throw new Error("not supported: conductor storage is written only by the Conductor app");
  },

  defaultPath(): string {
    return defaultConductorPath();
  },
};
