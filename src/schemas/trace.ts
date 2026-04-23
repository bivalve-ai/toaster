// Trace — the canonical, agent-agnostic shape of an AI agent session.
// Designed so we can translate between pi / Claude Code / OpenAI Codex (and
// more to come) via a set of per-agent adapters. Everything readable and
// writeable flows through this type.
//
// Background: agent session files on disk are JSONL with a different schema
// per vendor. Rather than N-to-N pairwise translators (which grow quadratically
// as we add agents), each agent gets one adapter: `read(path) → Trace` and
// `write(trace, opts) → file`. Translation becomes read-from-A → write-to-B.
//
// The name is "Trace" (not "Session" or "Transcript") to align with the term
// that's winning in agent tooling + LLM observability — LangSmith, Phoenix,
// OpenTelemetry semconv, etc. A Trace can be resumed in a fresh agent; it's
// not an inert observability record.

export type AgentKind = "pi" | "claude" | "codex";

// Actor role of an individual Turn. "tool" normalizes all the ways agents
// represent tool results (pi's role=toolResult message; claude's user-role
// with tool_result content blocks; codex's function_call_output).
export type TraceRole = "system" | "developer" | "user" | "assistant" | "tool";

// -------------------- session-level --------------------

export interface Trace {
  traceVersion: 1;
  id: string;
  cwd?: string;
  createdAt?: string;
  /** Set when this Trace forked off from another Trace (pi supports this). */
  parentTraceId?: string;
  source: Provenance;
  /** Which agent(s) wrote to this conversation. Usually one; more on cross-agent replay. */
  agents: AgentFingerprint[];
  turns: TraceTurn[];
  /** Non-conversation events: token counts, permission-mode transitions, model changes, etc. */
  events: TraceEvent[];
  /** Catch-all for agent-specific top-level fields we want to preserve across round-trips. */
  metadata: Record<string, unknown>;
  /** Tracked lossy choices during read/write — nothing is dropped silently. */
  losses: TraceLoss[];
}

export interface AgentFingerprint {
  agent: AgentKind;
  version?: string;
  model?: string;
  provider?: string;
}

// -------------------- turn-level --------------------

export interface TraceTurn {
  id: string;
  parentId?: string | null;
  role: TraceRole;
  timestamp?: string;
  content: TraceContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: "stop" | "tool_use" | "length" | "error" | "cancelled" | "unknown";
  usage?: TraceUsage;
  provenance: Provenance;
  metadata: Record<string, unknown>;
  losses?: TraceLoss[];
  /**
   * When set, this turn belongs to a secondary thread (subagent / sidechain),
   * not the main conversation. Multiple subagent branches can coexist in one
   * Trace. See SubagentContext for the fork-point semantics.
   */
  subagent?: SubagentContext;
}

/**
 * Metadata attached to a turn that's part of a subagent/sidechain branch.
 *
 * - Claude Code: sidechains spawn from Task() invocations; every sidechain
 *   turn has `isSidechain: true` in the native format.
 * - Pi: parent-session forking is session-level (see Trace.parentTraceId);
 *   within-session subagents aren't an established pattern yet.
 * - Codex: not currently a primitive; could emerge via nested Task()-like
 *   behavior later.
 */
export interface SubagentContext {
  /** Branch id — unique within this Trace. */
  id: string;
  /** The main-thread turn id that invoked the subagent. */
  spawnedByTurnId: string;
  origin: "claude-sidechain" | "pi-fork" | "codex-task" | "unknown";
  metadata?: Record<string, unknown>;
}

// -------------------- content blocks --------------------

export type TraceContentBlock =
  | TraceTextBlock
  | TraceThinkingBlock
  | TraceToolCallBlock
  | TraceToolResultBlock
  | TraceUnknownBlock;

export interface TraceTextBlock {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface TraceThinkingBlock {
  type: "thinking";
  text: string;
  /**
   * Signature bytes, if the source agent recorded them. Anthropic's API
   * requires a valid signature for thinking blocks on resume. Pi stores
   * its own `thinkingSignature` that does NOT validate against Anthropic;
   * translating pi-thinking to claude usually means dropping the block.
   */
  signature?: string;
  format?: "pi" | "anthropic" | "codex-reasoning";
  metadata?: Record<string, unknown>;
}

export interface TraceToolCallBlock {
  type: "tool_call";
  /** Canonical id — safe for any target (Anthropic validates `/^[a-zA-Z0-9_-]+$/`). */
  id: string;
  /** Original id as produced by the source agent, retained for round-trip fidelity. */
  rawId?: string;
  name: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TraceToolResultBlock {
  type: "tool_result";
  /** Links to the matching TraceToolCallBlock.id — the canonical id. */
  toolCallId: string;
  rawToolCallId?: string;
  toolName?: string;
  /** Usually one text block; kept nested so structured results can pass through. */
  content: TraceContentBlock[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Catch-all for content types we don't recognize. Keeps schema-drift
 * durable — an agent adding a new content block type doesn't cost us data.
 */
export interface TraceUnknownBlock {
  type: "unknown";
  originalType?: string;
  value: unknown;
  metadata?: Record<string, unknown>;
}

// -------------------- events (non-conversation) --------------------

export interface TraceEvent {
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

export interface TraceUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Where a piece of data came from. Every Trace, Turn, and Event carries
 * this so round-trip bugs can be traced back to the source file + line.
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
export interface TraceLoss {
  severity: "info" | "warning" | "error";
  path: string;
  reason: string;
  value?: unknown;
}
