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
  Toast,
  ToastTurn,
  ToastEvent,
  ToastContentBlock,
  Provenance,
  ToastLoss,
  ToastUsage,
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
  coerceToolInputObject,
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

export const piCompat: AgentCompat = {
  assistantUsage: "required",
  toolInput: "object-only",
  writeCanonicalToolIds: false,
  toolCallId: {
    pattern: "^[a-zA-Z0-9_-]+$",
    maxLength: 64,
  },
  thinking: "native",
};

// ------- adapter -------

export const piAdapter: AgentAdapter = {
  kind: AGENT,
  compat: piCompat,

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

  async read(path: string, _options: ReadOptions = {}): Promise<Toast> {
    const turns: ToastTurn[] = [];
    const events: ToastEvent[] = [];
    const losses: ToastLoss[] = [];

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
        const role: ToastRole =
          msg.role === "toolResult" || msg.role === "tool" ? "tool" :
          msg.role === "assistant" ? "assistant" :
          msg.role === "system" ? "system" :
          msg.role === "developer" ? "developer" :
          "user";

        const content: ToastContentBlock[] = [];
        const rawContent = piContentBlocks(msg.content);
        for (let i = 0; i < rawContent.length; i++) {
          const c = rawContent[i];
          if (!c || typeof c !== "object") {
            content.push({ type: "unknown", value: c });
            losses.push(makeLoss("info", `turns[${turns.length}].content[${i}]`, "non-object pi content block", c));
          } else if (c.type === "text" && typeof c.text === "string") {
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
              arguments: c.arguments ?? {},
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
          const resultBlock: ToastContentBlock = {
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

        const turn: ToastTurn = {
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
          metadata: typeof msg.api === "string" ? { piApi: msg.api } : {},
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

    const trace: Toast = {
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

  validateWrite(trace: Toast, options: WriteOptions = {}) {
    return validateToastForCompat(AGENT, trace, piCompat, options);
  },

  async write(trace: Toast, options: WriteOptions = {}): Promise<WriteResult> {
    const preflight = validateToastForCompat(AGENT, trace, piCompat, options);
    throwIfStrictValidationFails(AGENT, options, preflight);

    const { trace: preparedTrace, losses: compactionLosses } = compactToastForWrite(AGENT, trace, piCompat, options);
    const importedEvents = preparedTrace.events.filter((ev) => !isPiPassthroughEvent(ev));
    const traceWithImportedEvents = importedEvents.length > 0
      ? prependImportedContextTurn(
          preparedTrace,
          makeImportedContextTurn(
            `imported-events-${randomUUID()}`,
            preparedTrace.createdAt ?? new Date().toISOString(),
            importedEvents.map((event) => makeImportedEventNote(event)),
            AGENT,
          ),
        )
      : preparedTrace;
    const sessionId = options.sessionId ?? traceWithImportedEvents.id ?? randomUUID();
    const cwd = traceWithImportedEvents.cwd ?? homedir();
    const createdAt = traceWithImportedEvents.createdAt ?? new Date().toISOString();
    const target = options.targetPath ?? defaultPiSessionPath(cwd, sessionId, createdAt);

    const losses: ToastLoss[] = [...validationResultToLosses(preflight), ...compactionLosses];
    if (importedEvents.length > 0) {
      losses.push(makeLoss("info", "events[]", `${importedEvents.length} event(s) preserved as imported context for pi`));
    }
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: createdAt,
      cwd,
      ...(traceWithImportedEvents.parentTraceId ? { parentSession: traceWithImportedEvents.parentTraceId } : {}),
    };

    // pi-native events we pass through (model_change, ...) go back between the
    // turns they sat between in the source, so the last line, which pi takes
    // as the leaf, is where the source conversation ended.
    const entries: Record<string, unknown>[] = [];
    const passthrough = traceWithImportedEvents.events.filter(isPiPassthroughEvent);
    let nextEvent = 0;
    const flushEventsBefore = (line: number) => {
      while (nextEvent < passthrough.length) {
        const eventLine = passthrough[nextEvent].provenance?.line;
        if (typeof eventLine !== "number" || eventLine >= line) break;
        entries.push(piEventEntry(passthrough[nextEvent++]));
      }
    };

    for (let i = 0; i < traceWithImportedEvents.turns.length; i++) {
      const turn = traceWithImportedEvents.turns[i];
      const turnLine = turn.provenance?.line;
      if (typeof turnLine === "number") flushEventsBefore(turnLine);
      const msg: Record<string, unknown> = { role: roleToPi(turn.role) };
      msg.content = [];

      if (turn.role === "tool") {
        // Pi carries the linkage on the message.
        const result = turn.content.find((b) => b.type === "tool_result") as
          | { type: "tool_result"; toolCallId: string; rawToolCallId?: string; toolName?: string; content: ToastContentBlock[]; isError?: boolean }
          | undefined;
        if (result) {
          msg.toolCallId = result.rawToolCallId ?? result.toolCallId;
          if (result.toolName) msg.toolName = result.toolName;
          if (result.isError) msg.isError = true;
          const rendered = joinRenderableText(result.content);
          (msg.content as Record<string, unknown>[]) = rendered ? [{ type: "text", text: rendered }] : [];
        }
      } else {
        for (const b of turn.content) {
          if (b.type === "text" || b.type === "note") {
            const text = renderContentBlockAsText(b);
            if (text) (msg.content as Record<string, unknown>[]).push({ type: "text", text });
          } else if (b.type === "thinking") {
            const out: Record<string, unknown> = { type: "thinking", thinking: b.text };
            if (b.signature) out.thinkingSignature = b.signature;
            (msg.content as Record<string, unknown>[]).push(out);
          } else if (b.type === "tool_call") {
            const args = piToolArguments(b.arguments, losses, `turns[${i}].content`);
            (msg.content as Record<string, unknown>[]).push({
              type: "toolCall",
              id: b.rawId ?? b.id,
              name: b.name,
              arguments: args,
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
        if (turn.role === "assistant") msg.api = piApiForTurn(turn);
        if (turn.role === "assistant") msg.stopReason = piStopReasonFromTrace(turn, losses, `turns[${i}].stopReason`);
        if (turn.usage) msg.usage = piUsageFromTrace(turn.usage);
        else if (turn.role === "assistant") msg.usage = piUsageFromTrace(emptyToastUsage());
      }

      // pi-ai messages carry their own timestamp in ms; the entry's is ISO.
      // Not on system messages: pi replays a timestamped system message as a
      // complete prompt + tool baseline, and one without toolsAdded would
      // resume the session with no tools.
      const entryTimestamp = turn.timestamp ?? createdAt;
      const messageTimestamp = Date.parse(entryTimestamp);
      if (turn.role !== "system" && Number.isFinite(messageTimestamp)) msg.timestamp = messageTimestamp;

      entries.push({
        type: "message",
        id: turn.id,
        parentId: turn.parentId ?? null,
        timestamp: entryTimestamp,
        message: msg,
      });
    }
    while (nextEvent < passthrough.length) entries.push(piEventEntry(passthrough[nextEvent++]));

    const relinked = linkPiEntries(entries, traceWithImportedEvents.events);
    if (relinked > 0) {
      losses.push(makeLoss("info", "turns[].parentId", `${relinked} entr${relinked === 1 ? "y" : "ies"} re-parented so pi's leaf reaches every turn`));
    }
    const lines: Record<string, unknown>[] = [header, ...entries];

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

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
    return defaultPiSessionPath(trace.cwd ?? homedir(), sessionId, trace.createdAt);
  },
};

// ------- entry tree -------

/** Event types the writer emits as pi entries; all others become imported context. */
function isPiPassthroughEvent(ev: ToastEvent): boolean {
  return ev.type === "model_change" || ev.type === "thinking_level_change" || ev.type === "custom" || ev.type === "session_info";
}

function piEventEntry(ev: ToastEvent): Record<string, unknown> {
  // Passthrough via the original value shape when possible (copied: parentId may be relinked).
  return isPlainObject(ev.value)
    ? { ...ev.value }
    : { type: ev.type, id: ev.id, parentId: ev.parentId ?? null, timestamp: ev.timestamp, value: ev.value };
}

/**
 * pi rebuilds context by walking parentId up from the last entry and stops at
 * the first id it can't find. Make every entry point at one written before it.
 * A parent that wasn't written (an event folded into imported context, a
 * coalesced Claude chunk, a second root) is resolved through the dropped
 * event's own parent when the trace recorded one, else it becomes the previous
 * entry. Returns how many entries changed parent.
 */
function linkPiEntries(entries: Record<string, unknown>[], events: ToastEvent[]): number {
  const droppedParents = new Map<string, string | null>();
  for (const ev of events) {
    const raw = isPlainObject(ev.value) ? ev.value : undefined;
    droppedParents.set(ev.id, ev.parentId ?? (typeof raw?.parentId === "string" ? raw.parentId : null));
  }

  const written = new Set<string>();
  let previous: string | null = null;
  let changed = 0;
  for (const entry of entries) {
    const original = typeof entry.parentId === "string" ? entry.parentId : null;
    let parent = original;
    const seen = new Set<string>();
    while (parent !== null && !written.has(parent) && droppedParents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = droppedParents.get(parent) ?? null;
    }
    const linked = parent !== null && written.has(parent) ? parent : previous;
    if (linked !== original) changed++;
    entry.parentId = linked;
    previous = String(entry.id);
    written.add(previous);
  }
  return changed;
}

// ------- tiny mappers -------

/**
 * pi-ai allows `content: string` on user, system and custom messages. A string
 * is one text block; anything else that isn't an array carries no blocks.
 */
function piContentBlocks(content: unknown): any[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

function roleToPi(r: ToastRole): string {
  if (r === "tool") return "toolResult";
  if (r === "assistant") return "assistant";
  if (r === "system") return "system";
  if (r === "developer") return "developer";
  return "user";
}

// pi-ai's AssistantMessage requires `api`, the wire protocol that produced it.
// pi-ai compares provider + api + model with the active model before replaying
// thinking signatures and provider-native tool-call data, so a missing or wrong
// api can only make pi treat the turn as foreign (signatures dropped, thinking
// sent as text), never the reverse. Values from the pi-ai 1.0.0 catalog, where
// each of these providers uses a single api.
const PI_API_BY_PROVIDER: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  "openai-codex": "openai-codex-responses",
  "azure-openai-responses": "azure-openai-responses",
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
  "amazon-bedrock": "bedrock-converse-stream",
  mistral: "mistral-conversations",
};

// Fallback for other providers: most OpenAI-compatible providers in pi-ai's
// catalog (groq, deepseek, openrouter, together, ...) speak openai-completions.
const PI_FALLBACK_API = "openai-completions";

function piApiForTurn(turn: ToastTurn): string {
  // Preserve the source value when the turn came from pi (see read()).
  if (typeof turn.metadata?.piApi === "string" && turn.metadata.piApi) return turn.metadata.piApi;
  const provider = turn.provider;
  return provider && Object.hasOwn(PI_API_BY_PROVIDER, provider) ? PI_API_BY_PROVIDER[provider] : PI_FALLBACK_API;
}

// pi-ai StopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
// (plus "pending"/"deferred", which pi never persists as finished turns).
function mapPiStopReason(s?: string): ToastTurn["stopReason"] {
  if (!s) return undefined;
  if (s === "toolUse") return "tool_use";
  if (s === "length") return "length";
  if (s === "error") return "error";
  if (s === "aborted" || s === "cancelled") return "cancelled";
  if (s === "stop") return "stop";
  return "unknown";
}

/**
 * Inverse of mapPiStopReason. pi-ai requires a stop reason on every assistant
 * message, so "unknown" or a missing value is written as "toolUse" when the
 * turn carries tool calls and "stop" otherwise.
 */
function piStopReasonFromTrace(turn: ToastTurn, losses: ToastLoss[], path: string): string {
  switch (turn.stopReason) {
    case "tool_use": return "toolUse";
    case "stop": return "stop";
    case "length": return "length";
    case "error": return "error";
    case "cancelled": return "aborted";
  }
  const inferred = turn.content.some((b) => b.type === "tool_call") ? "toolUse" : "stop";
  if (turn.stopReason === "unknown") {
    losses.push(makeLoss("info", path, `unknown stop reason written as pi "${inferred}"`));
  }
  return inferred;
}

function mapPiUsage(u?: any): ToastUsage | undefined {
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

function emptyToastUsage(): ToastUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function piUsageFromTrace(u: ToastUsage): Record<string, unknown> {
  return {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)),
    cost: { total: u.costUsd ?? 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function piToolArguments(
  input: unknown,
  losses: ToastLoss[],
  path: string,
): Record<string, unknown> {
  return coerceToolInputObject("pi", input, losses, path);
}
