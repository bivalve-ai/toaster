// Pi adapter — reads/writes ~/.pi/agent/sessions/<cwd-enc>/<ts>_<id>.jsonl
// as Traces. Derived from the original pairwise translators + what we've
// learned about pi's on-disk shape by poking sessions in the wild.

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
  TraceRole,
} from "../schemas/trace.js";
import type {
  AgentAdapter,
  DiscoveredSession,
  ReadOptions,
  WriteOptions,
  WriteResult,
} from "./types.js";

const AGENT = "pi" as const;

// ------- helpers -------

function encodeCwdForPi(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
}

function decodeCwdFromPi(dirName: string): string {
  return "/" + dirName.replace(/^--/, "").replace(/--$/, "").replace(/-/g, "/");
}

export function defaultPiSessionPath(cwd: string, sessionId: string, timestamp?: string): string {
  const enc = encodeCwdForPi(cwd);
  const ts = (timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return join(homedir(), ".pi", "agent", "sessions", enc, `${ts}_${sessionId}.jsonl`);
}

function makeLoss(severity: TraceLoss["severity"], path: string, reason: string, value?: unknown): TraceLoss {
  return { severity, path, reason, value };
}

// ------- adapter -------

export const piAdapter: AgentAdapter = {
  kind: AGENT,

  async detect(path: string): Promise<boolean> {
    // Quick sniff: first non-empty line must be a pi session header.
    try {
      const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as { type?: string; version?: number; id?: string; cwd?: string };
          return d.type === "session" && typeof d.id === "string" && typeof d.cwd === "string";
        } catch {
          return false;
        } finally {
          // first non-empty line wins
          rl.close();
        }
      }
    } catch { /* ignore */ }
    return false;
  },

  async list(): Promise<DiscoveredSession[]> {
    const root = join(homedir(), ".pi", "agent", "sessions");
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    const subdirs = await readdir(root, { withFileTypes: true });
    for (const d of subdirs) {
      if (!d.isDirectory()) continue;
      const cwd = decodeCwdFromPi(d.name);
      const files = await readdir(join(root, d.name));
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(root, d.name, f);
        const s = await stat(full);
        const base = f.replace(/\.jsonl$/, "");
        const underscore = base.indexOf("_");
        const id = underscore >= 0 ? base.slice(underscore + 1) : base;
        out.push({ agent: AGENT, path: full, id, mtime: s.mtime, bytes: s.size, cwd });
      }
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Trace> {
    const turns: TraceTurn[] = [];
    const events: TraceEvent[] = [];
    const losses: TraceLoss[] = [];

    let header: { id: string; timestamp: string; cwd: string; version?: number; parentSession?: string } | null = null;
    const fingerprint = { agent: AGENT, model: undefined as string | undefined, provider: undefined as string | undefined };

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

      const baseProv = (): Provenance => ({
        agent: AGENT, path, line: lineNo,
        rawType: raw.type, rawId: raw.id, rawParentId: raw.parentId ?? null,
        schemaVersion: header?.version,
      });

      // Session header.
      if (raw.type === "session") {
        header = {
          id: String(raw.id),
          timestamp: String(raw.timestamp || new Date().toISOString()),
          cwd: String(raw.cwd || ""),
          version: typeof raw.version === "number" ? raw.version : undefined,
          parentSession: raw.parentSession ? String(raw.parentSession) : undefined,
        };
        continue;
      }

      // Meta events that aren't conversation turns.
      if (raw.type === "model_change" || raw.type === "thinking_level_change" || raw.type === "custom" || raw.type === "session_info") {
        events.push({
          id: String(raw.id || `ev-${lineNo}`),
          type: raw.type,
          timestamp: raw.timestamp,
          parentId: raw.parentId ?? null,
          value: raw,
          provenance: baseProv(),
        });
        if (raw.type === "model_change" && raw.modelId) fingerprint.model = fingerprint.model ?? String(raw.modelId);
        if (raw.type === "model_change" && raw.provider) fingerprint.provider = fingerprint.provider ?? String(raw.provider);
        continue;
      }

      // Conversation turn.
      if (raw.type === "message" && raw.message) {
        const msg = raw.message;
        const role: TraceRole =
          msg.role === "toolResult" || msg.role === "tool" ? "tool" :
          msg.role === "assistant" ? "assistant" :
          msg.role === "system" ? "system" :
          msg.role === "developer" ? "developer" :
          "user";

        const content: TraceContentBlock[] = [];
        for (let i = 0; i < (msg.content || []).length; i++) {
          const c = msg.content[i];
          if (c.type === "text" && typeof c.text === "string") {
            content.push({ type: "text", text: c.text });
          } else if (c.type === "thinking" && typeof c.thinking === "string") {
            content.push({
              type: "thinking",
              text: c.thinking,
              signature: typeof c.thinkingSignature === "string" ? c.thinkingSignature : undefined,
              format: "pi",
            });
          } else if (c.type === "toolCall") {
            content.push({
              type: "tool_call",
              id: sanitizeToolId(c.id),
              rawId: typeof c.id === "string" ? c.id : undefined,
              name: String(c.name || "unknown"),
              arguments: (c.arguments || {}) as Record<string, unknown>,
            });
          } else if (role === "tool" && c.type === "text") {
            // Text inside a toolResult role is the tool's output.
            content.push({ type: "text", text: c.text });
          } else {
            content.push({ type: "unknown", originalType: c.type, value: c });
            losses.push(makeLoss("info", `turns[${turns.length}].content[${i}]`, `unknown pi content type "${c.type}"`, c));
          }
        }

        // Tool-result turns in pi carry their tool linkage on the message, not in a block.
        if (role === "tool") {
          const textBlocks = content.filter((b): b is { type: "text"; text: string; metadata?: Record<string, unknown> } => b.type === "text");
          const toolId = sanitizeToolId(msg.toolCallId);
          const resultBlock: TraceContentBlock = {
            type: "tool_result",
            toolCallId: toolId,
            rawToolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
            toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
            content: textBlocks,
            isError: Boolean(msg.isError),
          };
          turns.push({
            id: String(raw.id || `turn-${lineNo}`),
            parentId: raw.parentId ?? null,
            role: "tool",
            timestamp: raw.timestamp,
            content: [resultBlock],
            provenance: baseProv(),
            metadata: {},
          });
          continue;
        }

        const turn: TraceTurn = {
          id: String(raw.id || `turn-${lineNo}`),
          parentId: raw.parentId ?? null,
          role,
          timestamp: raw.timestamp,
          content,
          model: msg.model,
          provider: msg.provider,
          stopReason: mapPiStopReason(msg.stopReason),
          usage: mapPiUsage(msg.usage),
          provenance: baseProv(),
          metadata: {},
        };
        turns.push(turn);

        if (role === "assistant") {
          if (msg.model) fingerprint.model = fingerprint.model ?? String(msg.model);
          if (msg.provider) fingerprint.provider = fingerprint.provider ?? String(msg.provider);
        }
        continue;
      }

      // Unknown top-level type — preserve as an event.
      events.push({
        id: String(raw.id || `ev-${lineNo}`),
        type: raw.type || "unknown",
        timestamp: raw.timestamp,
        value: raw,
        provenance: baseProv(),
      });
    }

    if (!header) throw new Error(`pi session header not found in ${path}`);

    const trace: Trace = {
      traceVersion: 1,
      id: header.id,
      cwd: header.cwd,
      createdAt: header.timestamp,
      parentTraceId: header.parentSession,
      source: {
        agent: AGENT,
        path,
        schemaVersion: header.version,
      },
      agents: [{ agent: AGENT, model: fingerprint.model, provider: fingerprint.provider }],
      turns,
      events,
      metadata: {},
      losses,
    };
    return trace;
  },

  async write(trace: Trace, options: WriteOptions = {}): Promise<WriteResult> {
    const sessionId = options.sessionId ?? trace.id ?? randomUUID();
    const cwd = trace.cwd ?? homedir();
    const createdAt = trace.createdAt ?? new Date().toISOString();
    const target = options.targetPath ?? defaultPiSessionPath(cwd, sessionId, createdAt);

    const lines: Record<string, unknown>[] = [];
    // Header
    lines.push({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: createdAt,
      cwd,
      ...(trace.parentTraceId ? { parentSession: trace.parentTraceId } : {}),
    });

    const losses: TraceLoss[] = [];
    for (let i = 0; i < trace.turns.length; i++) {
      const turn = trace.turns[i];
      const msg: Record<string, unknown> = { role: roleToPi(turn.role) };
      msg.content = [];

      if (turn.role === "tool") {
        // Pi carries the linkage on the message.
        const result = turn.content.find((b) => b.type === "tool_result") as
          | { type: "tool_result"; toolCallId: string; rawToolCallId?: string; toolName?: string; content: TraceContentBlock[]; isError?: boolean }
          | undefined;
        if (result) {
          msg.toolCallId = result.rawToolCallId ?? result.toolCallId;
          if (result.toolName) msg.toolName = result.toolName;
          if (result.isError) msg.isError = true;
          (msg.content as Record<string, unknown>[]) = result.content
            .filter((b) => b.type === "text")
            .map((b) => ({ type: "text", text: (b as { text: string }).text }));
        }
      } else {
        for (const b of turn.content) {
          if (b.type === "text") (msg.content as Record<string, unknown>[]).push({ type: "text", text: b.text });
          else if (b.type === "thinking") {
            const out: Record<string, unknown> = { type: "thinking", thinking: b.text };
            if (b.signature) out.thinkingSignature = b.signature;
            (msg.content as Record<string, unknown>[]).push(out);
          } else if (b.type === "tool_call") {
            (msg.content as Record<string, unknown>[]).push({
              type: "toolCall",
              id: b.rawId ?? b.id,
              name: b.name,
              arguments: b.arguments,
            });
          } else if (b.type === "tool_result") {
            // A tool_result block inside a non-tool role — unusual. Demote to text.
            losses.push(makeLoss("warning", `turns[${i}]`, "tool_result block found in non-tool role — inlining as text"));
            (msg.content as Record<string, unknown>[]).push({ type: "text", text: JSON.stringify(b) });
          } else if (b.type === "unknown") {
            losses.push(makeLoss("info", `turns[${i}]`, `dropped unknown content block type "${b.originalType ?? "?"}"`));
          }
        }
        if (turn.model) msg.model = turn.model;
        if (turn.provider) msg.provider = turn.provider;
        if (turn.stopReason) msg.stopReason = turn.stopReason;
        if (turn.usage) msg.usage = piUsageFromTrace(turn.usage);
      }

      lines.push({
        type: "message",
        id: turn.id,
        parentId: turn.parentId ?? null,
        timestamp: turn.timestamp ?? createdAt,
        message: msg,
      });
    }

    // Non-conversation events — preserve types we recognize.
    for (const ev of trace.events) {
      if (ev.type === "model_change" || ev.type === "thinking_level_change" || ev.type === "custom" || ev.type === "session_info") {
        // Passthrough via the original value shape when possible.
        const v = ev.value as Record<string, unknown> | undefined;
        lines.push(v && typeof v === "object" ? v : { type: ev.type, id: ev.id, timestamp: ev.timestamp, value: ev.value });
      } else {
        losses.push(makeLoss("info", `events[]`, `skipped non-pi event type "${ev.type}"`));
      }
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

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
    const sessionId = options.sessionId ?? trace.id ?? randomUUID();
    return defaultPiSessionPath(trace.cwd ?? homedir(), sessionId, trace.createdAt);
  },
};

// ------- tiny mappers -------

function roleToPi(r: TraceRole): string {
  if (r === "tool") return "toolResult";
  if (r === "assistant") return "assistant";
  if (r === "system") return "system";
  if (r === "developer") return "developer";
  return "user";
}

function mapPiStopReason(s?: string): TraceTurn["stopReason"] {
  if (!s) return undefined;
  if (s === "toolUse") return "tool_use";
  if (s === "length") return "length";
  if (s === "error") return "error";
  if (s === "cancelled") return "cancelled";
  if (s === "stop") return "stop";
  return "unknown";
}

function mapPiUsage(u?: any): TraceUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    totalTokens: u.totalTokens,
    costUsd: u.cost?.total,
  };
}

function piUsageFromTrace(u: TraceUsage): Record<string, unknown> {
  return {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    cost: { total: u.costUsd ?? 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function sanitizeToolId(raw: unknown): string {
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]+$/.test(raw) && raw.length <= 64) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (cleaned) return cleaned;
  }
  return "call_" + randomUUID().replace(/-/g, "");
}
