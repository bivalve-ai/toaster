// Pi session → Claude Code session.
//
// Reads a pi JSONL at `sourcePath`, writes a claude-format JSONL at the target
// (defaults to the user's ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl).
// Returns the translated session + the session id the caller can pass to
// `claude --resume <id>`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { PiEntry, PiSession, PiSessionHeader } from "../schemas/pi.js";
import type {
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeTurnEntry,
} from "../schemas/claude.js";

export interface PiToClaudeOptions {
  /** Pre-chosen claude session id. Default: fresh UUID. */
  sessionId?: string;
  /** Override the destination path. Default: claude's standard projects layout. */
  targetPath?: string;
  /** Claude Code version string to embed in the envelope. Default: "2.1.114". */
  claudeVersion?: string;
  /** Default assistant model to use when pi didn't record one. */
  defaultAssistantModel?: string;
}

export interface PiToClaudeResult {
  source: string;
  target: string;
  sessionId: string;
  cwd: string;
  events: number;
}

/** Encode a cwd the way claude does for ~/.claude/projects/<key>/. */
export function claudeProjectKeyForCwd(cwd: string): string {
  return "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
}

/** Claude's default path for a session file. */
export function defaultClaudeSessionPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", claudeProjectKeyForCwd(cwd), `${sessionId}.jsonl`);
}

// Anthropic's API requires tool_use.id to match /^[a-zA-Z0-9_-]+$/. Pi uses
// composite IDs with `|` separators, so we sanitize on the way out and maintain
// a stable map so tool_use ↔ tool_result still reference each other.
export function sanitizeToolId(raw: unknown): string {
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]+$/.test(raw) && raw.length <= 64) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (cleaned) return cleaned;
  }
  return "call_" + randomUUID().replace(/-/g, "");
}

function parsePiJsonl(raw: string): PiSession {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const parsed = lines.map((l) => JSON.parse(l));
  const header = parsed.find((e): e is PiSessionHeader => e?.type === "session");
  if (!header) throw new Error("pi session is missing its session-header entry");
  const entries = parsed.filter((e) => e && e.type !== "session") as PiEntry[];
  return { header, entries };
}

export function translatePiToClaudeSession(
  pi: PiSession,
  opts: PiToClaudeOptions = {},
): { sessionId: string; cwd: string; entries: ClaudeEntry[] } {
  const sessionId = opts.sessionId ?? randomUUID();
  const claudeVersion = opts.claudeVersion ?? "2.1.114";
  const defaultModel = opts.defaultAssistantModel ?? "claude-sonnet-4-20250514";
  const cwd = pi.header.cwd;

  const toolIdMap = new Map<string, string>();
  const toolIdFor = (raw: string | undefined | null): string => {
    const key = raw ?? "";
    if (!toolIdMap.has(key)) toolIdMap.set(key, sanitizeToolId(key));
    return toolIdMap.get(key)!;
  };

  const baseEnvelope = (uuid: string, parentUuid: string | null, ts: string) => ({
    uuid,
    parentUuid,
    isSidechain: false,
    sessionId,
    timestamp: ts,
    cwd,
    userType: "external" as const,
    entrypoint: "cli" as const,
    version: claudeVersion,
  });

  const out: ClaudeEntry[] = [];
  // Every claude session we've inspected starts with a permission-mode marker.
  out.push({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId });

  let lastUuid: string | null = null;
  for (const e of pi.entries) {
    if (e.type !== "message" || !e.message) continue;

    const msg = e.message;
    const ts = e.timestamp || pi.header.timestamp;
    const uuid = e.id || randomUUID();
    const parentUuid = (e.parentId as string | null | undefined) ?? lastUuid;

    if (msg.role === "user") {
      const text = (msg.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");
      const turn: ClaudeTurnEntry = {
        type: "user",
        ...baseEnvelope(uuid, parentUuid, ts),
        promptId: randomUUID(),
        message: { role: "user", content: text },
        permissionMode: "bypassPermissions",
      };
      out.push(turn);
    } else if (msg.role === "assistant") {
      const content: ClaudeContentBlock[] = [];
      for (const c of msg.content || []) {
        if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinking) content.push({ type: "thinking", thinking: c.thinking });
        else if (c.type === "toolCall") {
          content.push({
            type: "tool_use",
            id: toolIdFor(c.id),
            name: c.name ?? "unknown",
            input: c.arguments ?? {},
          });
        }
      }
      const turn: ClaudeTurnEntry = {
        type: "assistant",
        ...baseEnvelope(uuid, parentUuid, ts),
        message: {
          id: randomUUID(),
          role: "assistant",
          model: msg.model || defaultModel,
          content,
        },
      };
      out.push(turn);
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const toolUseId = toolIdFor(msg.toolCallId);
      const blocks: ClaudeContentBlock[] = [];
      for (const c of msg.content || []) {
        const text = typeof c.text === "string" ? c.text : JSON.stringify(c);
        blocks.push({ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: Boolean(msg.isError) });
      }
      const turn: ClaudeTurnEntry = {
        type: "user",
        ...baseEnvelope(uuid, parentUuid, ts),
        message: { role: "user", content: blocks },
      };
      out.push(turn);
    }
    // Meta events (model_change, thinking_level_change, etc.) aren't carried
    // forward — they're pi-internal settings and don't affect claude's resume.

    lastUuid = uuid;
  }

  return { sessionId, cwd, entries: out };
}

export async function migratePiSessionToClaude(
  sourcePath: string,
  opts: PiToClaudeOptions = {},
): Promise<PiToClaudeResult> {
  const raw = await readFile(sourcePath, "utf-8");
  const pi = parsePiJsonl(raw);
  const { sessionId, cwd, entries } = translatePiToClaudeSession(pi, opts);

  const targetPath = opts.targetPath ?? defaultClaudeSessionPath(cwd, sessionId);
  await mkdir(dirname(targetPath), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(targetPath, body);

  return { source: sourcePath, target: targetPath, sessionId, cwd, events: entries.length };
}
