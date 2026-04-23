// Golden-path round-trip. Uses a tiny synthetic pi session (no files on disk
// needed). pi → claude → pi should preserve the material turns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { migratePiSessionToClaude } from "../src/translators/pi-to-claude.js";
import { normalizeClaudeJSONL } from "../src/translators/claude-to-pi.js";
import type { PiSession } from "../src/schemas/pi.js";

function makePiFixture(): string {
  const sessionId = randomUUID();
  const ts = "2026-04-22T00:00:00.000Z";
  const toolCallId = "call_ae6E5CXGU40cM2IQxo7X8BZ2|fc_082fd311fa6668220169c9ca09425c81978471d0b72394d03d"; // pi-style, has "|"
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: "/tmp/toaster-test" },
    {
      type: "message", id: "u1", parentId: null, timestamp: ts,
      message: { role: "user", content: [{ type: "text", text: "ls" }] },
    },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }],
        model: "claude-sonnet-4-20250514",
      },
    },
    {
      type: "message", id: "t1", parentId: "a1", timestamp: ts,
      message: {
        role: "toolResult", toolCallId, toolName: "bash",
        content: [{ type: "text", text: "README.md\npackage.json\n" }],
      },
    },
    {
      type: "message", id: "a2", parentId: "t1", timestamp: ts,
      message: { role: "assistant", content: [{ type: "text", text: "Two files." }] },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("pi → claude → pi round-trip preserves turn count + sanitizes tool ids", async () => {
  const piPath = join(tmpdir(), `toaster-rt-${Date.now()}.pi.jsonl`);
  await writeFile(piPath, makePiFixture());

  // pi → claude
  const fwd = await migratePiSessionToClaude(piPath);
  assert.ok(fwd.sessionId.length > 0, "forward produced a session id");
  assert.ok(fwd.events >= 4, `expected at least 4 events in claude output, got ${fwd.events}`);

  // claude → pi (back)
  const back: PiSession = await normalizeClaudeJSONL(fwd.target);
  assert.equal(back.header.cwd, "/tmp/toaster-test", "cwd survives");
  const roles = back.entries
    .filter((e) => e.type === "message")
    .map((e) => e.message?.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"], "turn roles survive");

  // The pipe in the original tool id is gone — it was sanitized on the way to claude.
  const assistantWithTool = back.entries.find((e) => e.message?.role === "assistant" && e.message?.content?.[0]?.type === "toolCall");
  assert.ok(assistantWithTool, "assistant toolCall survived");
  const tcId = assistantWithTool?.message?.content?.[0]?.id;
  assert.match(tcId || "", /^[a-zA-Z0-9_-]+$/, "tool_use id round-trips as api-safe");
});
