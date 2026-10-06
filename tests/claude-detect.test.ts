import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectAgent, readToast } from "../src/index.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/claude/queue-operation-first.jsonl");

test("claude: a session that opens with queue-operation lines is detected and read", async () => {
  assert.equal(await detectAgent(FIXTURE), "claude");
  const toast = await readToast("claude", FIXTURE);
  assert.equal(toast.cwd, "/work/site");
  assert.deepEqual(toast.turns.map((t) => t.role), ["user", "assistant"]);
});

test("claude: a file of only queue-operation lines is not a session", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "toaster-claude-")), "q.jsonl");
  writeFileSync(path, '{"type":"queue-operation","operation":"enqueue","sessionId":"x"}\n');
  assert.equal(await detectAgent(path), null);
});
