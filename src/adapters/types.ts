// The AgentAdapter interface — implemented once per agent (pi, claude, codex…).
// Translation becomes N + N operations instead of N × N: every adapter reads
// into Trace and writes out of Trace; the orchestrator (src/translate.ts)
// pairs any source with any target.

import type { AgentKind, Trace } from "../schemas/trace.js";

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
  /** Default assistant model when the Trace doesn't record one. */
  defaultModel?: string;
  /** Pin the target agent's version in the output envelope. */
  agentVersion?: string;
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

  /** Sniff a file to see if it's this agent's format. Cheap check. */
  detect(path: string): Promise<boolean>;

  /** Walk the agent's conventional on-disk session storage. */
  list(): Promise<DiscoveredSession[]>;

  /** Read the agent's JSONL into a Trace. Must populate Provenance. */
  read(path: string, options?: ReadOptions): Promise<Trace>;

  /** Write a Trace back out in the agent's native format. */
  write(trace: Trace, options?: WriteOptions): Promise<WriteResult>;

  /** Compute the conventional target path for a Trace. */
  defaultPath(trace: Trace, options?: WriteOptions): string;

  /** Optional: validate a Trace is safely writable to this agent. */
  validateWrite?(trace: Trace): ValidationResult;

  /** Optional: validate a native session file on disk. */
  validateNative?(path: string): Promise<ValidationResult>;
}
