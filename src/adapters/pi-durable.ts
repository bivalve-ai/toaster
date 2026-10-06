// pi-durable adapter — reads one conversation of a pi-durable SQLite file (for
// example Agent Dock's ~/.dock/session.sqlite) as a Toast. Read-only: the file
// belongs to the process hosting the Harness; this adapter opens its own
// read-only connection, never writes, and refuses `write()`.
//
// Path: `/path/session.sqlite#<conversationId>`; without a fragment, the root
// conversation (id 1).
//
// What is read is the conversation's *context projection* — what the next
// model request would see — derived from the entries exactly as
// @earendil-works/pi-durable 1.0.4 does it (src/harness/context.ts):
//
//   1. Visible entries: the conversation's own, plus a fork parent's through
//      the fork entry, recursively.
//   2. H = the newest visible entry with a `head`; the range runs from H.head
//      (or the start) through the newest visible entry.
//   3. Edits of every entry in the range apply; per target, the newest wins.
//   4. Active entries are H followed by the range's non-head entries.
//   5. Each active entry contributes its `model` messages, or none for an
//      `omit` edit, or the edit's messages for a `replace`.
//   6. Assistant messages that stopped with aborted/error/deferred are dropped.
//   7. Each assistant's tool results are placed right after it in call order;
//      a missing result is synthesized as an error; unmatched results drop.
//
// Every visible entry is also kept verbatim as an event (`pi-durable.entry`),
// and every entry the projection left out is recorded as an info loss.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Provenance, Toast, ToastContentBlock, ToastEvent, ToastLoss, ToastTurn, ToastUsage } from "../schemas/toast.js";
import type { AgentAdapter, AgentCompat, DiscoveredSession, ReadOptions, WriteResult } from "./types.js";
import { makeLoss, sanitizeToolId } from "./shared.js";

const AGENT = "pi-durable" as const;
const ROOT_CONVERSATION_ID = 1;
const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

export const piDurableCompat: AgentCompat = {
  assistantUsage: "optional",
  toolInput: "object-only",
  writeCanonicalToolIds: false,
  thinking: "not-written",
};

/** Default location of Agent Dock's storage; override with DOCK_DIR. */
export function defaultPiDurablePath(): string {
  return join(process.env.DOCK_DIR ?? join(homedir(), ".dock"), "session.sqlite");
}

// ------- storage access (read-only) -------

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: unknown[]): Row[]; get(...params: unknown[]): Row | undefined }; close(): void };

async function openReadOnly(file: string): Promise<Db> {
  let sqlite: { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Db };
  try {
    sqlite = (await import("node:sqlite")) as unknown as typeof sqlite;
  } catch {
    throw new Error("the pi-durable adapter needs node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite)");
  }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

function splitPath(path: string): { file: string; conversationId: number } {
  const hash = path.lastIndexOf("#");
  if (hash < 0) return { file: path, conversationId: ROOT_CONVERSATION_ID };
  const id = Number(path.slice(hash + 1));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`bad conversation id in ${path}`);
  return { file: path.slice(0, hash), conversationId: id };
}

type EntryRecord = {
  id: number;
  conversationId: number;
  kind: string;
  model?: PiMessage[];
  data?: unknown;
  head?: number;
  edits?: Array<{ target: number; action: "omit" | "replace"; messages?: PiMessage[] }>;
  byTaskId?: number;
};

type ConversationRecord = { id: number; parent?: { conversationId: number; at: number }; owner?: { conversationId: number; taskId: number } };

function conversation(db: Db, id: number): ConversationRecord | undefined {
  const row = db.prepare("SELECT record FROM conversations WHERE id = ?").get(id);
  return row ? (JSON.parse(String(row.record)) as ConversationRecord) : undefined;
}

/** Visible entries of a conversation up to `maxId`, oldest first: its own plus its fork parent's through the fork point. */
function visibleEntries(db: Db, id: number, maxId = Number.MAX_SAFE_INTEGER): EntryRecord[] {
  const conv = conversation(db, id);
  if (!conv) throw new Error(`no conversation ${id}`);
  const inherited = conv.parent ? visibleEntries(db, conv.parent.conversationId, Math.min(conv.parent.at, maxId)) : [];
  const own = db
    .prepare("SELECT record FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id")
    .all(id, maxId)
    .map((row) => JSON.parse(String(row.record)) as EntryRecord);
  return [...inherited, ...own];
}

// ------- documents: latest value of a conversation document -------

const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

/** Apply decoded Chord ops (r s d a t p m) to a plain JSON value. Unknown ops throw. */
function applyOps(target: unknown, ops: unknown[]): unknown {
  let root = target;
  const parentOf = (path: unknown[]): [Record<string | number, unknown>, string | number] => {
    if (path.some((seg) => typeof seg === "string" && RESERVED.has(seg))) throw new Error("unsafe path");
    let node = root as Record<string | number, unknown>;
    for (const seg of path.slice(0, -1)) node = node[seg as string] as Record<string | number, unknown>;
    return [node, path[path.length - 1] as string | number];
  };
  const at = (path: unknown[]): unknown => (path.length === 0 ? root : (([p, k]) => p[k])(parentOf(path)));
  for (const raw of ops) {
    const op = raw as unknown[];
    switch (op[0]) {
      case "r": root = structuredClone(op[1]); break;
      case "s": { const [p, k] = parentOf(op[1] as unknown[]); p[k] = structuredClone(op[2]); break; }
      case "d": { const [p, k] = parentOf(op[1] as unknown[]); if (Array.isArray(p)) p.splice(Number(k), 1); else delete p[k]; break; }
      case "a": { const [p, k] = parentOf(op[1] as unknown[]); p[k] = String(p[k] ?? "") + String(op[2]); break; }
      case "t": { const [p, k] = parentOf(op[1] as unknown[]); p[k] = String(p[k] ?? "").slice(Number(op[2])); break; } // trims the front
      case "p": (at(op[1] as unknown[]) as unknown[]).splice(Number(op[2]), Number(op[3]), ...structuredClone(op[4] as unknown[])); break;
      case "m": { const arr = at(op[1] as unknown[]) as unknown[]; const old = [...arr]; (op[2] as number[]).forEach((from, i) => (arr[i] = old[from])); break; }
      default: throw new Error(`unknown op ${String(op[0])}`);
    }
  }
  return root;
}

/** The current value of a conversation-scoped singleton document, or undefined if it cannot be rebuilt. */
function conversationDoc(db: Db, conversationId: number, kind: string): Record<string, unknown> | undefined {
  const doc = db
    .prepare("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND owner_id = ? AND family = 0 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(JSON.stringify(kind), conversationId);
  if (!doc) return undefined;
  const revisions = db.prepare("SELECT kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(doc.id);
  let value: unknown;
  try {
    for (const r of revisions) value = r.kind === "base" ? JSON.parse(String(r.content)) : applyOps(value, JSON.parse(String(r.content)) as unknown[]);
  } catch {
    return undefined;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// ------- the context projection -------

type PiContent = { type: string; text?: string; thinking?: string; thinkingSignature?: string; redacted?: boolean; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string };
type PiMessage = {
  role: string;
  content: string | PiContent[];
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};
type Contributed = { message: PiMessage; entry: EntryRecord; synthesized?: boolean };

function project(entries: EntryRecord[], losses: ToastLoss[]): Contributed[] {
  if (entries.length === 0) return [];
  const head = [...entries].reverse().find((e) => e.head !== undefined && e.head !== null);
  const range = head ? entries.filter((e) => e.id >= head.head!) : entries;
  for (const e of entries) if (!range.includes(e)) losses.push(makeLoss("info", `entries[${e.id}]`, `${e.kind} is before the active context head ${head!.id}`));

  const edits = new Map<number, NonNullable<EntryRecord["edits"]>[number]>();
  for (const e of range) for (const edit of e.edits ?? []) edits.set(edit.target, edit);
  const active = head ? [head, ...range.filter((e) => e.head === undefined || e.head === null)] : range;
  for (const e of range) if (!active.includes(e)) losses.push(makeLoss("info", `entries[${e.id}]`, `${e.kind} is an older head marker superseded by ${head!.id}`));

  const contributed: Contributed[] = [];
  for (const entry of active) {
    const edit = edits.get(entry.id);
    if (edit?.action === "omit") {
      losses.push(makeLoss("info", `entries[${entry.id}]`, `${entry.kind} omitted from context by an edit`));
      continue;
    }
    const messages = edit?.action === "replace" ? edit.messages ?? [] : entry.model ?? [];
    if (messages.length === 0 && !edit) losses.push(makeLoss("info", `entries[${entry.id}]`, `${entry.kind} carries no model messages`));
    for (const message of messages) {
      if (message.role === "assistant" && EXCLUDED_STOP_REASONS.has(String(message.stopReason))) {
        losses.push(makeLoss("info", `entries[${entry.id}]`, `assistant message with stopReason ${message.stopReason} is not part of the context`));
        continue;
      }
      contributed.push({ message, entry });
    }
  }
  return orderToolResults(contributed, losses);
}

function orderToolResults(messages: Contributed[], losses: ToastLoss[]): Contributed[] {
  const ordered: Contributed[] = [];
  const placed = new Set<Contributed>();
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    if (item.message.role === "toolResult") continue;
    ordered.push(item);
    if (item.message.role !== "assistant" || typeof item.message.content === "string") continue;
    const calls = item.message.content.filter((c) => c.type === "toolCall");
    if (calls.length === 0) continue;
    const results = new Map<string, Contributed>();
    for (let next = i + 1; next < messages.length && messages[next].message.role !== "assistant"; next++) {
      const candidate = messages[next];
      if (candidate.message.role === "toolResult" && !results.has(String(candidate.message.toolCallId))) results.set(String(candidate.message.toolCallId), candidate);
    }
    for (const call of calls) {
      const result = results.get(String(call.id));
      if (result) {
        ordered.push(result);
        placed.add(result);
      } else {
        losses.push(makeLoss("info", `entries[${item.entry.id}]`, `tool call ${call.id} has no result; synthesized an error result as pi-durable does`));
        ordered.push({
          entry: item.entry,
          synthesized: true,
          message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: MISSING_RESULT_TEXT }], isError: true, timestamp: item.message.timestamp },
        });
      }
    }
  }
  for (const m of messages) {
    if (m.message.role === "toolResult" && !placed.has(m)) losses.push(makeLoss("info", `entries[${m.entry.id}]`, `tool result ${m.message.toolCallId} matches no preceding call; dropped as pi-durable does`));
  }
  return ordered;
}

// ------- messages → turns -------

function iso(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function blocks(content: string | PiContent[], path: string, losses: ToastLoss[]): ToastContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: ToastContentBlock[] = [];
  content.forEach((c, i) => {
    if (c.type === "text") out.push({ type: "text", text: c.text ?? "" });
    else if (c.type === "thinking") out.push({ type: "thinking", text: c.thinking ?? "", ...(c.thinkingSignature ? { signature: c.thinkingSignature } : {}), format: "pi" });
    else if (c.type === "toolCall") out.push({ type: "tool_call", id: sanitizeToolId(c.id), rawId: c.id, name: String(c.name ?? "unknown"), arguments: c.arguments ?? {} });
    else {
      out.push({ type: "unknown", originalType: c.type, value: c.type === "image" ? { type: "image", mimeType: c.mimeType } : c });
      losses.push(makeLoss("info", `${path}.content[${i}]`, `${c.type} content has no TOAST block`));
    }
  });
  return out;
}

function usage(u: PiMessage["usage"]): ToastUsage | undefined {
  if (!u) return undefined;
  return { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, totalTokens: u.totalTokens, costUsd: u.cost?.total };
}

function stopReason(s: string | undefined): ToastTurn["stopReason"] {
  if (!s) return undefined;
  if (s === "toolUse") return "tool_use";
  if (s === "aborted") return "cancelled";
  if (s === "stop" || s === "length" || s === "error") return s;
  return "unknown";
}

// ------- adapter -------

export const piDurableAdapter: AgentAdapter = {
  kind: AGENT,
  compat: piDurableCompat,

  async detect(path: string): Promise<boolean> {
    const { file } = splitPath(path);
    if (!existsSync(file)) return false;
    let db: Db | undefined;
    try {
      db = await openReadOnly(file);
      return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'durable_metadata'").get() !== undefined;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  },

  async list(): Promise<DiscoveredSession[]> {
    const file = defaultPiDurablePath();
    if (!existsSync(file)) return [];
    const s = statSync(file);
    const db = await openReadOnly(file);
    try {
      return db.prepare("SELECT id FROM conversations ORDER BY id").all().map((row) => {
        const id = Number(row.id);
        const cwd = conversationDoc(db, id, "pi.agent")?.cwd;
        return { agent: AGENT, path: `${file}#${id}`, id: String(id), mtime: s.mtime, bytes: s.size, ...(typeof cwd === "string" ? { cwd } : {}) };
      });
    } finally {
      db.close();
    }
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Toast> {
    const { file, conversationId } = splitPath(path);
    const db = await openReadOnly(file);
    try {
      const losses: ToastLoss[] = [];
      const entries = visibleEntries(db, conversationId);
      const agent = conversationDoc(db, conversationId, "pi.agent");
      const provider = conversationDoc(db, conversationId, "pi.provider");
      const prov = (entry: EntryRecord): Provenance => ({ agent: AGENT, path, rawType: entry.kind, rawId: String(entry.id) });

      const events: ToastEvent[] = entries.map((entry) => ({ id: `entry-${entry.id}`, type: "pi-durable.entry", value: entry, provenance: prov(entry) }));
      const turns: ToastTurn[] = [];
      const seen = new Map<number, number>();
      const fingerprint: { model?: string; provider?: string } = {};
      for (const { message, entry, synthesized } of project(entries, losses)) {
        const n = seen.get(entry.id) ?? 0;
        seen.set(entry.id, n + 1);
        const id = n === 0 ? `entry-${entry.id}` : `entry-${entry.id}-${n}`;
        const path = `turns[${turns.length}]`;
        const base = { id, parentId: turns.at(-1)?.id ?? null, timestamp: iso(message.timestamp), provenance: prov(entry), metadata: { entryKind: entry.kind, ...(synthesized ? { synthesized: true } : {}) } };
        if (message.role === "system") {
          losses.push(makeLoss("info", `entries[${entry.id}]`, "system prompt sections and tool declarations are not carried; the target agent has its own"));
          continue;
        }
        if (message.role === "toolResult") {
          turns.push({
            ...base,
            role: "tool",
            content: [{ type: "tool_result", toolCallId: sanitizeToolId(message.toolCallId), rawToolCallId: message.toolCallId, toolName: message.toolName, content: blocks(message.content, path, losses), isError: Boolean(message.isError) }],
          });
        } else if (message.role === "assistant") {
          fingerprint.model ??= message.model;
          fingerprint.provider ??= message.provider;
          turns.push({ ...base, role: "assistant", content: blocks(message.content, path, losses), model: message.model, provider: message.provider, stopReason: stopReason(message.stopReason), usage: usage(message.usage), metadata: { ...base.metadata, ...(message.api ? { api: message.api } : {}) } });
        } else if (message.role === "user") {
          turns.push({ ...base, role: "user", content: blocks(message.content, path, losses) });
        } else {
          losses.push(makeLoss("warning", `entries[${entry.id}]`, `message role ${message.role} has no TOAST role; dropped`));
        }
      }

      const cwd = typeof agent?.cwd === "string" ? agent.cwd : undefined;
      return {
        traceVersion: 1,
        id: typeof provider?.sessionId === "string" ? provider.sessionId : `pi-durable-${conversationId}`,
        ...(cwd ? { cwd } : {}),
        createdAt: turns.find((t) => t.timestamp)?.timestamp,
        source: { agent: AGENT, path },
        agents: [{ agent: AGENT, ...fingerprint }],
        turns,
        events,
        metadata: { conversationId, ...(agent ? { agent } : {}) },
        losses,
      };
    } finally {
      db.close();
    }
  },

  async write(): Promise<WriteResult> {
    throw new Error("not supported: pi-durable storage is written only by its Harness (Agent Dock imports TOAST itself)");
  },

  defaultPath(): string {
    return defaultPiDurablePath();
  },
};
