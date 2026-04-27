// Codex CLI session schema — inferred from real session files in ~/.codex/sessions.
//
// Each line is a JSON object with a top-level `type` and `timestamp`. The most
// important records for translation are:
// - `session_meta`          session envelope
// - `response_item`         user / assistant / tool items
// - `turn_context`          per-turn runtime metadata
// - `event_msg`             UI / runtime events such as token_count

export interface CodexSessionMetaPayload {
  id: string;
  timestamp: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  base_instructions?: { text?: string };
  git?: {
    commit_hash?: string;
    branch?: string;
  };
}

export interface CodexSessionMetaEntry {
  timestamp: string;
  type: "session_meta";
  payload: CodexSessionMetaPayload;
}

export interface CodexTextContent {
  type: "input_text" | "output_text";
  text: string;
}

export interface CodexMessageItem {
  type: "message";
  role: "developer" | "user" | "assistant";
  content: CodexTextContent[];
  phase?: string;
}

export interface CodexReasoningItem {
  type: "reasoning";
  summary?: Array<{ type?: string; text?: string }>;
  content?: string | null;
  encrypted_content?: string | null;
}

export interface CodexFunctionCallItem {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

export interface CodexFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface CodexCustomToolCallItem {
  type: "custom_tool_call";
  status?: string;
  call_id: string;
  name: string;
  input: string;
}

export interface CodexCustomToolCallOutputItem {
  type: "custom_tool_call_output";
  call_id: string;
  output: string;
}

export type CodexResponseItem =
  | CodexMessageItem
  | CodexReasoningItem
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem
  | CodexCustomToolCallItem
  | CodexCustomToolCallOutputItem
  | ({ type: string } & Record<string, unknown>);

export interface CodexResponseEntry {
  timestamp: string;
  type: "response_item";
  payload: CodexResponseItem;
}

export interface CodexTurnContextEntry {
  timestamp: string;
  type: "turn_context";
  payload: Record<string, unknown> & {
    turn_id?: string;
    cwd?: string;
    model?: string;
    effort?: string;
  };
}

export interface CodexEventMsgEntry {
  timestamp: string;
  type: "event_msg";
  payload: ({ type: string } & Record<string, unknown>);
}

export type CodexEntry =
  | CodexSessionMetaEntry
  | CodexResponseEntry
  | CodexTurnContextEntry
  | CodexEventMsgEntry
  | ({ type: string; timestamp?: string } & Record<string, unknown>);
