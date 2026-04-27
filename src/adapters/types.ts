// The AgentAdapter interface — implemented once per agent (pi, claude, codex…).
// Translation becomes N + N operations instead of N × N: every adapter reads
// into Toast and writes out of Toast; the orchestrator (src/translate.ts)
// pairs any source with any target.

import type { AgentKind, Toast } from "../schemas/toast.js";

export interface AgentCompat {
  /** Whether assistant turns need usage counters present for safe native resume. */
  assistantUsage: "optional" | "required";
  /** Whether tool call arguments can be arbitrary JSON or must be wrapped as an object. */
  toolInput: "any-json" | "object-only";
  /** Whether the native writer should emit canonical TOAST tool ids instead of raw source ids. */
  writeCanonicalToolIds: boolean;
  /** Constraints for tool call ids accepted by the native format or CLI resume path. */
  toolCallId?: {
    pattern: string;
    maxLength?: number;
  };
  /** How native resume treats thinking blocks. */
  thinking: "native" | "signed-only" | "not-written";
}

export interface DiscoveredSession {
  agent: AgentKind;
  path: string;
  id: string;
  mtime: Date;
  bytes: number;
  cwd?: string;
}

export interface ReadOptions {
  /** Keep event types we don't recognize (default true — preserve for round-trip). */
  preserveUnknownEvents?: boolean;
}

export interface WriteOptions {
  /** Override the target path. Default: adapter's conventional on-disk location. */
  targetPath?: string;
  /** Override the session id written to the target (defaults to a fresh UUID). */
  sessionId?: string;
  /** Default assistant model when the Toast doesn't record one. */
  defaultModel?: string;
  /** Pin the target agent's version in the output envelope. */
  agentVersion?: string;
  /** Downgrade non-portable thinking blocks into explicit compaction notes instead of dropping them. */
  thinkingPolicy?: "drop" | "note";
  /** If true, adapters should fail on any loss marked severity=error instead of swallowing. */
  strict?: boolean;
}

export interface WriteResult {
  sourceAgent?: AgentKind;
  targetAgent: AgentKind;
  target: string;
  sessionId: string;
  cwd?: string;
  turns: number;
  events: number;
  losses: Array<{ severity: string; path: string; reason: string }>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface AgentAdapter {
  kind: AgentKind;
  compat: AgentCompat;

  /** Sniff a file to see if it's this agent's format. Cheap check. */
  detect(path: string): Promise<boolean>;

  /** Walk the agent's conventional on-disk session storage. */
  list(): Promise<DiscoveredSession[]>;

  /** Read the agent's JSONL into a Toast. Must populate Provenance. */
  read(path: string, options?: ReadOptions): Promise<Toast>;

  /** Write a Toast back out in the agent's native format. */
  write(trace: Toast, options?: WriteOptions): Promise<WriteResult>;

  /** Compute the conventional target path for a Toast. */
  defaultPath(trace: Toast, options?: WriteOptions): string;

  /** Optional: validate a Toast is safely writable to this agent. */
  validateWrite?(trace: Toast, options?: WriteOptions): ValidationResult;

  /** Optional: validate a native session file on disk. */
  validateNative?(path: string): Promise<ValidationResult>;
}
