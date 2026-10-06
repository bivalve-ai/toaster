import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { detectAgent, getAdapter, readToast } from "../src/index.js";
import type { ToastContentBlock, ToastTurn } from "../src/schemas/toast.js";

// Built by tests/fixtures/pi-durable/build.mjs with pi-durable 1.0.4: 1 = root (tool round, reset), 27 = fork of 1
// before the reset, 37 = hand-written entries (omit and replace edits, an aborted assistant, an orphaned tool call).
const FIXTURE = join(process.cwd(), "tests/fixtures/pi-durable/session.sqlite");
const CONVERSATIONS = [1, 27, 37];

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "toaster-pi-durable-"));
  const file = join(dir, "session.sqlite");
  copyFileSync(FIXTURE, file);
  return file;
}

type Text = { type: string; text?: string; id?: string };
const textOf = (content: string | Text[]) => (typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join(""));

/** One line per model message, as the target harness would see it. System entries carry no conversation. */
function normalizeMessages(messages: readonly any[]): string[] {
  return messages.flatMap((m) => {
    if (m.role === "user") return [`user: ${textOf(m.content)}`];
    if (m.role === "assistant") {
      const calls = (m.content as Text[]).filter((c) => c.type === "toolCall").map((c) => c.id);
      return [`assistant: ${textOf(m.content)}${calls.length ? ` calls=${calls.join(",")}` : ""}`];
    }
    if (m.role === "toolResult") return [`tool ${m.toolCallId}: ${textOf(m.content)} error=${Boolean(m.isError)}`];
    return [];
  });
}

function normalizeTurns(turns: ToastTurn[]): string[] {
  const text = (blocks: ToastContentBlock[]) => blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return turns.map((t) => {
    if (t.role === "user") return `user: ${text(t.content)}`;
    if (t.role === "assistant") {
      const calls = t.content.flatMap((b) => (b.type === "tool_call" ? [b.rawId ?? b.id] : []));
      return `assistant: ${text(t.content)}${calls.length ? ` calls=${calls.join(",")}` : ""}`;
    }
    const r = t.content[0] as Extract<ToastContentBlock, { type: "tool_result" }>;
    return `tool ${r.rawToolCallId ?? r.toolCallId}: ${text(r.content)} error=${Boolean(r.isError)}`;
  });
}

async function harnessContexts(file: string): Promise<Map<number, string[]>> {
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry: createRegistry() }, ctx);
  try {
    const out = new Map<number, string[]>();
    for (const id of CONVERSATIONS) {
      const view = await (await harness.conversation(id as ConversationId, ctx))!.context(ctx);
      out.set(id, normalizeMessages(view.messages));
    }
    return out;
  } finally {
    await harness.close(ctx);
  }
}

test("pi-durable: detect recognizes the storage file, with or without a conversation fragment", async () => {
  const file = copy();
  assert.equal(await detectAgent(file), "pi-durable");
  assert.equal(await getAdapter("pi-durable").detect(`${file}#27`), true);
  const other = join(mkdtempSync(join(tmpdir(), "toaster-pi-durable-")), "x.jsonl");
  writeFileSync(other, "{}\n");
  assert.equal(await getAdapter("pi-durable").detect(other), false);
});

test("pi-durable: each conversation reads as exactly the context pi-durable would send", async () => {
  const file = copy();
  const expected = await harnessContexts(copy());
  for (const id of CONVERSATIONS) {
    const toast = await readToast("pi-durable", `${file}#${id}`);
    assert.deepEqual(normalizeTurns(toast.turns), expected.get(id), `conversation ${id}`);
  }
});

test("pi-durable: the root after a reset starts at the handoff; older entries become info losses", async () => {
  const toast = await readToast("pi-durable", copy()); // no fragment: the root
  assert.equal(toast.cwd, "/work/demo"); // from a pi.agent delta revision, not the base
  assert.equal(toast.metadata.conversationId, 1);
  assert.match(normalizeTurns(toast.turns)[0], /^user: Handoff: we were doing arithmetic/);
  assert.ok(toast.losses.some((l) => /before the active context head/.test(l.reason)));
  assert.ok(toast.losses.every((l) => l.severity === "info"));
  assert.ok(toast.events.length > toast.turns.length, "raw entries are kept as pi-durable.entry events");
  assert.ok(toast.events.every((e) => e.type === "pi-durable.entry"));
});

test("pi-durable: the fork inherits entries through the fork point and keeps tool linkage", async () => {
  const toast = await readToast("pi-durable", `${copy()}#27`);
  const lines = normalizeTurns(toast.turns);
  assert.deepEqual(lines.slice(0, 4), ["user: What is 2+2?", "assistant:  calls=call|1", "tool call|1: 4 error=false", "assistant: 4"]);
  const call = toast.turns[1].content.find((b) => b.type === "tool_call") as Extract<ToastContentBlock, { type: "tool_call" }>;
  assert.equal(call.id, "call_1"); // canonical id is sanitized; the raw id survives
  assert.ok(toast.turns[1].content.some((b) => b.type === "thinking"));
  assert.equal(toast.turns[1].stopReason, "tool_use");
});

test("pi-durable: edits, aborted answers and orphaned calls follow pi-durable's rules", async () => {
  const toast = await readToast("pi-durable", `${copy()}#37`);
  const lines = normalizeTurns(toast.turns);
  assert.ok(!lines.some((l) => l.includes("secret")), "omitted by an edit");
  assert.ok(lines.includes("user: final question") && !lines.includes("user: draft question"), "replaced by an edit");
  assert.ok(!lines.some((l) => l.includes("half an ans")), "aborted assistant excluded");
  assert.ok(lines.some((l) => l.startsWith("tool orphan-1: Tool result unavailable") && l.endsWith("error=true")), "missing result synthesized");
  for (const reason of [/omitted from context by an edit/, /stopReason aborted/, /carries no model messages/, /has no result; synthesized/]) {
    assert.ok(toast.losses.some((l) => reason.test(l.reason)), String(reason));
  }
});

test("pi-durable: list() enumerates the conversations of DOCK_DIR/session.sqlite with their cwd", async () => {
  const file = copy();
  const previous = process.env.DOCK_DIR;
  process.env.DOCK_DIR = join(file, "..");
  try {
    const rows = await getAdapter("pi-durable").list();
    assert.deepEqual(rows.map((r) => r.id), ["1", "27", "37"]);
    assert.equal(rows[0].cwd, "/work/demo");
    assert.equal(rows[1].path, `${file}#27`);
  } finally {
    if (previous === undefined) delete process.env.DOCK_DIR;
    else process.env.DOCK_DIR = previous;
  }
});

test("pi-durable: write() refuses; the storage belongs to its Harness", async () => {
  const toast = await readToast("pi-durable", `${copy()}#1`);
  await assert.rejects(getAdapter("pi-durable").write(toast), /not supported/);
});
