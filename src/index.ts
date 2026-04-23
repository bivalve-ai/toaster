// Public library API.
//
//   import { translate, readTrace, writeTrace, discoverSessions } from "toaster-notes";
//
//   const trace = await readTrace("pi", piSessionPath);
//   await writeTrace("claude", trace);
//
//   // or one-shot:
//   const result = await translate("claude", piSessionPath, { from: "pi" });

export { translate } from "./translate.js";
export { discoverSessions, type DiscoveredSession } from "./discover.js";
export { adapters, getAdapter, detectAgent, piAdapter, claudeAdapter } from "./adapters/index.js";
export type {
  AgentAdapter,
  WriteOptions,
  WriteResult,
  ReadOptions,
  ValidationResult,
} from "./adapters/types.js";

export type {
  Trace,
  TraceTurn,
  TraceEvent,
  TraceContentBlock,
  TraceTextBlock,
  TraceThinkingBlock,
  TraceToolCallBlock,
  TraceToolResultBlock,
  TraceUnknownBlock,
  TraceUsage,
  TraceLoss,
  TraceRole,
  AgentKind,
  AgentFingerprint,
  Provenance,
  SubagentContext,
} from "./schemas/trace.js";

// Convenience: two-arg verb shape.
import type { AgentKind, Trace } from "./schemas/trace.js";
import type { WriteOptions } from "./adapters/types.js";
import { getAdapter } from "./adapters/index.js";
export async function readTrace(agent: AgentKind, path: string): Promise<Trace> {
  return getAdapter(agent).read(path);
}
export async function writeTrace(agent: AgentKind, trace: Trace, options?: WriteOptions) {
  return getAdapter(agent).write(trace, options);
}

// Legacy pairwise helpers, preserved for back-compat.
export { migratePiSessionToClaude } from "./translators/pi-to-claude.js";
export { migrateClaudeSessionToPi } from "./translators/claude-to-pi.js";
