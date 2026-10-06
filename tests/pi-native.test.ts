// Pi-native fidelity: toaster writes a pi session into a temp dir, then pi's
// own SessionManager (@earendil-works/pi-coding-agent, pinned to the version
// users run) opens the file and rebuilds the model context. Assertions are on
// what pi would send, not on toaster re-reading its own output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModelRuntime, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

import { piAdapter } from "../src/adapters/pi.js";
import { readToastArtifact } from "../src/library.js";
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
function loadInPi(dir: string, target: string) {
  const manager = SessionManager.open(target, join(dir, "pi-sessions"));
  const context = manager.buildSessionContext();
  return {
    messages: context.messages as unknown as PiMessage[],
    llm: convertToLlm(context.messages) as unknown as PiMessage[],
    model: context.model,
    thinkingLevel: context.thinkingLevel,
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

// ---------- bug 3: assistant api ----------

test("pi reader keeps the source api on the turn", async () => {
  const trace = await piAdapter.read(fixture("pi-stop-reasons.jsonl"));
  const assistant = trace.turns.find((turn) => turn.role === "assistant");
  assert.equal(assistant?.metadata.piApi, "anthropic-messages");
});

test("pi writer: assistant messages carry the api pi's own model catalog expects", async () => {
  const trace = await readToastArtifact(fixture("toast-assistant-api.toast.json"));
  const { dir, target } = await tempTarget();
  await piAdapter.write(trace, { targetPath: target });
  const { messages } = loadInPi(dir, target);

  const assistants = messages.filter((message) => message.role === "assistant");
  assert.deepEqual(
    assistants.map((message) => [message.provider, message.model, message.api]),
    [
      ["anthropic", "claude-sonnet-4-5", "anthropic-messages"],
      ["openai", "gpt-5", "openai-responses"],
      ["google", "gemini-2.5-pro", "google-generative-ai"],
      // Source value from turn.metadata.piApi wins over derivation.
      ["github-copilot", "claude-sonnet-4.6", "anthropic-messages"],
      // Provider pi-ai has no catalog entry for: documented fallback.
      ["acme-local", "acme-1", "openai-completions"],
    ],
  );

  // pi-ai only replays thinking signatures and native tool-call metadata when
  // provider + api + model all match the active model, so the written api must
  // equal what pi's catalog says for that model. Static catalog, no network,
  // credentials file in the temp dir.
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const message of assistants.slice(0, 4)) {
    const model = runtime.getModel(message.provider, message.model);
    assert.ok(model, `pi catalog knows ${message.provider}/${message.model}`);
    assert.equal(message.api, model.api, `${message.provider}/${message.model}`);
  }
});

test("pi writer: messages carry pi-ai's numeric timestamp (ms since epoch)", async () => {
  const trace = await readToastArtifact(fixture("toast-assistant-api.toast.json"));
  const { dir, target } = await tempTarget();
  await piAdapter.write(trace, { targetPath: target });
  const { messages } = loadInPi(dir, target);
  assert.equal(messages.length, trace.turns.length);
  assert.deepEqual(
    messages.map((message) => message.timestamp),
    trace.turns.map((turn) => Date.parse(turn.timestamp!)),
  );
});

// ---------- entry tree: pi's leaf must reach every turn ----------

function conversation(messages: PiMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
    .map((message) => `${message.role}: ${textOf(message)}`);
}

test("pi -> pi: pi rebuilds the same conversation, model and thinking level as the source", async () => {
  // What pi itself sees in the source file (opened from a temp copy).
  const source = await tempTarget();
  await copyFile(fixture("pi-session-entries.jsonl"), source.target);
  const expected = loadInPi(source.dir, source.target);
  assert.equal(conversation(expected.messages).length, 4);

  const actual = await translatePiFixtureThroughPi("pi-session-entries.jsonl");
  assert.deepEqual(conversation(actual.messages), conversation(expected.messages));
  assert.deepEqual(actual.model, expected.model);
  assert.equal(actual.thinkingLevel, expected.thinkingLevel);
});

test("claude -> pi: a split assistant message does not cut pi's context short", async () => {
  // Claude Code writes one JSONL entry per assistant content block; toaster
  // coalesces them into one turn, so the tool result's parentUuid names an
  // entry that has no pi counterpart.
  const { dir, target } = await tempTarget();
  await translate("pi", fixture("claude-split-assistant.jsonl"), { from: "claude", targetPath: target });
  const { messages } = loadInPi(dir, target);
  assert.deepEqual(conversation(messages), [
    "user: what is in this repo?",
    "assistant: Let me look.",
    "toolResult: README.md\n",
    "assistant: Just a README.",
  ]);
  const call = (messages[1].content as PiMessage[]).find((block) => block.type === "toolCall");
  assert.equal(messages[1].stopReason, "toolUse");
  assert.equal(messages[2].toolCallId, call?.id);
});

// ---------- developer turns and imported context ----------

test("pi writer: developer turns and imported events reach the model pi would call", async () => {
  const trace = await readToastArtifact(fixture("toast-developer-turn.toast.json"));
  const { dir, target } = await tempTarget();
  await piAdapter.write(trace, { targetPath: target });
  const { llm } = loadInPi(dir, target);

  const texts = llm.map((message) => `${message.role}: ${textOf(message)}`);
  assert.ok(texts.includes("user: Use pnpm, not npm."), texts.join("\n"));
  assert.ok(texts.some((text) => text.startsWith("user: turn_context: ") && text.includes('"effort": "high"')), texts.join("\n"));
  assert.deepEqual(
    llm.map((message) => message.role),
    ["user", "user", "user", "assistant"], // imported events, developer, user, assistant
  );
});

test("pi reader: a toaster developer turn reads back as developer", async () => {
  const trace = await readToastArtifact(fixture("toast-developer-turn.toast.json"));
  const { target } = await tempTarget();
  await piAdapter.write(trace, { targetPath: target });
  const reread = await piAdapter.read(target);
  assert.deepEqual(reread.turns.map((turn) => turn.role), ["developer", "developer", "user", "assistant"]);
  assert.deepEqual(reread.turns[1].content, [{ type: "text", text: "Use pnpm, not npm." }]);
});
