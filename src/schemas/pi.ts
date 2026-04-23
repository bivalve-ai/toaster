// Pi session schema — normalized shape used throughout toaster.
// Matches the JSONL written by @mariozechner/pi-coding-agent into
// ~/.pi/agent/sessions/--<cwd-encoded>--/<ts>_<uuid>.jsonl.

export interface PiContent {
  type: string; // "text" | "thinking" | "toolCall" | ...
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface PiMessage {
  role: string; // "user" | "assistant" | "toolResult"
  content: PiContent[];
  usage?: PiUsage;
  model?: string;
  provider?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface PiSessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface PiEntry {
  type: string; // "message" | "model_change" | "thinking_level_change" | "custom" | ...
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  provider?: string;
  modelId?: string;
  cwd?: string;
  customType?: string;
  data?: unknown;
  name?: string;
}

export interface PiSession {
  header: PiSessionHeader;
  entries: PiEntry[];
}
