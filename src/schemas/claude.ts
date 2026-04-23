// Claude Code session schema — inferred from inspecting real session files
// written to ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl.
//
// Each line is a single event. Events have a common envelope (uuid, parentUuid,
// sessionId, timestamp, cwd, etc.) plus a `type` discriminator and `message`
// payload for user/assistant turns.

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string; // MUST match /^[a-zA-Z0-9_-]+$/ — Anthropic API validation
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
  is_error?: boolean;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeMessage {
  id?: string;
  role: "user" | "assistant";
  model?: string;
  // content is a string for simple user turns, or an array of blocks for
  // assistant turns / tool-bearing turns.
  content: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
  stop_reason?: string | null;
}

// The envelope fields attached to every turn event.
export interface ClaudeEnvelope {
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  sessionId: string;
  timestamp: string;
  cwd: string;
  userType?: string; // "external"
  entrypoint?: string; // "cli"
  version?: string;
  gitBranch?: string;
  permissionMode?: string;
}

export interface ClaudeTurnEntry extends ClaudeEnvelope {
  type: "user" | "assistant";
  promptId?: string;
  message: ClaudeMessage;
}

export interface ClaudePermissionModeEntry {
  type: "permission-mode";
  permissionMode: string;
  sessionId: string;
}

export interface ClaudeFileHistorySnapshotEntry {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: unknown;
  isSnapshotUpdate: boolean;
}

export type ClaudeEntry =
  | ClaudeTurnEntry
  | ClaudePermissionModeEntry
  | ClaudeFileHistorySnapshotEntry
  | ({ type: string } & Record<string, unknown>); // catch-all

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  entries: ClaudeEntry[];
}
