// Backwards-compat wrapper. Real logic now lives in src/adapters/pi.ts (via
// Toast) + src/translate.ts. Old imports still work.

import type { WriteResult } from "../adapters/types.js";
import { translate } from "../translate.js";
export { defaultPiSessionPath } from "../adapters/pi.js";

export async function migrateClaudeSessionToPi(sourcePath: string): Promise<{
  source: string;
  target: string;
  sessionId: string;
  cwd: string;
  events: number;
}> {
  const result: WriteResult = await translate("pi", sourcePath, { from: "claude" });
  return {
    source: sourcePath,
    target: result.target,
    sessionId: result.sessionId,
    cwd: result.cwd ?? "",
    events: result.turns,
  };
}

// The old normalize + serialize internal API — tests poke this directly. Keep
// a thin re-export over the adapter read so legacy code paths compile.
import { piAdapter } from "../adapters/pi.js";
export async function normalizeClaudeJSONL(filePath: string) {
  // Read claude and convert the Toast to something roughly shaped like the old
  // NormalizedPiSession — for tests that inspect role names etc.
  const { claudeAdapter } = await import("../adapters/claude.js");
  const trace = await claudeAdapter.read(filePath);
  return traceToLegacyPiSession(trace);
}
export function serializePiSession(_session: unknown): string {
  throw new Error("serializePiSession is deprecated — use translate('pi', ...)");
}

function traceToLegacyPiSession(trace: {
  id: string; cwd?: string; createdAt?: string; turns: any[]; events: any[];
}) {
  return {
    header: {
      type: "session" as const,
      version: 3,
      id: trace.id,
      timestamp: trace.createdAt ?? new Date().toISOString(),
      cwd: trace.cwd ?? "",
    },
    entries: trace.turns.map((t) => ({
      type: "message",
      id: t.id,
      parentId: t.parentId,
      timestamp: t.timestamp,
      message: {
        role: t.role === "tool" ? "toolResult" : t.role,
        content: (t.content ?? []).map((b: any) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "thinking") return { type: "thinking", thinking: b.text };
          if (b.type === "tool_call") return { type: "toolCall", id: b.rawId ?? b.id, name: b.name, arguments: b.arguments };
          if (b.type === "tool_result") return { type: "text", text: (b.content?.[0]?.text) ?? "" };
          return b;
        }),
      },
    })),
  };
}
