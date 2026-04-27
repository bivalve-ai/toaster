// Public library API.
//
//   import { translate, readToast, writeToast, discoverSessions } from "toaster-cli";
//
//   const trace = await readToast("pi", piSessionPath);
//   await writeToast("claude", trace);
//
//   // or one-shot:
//   const result = await translate("claude", piSessionPath, { from: "pi" });

export { translate } from "./translate.js";
export { runCorpus } from "./corpus.js";
export { discoverSessions, type DiscoveredSession } from "./discover.js";
export {
  defaultLibraryDir,
  isToast,
  readToastArtifact,
  readSessionAsToast,
  saveToastToLibrary,
  saveSessionToLibrary,
  saveAllSessionsToLibrary,
  listLibrarySessions,
  updateIndex,
  type SavedSession,
  type SaveToastOptions,
  type SaveSessionOptions,
  type SaveAllOptions,
  type SaveAllResult,
  type LibraryIndex,
} from "./library.js";
export {
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  setConfigValue,
  getConfigValue,
  parseConfigValue,
  type ToasterConfig,
  type RedactionProvider,
} from "./config.js";
export {
  redactToast,
  sanitizeRedactionReport,
  detectLocal,
  type RedactionLabel,
  type RedactionSpan,
  type RedactionFieldReport,
  type RedactionReport,
  type RedactionOptions,
  type RedactionResult,
} from "./redaction.js";
export {
  createCloudSafeMirror,
  type CloudSafeMirrorOptions,
  type CloudSafeMirrorResult,
} from "./mirror.js";
export { adapters, getAdapter, detectAgent, piAdapter, claudeAdapter, codexAdapter, opencodeAdapter } from "./adapters/index.js";
export type {
  AgentAdapter,
  AgentCompat,
  WriteOptions,
  WriteResult,
  ReadOptions,
  ValidationResult,
} from "./adapters/types.js";
export type {
  CorpusOptions,
  CorpusTraceSummary,
  CorpusTargetReport,
  CorpusCaseReport,
  CorpusSummary,
  CorpusReport,
} from "./corpus.js";

export type {
  Toast,
  ToastTurn,
  ToastEvent,
  ToastContentBlock,
  ToastTextBlock,
  ToastThinkingBlock,
  ToastNoteBlock,
  ToastToolCallBlock,
  ToastToolResultBlock,
  ToastUnknownBlock,
  ToastUsage,
  ToastLoss,
  ToastRole,
  AgentKind,
  AgentFingerprint,
  Provenance,
  SubagentContext,
} from "./schemas/toast.js";

// Convenience: two-arg verb shape.
import type { AgentKind, Toast } from "./schemas/toast.js";
import type { ValidationResult, WriteOptions } from "./adapters/types.js";
import { getAdapter } from "./adapters/index.js";
export async function readToast(agent: AgentKind, path: string): Promise<Toast> {
  return getAdapter(agent).read(path);
}
export function validateToast(agent: AgentKind, trace: Toast, options?: WriteOptions): ValidationResult {
  const adapter = getAdapter(agent);
  return adapter.validateWrite ? adapter.validateWrite(trace, options) : { ok: true, errors: [], warnings: [] };
}
export async function writeToast(agent: AgentKind, trace: Toast, options?: WriteOptions) {
  return getAdapter(agent).write(trace, options);
}

// Legacy pairwise helpers, preserved for back-compat.
export { migratePiSessionToClaude } from "./translators/pi-to-claude.js";
export { migrateClaudeSessionToPi } from "./translators/claude-to-pi.js";
