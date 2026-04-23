// Claude Code adapter — reads/writes ~/.claude/projects/<cwd-enc>/<id>.jsonl.
// Consolidates the read logic from the original claude-to-pi.ts and the write
// logic from the original pi-to-claude.ts, now both expressed in terms of the
// canonical Trace.

import { createReadStream } from "node:fs";
import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type {
  Trace,
  TraceTurn,
  TraceEvent,
  TraceContentBlock,
  Provenance,
  TraceLoss,
  TraceUsage,
} from "../schemas/trace.js";
import type {
  AgentAdapter,
  DiscoveredSession,
  ReadOptions,
  WriteOptions,
  WriteResult,
} from "./types.js";
import { sanitizeToolId } from "./pi.js";

const AGENT = "claude" as const;
const CLAUDE_VERSION_DEFAULT = "2.1.114";

// ------- helpers -------

function encodeCwdForClaude(cwd: string): string {
  return "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
}
function decodeCwdFromClaude(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
}

export function defaultClaudeSessionPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeCwdForClaude(cwd), `${sessionId}.jsonl`);
}

function makeLoss(severity: TraceLoss["severity"], path: string, reason: string, value?: unknown): TraceLoss {
  return { severity, path, reason, value };
}

// ------- adapter -------

export const claudeAdapter: AgentAdapter = {
  kind: AGENT,

  async detect(path: string): Promise<boolean> {
    try {
      const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as { type?: string; sessionId?: string };
          rl.close();
          return d.type === "permission-mode" || d.type === "file-history-snapshot" || d.type === "user" || d.type === "assistant";
        } catch {
          rl.close();
          return false;
        }
      }
    } catch { /* ignore */ }
    return false;
  },

  async list(): Promise<DiscoveredSession[]> {
    const root = join(homedir(), ".claude", "projects");
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    const dirs = await readdir(root, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const cwd = decodeCwdFromClaude(d.name);
      const files = await readdir(join(root, d.name));
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(root, d.name, f);
        const s = await stat(full);
        const id = f.replace(/\.jsonl$/, "");
        out.push({ agent: AGENT, path: full, id, mtime: s.mtime, bytes: s.size, cwd });
      }
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Trace> {
    const turns: TraceTurn[] = [];
    const events: TraceEvent[] = [];
    const losses: TraceLoss[] = [];

    // Assistant snapshots may appear multiple times — coalesce by message id.
    const assistantByMsgId = new Map<string, { turn: TraceTurn; seen: Set<string> }>();
    const toolCalls = new Map<string, { name?: string }>();

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let createdAt: string | null = null;
    let claudeVersion: string | undefined;
    let gitBranch: string | undefined;
    let modelSeen: string | undefined;

    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      let raw: Record<string, any>;
      try {
        raw = JSON.parse(line);
      } catch {
        losses.push(makeLoss("warning", `line[${lineNo}]`, "not valid JSON — skipped"));
        continue;
      }

      // Capture session metadata from the first event that has it.
      if (!sessionId && typeof raw.sessionId === "string") sessionId = raw.sessionId;
      if (!cwd && typeof raw.cwd === "string") cwd = raw.cwd;
      if (!createdAt && typeof raw.timestamp === "string") createdAt = raw.timestamp;
      if (!claudeVersion && typeof raw.version === "string") claudeVersion = raw.version;
      if (!gitBranch && typeof raw.gitBranch === "string") gitBranch = raw.gitBranch;

      const baseProv = (): Provenance => ({
        agent: AGENT, path, line: lineNo,
        rawType: raw.type, rawId: raw.uuid, rawParentId: raw.parentUuid ?? null,
        schemaVersion: claudeVersion,
      });

      // Permission-mode + file-history-snapshot + anything unclassified → events.
      if (raw.type === "permission-mode" || raw.type === "file-history-snapshot") {
        events.push({
          id: raw.uuid ?? `ev-${lineNo}`,
          type: raw.type,
          timestamp: raw.timestamp,
          value: raw,
          provenance: baseProv(),
        });
        continue;
      }

      // Assistant turn (possibly snapshotted — coalesce by message.id).
      if (raw.type === "assistant" && raw.message?.role === "assistant") {
        const msg = raw.message;
        const key = msg.id || raw.uuid || `ass-${lineNo}`;
        let state = assistantByMsgId.get(key);
        if (!state) {
          const turn: TraceTurn = {
            id: raw.uuid ?? key,
            parentId: raw.parentUuid ?? null,
            role: "assistant",
            timestamp: raw.timestamp,
            content: [],
            model: msg.model,
            provider: inferProvider(msg.model),
            stopReason: mapClaudeStopReason(msg.stop_reason),
            usage: mapClaudeUsage(msg.usage),
            provenance: baseProv(),
            metadata: { gitBranch },
          };
          state = { turn, seen: new Set() };
          assistantByMsgId.set(key, state);
          turns.push(turn);
          if (msg.model) modelSeen = modelSeen ?? String(msg.model);
        } else {
          // Fold additional fields in if not already set.
          state.turn.usage = state.turn.usage ?? mapClaudeUsage(msg.usage);
          state.turn.model = state.turn.model ?? msg.model;
          state.turn.stopReason = state.turn.stopReason ?? mapClaudeStopReason(msg.stop_reason);
        }

        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          const k = blockKey(b);
          if (state.seen.has(k)) continue;
          state.seen.add(k);
          if (b.type === "text" && typeof b.text === "string") {
            state.turn.content.push({ type: "text", text: b.text });
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            state.turn.content.push({
              type: "thinking",
              text: b.thinking,
              signature: typeof b.signature === "string" ? b.signature : undefined,
              format: "anthropic",
            });
          } else if (b.type === "tool_use" && b.id && b.name) {
            state.turn.content.push({
              type: "tool_call",
              id: sanitizeToolId(b.id),
              rawId: String(b.id),
              name: String(b.name),
              arguments: (b.input || {}) as Record<string, unknown>,
            });
            toolCalls.set(String(b.id), { name: String(b.name) });
          } else {
            state.turn.content.push({ type: "unknown", originalType: b.type, value: b });
            losses.push(makeLoss("info", `turns[${turns.length - 1}].content`, `unknown claude block type "${b.type}"`, b));
          }
        }
        continue;
      }

      // User turn (may carry tool_result content → maps to role: tool).
      if (raw.type === "user" && raw.message?.role === "user") {
        const msg = raw.message;
        const content = msg.content;
        if (typeof content === "string") {
          turns.push({
            id: raw.uuid ?? `user-${lineNo}`,
            parentId: raw.parentUuid ?? null,
            role: "user",
            timestamp: raw.timestamp,
            content: content ? [{ type: "text", text: content }] : [],
            provenance: baseProv(),
            metadata: {},
          });
        } else if (Array.isArray(content)) {
          const toolResults = content.filter((b: any) => b.type === "tool_result");
          const textParts = content.filter((b: any) => b.type === "text").map((b: any) => b.text || "").filter(Boolean);

          if (toolResults.length > 0) {
            // Pi-style: each tool_result becomes its own "tool" turn.
            let parentForTool: string | null = raw.parentUuid ?? null;
            for (let i = 0; i < toolResults.length; i++) {
              const tr = toolResults[i];
              const toolId = sanitizeToolId(tr.tool_use_id);
              const turnId = i === 0 && raw.uuid ? raw.uuid : `${raw.uuid ?? "tr"}-${i}`;
              turns.push({
                id: turnId,
                parentId: parentForTool,
                role: "tool",
                timestamp: raw.timestamp,
                content: [{
                  type: "tool_result",
                  toolCallId: toolId,
                  rawToolCallId: typeof tr.tool_use_id === "string" ? tr.tool_use_id : undefined,
                  toolName: toolCalls.get(String(tr.tool_use_id))?.name,
                  content: [{ type: "text", text: stringifyToolContent(tr.content) }],
                  isError: Boolean(tr.is_error),
                }],
                provenance: baseProv(),
                metadata: {},
              });
              parentForTool = turnId;
            }
            continue;
          }
          if (textParts.length > 0) {
            turns.push({
              id: raw.uuid ?? `user-${lineNo}`,
              parentId: raw.parentUuid ?? null,
              role: "user",
              timestamp: raw.timestamp,
              content: [{ type: "text", text: textParts.join("\n") }],
              provenance: baseProv(),
              metadata: {},
            });
          }
        }
        continue;
      }

      // Unknown top-level — preserve as an event.
      events.push({
        id: raw.uuid ?? `ev-${lineNo}`,
        type: String(raw.type ?? "unknown"),
        timestamp: raw.timestamp,
        value: raw,
        provenance: baseProv(),
      });
    }

    if (!sessionId) throw new Error(`claude session id not found in ${path}`);

    const trace: Trace = {
      traceVersion: 1,
      id: sessionId,
      cwd: cwd ?? undefined,
      createdAt: createdAt ?? undefined,
      source: { agent: AGENT, path, schemaVersion: claudeVersion },
      agents: [{ agent: AGENT, version: claudeVersion, model: modelSeen }],
      turns,
      events,
      metadata: { gitBranch },
      losses,
    };
    return trace;
  },

  async write(trace: Trace, options: WriteOptions = {}): Promise<WriteResult> {
    const sessionId = options.sessionId ?? randomUUID();
    const cwd = trace.cwd ?? homedir();
    const version = options.agentVersion ?? CLAUDE_VERSION_DEFAULT;
    const defaultModel = options.defaultModel ?? "claude-sonnet-4-20250514";
    const target = options.targetPath ?? defaultClaudeSessionPath(cwd, sessionId);

    const losses: TraceLoss[] = [];
    const out: Record<string, unknown>[] = [];

    // Header.
    out.push({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId });

    const envelope = (uuid: string, parentUuid: string | null | undefined, ts: string) => ({
      uuid,
      parentUuid: parentUuid ?? null,
      isSidechain: false,
      sessionId,
      timestamp: ts,
      cwd,
      userType: "external",
      entrypoint: "cli",
      version,
    });

    for (let i = 0; i < trace.turns.length; i++) {
      const turn = trace.turns[i];
      const ts = turn.timestamp ?? trace.createdAt ?? new Date().toISOString();

      if (turn.role === "user" || turn.role === "system" || turn.role === "developer") {
        // Native claude doesn't have a `developer` or `system` turn type — fold into `user`
        // and record the mapping so it's visible.
        if (turn.role !== "user") losses.push(makeLoss("info", `turns[${i}]`, `role "${turn.role}" folded to user for claude`));
        const text = turn.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
        out.push({
          type: "user",
          ...envelope(turn.id, turn.parentId ?? null, ts),
          promptId: randomUUID(),
          message: { role: "user", content: text },
          permissionMode: "bypassPermissions",
        });
      } else if (turn.role === "assistant") {
        const blocks: Record<string, unknown>[] = [];
        for (const b of turn.content) {
          if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
          else if (b.type === "thinking") {
            // Only valid if we have a real Anthropic signature — pi's thinkingSignature
            // doesn't validate against Anthropic's API. Drop otherwise + flag.
            if (b.format === "anthropic" && typeof b.signature === "string" && b.signature.length > 0) {
              blocks.push({ type: "thinking", thinking: b.text, signature: b.signature });
            } else {
              losses.push(makeLoss("info", `turns[${i}].content.thinking`, `thinking block dropped — signature missing or not anthropic-format (format=${b.format ?? "unknown"})`));
            }
          } else if (b.type === "tool_call") {
            blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
          } else if (b.type === "unknown") {
            losses.push(makeLoss("info", `turns[${i}].content`, `dropped unknown block "${b.originalType ?? "?"}"`));
          }
        }
        out.push({
          type: "assistant",
          ...envelope(turn.id, turn.parentId ?? null, ts),
          message: {
            id: randomUUID(),
            role: "assistant",
            model: turn.model || defaultModel,
            content: blocks,
          },
        });
      } else if (turn.role === "tool") {
        // Tool turns in claude live inside a user-role envelope.
        const result = turn.content.find((b) => b.type === "tool_result") as
          | { type: "tool_result"; toolCallId: string; rawToolCallId?: string; content: TraceContentBlock[]; isError?: boolean }
          | undefined;
        if (!result) {
          losses.push(makeLoss("warning", `turns[${i}]`, "tool role turn has no tool_result block"));
          continue;
        }
        const contentText = (result.content || [])
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
        out.push({
          type: "user",
          ...envelope(turn.id, turn.parentId ?? null, ts),
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: result.toolCallId,
              content: contentText,
              is_error: Boolean(result.isError),
            }],
          },
        });
      }
    }

    // We don't write trace.events here — claude regenerates permission-mode + snapshots itself.
    if (trace.events.length > 0) {
      losses.push(makeLoss("info", `events[]`, `${trace.events.length} non-conversation events not written in claude format`));
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, out.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");

    return {
      sourceAgent: trace.source?.agent,
      targetAgent: AGENT,
      target,
      sessionId,
      cwd,
      turns: trace.turns.length,
      events: trace.events.length,
      losses: [...trace.losses, ...losses].map((l) => ({ severity: l.severity, path: l.path, reason: l.reason })),
    };
  },

  defaultPath(trace: Trace, options: WriteOptions = {}): string {
    const sessionId = options.sessionId ?? randomUUID();
    return defaultClaudeSessionPath(trace.cwd ?? homedir(), sessionId);
  },
};

// ------- tiny mappers -------

function blockKey(b: any): string {
  if (b.type === "text") return `t:${b.text}`;
  if (b.type === "thinking") return `th:${b.thinking}`;
  if (b.type === "tool_use") return `tu:${b.id}`;
  return `u:${JSON.stringify(b).slice(0, 60)}`;
}

function inferProvider(model?: string): string | undefined {
  if (!model) return undefined;
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini")) return "google";
  return undefined;
}

function mapClaudeStopReason(s?: string | null): TraceTurn["stopReason"] {
  if (!s) return undefined;
  if (s === "tool_use") return "tool_use";
  if (s === "max_tokens" || s === "length") return "length";
  if (s === "error") return "error";
  if (s === "stop_sequence" || s === "end_turn") return "stop";
  return "unknown";
}

function mapClaudeUsage(u?: any): TraceUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
  };
}

function stringifyToolContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (c === null || c === undefined) return "";
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}
