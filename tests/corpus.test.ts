import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { runCorpus } from "../src/corpus.js";

function makePiFixture(): string {
  const sessionId = randomUUID();
  const ts = "2026-04-22T00:00:00.000Z";
  return [
    { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: "/tmp/toaster-test" },
    { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "ls" }] } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: ts,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "README.md\npackage.json\n" }],
        model: "claude-sonnet-4-20250514",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function makeCodexFixture(): string {
  const sessionId = randomUUID();
  const ts = "2026-04-23T04:38:23.925Z";
  return [
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
      payload: { turn_id: "turn-1", cwd: "/tmp/toaster-test", model: "gpt-5.4", effort: "high" },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "show me the files" }] },
    },
    {
      timestamp: ts,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I’ll list the files." }] },
    },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

test("runCorpus walks a local directory and produces target reports", async () => {
  const root = join(tmpdir(), `toaster-corpus-${Date.now()}`);
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "pi.jsonl"), makePiFixture(), "utf8");
  await writeFile(join(root, "nested", "codex.jsonl"), makeCodexFixture(), "utf8");

  const report = await runCorpus(root, { targets: ["claude"] });

  assert.equal(report.summary.files, 2);
  assert.equal(report.summary.detected, 2);
  assert.equal(report.summary.readOk, 2);
  assert.equal(report.cases.length, 2);
  assert.equal(report.summary.byTarget.claude?.writeOk, 2);
  assert.equal(report.summary.byTarget.claude?.rereadOk, 2);

  for (const row of report.cases) {
    assert.equal(row.detectedAgent === "pi" || row.detectedAgent === "codex", true);
    assert.equal(row.readOk, true);
    assert.ok(row.summary);
    assert.equal(row.targets.length, 1);
    assert.equal(row.targets[0]?.target, "claude");
    assert.equal(row.targets[0]?.writeOk, true);
    assert.equal(row.targets[0]?.rereadOk, true);
  }
});
