// TOAST — the canonical, agent-agnostic shape of an AI agent session.
//
// TOAST stands for Transferable Open Agent Session Trace. Every supported
// agent reads its native session format into this shape and writes back out of
// it. Translation becomes read-from-A → TOAST → write-to-B.

export type AgentKind = "pi" | "claude" | "codex" | "opencode";

// Actor role of an individual turn. "tool" normalizes all the ways agents
// represent tool results (pi's role=toolResult message; claude's user-role
// with tool_result content blocks; codex's function_call_output).
export type ToastRole = "system" | "developer" | "user" | "assistant" | "tool";

// -------------------- session-level --------------------

export interface Toast {
  // Kept as `traceVersion` for v1 compatibility with the existing format.
  traceVersion: 1;
  id: string;
  cwd?: string;
  createdAt?: string;
  /** Set when this TOAST forked off from another TOAST (pi supports this). */
  parentTraceId?: string;
  source: Provenance;
  /** Which agent(s) wrote to this conversation. Usually one; more on cross-agent replay. */
  agents: AgentFingerprint[];
  turns: ToastTurn[];
  /** Non-conversation events: token counts, permission-mode transitions, model changes, etc. */
  events: ToastEvent[];
  /** Catch-all for agent-specific top-level fields we want to preserve across round-trips. */
  metadata: Record<string, unknown>;
  /** Tracked lossy choices during read/write — nothing is dropped silently. */
  losses: ToastLoss[];
}

export interface AgentFingerprint {
  agent: AgentKind;
  version?: string;
  model?: string;
  provider?: string;
}

// -------------------- turn-level --------------------

export interface ToastTurn {
  id: string;
  parentId?: string | null;
  role: ToastRole;
  timestamp?: string;
  content: ToastContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: "stop" | "tool_use" | "length" | "error" | "cancelled" | "unknown";
  usage?: ToastUsage;
  provenance: Provenance;
  metadata: Record<string, unknown>;
  losses?: ToastLoss[];
  /**
   * When set, this turn belongs to a secondary thread (subagent / sidechain),
   * not the main conversation. Multiple subagent branches can coexist in one
   * TOAST. See SubagentContext for the fork-point semantics.
   */
  subagent?: SubagentContext;
}

/**
 * Metadata attached to a turn that's part of a subagent/sidechain branch.
 *
 * - Claude Code: sidechains spawn from Task() invocations; every sidechain
 *   turn has `isSidechain: true` in the native format.
 * - Pi: parent-session forking is session-level (see Toast.parentTraceId);
 *   within-session subagents aren't an established pattern yet.
 * - Codex: not currently a primitive; could emerge via nested Task()-like
 *   behavior later.
 */
export interface SubagentContext {
  /** Branch id — unique within this TOAST. */
  id: string;
  /** The main-thread turn id that invoked the subagent. */
  spawnedByTurnId: string;
  origin: "claude-sidechain" | "pi-fork" | "codex-task" | "unknown";
  metadata?: Record<string, unknown>;
}

// -------------------- content blocks --------------------

export type ToastContentBlock =
  | ToastTextBlock
  | ToastThinkingBlock
  | ToastNoteBlock
  | ToastToolCallBlock
  | ToastToolResultBlock
  | ToastUnknownBlock;

export interface ToastTextBlock {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ToastThinkingBlock {
  type: "thinking";
  text: string;
  /**
   * Signature bytes, if the source agent recorded them. Anthropic's API
   * requires a valid signature for thinking blocks on resume. Pi stores
   * its own `thinkingSignature` that does NOT validate against Anthropic;
   * translating pi-thinking to claude usually means dropping the block.
   */
  signature?: string;
  format?: "pi" | "anthropic" | "codex-reasoning" | "opencode-reasoning";
  metadata?: Record<string, unknown>;
}

/**
 * A note block is a durable downgrade target for content that cannot be
 * preserved natively in another agent format. Notes are explicit, visible,
 * and should never pretend to be the original hidden content.
 */
export interface ToastNoteBlock {
  type: "note";
  kind: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ToastToolCallBlock {
  type: "tool_call";
  /** Canonical id — safe for any target (Anthropic validates `/^[a-zA-Z0-9_-]+$/`). */
  id: string;
  /** Original id as produced by the source agent, retained for round-trip fidelity. */
  rawId?: string;
  name: string;
  /** Tool input. Usually an object, but some agents persist raw strings or other JSON values. */
  arguments: unknown;
  metadata?: Record<string, unknown>;
}

export interface ToastToolResultBlock {
  type: "tool_result";
  /** Links to the matching ToastToolCallBlock.id — the canonical id. */
  toolCallId: string;
  rawToolCallId?: string;
  toolName?: string;
  /** Usually one text block; kept nested so structured results can pass through. */
  content: ToastContentBlock[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Catch-all for content types we don't recognize. Keeps schema drift durable —
 * an agent adding a new content block type doesn't cost us data.
 */
export interface ToastUnknownBlock {
  type: "unknown";
  originalType?: string;
  value: unknown;
  metadata?: Record<string, unknown>;
}

// -------------------- events (non-conversation) --------------------

export interface ToastEvent {
  id: string;
  /**
   * The event type — passed through verbatim from the source agent when
   * possible (e.g. "model_change", "permission-mode", "token_count",
   * "turn_context"). Adapters can also mint synthetic types.
   */
  type: string;
  timestamp?: string;
  parentId?: string | null;
  value: unknown;
  provenance: Provenance;
  metadata?: Record<string, unknown>;
}

// -------------------- shared bits --------------------

export interface ToastUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Where a piece of data came from. Every TOAST, turn, and event carries this
 * so round-trip bugs can be traced back to the source file + line.
 */
export interface Provenance {
  agent: AgentKind;
  path?: string;
  line?: number;
  rawType?: string;
  rawId?: string;
  rawParentId?: string | null;
  schemaVersion?: string | number;
}

/**
 * A tracked lossy decision during read or write. Use path-strings like
 * `turns[3].content[1].signature` so diffing is sane. Severity: info for
 * expected drops (agent X doesn't have concept Y), warning for unexpected,
 * error when we drop something that might materially change replay.
 */
export interface ToastLoss {
  severity: "info" | "warning" | "error";
  path: string;
  reason: string;
  value?: unknown;
}
