// Codex adapter — reads/writes ~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<id>.jsonl
// as Traces. The schema is inferred from real Codex CLI session files.

import { createReadStream } from "node:fs";
import { readdir, stat, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type {
  Toast,
  ToastTurn,
  ToastEvent,
  ToastContentBlock,
  Provenance,
  ToastLoss,
  ToastRole,
} from "../schemas/toast.js";
import type {
  AgentAdapter,
  AgentCompat,
  DiscoveredSession,
  ReadOptions,
  WriteOptions,
  WriteResult,
} from "./types.js";
import {
  compactToastForWrite,
  isPlainObject,
  joinRenderableText,
  makeImportedContextTurn,
  makeImportedEventNote,
  makeLoss,
  prependImportedContextTurn,
  renderContentBlockAsText,
  sanitizeToolId,
  summarizeWriteLosses,
  throwIfStrictValidationFails,
  validateToastForCompat,
  validationResultToLosses,
} from "./shared.js";

const AGENT = "codex" as const;
const CODEX_VERSION_DEFAULT = "0.120.0";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localParts(ts?: string) {
  const d = ts ? new Date(ts) : new Date();
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return {
    year: String(date.getFullYear()),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    stamp: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`,
  };
}

export function defaultCodexSessionPath(cwd: string, sessionId: string, timestamp?: string): string {
  const { year, month, day, stamp } = localParts(timestamp);
  return join(homedir(), ".codex", "sessions", year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

export const codexCompat: AgentCompat = {
  assistantUsage: "optional",
  toolInput: "any-json",
  writeCanonicalToolIds: true,
  toolCallId: {
    pattern: "^[a-zA-Z0-9_-]+$",
    maxLength: 64,
  },
  thinking: "not-written",
};

function parseCodexToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeReasoning(payload: any): string | undefined {
  const summary = Array.isArray(payload?.summary) ? payload.summary : [];
  const text = summary
    .map((s: any) => (typeof s?.text === "string" ? s.text : ""))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function parseToolOutput(value: unknown): {
  text: string;
  metadata?: Record<string, unknown>;
  isError?: boolean;
  originalOutput?: string;
} {
  if (typeof value !== "string") {
    return { text: stringifyToolValue(value) };
  }

  try {
    const parsed = JSON.parse(value);
    if (isPlainObject(parsed) && typeof parsed.output === "string") {
      const metadata = isPlainObject(parsed.metadata) ? parsed.metadata : undefined;
      const exitCode = typeof metadata?.exit_code === "number" ? metadata.exit_code : undefined;
      return {
        text: parsed.output,
        metadata,
        isError: typeof exitCode === "number" ? exitCode !== 0 : undefined,
        originalOutput: value,
      };
    }
  } catch {
    // fall through
  }

  return {
    text: value,
    isError: /^aborted by user/i.test(value) || /verification failed/i.test(value) ? true : undefined,
    originalOutput: value,
  };
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

async function readFirstJsonLine(path: string): Promise<any | null> {
  try {
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      rl.close();
      return JSON.parse(line);
    }
  } catch {
    // ignore
  }
  return null;
}

async function readCodexVersion(): Promise<string> {
  try {
    const raw = await readFile(join(homedir(), ".codex", "version.json"), "utf-8");
    const parsed = JSON.parse(raw) as { latest_version?: string };
    if (typeof parsed.latest_version === "string" && parsed.latest_version) return parsed.latest_version;
  } catch {
    // ignore
  }
  return CODEX_VERSION_DEFAULT;
}

function roleToCodex(role: ToastRole): "developer" | "user" | "assistant" {
  if (role === "assistant") return "assistant";
  if (role === "developer" || role === "system") return "developer";
  return "user";
}

function inferProvider(model?: string): string | undefined {
  if (!model) return undefined;
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini")) return "google";
  return undefined;
}

export const codexAdapter: AgentAdapter = {
  kind: AGENT,
  compat: codexCompat,

  async detect(path: string): Promise<boolean> {
    const first = await readFirstJsonLine(path);
    return first?.type === "session_meta" && typeof first?.payload?.id === "string";
  },

  async list(): Promise<DiscoveredSession[]> {
    const root = join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];

    const years = await readdir(root, { withFileTypes: true });
    for (const year of years) {
      if (!year.isDirectory()) continue;
      const yearDir = join(root, year.name);
      const months = await readdir(yearDir, { withFileTypes: true });
      for (const month of months) {
        if (!month.isDirectory()) continue;
        const monthDir = join(yearDir, month.name);
        const days = await readdir(monthDir, { withFileTypes: true });
        for (const day of days) {
          if (!day.isDirectory()) continue;
          const dayDir = join(monthDir, day.name);
          const files = await readdir(dayDir);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const full = join(dayDir, file);
            const s = await stat(full);
            const first = await readFirstJsonLine(full);
            const id = typeof first?.payload?.id === "string"
              ? first.payload.id
              : file.replace(/^rollout-[0-9T-]+-/, "").replace(/\.jsonl$/, "");
            const cwd = typeof first?.payload?.cwd === "string" ? first.payload.cwd : undefined;
            out.push({ agent: AGENT, path: full, id, mtime: s.mtime, bytes: s.size, cwd });
          }
        }
      }
    }

    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Toast> {
    const turns: ToastTurn[] = [];
    const events: ToastEvent[] = [];
    const losses: ToastLoss[] = [];
    const toolCalls = new Map<string, { id: string; name: string; codexType: string }>();

    let header: Record<string, any> | null = null;
    let modelSeen: string | undefined;
    let providerSeen: string | undefined;
    let lastTurnId: string | null = null;

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
        agent: AGENT,
        path,
        line: lineNo,
        rawType: raw.type,
        rawId: raw.payload?.call_id ?? raw.payload?.turn_id ?? raw.payload?.id,
        rawParentId: null,
        schemaVersion: header?.cli_version,
      });

      if (raw.type === "session_meta" && raw.payload) {
        header = raw.payload;
        providerSeen = typeof raw.payload.model_provider === "string" ? raw.payload.model_provider : providerSeen;
        continue;
      }

      if (raw.type === "turn_context") {
        const payload = raw.payload || {};
        if (!modelSeen && typeof payload.model === "string") modelSeen = payload.model;
        events.push({
          id: payload.turn_id ?? `ev-${lineNo}`,
          type: "turn_context",
          timestamp: raw.timestamp,
          value: payload,
          provenance: baseProv(),
        });
        continue;
      }

      if (raw.type === "event_msg") {
        const payload = raw.payload || {};
        events.push({
          id: payload.turn_id ?? `ev-${lineNo}`,
          type: String(payload.type ?? "event_msg"),
          timestamp: raw.timestamp,
          value: payload,
          provenance: baseProv(),
        });
        continue;
      }

      if (raw.type !== "response_item") {
        events.push({
          id: `ev-${lineNo}`,
          type: String(raw.type ?? "unknown"),
          timestamp: raw.timestamp,
          value: raw,
          provenance: baseProv(),
        });
        continue;
      }

      const item = raw.payload || {};

      if (item.type === "message") {
        const role = item.role === "assistant"
          ? "assistant"
          : item.role === "developer"
            ? "developer"
            : item.role === "user"
              ? "user"
              : "user";
        if (item.role !== role) {
          losses.push(makeLoss("info", `line[${lineNo}]`, `unknown codex message role "${String(item.role)}" folded to user`, item.role));
        }

        const content: ToastContentBlock[] = [];
        const blocks = Array.isArray(item.content) ? item.content : [];
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          if ((block?.type === "input_text" || block?.type === "output_text") && typeof block.text === "string") {
            content.push({ type: "text", text: block.text });
          } else {
            content.push({ type: "unknown", originalType: block?.type, value: block });
            losses.push(makeLoss("info", `turns[${turns.length}].content[${i}]`, `unknown codex content type "${String(block?.type ?? "?")}"`, block));
          }
        }

        const turnId = `turn-${lineNo}`;
        turns.push({
          id: turnId,
          parentId: lastTurnId,
          role,
          timestamp: raw.timestamp,
          content,
          provenance: baseProv(),
          metadata: item.phase ? { phase: item.phase } : {},
        });
        lastTurnId = turnId;
        continue;
      }

      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const input = item.type === "function_call"
          ? parseCodexToolInput(item.arguments)
          : parseCodexToolInput(item.input);
        const canonicalId = sanitizeToolId(item.call_id);
        toolCalls.set(String(item.call_id), {
          id: canonicalId,
          name: String(item.name || "unknown"),
          codexType: item.type,
        });
        const turnId = `turn-${lineNo}`;
        turns.push({
          id: turnId,
          parentId: lastTurnId,
          role: "assistant",
          timestamp: raw.timestamp,
          content: [{
            type: "tool_call",
            id: canonicalId,
            rawId: typeof item.call_id === "string" ? item.call_id : undefined,
            name: String(item.name || "unknown"),
            arguments: input,
            metadata: {
              codexResponseType: item.type,
              ...(item.status ? { status: item.status } : {}),
            },
          }],
          provenance: baseProv(),
          metadata: {},
        });
        lastTurnId = turnId;
        continue;
      }

      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const linked = toolCalls.get(String(item.call_id));
        const parsed = parseToolOutput(item.output);
        const turnId = `turn-${lineNo}`;
        turns.push({
          id: turnId,
          parentId: lastTurnId,
          role: "tool",
          timestamp: raw.timestamp,
          content: [{
            type: "tool_result",
            toolCallId: linked?.id ?? sanitizeToolId(item.call_id),
            rawToolCallId: typeof item.call_id === "string" ? item.call_id : undefined,
            toolName: linked?.name,
            content: [{ type: "text", text: parsed.text }],
            isError: parsed.isError,
            metadata: {
              codexResponseType: item.type,
              ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
              ...(parsed.originalOutput ? { originalOutput: parsed.originalOutput } : {}),
            },
          }],
          provenance: baseProv(),
          metadata: {},
        });
        lastTurnId = turnId;
        continue;
      }

      if (item.type === "reasoning") {
        events.push({
          id: `ev-${lineNo}`,
          type: "reasoning",
          timestamp: raw.timestamp,
          value: {
            summary: summarizeReasoning(item),
            encrypted: typeof item.encrypted_content === "string" && item.encrypted_content.length > 0,
          },
          provenance: baseProv(),
        });
        continue;
      }

      events.push({
        id: `ev-${lineNo}`,
        type: String(item.type ?? "response_item"),
        timestamp: raw.timestamp,
        value: item,
        provenance: baseProv(),
      });
    }

    if (!header || typeof header.id !== "string") {
      throw new Error(`codex session header not found in ${path}`);
    }

    const trace: Toast = {
      traceVersion: 1,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : undefined,
      createdAt: typeof header.timestamp === "string" ? header.timestamp : undefined,
      source: {
        agent: AGENT,
        path,
        schemaVersion: header.cli_version,
      },
      agents: [{
        agent: AGENT,
        version: typeof header.cli_version === "string" ? header.cli_version : undefined,
        provider: providerSeen,
        model: modelSeen,
      }],
      turns,
      events,
      metadata: {
        ...(typeof header.originator === "string" ? { originator: header.originator } : {}),
        ...(typeof header.source === "string" ? { source: header.source } : {}),
        ...(typeof header.base_instructions?.text === "string" ? { baseInstructions: header.base_instructions.text } : {}),
        ...(isPlainObject(header.git) ? { git: header.git } : {}),
      },
      losses,
    };
    return trace;
  },

  validateWrite(trace: Toast, options: WriteOptions = {}) {
    return validateToastForCompat(AGENT, trace, codexCompat, options);
  },

  async write(trace: Toast, options: WriteOptions = {}): Promise<WriteResult> {
    const preflight = validateToastForCompat(AGENT, trace, codexCompat, options);
    throwIfStrictValidationFails(AGENT, options, preflight);

    const { trace: preparedTrace, losses: compactionLosses } = compactToastForWrite(AGENT, trace, codexCompat, options);
    const traceWithImportedEvents = preparedTrace.events.length > 0
      ? prependImportedContextTurn(
          preparedTrace,
          makeImportedContextTurn(
            `imported-events-${randomUUID()}`,
            preparedTrace.createdAt ?? new Date().toISOString(),
            preparedTrace.events.map((event) => makeImportedEventNote(event)),
            AGENT,
          ),
        )
      : preparedTrace;
    const sessionId = options.sessionId ?? traceWithImportedEvents.id ?? randomUUID();
    const cwd = traceWithImportedEvents.cwd ?? homedir();
    const createdAt = traceWithImportedEvents.createdAt ?? new Date().toISOString();
    const target = options.targetPath ?? defaultCodexSessionPath(cwd, sessionId, createdAt);
    const version = options.agentVersion ?? await readCodexVersion();
    const provider = traceWithImportedEvents.agents.find((a) => a.agent === AGENT)?.provider
      ?? traceWithImportedEvents.agents.find((a) => a.provider)?.provider
      ?? inferProvider(traceWithImportedEvents.turns.find((t) => t.model)?.model);

    const lines: Array<Record<string, unknown>> = [];
    const losses: ToastLoss[] = [...validationResultToLosses(preflight), ...compactionLosses];
    if (preparedTrace.events.length > 0) {
      losses.push(makeLoss("info", "events[]", `${preparedTrace.events.length} event(s) preserved as imported context for codex`));
    }

    lines.push({
      timestamp: createdAt,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: createdAt,
        cwd,
        originator: "toaster",
        cli_version: version,
        source: "import",
        ...(provider ? { model_provider: provider } : {}),
        ...(typeof traceWithImportedEvents.metadata.baseInstructions === "string" ? { base_instructions: { text: traceWithImportedEvents.metadata.baseInstructions } } : {}),
        ...(isPlainObject(traceWithImportedEvents.metadata.git) ? { git: traceWithImportedEvents.metadata.git } : {}),
      },
    });

    const pushMessage = (timestamp: string, role: "developer" | "user" | "assistant", text: string, phase?: string) => {
      lines.push({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
          ...(phase ? { phase } : {}),
        },
      });
    };

    const flushText = (timestamp: string, role: "assistant", parts: string[], phase?: string) => {
      const text = parts.join("");
      if (!text) return;
      pushMessage(timestamp, role, text, phase);
      parts.length = 0;
    };

    for (let i = 0; i < traceWithImportedEvents.turns.length; i++) {
      const turn = traceWithImportedEvents.turns[i];
      const ts = turn.timestamp ?? createdAt;

      if (turn.role === "user" || turn.role === "developer" || turn.role === "system") {
        const role = roleToCodex(turn.role);
        if (turn.role === "system") {
          losses.push(makeLoss("info", `turns[${i}]`, 'role "system" folded to developer for codex'));
        }
        const text = joinRenderableText(turn.content);
        pushMessage(ts, role, text, typeof turn.metadata.phase === "string" ? turn.metadata.phase : undefined);
        continue;
      }

      if (turn.role === "assistant") {
        const textParts: string[] = [];
        const phase = typeof turn.metadata.phase === "string" ? turn.metadata.phase : undefined;
        for (const block of turn.content) {
          if (block.type === "text" || block.type === "note") {
            const text = renderContentBlockAsText(block);
            if (text) textParts.push(text);
            continue;
          }
          if (block.type === "thinking") {
            losses.push(makeLoss("info", `turns[${i}].content`, "thinking block not written in codex format"));
            continue;
          }
          if (block.type === "unknown") {
            losses.push(makeLoss("info", `turns[${i}].content`, `dropped unknown block "${block.originalType ?? "?"}"`));
            continue;
          }
          if (block.type !== "tool_call") continue;

          flushText(ts, "assistant", textParts, phase);

          const responseType = typeof block.metadata?.codexResponseType === "string"
            ? block.metadata.codexResponseType
            : typeof block.arguments === "string"
              ? "custom_tool_call"
              : "function_call";
          if (responseType === "custom_tool_call") {
            lines.push({
              timestamp: ts,
              type: "response_item",
              payload: {
                type: "custom_tool_call",
                status: typeof block.metadata?.status === "string" ? block.metadata.status : "completed",
                call_id: block.id,
                name: block.name,
                input: typeof block.arguments === "string" ? block.arguments : stringifyToolValue(block.arguments),
              },
            });
          } else {
            lines.push({
              timestamp: ts,
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.arguments ?? {}),
              },
            });
          }
        }
        flushText(ts, "assistant", textParts, phase);
        continue;
      }

      if (turn.role === "tool") {
        const result = turn.content.find((b) => b.type === "tool_result") as
          | { type: "tool_result"; toolCallId: string; rawToolCallId?: string; content: ToastContentBlock[]; isError?: boolean; metadata?: Record<string, unknown> }
          | undefined;
        if (!result) {
          losses.push(makeLoss("warning", `turns[${i}]`, "tool role turn has no tool_result block"));
          continue;
        }

        const responseType = typeof result.metadata?.codexResponseType === "string"
          ? result.metadata.codexResponseType
          : "function_call_output";
        const text = joinRenderableText(result.content);
        const output = typeof result.metadata?.originalOutput === "string"
          ? result.metadata.originalOutput
          : text;

        lines.push({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: responseType,
            call_id: result.toolCallId,
            output,
          },
        });
        continue;
      }
    }

    // Codex has no native slot for arbitrary imported events in the translated format.

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");

    return {
      sourceAgent: traceWithImportedEvents.source?.agent,
      targetAgent: AGENT,
      target,
      sessionId,
      cwd,
      turns: traceWithImportedEvents.turns.length,
      events: traceWithImportedEvents.events.length,
      losses: summarizeWriteLosses(traceWithImportedEvents, losses),
    };
  },

  defaultPath(trace: Toast, options: WriteOptions = {}): string {
    const sessionId = options.sessionId ?? trace.id ?? randomUUID();
    return defaultCodexSessionPath(trace.cwd ?? homedir(), sessionId, trace.createdAt);
  },
};

