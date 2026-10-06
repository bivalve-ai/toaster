// Pi-native fidelity: toaster writes a pi session into a temp dir, then pi's
// own SessionManager (@earendil-works/pi-coding-agent, pinned to the version
// users run) opens the file and rebuilds the model context. Assertions are on
// what pi would send, not on toaster re-reading its own output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

import { piAdapter } from "../src/adapters/pi.js";
import type { WriteOptions } from "../src/adapters/types.js";
import { translate } from "../src/translate.js";

type PiMessage = Record<string, any>;

function fixture(name: string): string {
  // Compiled tests run from dist-tests/tests/; fixtures stay in the source tree.
  return fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));
}

async function tempTarget(): Promise<{ dir: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), "toaster-pi-native-"));
  return { dir, target: join(dir, "session.jsonl") };
}

/** Open a written session with pi's SessionManager and rebuild its context. */
function loadInPi(dir: string, target: string): { messages: PiMessage[]; llm: PiMessage[] } {
  const manager = SessionManager.open(target, join(dir, "pi-sessions"));
  const context = manager.buildSessionContext();
  return {
    messages: context.messages as unknown as PiMessage[],
    llm: convertToLlm(context.messages) as unknown as PiMessage[],
  };
}

async function translatePiFixtureThroughPi(name: string, options: WriteOptions = {}) {
  const { dir, target } = await tempTarget();
  await translate("pi", fixture(name), { ...options, from: "pi", targetPath: target });
  return loadInPi(dir, target);
}

function textOf(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as PiMessage[])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ---------- bug 1: string content ----------

test("pi reader: string message content becomes one text block", async () => {
  const trace = await piAdapter.read(fixture("pi-string-content.jsonl"));
  const user = trace.turns.find((turn) => turn.role === "user");
  assert.deepEqual(user?.content, [{ type: "text", text: "HELLO" }]);
});

for (const thinkingPolicy of ["drop", "note"] as const) {
  test(`pi string content survives into pi's rebuilt context (thinkingPolicy ${thinkingPolicy})`, async () => {
    const { llm } = await translatePiFixtureThroughPi("pi-string-content.jsonl", { thinkingPolicy });
    const users = llm.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(textOf(users[0]), "HELLO");
    assert.deepEqual(users[0].content, [{ type: "text", text: "HELLO" }]);
  });
}

// ---------- bug 2: stop reasons ----------

test("pi reader maps pi-ai stop reasons to TOAST (toolUse, stop, aborted)", async () => {
  const trace = await piAdapter.read(fixture("pi-stop-reasons.jsonl"));
  const stops = trace.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.stopReason);
  assert.deepEqual(stops, ["tool_use", "stop", "cancelled"]);
});

test("pi writer: TOAST stop reasons land as pi-ai values and the tool pair survives", async () => {
  const { messages } = await translatePiFixtureThroughPi("pi-stop-reasons.jsonl");
  const assistants = messages.filter((message) => message.role === "assistant");
  assert.deepEqual(assistants.map((message) => message.stopReason), ["toolUse", "stop", "aborted"]);

  const call = (assistants[0].content as PiMessage[]).find((block) => block.type === "toolCall");
  assert.deepEqual(call, { type: "toolCall", id: "toolu_01A2B3C4D5", name: "bash", arguments: { command: "ls" } });

  const results = messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolCallId, call?.id);
  assert.equal(results[0].toolName, "bash");
  assert.equal(textOf(results[0]), "README.md\npackage.json\n");
  // The result directly follows its call, as pi replays it.
  assert.equal(messages.indexOf(results[0]), messages.indexOf(assistants[0]) + 1);
});

test("pi writer: unknown or missing stop reasons become toolUse/stop, never off-contract values", async () => {
  const trace = await piAdapter.read(fixture("pi-stop-reasons.jsonl"));
  const assistants = trace.turns.filter((turn) => turn.role === "assistant");
  assistants[0].stopReason = undefined;
  assistants[1].stopReason = "unknown";
  const { dir, target } = await tempTarget();
  const result = await piAdapter.write(trace, { targetPath: target });
  const { messages } = loadInPi(dir, target);
  assert.deepEqual(
    messages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
    ["toolUse", "stop", "aborted"],
  );
  assert.ok(result.losses.some((loss) => loss.reason.includes('unknown stop reason written as pi "stop"')));
});
