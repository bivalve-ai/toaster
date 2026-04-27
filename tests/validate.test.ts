import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAdapter } from "../src/adapters/claude.js";
import { piAdapter } from "../src/adapters/pi.js";
import type { Toast } from "../src/schemas/toast.js";

function makeToast(turns: Toast["turns"]): Toast {
  return {
    traceVersion: 1,
    id: "toast-1",
    cwd: "/tmp/toaster-test",
    createdAt: "2026-04-23T00:00:00.000Z",
    source: { agent: "pi" },
    agents: [{ agent: "pi" }],
    turns,
    events: [],
    metadata: {},
    losses: [],
  };
}

test("pi validateWrite reports missing assistant usage as an error", () => {
  const toast = makeToast([
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);

  const result = piAdapter.validateWrite?.(toast);
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? "", /assistant usage is required for pi resume safety/);
});

test("pi strict write fails fast on preflight validation errors", async () => {
  const toast = makeToast([
    {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);

  await assert.rejects(
    piAdapter.write(toast, {
      targetPath: join(tmpdir(), `toaster-validate-pi-${Date.now()}.jsonl`),
      strict: true,
    }),
    /cannot safely write TOAST to pi: turns\[0\]: assistant usage is required for pi resume safety/,
  );
});

test("claude validateWrite warns about unsigned thinking and non-object tool input", () => {
  const toast = makeToast([
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden chain of thought", format: "pi" },
        { type: "tool_call", id: "call_1", name: "apply_patch", arguments: "*** Begin Patch" },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);

  const result = claudeAdapter.validateWrite?.(toast);
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((warning) => /non-portable thinking will be preserved as imported context/.test(warning)));
  assert.ok(result.warnings.some((warning) => /requires object tool input; non-object input will be wrapped/.test(warning)));
});

test("claude strict write does not fail on warnings-only preflight", async () => {
  const toast = makeToast([
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "patch the file" }],
      provenance: { agent: "pi" },
      metadata: {},
    },
    {
      id: "a1",
      parentId: "u1",
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden chain of thought", format: "pi" },
        { type: "tool_call", id: "call_1", name: "apply_patch", arguments: "*** Begin Patch" },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);

  const result = await claudeAdapter.write(toast, {
    targetPath: join(tmpdir(), `toaster-validate-claude-${Date.now()}.jsonl`),
    strict: true,
    sessionId: "validate-claude-session",
  });

  assert.equal(result.targetAgent, "claude");
  assert.ok(result.losses.some((loss) => loss.severity === "warning" && /non-portable thinking will be preserved as imported context/.test(loss.reason)));
  assert.ok(result.losses.some((loss) => loss.severity === "warning" && /requires object tool input/.test(loss.reason)));
});

test("claude preserves non-portable thinking as imported context by default", async () => {
  const toast = makeToast([
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "patch the file" }],
      provenance: { agent: "pi" },
      metadata: {},
    },
    {
      id: "a1",
      parentId: "u1",
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden chain of thought", format: "pi" },
        { type: "text", text: "I can help with that." },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);

  const outPath = join(tmpdir(), `toaster-thinking-note-claude-${Date.now()}.jsonl`);
  await claudeAdapter.write(toast, {
    targetPath: outPath,
    sessionId: "thinking-note-session",
  });

  const reread = await claudeAdapter.read(outPath);
  const assistant = reread.turns.find((turn) => turn.role === "assistant");
  assert.ok(assistant);
  const texts = assistant?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
  assert.match(texts, /hidden chain of thought/);
  assert.match(texts, /I can help with that\./);
  assert.doesNotMatch(texts, /\[toaster note\]/);
});

test("claude preserves unknown content blocks as imported context", async () => {
  const toast = makeToast([
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "unknown", originalType: "reasoning_summary", value: { text: "Investigated the repository structure." } },
        { type: "text", text: "Next I will make the change." },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provenance: { agent: "codex" },
      metadata: {},
    },
  ]);

  const outPath = join(tmpdir(), `toaster-unknown-block-claude-${Date.now()}.jsonl`);
  await claudeAdapter.write(toast, {
    targetPath: outPath,
    sessionId: "unknown-block-session",
  });

  const reread = await claudeAdapter.read(outPath);
  const assistant = reread.turns.find((turn) => turn.role === "assistant");
  assert.ok(assistant);
  const texts = assistant?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
  assert.match(texts, /Investigated the repository structure\./);
  assert.match(texts, /Next I will make the change\./);
});

test("claude preserves events as imported context instead of dropping them", async () => {
  const toast = makeToast([
    {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      provenance: { agent: "pi" },
      metadata: {},
    },
  ]);
  toast.events.push({
    id: "ev1",
    type: "permission-mode",
    timestamp: "2026-04-23T00:00:00.000Z",
    value: { permissionMode: "bypassPermissions" },
    provenance: { agent: "claude" },
  });

  const outPath = join(tmpdir(), `toaster-event-context-claude-${Date.now()}.jsonl`);
  await claudeAdapter.write(toast, {
    targetPath: outPath,
    sessionId: "event-context-session",
  });

  const reread = await claudeAdapter.read(outPath);
  const imported = reread.turns.find((turn) => turn.role === "user" && turn.content.some((block) => block.type === "text" && /permission-mode/.test(block.text)));
  assert.ok(imported);
  const text = imported?.content.find((block) => block.type === "text")?.type === "text"
    ? imported.content.find((block) => block.type === "text")!.text
    : "";
  assert.match(text, /permission-mode/);
  assert.match(text, /bypassPermissions/);
});
