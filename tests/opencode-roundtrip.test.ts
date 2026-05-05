import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { opencodeAdapter } from "../src/adapters/opencode.js";

// A native opencode export covering: text + reasoning + a single tool part
// (with input AND output on the same part, as opencode actually emits),
// step-start/step-finish markers, and an unknown forward-compatible part.
function makeNative() {
  return {
    info: {
      id: "ses_rt",
      title: "round trip",
      version: "0.1",
      time: { created: 1714000000000, updated: 1714000099000 },
      directory: "/tmp/x",
    },
    messages: [
      {
        info: {
          id: "msg_u1",
          role: "user",
          sessionID: "ses_rt",
          time: { created: 1714000001000 },
        },
        parts: [
          { id: "prt_u1", sessionID: "ses_rt", messageID: "msg_u1", type: "text", text: "list files" },
        ],
      },
      {
        info: {
          id: "msg_a1",
          role: "assistant",
          sessionID: "ses_rt",
          providerID: "anthropic",
          modelID: "claude-3-7",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/x", root: "/tmp/x" },
          time: { created: 1714000002000, completed: 1714000003000 },
          tokens: { input: 12, output: 34, reasoning: 5, cache: { read: 0, write: 0 } },
          cost: 0.0001,
          finish: "stop",
        },
        parts: [
          { id: "prt_step1", sessionID: "ses_rt", messageID: "msg_a1", type: "step-start" },
          { id: "prt_r1", sessionID: "ses_rt", messageID: "msg_a1", type: "reasoning", text: "I should ls." },
          { id: "prt_t1", sessionID: "ses_rt", messageID: "msg_a1", type: "text", text: "Listing now." },
          {
            id: "prt_tool1",
            sessionID: "ses_rt",
            messageID: "msg_a1",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "a.txt\nb.txt",
              time: { start: 1714000002500, end: 1714000002800 },
              metadata: { exit: 0 },
            },
          },
          {
            id: "prt_step1e",
            sessionID: "ses_rt",
            messageID: "msg_a1",
            type: "step-finish",
            tokens: { input: 12, output: 34 },
            cost: 0.0001,
          },
          {
            id: "prt_weird",
            sessionID: "ses_rt",
            messageID: "msg_a1",
            type: "future-shaped-part",
            payload: { hello: "world" },
          },
        ],
      },
    ],
  };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}
async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("opencode round-trip is structurally idempotent (native -> toast -> native -> toast)", async () => {
  const stamp = Date.now();
  const p0 = join(tmpdir(), `oc-rt0-${stamp}.json`);
  const p1 = join(tmpdir(), `oc-rt1-${stamp}.json`);
  const p2 = join(tmpdir(), `oc-rt2-${stamp}.json`);

  await writeJson(p0, makeNative());
  const t1 = await opencodeAdapter.read(p0);
  await opencodeAdapter.write(t1, { targetPath: p1, sessionId: "ses_rt" });
  const t2 = await opencodeAdapter.read(p1);
  await opencodeAdapter.write(t2, { targetPath: p2, sessionId: "ses_rt" });

  const n1 = await readJson(p1);
  const n2 = await readJson(p2);

  // Bug 1: events should not be re-materialized as a synthetic user "imported context"
  // message. The user-facing transcript should still have exactly one user turn.
  const userTurns2 = t2.turns.filter((t: any) => t.role === "user");
  assert.equal(userTurns2.length, 1, "expected exactly one user turn after round-trip");

  // Bug 2: a single native tool part (input+output) must not duplicate into two
  // tool_call blocks across the round-trip.
  const toolCalls2 = t2.turns
    .flatMap((t: any) => t.content)
    .filter((b: any) => b.type === "tool_call" && b.rawId === "call_1");
  assert.equal(toolCalls2.length, 1, "tool call should not duplicate on rewrite");

  // Bug 4: tool state must remain "completed" with the original output, not regress
  // to "pending" with the original status nested under metadata.
  const toolPart2 = (n2.messages as any[])
    .flatMap((m) => m.parts)
    .find((p: any) => p?.type === "tool" && p?.callID === "call_1");
  assert.ok(toolPart2, "tool part should survive in native output");
  assert.equal(toolPart2.state?.status, "completed");
  assert.equal(toolPart2.state?.output, "a.txt\nb.txt");

  // Bug 3: ids must not grow with every hop.
  const ids1 = (n1.messages as any[]).map((m) => m.info.id).sort();
  const ids2 = (n2.messages as any[]).map((m) => m.info.id).sort();
  assert.deepEqual(ids2, ids1, "message ids should be stable across rewrites");

  // Tool-result linkage in TOAST must still resolve to a real assistant tool_call.
  const result2 = t2.turns
    .flatMap((t: any) => t.content)
    .find((b: any) => b.type === "tool_result");
  assert.ok(result2, "tool_result should be preserved");
  assert.equal(result2.rawToolCallId, "call_1");

  // The agents fingerprint array should not balloon on each hop.
  assert.ok(
    (t2.agents?.length ?? 0) <= (t1.agents?.length ?? 0) + 1,
    `agents array grew unboundedly: t1=${t1.agents?.length} t2=${t2.agents?.length}`,
  );

  // step-start / step-finish / unknown parts should round-trip back as native parts
  // on the assistant message they belonged to (or at minimum not as a fake user turn).
  const assistantParts2 = (n2.messages as any[])
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) => m.parts);
  const hasStepStart = assistantParts2.some((p: any) => p?.type === "step-start");
  const hasStepFinish = assistantParts2.some((p: any) => p?.type === "step-finish");
  const hasUnknown = assistantParts2.some((p: any) => p?.type === "future-shaped-part");
  assert.ok(hasStepStart, "step-start should round-trip as a native part");
  assert.ok(hasStepFinish, "step-finish should round-trip as a native part");
  assert.ok(hasUnknown, "unknown part type should round-trip as a native part");
});
