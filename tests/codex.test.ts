import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { readFile } from "node:fs/promises";

import { codexAdapter } from "../src/adapters/codex.js";
import { piAdapter } from "../src/adapters/pi.js";
import { translate } from "../src/translate.js";

function makeCodexFixture(sessionId = randomUUID()): string {
  const ts = "2026-04-23T04:38:23.925Z";
  const patch = "*** Begin Patch\n*** Update File: /tmp/toaster-test/README.md\n@@\n-old\n+new\n*** End Patch";
  const lines = [
    {
      timestamp: ts,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: ts,
        cwd: "/tmp/toaster-test",
        originator: "codex_cli",
        cli_version: "0.120.0",
        source: "interactive",
        model_provider: "openai",
      },
    },
    {
      timestamp: ts,
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: "/tmp/toaster-test",
        model: "gpt-5.4",
        effort: "high",
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "show me the files" }],
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll list the files." }],
        phase: "commentary",
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls"], workdir: "/tmp/toaster-test" }),
        call_id: "call_shell_1",
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_shell_1",
        output: JSON.stringify({
          output: "README.md\npackage.json\n",
          metadata: { exit_code: 0, duration_seconds: 0.0 },
        }),
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        status: "completed",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: patch,
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_patch_1",
        output: "apply_patch verification failed: Failed to find expected lines in /tmp/toaster-test/README.md",
      },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Listed the files and the patch failed." }],
      },
    },
    {
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
          },
        },
      },
    },
  ];

  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

test("codex adapter reads native sessions with function_call and custom_tool_call items", async () => {
  const codexPath = join(tmpdir(), `toaster-codex-${Date.now()}.jsonl`);
  await writeFile(codexPath, makeCodexFixture());

  const trace = await codexAdapter.read(codexPath);
  assert.equal(trace.id.length > 0, true);
  assert.equal(trace.cwd, "/tmp/toaster-test");
  assert.equal(trace.agents[0]?.agent, "codex");
  assert.equal(trace.agents[0]?.model, "gpt-5.4");
  assert.equal(trace.agents[0]?.provider, "openai");

  assert.deepEqual(
    trace.turns.map((t) => t.role),
    ["user", "assistant", "assistant", "tool", "assistant", "tool", "assistant"],
  );

  const shellCall = trace.turns[2].content[0];
  assert.equal(shellCall.type, "tool_call");
  assert.equal(shellCall.name, "shell");
  assert.deepEqual(shellCall.arguments, { command: ["bash", "-lc", "ls"], workdir: "/tmp/toaster-test" });

  const patchCall = trace.turns[4].content[0];
  assert.equal(patchCall.type, "tool_call");
  assert.equal(patchCall.name, "apply_patch");
  assert.equal(typeof patchCall.arguments, "string");
  assert.match(String(patchCall.arguments), /\*\*\* Begin Patch/);

  const shellResult = trace.turns[3].content[0];
  assert.equal(shellResult.type, "tool_result");
  assert.equal(shellResult.content[0]?.type, "text");
  const shellText = shellResult.content[0]?.type === "text" ? shellResult.content[0].text : "";
  assert.match(shellText, /README\.md/);

  const patchResult = trace.turns[5].content[0];
  assert.equal(patchResult.type, "tool_result");
  assert.equal(patchResult.isError, true);
  const patchText = patchResult.content[0]?.type === "text" ? patchResult.content[0].text : "";
  assert.match(patchText, /verification failed/);

  assert.equal(trace.events.some((e) => e.type === "turn_context"), true);
  assert.equal(trace.events.some((e) => e.type === "token_count"), true);
});

test("codex tool calls with string input survive translation through TOAST into pi", async () => {
  const codexPath = join(tmpdir(), `toaster-codex-in-${Date.now()}.jsonl`);
  const piPath = join(tmpdir(), `toaster-codex-out-${Date.now()}.jsonl`);
  await writeFile(codexPath, makeCodexFixture());

  await translate("pi", codexPath, { from: "codex", targetPath: piPath, sessionId: randomUUID() });
  const piTrace = await piAdapter.read(piPath);

  const patchTurn = piTrace.turns.find((turn) =>
    turn.role === "assistant"
    && turn.content.some((block) => block.type === "tool_call" && block.name === "apply_patch"),
  );
  assert.ok(patchTurn, "expected apply_patch tool call to survive codex -> pi translation");

  const patchCall = patchTurn?.content.find((block) => block.type === "tool_call");
  assert.equal(patchCall?.type, "tool_call");
  assert.deepEqual(patchCall?.arguments, {
    input: "*** Begin Patch\n*** Update File: /tmp/toaster-test/README.md\n@@\n-old\n+new\n*** End Patch",
  });
});

test("pi -> codex write sanitizes long tool call ids for resume safety", async () => {
  const piPath = join(tmpdir(), `toaster-pi-for-codex-${Date.now()}.jsonl`);
  const codexPath = join(tmpdir(), `toaster-codex-from-pi-${Date.now()}.jsonl`);
  const ts = "2026-04-22T00:00:00.000Z";
  const toolCallId = "call_ae6E5CXGU40cM2IQxo7X8BZ2|fc_082fd311fa6668220169c9ca09425c81978471d0b72394d03d";
  const piLines = [
    { type: "session", version: 3, id: randomUUID(), timestamp: ts, cwd: "/tmp/toaster-test" },
    { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "ls" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", id: "t1", parentId: "a1", timestamp: ts, message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "README.md\n" }] } },
  ];
  await writeFile(piPath, piLines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  await translate("codex", piPath, { from: "pi", targetPath: codexPath, sessionId: randomUUID() });
  const raw = await readFile(codexPath, "utf8");
  assert.doesNotMatch(raw, /call_ae6E5CXGU40cM2IQxo7X8BZ2\|/);

  const ids = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "response_item" && (entry.payload?.type === "function_call" || entry.payload?.type === "function_call_output"))
    .map((entry) => String(entry.payload.call_id));
  assert.ok(ids.length >= 2);
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
});

test("codex write/read round-trip preserves assistant text and custom tool inputs", async () => {
  const sourcePath = join(tmpdir(), `toaster-codex-source-${Date.now()}.jsonl`);
  const outPath = join(tmpdir(), `toaster-codex-roundtrip-${Date.now()}.jsonl`);
  await writeFile(sourcePath, makeCodexFixture("019db8a1-c9a7-79a3-abb3-c04317bfda45"));

  const trace = await codexAdapter.read(sourcePath);
  const result = await codexAdapter.write(trace, {
    targetPath: outPath,
    sessionId: "019db8a1-c9a7-79a3-abb3-c04317bfda45",
    agentVersion: "0.120.0",
  });

  assert.equal(result.target, outPath);

  const reread = await codexAdapter.read(outPath);
  assert.equal(reread.id, "019db8a1-c9a7-79a3-abb3-c04317bfda45");
  assert.equal(reread.turns.some((turn) => turn.role === "user"), true);
  assert.equal(reread.turns.at(-1)?.role, "assistant");

  const patchCall = reread.turns.find((turn) =>
    turn.role === "assistant"
    && turn.content.some((block) => block.type === "tool_call" && block.name === "apply_patch"),
  )?.content.find((block) => block.type === "tool_call");
  assert.equal(typeof patchCall?.arguments, "string");
  assert.match(String(patchCall?.arguments), /\*\*\* Begin Patch/);
});
