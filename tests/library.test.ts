import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listLibrarySessions,
  readToastArtifact,
  saveToastToLibrary,
} from "../src/library.js";
import type { Toast } from "../src/schemas/toast.js";

test("saveToastToLibrary writes git-friendly TOAST artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toaster-library-test-"));
  const toast: Toast = {
    traceVersion: 1,
    id: "ses_test",
    cwd: "/tmp/project",
    createdAt: "2026-04-25T00:00:00.000Z",
    source: { agent: "pi", path: "/tmp/source.jsonl" },
    agents: [{ agent: "pi", model: "test-model" }],
    turns: [
      {
        id: "turn_user",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        provenance: { agent: "pi", path: "/tmp/source.jsonl", line: 2 },
        metadata: {},
      },
    ],
    events: [],
    metadata: {},
    losses: [],
  };

  const saved = await saveToastToLibrary(toast, { dir, name: "My Test Session" });
  assert.equal(saved.name, "my-test-session");
  assert.equal(saved.turns, 1);

  const reread = await readToastArtifact(saved.toastPath);
  assert.equal(reread.id, "ses_test");
  assert.equal(reread.source.agent, "pi");

  const library = await listLibrarySessions(dir);
  assert.equal(library.sessions.length, 1);
  assert.equal(library.sessions[0]?.name, "my-test-session");
});
