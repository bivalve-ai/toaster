import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";

import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Toast } from "../src/schemas/toast.js";

function makeOpenCodeFixture(): string {
  return JSON.stringify({
    info: {
      id: "ses_fixture1",
      slug: "fixture1",
      projectID: "global",
      directory: "/tmp/toaster-test",
      title: "Imported session",
      version: "0.1.0",
      time: { created: 1714000000000, updated: 1714000005000 },
    },
    messages: [
      {
        info: {
          id: "msg_user1",
          sessionID: "ses_fixture1",
          role: "user",
          time: { created: 1714000000000 },
          format: { type: "text" },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" },
        },
        parts: [
          { id: "prt_user1", sessionID: "ses_fixture1", messageID: "msg_user1", type: "text", text: "show me the files" },
        ],
      },
      {
        info: {
          id: "msg_assistant1",
          sessionID: "ses_fixture1",
          role: "assistant",
          time: { created: 1714000001000, completed: 1714000002000 },
          parentID: "msg_user1",
          modelID: "claude-sonnet-4",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/toaster-test", root: "/tmp/toaster-test" },
          summary: false,
          cost: 0.12,
          tokens: { total: 30, input: 10, output: 15, reasoning: 5, cache: { read: 0, write: 0 } },
          finish: "stop",
        },
        parts: [
          { id: "prt_reason1", sessionID: "ses_fixture1", messageID: "msg_assistant1", type: "reasoning", text: "Need to inspect the repository first.", time: { start: 1714000001100, end: 1714000001200 } },
          { id: "prt_text1", sessionID: "ses_fixture1", messageID: "msg_assistant1", type: "text", text: "I’ll list the files." },
          {
            id: "prt_tool1",
            sessionID: "ses_fixture1",
            messageID: "msg_assistant1",
            type: "tool",
            callID: "call_shell_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "README.md\npackage.json\n",
              title: "bash",
              metadata: {},
              time: { start: 1714000001300, end: 1714000001400 },
            },
          },
        ],
      },
    ],
  }, null, 2) + "\n";
}

function makeToast(): Toast {
  return {
    traceVersion: 1,
    id: "toast-opencode",
    cwd: "/tmp/toaster-test",
    createdAt: "2026-04-23T00:00:00.000Z",
    source: { agent: "pi" },
    agents: [{ agent: "pi" }],
    turns: [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "show me the files" }],
        provenance: { agent: "pi" },
        metadata: {},
      },
      {
        id: "a1",
        parentId: "u1",
        role: "assistant",
        content: [
          { type: "thinking", text: "Need to inspect the repository first.", format: "opencode-reasoning" },
          { type: "text", text: "I’ll list the files." },
        ],
        model: "claude-sonnet-4",
        provider: "anthropic",
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25, costUsd: 0.12, metadata: { reasoningTokens: 5 } },
        provenance: { agent: "pi" },
        metadata: {},
      },
    ],
    events: [],
    metadata: { title: "Imported session" },
    losses: [],
  };
}

test("opencode adapter detects and reads export JSON", async () => {
  const path = join(tmpdir(), `toaster-opencode-${Date.now()}.json`);
  await writeFile(path, makeOpenCodeFixture(), "utf8");

  assert.equal(await opencodeAdapter.detect(path), true);
  const toast = await opencodeAdapter.read(path);

  assert.equal(toast.id, "ses_fixture1");
  assert.equal(toast.cwd, "/tmp/toaster-test");
  assert.equal(toast.turns.some((turn) => turn.role === "assistant"), true);
  assert.equal(toast.turns.some((turn) => turn.role === "tool"), true);

  const assistant = toast.turns.find((turn) => turn.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant?.provider, "anthropic");
  assert.equal(assistant?.model, "claude-sonnet-4");
  assert.equal(assistant?.usage?.costUsd, 0.12);
  assert.equal(assistant?.content.some((block) => block.type === "thinking"), true);
});

test("opencode write/read round-trip preserves reasoning and usage", async () => {
  const path = join(tmpdir(), `toaster-opencode-roundtrip-${Date.now()}.json`);
  const result = await opencodeAdapter.write(makeToast(), { targetPath: path, sessionId: "ses_roundtrip1" });
  assert.equal(result.target, path);

  const reread = await opencodeAdapter.read(path);
  assert.equal(reread.id, "ses_roundtrip1");
  const assistant = reread.turns.find((turn) => turn.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant?.content.some((block) => block.type === "thinking" && block.text.includes("inspect the repository")), true);
  assert.equal(assistant?.usage?.inputTokens, 10);
  assert.equal(assistant?.usage?.outputTokens, 15);
  assert.equal(assistant?.usage?.costUsd, 0.12);
});
