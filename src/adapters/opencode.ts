import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Toast,
  ToastContentBlock,
  ToastEvent,
  ToastLoss,
  ToastRole,
  ToastTurn,
  ToastUsage,
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
  coerceToolInputObject,
  isPlainObject,
  joinRenderableText,
  makeImportedContextTurn,
  makeImportedEventNote,
  makeLoss,
  prependImportedContextTurn,
  sanitizeToolId,
  summarizeWriteLosses,
  throwIfStrictValidationFails,
  validateToastForCompat,
  validationResultToLosses,
} from "./shared.js";

const AGENT = "opencode" as const;
const OPENCODE_VERSION_DEFAULT = "0.1";
const DEFAULT_MODEL = { providerID: "openai", modelID: "gpt-5" };
const DEFAULT_AGENT = "build";

export const opencodeCompat: AgentCompat = {
  assistantUsage: "optional",
  toolInput: "object-only",
  writeCanonicalToolIds: true,
  thinking: "native",
};

type OpenCodeExport = {
  info: Record<string, any>;
  messages: Array<{
    info: Record<string, any>;
    parts: Array<Record<string, any>>;
  }>;
};

function makeSessionId(id?: string): string {
  const value = id ?? randomUUID().replace(/-/g, "");
  return value.startsWith("ses_") ? value : `ses_${value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
}

function makeMessageId(id?: string): string {
  const value = id ?? randomUUID().replace(/-/g, "");
  return value.startsWith("msg_") ? value : `msg_${value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
}

function makePartId(id?: string): string {
  const value = id ?? randomUUID().replace(/-/g, "");
  return value.startsWith("prt_") ? value : `prt_${value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
}

function defaultOpencodePath(trace: Toast, sessionId: string): string {
  return join(trace.cwd ?? process.cwd(), `${sessionId}.opencode.json`);
}

function looksLikeOpenCodeExport(value: unknown): value is OpenCodeExport {
  return isPlainObject(value)
    && isPlainObject(value.info)
    && Array.isArray(value.messages)
    && value.messages.every((msg) => isPlainObject(msg) && isPlainObject(msg.info) && Array.isArray(msg.parts));
}

function mapOpencodeStopReason(reason?: string): ToastTurn["stopReason"] {
  if (!reason) return undefined;
  if (reason === "tool_use") return "tool_use";
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "error") return "error";
  if (reason === "cancelled" || reason === "aborted") return "cancelled";
  return "stop";
}

function mapOpencodeUsage(input: any): ToastUsage | undefined {
  if (!input || typeof input !== "object") return undefined;
  const tokens = input.tokens ?? input;
  const total = typeof tokens.total === "number"
    ? tokens.total
    : [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write]
        .filter((value) => typeof value === "number")
        .reduce((sum, value) => sum + value, 0);
  return {
    inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
    outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
    cacheReadTokens: typeof tokens.cache?.read === "number" ? tokens.cache.read : undefined,
    cacheWriteTokens: typeof tokens.cache?.write === "number" ? tokens.cache.write : undefined,
    totalTokens: total || undefined,
    costUsd: typeof input.cost === "number" ? input.cost : undefined,
    metadata: typeof tokens.reasoning === "number" ? { reasoningTokens: tokens.reasoning } : undefined,
  };
}

function usageToOpencode(usage?: ToastUsage): { cost: number; tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } } } {
  return {
    cost: usage?.costUsd ?? 0,
    tokens: {
      total: usage?.totalTokens,
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      reasoning: typeof usage?.metadata?.reasoningTokens === "number" ? Number(usage.metadata.reasoningTokens) : 0,
      cache: {
        read: usage?.cacheReadTokens ?? 0,
        write: usage?.cacheWriteTokens ?? 0,
      },
    },
  };
}

function inferModelProvider(model?: string, provider?: string): { providerID: string; modelID: string } {
  if (provider && model) return { providerID: provider, modelID: model };
  if (model && model.includes("/")) {
    const [providerID, ...rest] = model.split("/");
    return { providerID, modelID: rest.join("/") || DEFAULT_MODEL.modelID };
  }
  return {
    providerID: provider ?? DEFAULT_MODEL.providerID,
    modelID: model ?? DEFAULT_MODEL.modelID,
  };
}

function roleToOpenCode(role: ToastRole): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

export const opencodeAdapter: AgentAdapter = {
  kind: AGENT,
  compat: opencodeCompat,

  async detect(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return looksLikeOpenCodeExport(parsed);
    } catch {
      return false;
    }
  },

  async list(): Promise<DiscoveredSession[]> {
    return [];
  },

  async read(path: string, _options: ReadOptions = {}): Promise<Toast> {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (!looksLikeOpenCodeExport(raw)) {
      throw new Error(`opencode export JSON not found in ${path}`);
    }

    const info = raw.info;
    const turns: ToastTurn[] = [];
    const events: ToastEvent[] = [];
    const losses: ToastLoss[] = [];
    const fingerprints: Array<{ agent: typeof AGENT; version?: string; model?: string; provider?: string }> = [];

    let lastTurnId: string | null = null;

    for (let i = 0; i < raw.messages.length; i++) {
      const message = raw.messages[i];
      const msgInfo = message.info;
      const role = msgInfo.role === "assistant" ? "assistant" : "user";
      const turn: ToastTurn = {
        id: String(msgInfo.id ?? `turn-${i}`),
        parentId: role === "assistant" ? (msgInfo.parentID ?? lastTurnId) : lastTurnId,
        role,
        timestamp: typeof msgInfo.time?.created === "number" ? new Date(msgInfo.time.created).toISOString() : undefined,
        content: [],
        model: role === "assistant" ? String(msgInfo.modelID ?? "") || undefined : String(msgInfo.model?.modelID ?? "") || undefined,
        provider: role === "assistant" ? String(msgInfo.providerID ?? "") || undefined : String(msgInfo.model?.providerID ?? "") || undefined,
        stopReason: role === "assistant" ? mapOpencodeStopReason(msgInfo.finish) : undefined,
        usage: role === "assistant" ? mapOpencodeUsage(msgInfo) : undefined,
        provenance: {
          agent: AGENT,
          path,
          rawType: "message",
          rawId: typeof msgInfo.id === "string" ? msgInfo.id : undefined,
          rawParentId: typeof msgInfo.parentID === "string" ? msgInfo.parentID : null,
          schemaVersion: info.version,
        },
        metadata: {
          ...(typeof msgInfo.agent === "string" ? { agent: msgInfo.agent } : {}),
          ...(typeof msgInfo.mode === "string" ? { mode: msgInfo.mode } : {}),
          ...(isPlainObject(msgInfo.summary) ? { summary: msgInfo.summary } : {}),
          ...(typeof msgInfo.system === "string" ? { system: msgInfo.system } : {}),
        },
      };

      for (let j = 0; j < message.parts.length; j++) {
        const part = message.parts[j];
        const partProv = {
          agent: AGENT,
          path,
          rawType: String(part.type ?? "part"),
          rawId: typeof part.id === "string" ? part.id : undefined,
          rawParentId: typeof msgInfo.id === "string" ? msgInfo.id : null,
          schemaVersion: info.version,
        };

        if (part.type === "text" && typeof part.text === "string") {
          turn.content.push({ type: "text", text: part.text, metadata: isPlainObject(part.metadata) ? part.metadata : undefined });
          continue;
        }

        if (part.type === "reasoning" && typeof part.text === "string") {
          turn.content.push({
            type: "thinking",
            text: part.text,
            format: "opencode-reasoning",
            metadata: isPlainObject(part.metadata) ? part.metadata : undefined,
          });
          continue;
        }

        if (part.type === "tool") {
          const toolId = sanitizeToolId(part.callID);
          turn.content.push({
            type: "tool_call",
            id: toolId,
            rawId: typeof part.callID === "string" ? part.callID : undefined,
            name: String(part.tool ?? "unknown"),
            arguments: part.state?.input ?? {},
            metadata: {
              status: part.state?.status,
              ...(isPlainObject(part.metadata) ? { metadata: part.metadata } : {}),
            },
          });

          if (part.state?.status === "completed" || part.state?.status === "error") {
            turns.push({
              id: `${turn.id}:tool:${j}`,
              parentId: turn.id,
              role: "tool",
              timestamp: typeof part.state?.time?.end === "number"
                ? new Date(part.state.time.end).toISOString()
                : turn.timestamp,
              content: [{
                type: "tool_result",
                toolCallId: toolId,
                rawToolCallId: typeof part.callID === "string" ? part.callID : undefined,
                toolName: String(part.tool ?? "unknown"),
                content: [{ type: "text", text: part.state?.status === "error" ? String(part.state.error ?? "") : String(part.state?.output ?? "") }],
                isError: part.state?.status === "error",
                metadata: isPlainObject(part.state?.metadata) ? part.state.metadata : undefined,
              }],
              provenance: partProv,
              metadata: {},
            });
          }
          continue;
        }

        if (part.type === "step-finish") {
          turn.usage = mapOpencodeUsage(part);
          turn.stopReason = mapOpencodeStopReason(part.reason);
          events.push({
            id: typeof part.id === "string" ? part.id : `${turn.id}:step-finish:${j}`,
            type: "step_finish",
            timestamp: turn.timestamp,
            value: part,
            provenance: partProv,
          });
          continue;
        }

        events.push({
          id: typeof part.id === "string" ? part.id : `${turn.id}:part:${j}`,
          type: String(part.type ?? "unknown"),
          timestamp: turn.timestamp,
          value: part,
          provenance: partProv,
        });
        losses.push(makeLoss("info", `turns[${turns.length}].content[${j}]`, `opencode part "${String(part.type ?? "?")}" preserved as event`, part));
      }

      turns.push(turn);
      lastTurnId = turn.id;

      const provider = turn.provider;
      const model = turn.model;
      if (model || provider) {
        fingerprints.push({ agent: AGENT, version: typeof info.version === "string" ? info.version : undefined, model, provider });
      }
    }

    return {
      traceVersion: 1,
      id: String(info.id),
      cwd: typeof info.directory === "string" ? info.directory : undefined,
      createdAt: typeof info.time?.created === "number" ? new Date(info.time.created).toISOString() : undefined,
      parentTraceId: typeof info.parentID === "string" ? info.parentID : undefined,
      source: { agent: AGENT, path, schemaVersion: info.version },
      agents: fingerprints.length > 0 ? fingerprints : [{ agent: AGENT, version: typeof info.version === "string" ? info.version : undefined }],
      turns,
      events,
      metadata: {
        ...(typeof info.title === "string" ? { title: info.title } : {}),
        ...(typeof info.slug === "string" ? { slug: info.slug } : {}),
        ...(isPlainObject(info.summary) ? { summary: info.summary } : {}),
        ...(isPlainObject(info.share) ? { share: info.share } : {}),
        ...(isPlainObject(info.permission) ? { permission: info.permission } : {}),
        ...(isPlainObject(info.revert) ? { revert: info.revert } : {}),
      },
      losses,
    };
  },

  validateWrite(trace: Toast, options: WriteOptions = {}) {
    return validateToastForCompat(AGENT, trace, opencodeCompat, options);
  },

  async write(trace: Toast, options: WriteOptions = {}): Promise<WriteResult> {
    const preflight = validateToastForCompat(AGENT, trace, opencodeCompat, options);
    throwIfStrictValidationFails(AGENT, options, preflight);

    const { trace: preparedTrace, losses: compactionLosses } = compactToastForWrite(AGENT, trace, opencodeCompat, options);
    const traceWithImportedEvents = preparedTrace.events.length > 0
      ? prependImportedContextTurn(
          preparedTrace,
          makeImportedContextTurn(
            makeMessageId(),
            preparedTrace.createdAt ?? new Date().toISOString(),
            preparedTrace.events.map((event) => makeImportedEventNote(event)),
            AGENT,
          ),
        )
      : preparedTrace;

    const sessionId = makeSessionId(options.sessionId ?? traceWithImportedEvents.id);
    const target = options.targetPath ?? defaultOpencodePath(traceWithImportedEvents, sessionId);
    const cwd = traceWithImportedEvents.cwd ?? process.cwd();
    const createdAt = traceWithImportedEvents.createdAt ?? new Date().toISOString();
    const timeCreated = new Date(createdAt).getTime();

    const losses: ToastLoss[] = [...validationResultToLosses(preflight), ...compactionLosses];
    if (preparedTrace.events.length > 0) {
      losses.push(makeLoss("info", "events[]", `${preparedTrace.events.length} event(s) preserved as imported context for opencode`));
    }

    const idMap = new Map<string, string>();
    const messages: OpenCodeExport["messages"] = [];

    for (let i = 0; i < traceWithImportedEvents.turns.length; i++) {
      const turn = traceWithImportedEvents.turns[i];
      const messageId = makeMessageId(turn.id);
      idMap.set(turn.id, messageId);
      const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : timeCreated + i;
      const model = inferModelProvider(turn.model, turn.provider);

      if (turn.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        for (let j = 0; j < turn.content.length; j++) {
          const block = turn.content[j];
          const partId = makePartId(`${turn.id}-${j}`);
          if (block.type === "text" || block.type === "note") {
            const text = block.type === "text" ? block.text : block.text;
            if (text) {
              parts.push({ id: partId, sessionID: sessionId, messageID: messageId, type: "text", text });
            }
            continue;
          }
          if (block.type === "thinking") {
            parts.push({
              id: partId,
              sessionID: sessionId,
              messageID: messageId,
              type: "reasoning",
              text: block.text,
              metadata: block.metadata,
              time: { start: timestamp, end: timestamp },
            });
            continue;
          }
          if (block.type === "tool_call") {
            parts.push({
              id: partId,
              sessionID: sessionId,
              messageID: messageId,
              type: "tool",
              callID: block.id,
              tool: block.name,
              state: {
                status: "pending",
                input: coerceToolInputObject("opencode", block.arguments, losses, `turns[${i}].content[${j}]`),
                raw: JSON.stringify(block.arguments ?? {}),
              },
              metadata: isPlainObject(block.metadata) ? block.metadata : undefined,
            });
            continue;
          }
        }

        const usage = usageToOpencode(turn.usage);
        messages.push({
          info: {
            id: messageId,
            sessionID: sessionId,
            role: "assistant",
            time: { created: timestamp, completed: timestamp },
            parentID: idMap.get(turn.parentId ?? "") ?? Array.from(idMap.values()).at(-2) ?? makeMessageId("root"),
            modelID: model.modelID,
            providerID: model.providerID,
            mode: String(turn.metadata.mode ?? DEFAULT_AGENT),
            agent: String(turn.metadata.agent ?? DEFAULT_AGENT),
            path: { cwd, root: cwd },
            summary: false,
            cost: usage.cost,
            tokens: usage.tokens,
            finish: turn.stopReason ?? "stop",
            variant: typeof turn.metadata.variant === "string" ? turn.metadata.variant : undefined,
          },
          parts,
        });
        continue;
      }

      if (turn.role === "tool") {
        const result = turn.content.find((block) => block.type === "tool_result") as
          | { type: "tool_result"; toolCallId: string; toolName?: string; content: ToastContentBlock[]; isError?: boolean; metadata?: Record<string, unknown> }
          | undefined;
        if (!result) {
          losses.push(makeLoss("warning", `turns[${i}]`, "tool role turn has no tool_result block"));
          continue;
        }
        messages.push({
          info: {
            id: messageId,
            sessionID: sessionId,
            role: "assistant",
            time: { created: timestamp, completed: timestamp },
            parentID: idMap.get(turn.parentId ?? "") ?? Array.from(idMap.values()).at(-1) ?? makeMessageId("root"),
            modelID: model.modelID,
            providerID: model.providerID,
            mode: DEFAULT_AGENT,
            agent: DEFAULT_AGENT,
            path: { cwd, root: cwd },
            summary: false,
            ...usageToOpencode(turn.usage),
            finish: turn.stopReason ?? (result.isError ? "error" : "tool_use"),
          },
          parts: [{
            id: makePartId(`${turn.id}-tool-result`),
            sessionID: sessionId,
            messageID: messageId,
            type: "tool",
            callID: result.toolCallId,
            tool: result.toolName ?? "unknown",
            state: result.isError
              ? {
                  status: "error",
                  input: {},
                  error: joinRenderableText(result.content),
                  time: { start: timestamp, end: timestamp },
                  metadata: result.metadata,
                }
              : {
                  status: "completed",
                  input: {},
                  output: joinRenderableText(result.content),
                  title: result.toolName ?? "unknown",
                  time: { start: timestamp, end: timestamp },
                  metadata: result.metadata ?? {},
                },
            metadata: result.metadata,
          }],
        });
        continue;
      }

      const text = joinRenderableText(turn.content);
      messages.push({
        info: {
          id: messageId,
          sessionID: sessionId,
          role: roleToOpenCode(turn.role),
          time: { created: timestamp },
          format: { type: "text" },
          agent: String(turn.metadata.agent ?? DEFAULT_AGENT),
          model,
          system: typeof turn.metadata.system === "string" ? turn.metadata.system : undefined,
          tools: typeof turn.metadata.tools === "object" ? turn.metadata.tools : undefined,
          summary: isPlainObject(turn.metadata.summary) ? turn.metadata.summary : undefined,
        },
        parts: text ? [{ id: makePartId(`${turn.id}-text`), sessionID: sessionId, messageID: messageId, type: "text", text }] : [],
      });
    }

    const exportData: OpenCodeExport = {
      info: {
        id: sessionId,
        slug: String(traceWithImportedEvents.metadata.slug ?? sessionId.slice(-8)),
        projectID: "global",
        directory: cwd,
        parentID: traceWithImportedEvents.parentTraceId ? makeSessionId(traceWithImportedEvents.parentTraceId) : undefined,
        title: String(traceWithImportedEvents.metadata.title ?? "Imported session"),
        version: options.agentVersion ?? OPENCODE_VERSION_DEFAULT,
        time: { created: timeCreated, updated: timeCreated },
        ...(isPlainObject(traceWithImportedEvents.metadata.summary) ? { summary: traceWithImportedEvents.metadata.summary } : {}),
        ...(isPlainObject(traceWithImportedEvents.metadata.share) ? { share: traceWithImportedEvents.metadata.share } : {}),
        ...(isPlainObject(traceWithImportedEvents.metadata.permission) ? { permission: traceWithImportedEvents.metadata.permission } : {}),
        ...(isPlainObject(traceWithImportedEvents.metadata.revert) ? { revert: traceWithImportedEvents.metadata.revert } : {}),
      },
      messages,
    };

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(exportData, null, 2) + "\n", "utf8");

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
    return defaultOpencodePath(trace, makeSessionId(options.sessionId ?? trace.id));
  },
};
