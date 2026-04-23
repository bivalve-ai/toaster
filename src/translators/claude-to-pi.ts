// Claude Code session → Pi session.
//
// Reads a claude JSONL from `sourcePath`, emits a pi-format JSONL.
// Ported from bivalve/shelley-adapter (which was where this translator first
// got written + hardened). The logic here is the mature half of the pair;
// `pi-to-claude.ts` is the newer inverse.

import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type {
  PiContent,
  PiEntry,
  PiMessage,
  PiSession,
  PiSessionHeader,
  PiUsage,
} from "../schemas/pi.js";
import type {
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeMessage,
  ClaudeTextBlock,
  ClaudeToolResultBlock,
  ClaudeUsage,
} from "../schemas/claude.js";

export interface ClaudeToPiOptions {
  sessionNameFromIndex?: boolean;
  includeQueueOperationsAsCustom?: boolean;
  includeProgressAsCustom?: boolean;
  includeFileSnapshotsAsCustom?: boolean;
}

const DEFAULT_OPTIONS: Required<ClaudeToPiOptions> = {
  sessionNameFromIndex: true,
  includeQueueOperationsAsCustom: true,
  includeProgressAsCustom: false,
  includeFileSnapshotsAsCustom: false,
};

function inferProvider(model?: string): string | undefined {
  if (!model) return undefined;
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini")) return "google";
  return undefined;
}

function mapStopReason(stopReason?: string | null): string | undefined {
  if (!stopReason) return undefined;
  if (stopReason === "tool_use") return "toolUse";
  if (stopReason === "max_tokens" || stopReason === "length") return "length";
  if (stopReason === "error") return "error";
  return "stop";
}

function mapUsage(usage?: ClaudeUsage): PiUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toTextBlocks(text: string): PiContent[] {
  return text ? [{ type: "text", text }] : [];
}

async function readSessionNameFromIndex(filePath: string, sessionId: string): Promise<string | undefined> {
  const dir = dirname(filePath);
  const candidates = [
    join(dir, "sessions-index.json"),
    join(dirname(dir), "sessions-index.json"),
    join(dirname(dirname(dir)), "sessions-index.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf-8");
      const parsed = JSON.parse(raw) as {
        entries?: Array<{ sessionId?: string; summary?: string; firstPrompt?: string }>;
      };
      const match = parsed.entries?.find((entry) => entry.sessionId === sessionId);
      if (match) return match.summary?.trim() || match.firstPrompt?.trim() || undefined;
    } catch { /* ignore */ }
  }
  return undefined;
}

function makeCustomEntry(
  id: string, parentId: string | null, timestamp: string, customType: string, data: unknown,
): PiEntry {
  return { type: "custom", id, parentId, timestamp, customType, data };
}

export async function normalizeClaudeJSONL(
  filePath: string,
  options: ClaudeToPiOptions = {},
): Promise<PiSession> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const entries: PiEntry[] = [];
  const piIdByClaudeUuid = new Map<string, string>();
  const toolCalls = new Map<string, { name?: string; args?: Record<string, unknown> }>();
  const assistantByMessageId = new Map<string, { entry: PiEntry; seen: Set<string> }>();

  let header: PiSessionHeader | null = null;
  let lastPiId: string | null = null;
  let syntheticId = 0;
  const nextSyntheticId = (prefix: string) => `claude-${prefix}-${++syntheticId}`;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let raw: ClaudeEntry & Record<string, any>;
    try { raw = JSON.parse(line); } catch { continue; }

    const timestamp = (raw.timestamp as string) || new Date().toISOString();

    if (!header && raw.sessionId && raw.cwd) {
      header = { type: "session", version: 3, id: raw.sessionId as string, timestamp, cwd: raw.cwd as string };
    }

    const resolveParentId = (parentUuid?: string | null): string | null => {
      if (parentUuid && piIdByClaudeUuid.has(parentUuid)) {
        return piIdByClaudeUuid.get(parentUuid) || null;
      }
      return lastPiId;
    };

    // --- assistant message snapshots → coalesced pi assistant entry ---
    if (raw.type === "assistant" && (raw.message as ClaudeMessage)?.role === "assistant") {
      const message = raw.message as ClaudeMessage;
      const messageKey = message.id || raw.uuid || nextSyntheticId("assistant");
      let state = assistantByMessageId.get(messageKey);

      if (!state) {
        const entryId = (raw.uuid as string) || `claude-assistant-${messageKey}`;
        const entry: PiEntry = {
          type: "message",
          id: entryId,
          parentId: resolveParentId(raw.parentUuid as string | null | undefined),
          timestamp,
          message: {
            role: "assistant",
            content: [],
            usage: mapUsage(message.usage),
            model: message.model,
            provider: inferProvider(message.model),
            stopReason: mapStopReason(message.stop_reason),
          },
        };
        entries.push(entry);
        state = { entry, seen: new Set<string>() };
        assistantByMessageId.set(messageKey, state);
        lastPiId = entryId;
      } else if (state.entry.message) {
        state.entry.message.usage = state.entry.message.usage || mapUsage(message.usage);
        state.entry.message.model = state.entry.message.model || message.model;
        state.entry.message.provider = state.entry.message.provider || inferProvider(message.model);
        state.entry.message.stopReason = state.entry.message.stopReason || mapStopReason(message.stop_reason);
      }

      if (raw.uuid) piIdByClaudeUuid.set(raw.uuid as string, state.entry.id || messageKey);

      const content = Array.isArray(message.content) ? message.content : [];
      const piMessage = state.entry.message as PiMessage;

      for (const block of content as ClaudeContentBlock[]) {
        if (block.type === "thinking" && (block as any).thinking) {
          const key = `thinking:${(block as any).thinking}`;
          if (!state.seen.has(key)) {
            state.seen.add(key);
            piMessage.content.push({ type: "thinking", thinking: (block as any).thinking });
          }
        }
        if (block.type === "text" && (block as any).text) {
          const key = `text:${(block as any).text}`;
          if (!state.seen.has(key)) {
            state.seen.add(key);
            piMessage.content.push({ type: "text", text: (block as any).text });
          }
        }
        if (block.type === "tool_use" && (block as any).id && (block as any).name) {
          const key = `tool:${(block as any).id}`;
          if (!state.seen.has(key)) {
            state.seen.add(key);
            piMessage.content.push({
              type: "toolCall",
              id: (block as any).id,
              name: (block as any).name,
              arguments: (block as any).input || {},
            });
            toolCalls.set((block as any).id, { name: (block as any).name, args: (block as any).input || {} });
          }
        }
      }
      continue;
    }

    // --- user message / tool-result carrier ---
    if (raw.type === "user" && (raw.message as ClaudeMessage)?.role === "user") {
      const message = raw.message as ClaudeMessage;
      const parentId = resolveParentId(raw.parentUuid as string | null | undefined);
      const content = message.content;

      if (typeof content === "string") {
        const entryId = (raw.uuid as string) || nextSyntheticId("user");
        entries.push({
          type: "message",
          id: entryId,
          parentId,
          timestamp,
          message: { role: "user", content: toTextBlocks(content) },
        });
        if (raw.uuid) piIdByClaudeUuid.set(raw.uuid as string, entryId);
        lastPiId = entryId;
        continue;
      }

      if (Array.isArray(content)) {
        const toolResults = content.filter((b): b is ClaudeToolResultBlock => b.type === "tool_result");
        const textParts = content
          .filter((b): b is ClaudeTextBlock => b.type === "text")
          .map((b) => b.text || "")
          .filter(Boolean);

        if (toolResults.length > 0) {
          let parentForTool = parentId;
          for (let i = 0; i < toolResults.length; i++) {
            const block = toolResults[i];
            const toolCallId = block.tool_use_id || nextSyntheticId("tool");
            const call = toolCalls.get(toolCallId);
            const entryId = i === 0 && raw.uuid ? (raw.uuid as string) : nextSyntheticId("tool-result");
            entries.push({
              type: "message",
              id: entryId,
              parentId: parentForTool,
              timestamp,
              message: {
                role: "toolResult",
                toolCallId,
                toolName: call?.name || "unknown",
                isError: !!block.is_error,
                content: toTextBlocks(textFromUnknown(block.content)),
              },
            });
            parentForTool = entryId;
            lastPiId = entryId;
          }
          if (raw.uuid) piIdByClaudeUuid.set(raw.uuid as string, lastPiId || (raw.uuid as string));
          continue;
        }

        if (textParts.length > 0) {
          const entryId = (raw.uuid as string) || nextSyntheticId("user");
          entries.push({
            type: "message",
            id: entryId,
            parentId,
            timestamp,
            message: { role: "user", content: toTextBlocks(textParts.join("\n")) },
          });
          if (raw.uuid) piIdByClaudeUuid.set(raw.uuid as string, entryId);
          lastPiId = entryId;
          continue;
        }
      }
    }

    // --- optional preservation of non-message event types ---
    if (raw.type === "queue-operation" && opts.includeQueueOperationsAsCustom) {
      const entryId = nextSyntheticId("queue");
      entries.push(makeCustomEntry(entryId, lastPiId, timestamp, "claude.queue_operation", {
        operation: (raw as any).operation, content: (raw as any).content,
      }));
      continue;
    }
    if (raw.type === "progress" && opts.includeProgressAsCustom) {
      const entryId = (raw.uuid as string) || nextSyntheticId("progress");
      entries.push(makeCustomEntry(entryId, lastPiId, timestamp, "claude.progress", raw));
      if (raw.uuid) piIdByClaudeUuid.set(raw.uuid as string, entryId);
      continue;
    }
    if (raw.type === "file-history-snapshot" && opts.includeFileSnapshotsAsCustom) {
      const entryId = nextSyntheticId("snapshot");
      entries.push(makeCustomEntry(entryId, lastPiId, timestamp, "claude.file_history_snapshot", raw));
      continue;
    }
  }

  if (!header) throw new Error(`Could not detect Claude session metadata in ${filePath}`);

  if (opts.sessionNameFromIndex) {
    const sessionName = await readSessionNameFromIndex(filePath, header.id);
    if (sessionName) {
      entries.push({
        type: "session_info",
        id: nextSyntheticId("session-info"),
        parentId: lastPiId,
        timestamp: header.timestamp,
        name: sessionName,
      });
    }
  }

  return { header, entries };
}

export function serializePiSession(session: PiSession): string {
  return [session.header, ...session.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/** Default path pi writes sessions to: ~/.pi/agent/sessions/--<cwd-encoded>--/<ts>_<id>.jsonl */
export function defaultPiSessionPath(cwd: string, sessionId: string, timestamp?: string): string {
  const enc = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
  const ts = (timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return join(homedir(), ".pi", "agent", "sessions", enc, `${ts}_${sessionId}.jsonl`);
}

export interface MigrateClaudeToPiResult {
  source: string;
  target: string;
  sessionId: string;
  cwd: string;
  events: number;
}

export async function migrateClaudeSessionToPi(
  sourceFile: string,
  options: ClaudeToPiOptions & { targetPath?: string } = {},
): Promise<MigrateClaudeToPiResult> {
  const session = await normalizeClaudeJSONL(sourceFile, options);
  const target =
    options.targetPath ?? defaultPiSessionPath(session.header.cwd, session.header.id, session.header.timestamp);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serializePiSession(session), "utf-8");
  return {
    source: sourceFile, target,
    sessionId: session.header.id, cwd: session.header.cwd, events: session.entries.length,
  };
}
