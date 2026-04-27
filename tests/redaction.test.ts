import test from "node:test";
import assert from "node:assert/strict";

import { detectLocal, redactToast } from "../src/redaction.js";
import type { Toast } from "../src/schemas/toast.js";

test("local redactor detects common secrets and PII", () => {
  const fakeOpenAiKey = "sk" + "-test-abc1234567890";
  const spans = detectLocal(`Email maya.chen@example.com with ${fakeOpenAiKey} from /Users/austin/project`);
  assert.ok(spans.some((s) => s.label === "private_email"));
  assert.ok(spans.some((s) => s.label === "secret"));
  assert.ok(spans.some((s) => s.label === "private_path"));
});

function sampleToast(): Toast {
  return {
    traceVersion: 1,
    id: "ses_redact",
    cwd: "/Users/austin/project",
    source: { agent: "pi", path: "/Users/austin/.pi/session.jsonl" },
    agents: [{ agent: "pi" }],
    turns: [
      {
        id: "t1",
        role: "user",
        content: [{ type: "text", text: "Email maya.chen@example.com and use " + ("sk" + "-test-abc1234567890") }],
        provenance: { agent: "pi" },
        metadata: {},
      },
    ],
    events: [],
    metadata: {},
    losses: [],
  };
}

test("redactToast writes redacted copy and report", async () => {
  const result = await redactToast(sampleToast(), { provider: "local" });
  const text = result.toast.turns[0]?.content[0];
  assert.equal(text?.type, "text");
  if (text?.type === "text") {
    assert.match(text.text, /\[PRIVATE_EMAIL\]/);
    assert.match(text.text, /\[SECRET\]/);
    assert.doesNotMatch(text.text, /maya\.chen/);
  }
  assert.ok(result.report.spanCount >= 3);
});
