import { randomUUID } from "node:crypto";

import type { AgentKind, Toast, ToastContentBlock, ToastEvent, ToastLoss, ToastNoteBlock, ToastThinkingBlock, ToastTurn } from "../schemas/toast.js";
import type { AgentCompat, ValidationResult, WriteOptions } from "./types.js";

export function makeLoss(
  severity: ToastLoss["severity"],
  path: string,
  reason: string,
  value?: unknown,
): ToastLoss {
  return { severity, path, reason, value };
}

export function coerceToolInputObject(
  agent: string,
  input: unknown,
  losses: ToastLoss[],
  path: string,
): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  losses.push(makeLoss("info", path, `${agent} tool input must be an object — wrapped non-object input under input`));
  return { input };
}

export function sanitizeToolId(raw: unknown): string {
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]+$/.test(raw) && raw.length <= 64) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (cleaned) return cleaned;
  }
  return "call_" + randomUUID().replace(/-/g, "");
}

export function extractTextBlocks(content: ToastContentBlock[]): Array<{ type: "text"; text: string }> {
  return content.filter((block): block is { type: "text"; text: string } => block.type === "text");
}

export function summarizeWriteLosses(
  trace: Toast,
  losses: ToastLoss[],
): Array<{ severity: string; path: string; reason: string }> {
  return [...trace.losses, ...losses].map((loss) => ({
    severity: loss.severity,
    path: loss.path,
    reason: loss.reason,
  }));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyImportedValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => stringifyImportedValue(item)).filter(Boolean).join("\n");
  }
  if (isPlainObject(value)) {
    for (const key of ["text", "thinking", "content", "message", "summary"]) {
      const candidate = value[key];
      const text = stringifyImportedValue(candidate);
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shouldDowngradeThinkingBlock(block: ToastThinkingBlock, compat: AgentCompat): boolean {
  if (compat.thinking === "native") return false;
  if (compat.thinking === "not-written") return true;
  return block.format !== "anthropic" || typeof block.signature !== "string" || block.signature.length === 0;
}

function resolveThinkingPolicy(options?: WriteOptions): "drop" | "note" {
  return options?.thinkingPolicy ?? "note";
}

function makeThinkingCompactionNote(agent: string, block: ToastThinkingBlock): ToastNoteBlock {
  return {
    type: "note",
    kind: "imported_thinking",
    text: block.text,
    metadata: {
      compactedFrom: "thinking",
      sourceFormat: block.format ?? "unknown",
      targetAgent: agent,
      ...(block.signature ? { sourceSignature: block.signature } : {}),
    },
  };
}

function makeUnknownBlockCompactionNote(agent: string, block: Extract<ToastContentBlock, { type: "unknown" }>): ToastNoteBlock {
  return {
    type: "note",
    kind: "imported_content",
    text: stringifyImportedValue(block.value),
    metadata: {
      compactedFrom: "unknown",
      originalType: block.originalType,
      targetAgent: agent,
    },
  };
}

export function makeImportedEventNote(event: ToastEvent): ToastNoteBlock {
  const body = stringifyImportedValue(event.value);
  return {
    type: "note",
    kind: "imported_event",
    text: body ? `${event.type}: ${body}` : event.type,
    metadata: {
      importedEventType: event.type,
      importedEventTimestamp: event.timestamp,
    },
  };
}

export function prependImportedContextTurn(
  trace: Toast,
  turn: ToastTurn,
): Toast {
  return {
    ...trace,
    turns: [turn, ...trace.turns],
  };
}

export function makeImportedContextTurn(
  id: string,
  timestamp: string | undefined,
  blocks: ToastNoteBlock[],
  agent: string,
): ToastTurn {
  return {
    id,
    parentId: null,
    role: "developer",
    timestamp,
    content: blocks,
    provenance: { agent: traceSourceAgent(agent) },
    metadata: { synthetic: true, importedContext: true },
  };
}

function traceSourceAgent(agent: string): AgentKind {
  if (agent === "pi" || agent === "claude" || agent === "codex" || agent === "opencode") return agent;
  return "pi";
}

export function renderNoteBlockAsText(block: ToastNoteBlock): string {
  return block.text;
}

export function renderContentBlockAsText(block: ToastContentBlock): string | undefined {
  if (block.type === "text") return block.text;
  if (block.type === "note") return renderNoteBlockAsText(block);
  return undefined;
}

export function joinRenderableText(blocks: ToastContentBlock[], separator = ""): string {
  return blocks
    .map((block) => renderContentBlockAsText(block))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join(separator);
}

export function compactToastForWrite(
  agent: string,
  trace: Toast,
  compat: AgentCompat,
  options?: WriteOptions,
): { trace: Toast; losses: ToastLoss[] } {
  if (resolveThinkingPolicy(options) !== "note") {
    return { trace, losses: [] };
  }

  const losses: ToastLoss[] = [];
  let changed = false;
  const turns = trace.turns.map((turn, turnIndex) => {
    let turnChanged = false;
    const content = turn.content.map((block, blockIndex) => {
      if (block.type === "thinking" && shouldDowngradeThinkingBlock(block, compat) && resolveThinkingPolicy(options) === "note") {
        changed = true;
        turnChanged = true;
        losses.push(makeLoss("info", `turns[${turnIndex}].content[${blockIndex}]`, `thinking block downgraded to imported context for ${agent}`));
        return makeThinkingCompactionNote(agent, block);
      }
      if (block.type === "unknown") {
        changed = true;
        turnChanged = true;
        losses.push(makeLoss("info", `turns[${turnIndex}].content[${blockIndex}]`, `unknown content block downgraded to imported context for ${agent}`));
        return makeUnknownBlockCompactionNote(agent, block);
      }
      return block;
    });
    return turnChanged ? { ...turn, content } : turn;
  });

  return { trace: changed ? { ...trace, turns } : trace, losses };
}

export function validateToastForCompat(
  agent: string,
  trace: Toast,
  compat: AgentCompat,
  options?: WriteOptions,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (let turnIndex = 0; turnIndex < trace.turns.length; turnIndex++) {
    const turn = trace.turns[turnIndex];

    if (compat.assistantUsage === "required" && turn.role === "assistant" && !turn.usage) {
      errors.push(`turns[${turnIndex}]: assistant usage is required for ${agent} resume safety`);
    }

    if (turn.role === "tool" && !turn.content.some((block) => block.type === "tool_result")) {
      errors.push(`turns[${turnIndex}]: tool-role turn has no tool_result block`);
    }

    for (let blockIndex = 0; blockIndex < turn.content.length; blockIndex++) {
      const block = turn.content[blockIndex];
      const path = `turns[${turnIndex}].content[${blockIndex}]`;

      if (block.type === "tool_call") {
        if (compat.toolInput === "object-only" && !isPlainObject(block.arguments)) {
          warnings.push(`${path}: ${agent} requires object tool input; non-object input will be wrapped under input`);
        }
        if (compat.toolCallId?.pattern && !(new RegExp(compat.toolCallId.pattern).test(block.id))) {
          warnings.push(`${path}.id: tool call id does not match ${agent} pattern ${compat.toolCallId.pattern}`);
        }
        if (compat.toolCallId?.maxLength && block.id.length > compat.toolCallId.maxLength) {
          warnings.push(`${path}.id: tool call id exceeds ${agent} max length ${compat.toolCallId.maxLength}`);
        }
      }

      if (block.type === "tool_result") {
        if (compat.toolCallId?.pattern && !(new RegExp(compat.toolCallId.pattern).test(block.toolCallId))) {
          warnings.push(`${path}.toolCallId: tool result id does not match ${agent} pattern ${compat.toolCallId.pattern}`);
        }
        if (compat.toolCallId?.maxLength && block.toolCallId.length > compat.toolCallId.maxLength) {
          warnings.push(`${path}.toolCallId: tool result id exceeds ${agent} max length ${compat.toolCallId.maxLength}`);
        }
      }

      if (block.type === "thinking" && shouldDowngradeThinkingBlock(block, compat)) {
        if (resolveThinkingPolicy(options) === "note") {
          warnings.push(`${path}: non-portable thinking will be preserved as imported context when writing ${agent}`);
        } else if (compat.thinking === "signed-only") {
          warnings.push(`${path}: unsigned or non-anthropic thinking will be dropped when writing ${agent}`);
        } else {
          warnings.push(`${path}: thinking blocks are not written in ${agent} format`);
        }
      }

      if (block.type === "unknown") {
        warnings.push(`${path}: unknown content will be preserved as imported context when writing ${agent}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function validationResultToLosses(result: ValidationResult): ToastLoss[] {
  return [
    ...result.errors.map((reason) => makeLoss("error", "validateWrite", reason)),
    ...result.warnings.map((reason) => makeLoss("warning", "validateWrite", reason)),
  ];
}

export function throwIfStrictValidationFails(
  agent: string,
  options: { strict?: boolean } | undefined,
  result: ValidationResult,
): void {
  if (!options?.strict || result.errors.length === 0) return;
  throw new Error(`cannot safely write TOAST to ${agent}: ${result.errors.join("; ")}`);
}
