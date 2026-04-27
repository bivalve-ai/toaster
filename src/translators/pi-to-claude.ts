// Backwards-compat wrapper. The real logic now lives in src/adapters/claude.ts
// (via Toast) + src/translate.ts. Kept so existing imports keep working.

import type { WriteResult } from "../adapters/types.js";
import { translate } from "../translate.js";
export { sanitizeToolId } from "../adapters/shared.js";
export { defaultClaudeSessionPath } from "../adapters/claude.js";

export async function migratePiSessionToClaude(sourcePath: string): Promise<{
  source: string;
  target: string;
  sessionId: string;
  cwd: string;
  events: number;
}> {
  const result: WriteResult = await translate("claude", sourcePath, { from: "pi" });
  return {
    source: sourcePath,
    target: result.target,
    sessionId: result.sessionId,
    cwd: result.cwd ?? "",
    events: result.turns, // caller expected "events" count for backwards compat
  };
}
