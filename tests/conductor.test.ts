import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAdapter } from "../src/adapters/claude.js";
import { conductorAdapter } from "../src/adapters/conductor.js";
import { detectAgent, translate } from "../src/index.js";
import type { ToastContentBlock } from "../src/schemas/toast.js";

type Db = { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void };

const SESSION = "6a0c2b8e-0d4e-4b7a-9c43-2f1f0b6f9d10";
const CODEX_SESSION = "0f3e5a4c-8a7b-4d2e-b1f0-6c9d8e7f6a51";
const WORKSPACE = "/tmp/conductor/workspaces/acme/oslo";

// Only the columns the adapter reads; the real tables carry many more.
const SCHEMA = `
  CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, remote_url TEXT);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT, workspace_path TEXT);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, claude_session_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), model TEXT,
                         workspace_id TEXT, agent_type, title TEXT DEFAULT 'Untitled');
  CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                                 sent_at TEXT, cancelled_at TEXT);
`;

async function makeFixture(): Promise<string> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => Db };
  const file = join(mkdtempSync(join(tmpdir(), "toaster-conductor-")), "conductor.db");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run("repo-1", "acme", "git@github.com:acme/acme.git");
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)").run("ws-1", "repo-1", "oslo", "dev/oslo", "ready", WORKSPACE);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(SESSION, "claude-native-1", "2026-10-01 12:00:00", "opus", "ws-1", "claude", "Fix the build");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(CODEX_SESSION, "codex-native-1", "2026-10-02 12:00:00", "gpt-5.5", "ws-1", "codex", "Codex run");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run("empty-session", null, "2026-10-03 12:00:00", "opus", "ws-1", "claude", "Untitled");

  let n = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
  const user = (session: string, text: string, extra: { sent?: boolean; cancelled?: boolean } = {}) =>
    db.prepare("INSERT INTO session_messages VALUES (?, ?, 'user', ?, ?, ?, ?)").run(`m${++n}`, session, text, at(n), extra.sent === false ? null : at(n), extra.cancelled ? at(n) : null);
  const stream = (session: string, message: unknown) =>
    db.prepare("INSERT INTO session_messages VALUES (?, ?, 'assistant', ?, ?, ?, NULL)").run(`m${++n}`, session, JSON.stringify(message), at(n), at(n));

  stream(SESSION, { type: "system", subtype: "init", cwd: WORKSPACE, model: "claude-opus-5-5", session_id: "claude-native-1", uuid: "u-init" });
  user(SESSION, "Why is the build red?");
  stream(SESSION, { type: "system", subtype: "thinking_tokens", uuid: "u-tick-1" });
  stream(SESSION, { type: "assistant", uuid: "u-a1", parent_tool_use_id: null, message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Checking the log." }], stop_reason: null } });
  stream(SESSION, { type: "assistant", uuid: "u-a1b", parent_tool_use_id: null, message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "bin/ci" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } } });
  stream(SESSION, { type: "system", subtype: "thinking_tokens", uuid: "u-tick-2" });
  stream(SESSION, { type: "user", uuid: "u-r1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "Exit code 1", is_error: true }] } });
  stream(SESSION, { type: "assistant", uuid: "u-a2", parent_tool_use_id: null, message: { id: "msg_2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { prompt: "find the failing spec" } }], stop_reason: "tool_use" } });
  stream(SESSION, { type: "assistant", uuid: "u-s1", parent_tool_use_id: "toolu_agent", message: { id: "msg_3", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "fail" } }], stop_reason: "tool_use" } });
  stream(SESSION, { type: "user", uuid: "u-s2", parent_tool_use_id: "toolu_agent", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_grep", content: [{ type: "text", text: "spec/a_spec.rb" }] }] } });
  stream(SESSION, { type: "user", uuid: "u-r2", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "spec/a_spec.rb fails" }] } });
  stream(SESSION, { type: "assistant", uuid: "u-a3", parent_tool_use_id: null, message: { id: "msg_4", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "spec/a_spec.rb fails." }], stop_reason: "end_turn" } });
  stream(SESSION, { type: "system", subtype: "thinking_tokens", uuid: "u-tick-3" });
  stream(SESSION, { type: "result", subtype: "success", uuid: "u-res", result: "spec/a_spec.rb fails.", total_cost_usd: 0.42, duration_ms: 1200, num_turns: 3 });
  user(SESSION, "never mind", { cancelled: true });
  user(SESSION, "and fix it", { sent: false });

  user(CODEX_SESSION, "List the files");
  stream(CODEX_SESSION, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call_ls", name: "Bash", input: { command: "ls" } }] } });
  stream(CODEX_SESSION, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_ls", content: "README.md\n", is_error: false }] } });
  stream(CODEX_SESSION, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Just README.md." }] } });
  db.close();
  return file;
}

const textOf = (blocks: ToastContentBlock[]) => blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");

test("conductor: detects its store and nothing else", async () => {
  const file = await makeFixture();
  assert.equal(await conductorAdapter.detect(file), true);
  assert.equal(await conductorAdapter.detect(`${file}#${SESSION}`), true);
  assert.equal(await detectAgent(`${file}#${SESSION}`), "conductor");

  const other = join(mkdtempSync(join(tmpdir(), "toaster-conductor-")), "session.jsonl");
  writeFileSync(other, '{"type":"user","sessionId":"x","message":{"role":"user","content":"hi"}}\n');
  assert.equal(await conductorAdapter.detect(other), false);
  assert.equal(await conductorAdapter.detect(join(tmpdir(), "missing.db")), false);
});

test("conductor: lists sessions that have messages", async () => {
  const file = await makeFixture();
  const prior = process.env.CONDUCTOR_DB;
  process.env.CONDUCTOR_DB = file;
  try {
    const rows = await conductorAdapter.list();
    assert.deepEqual(rows.map((r) => r.id).sort(), [CODEX_SESSION, SESSION].sort());
    for (const r of rows) {
      assert.equal(r.agent, "conductor");
      assert.equal(r.path, `${file}#${r.id}`);
      assert.equal(r.cwd, WORKSPACE);
      assert.ok(r.bytes > 0);
    }
    assert.ok(rows[0].mtime >= rows[1].mtime);
  } finally {
    if (prior === undefined) delete process.env.CONDUCTOR_DB;
    else process.env.CONDUCTOR_DB = prior;
  }
});

test("conductor: reads a Claude session into turns, events and losses", async () => {
  const file = await makeFixture();
  const toast = await conductorAdapter.read(`${file}#${SESSION}`);

  assert.equal(toast.id, SESSION);
  assert.equal(toast.cwd, WORKSPACE);
  assert.equal(toast.createdAt, "2026-10-01T12:00:00Z");
  assert.deepEqual(toast.agents, [{ agent: "conductor", model: "claude-opus-5-5", provider: "anthropic" }]);
  assert.deepEqual(toast.metadata, {
    title: "Fix the build",
    agentType: "claude",
    nativeSessionId: "claude-native-1",
    workspace: { name: "oslo", branch: "dev/oslo", state: "ready", path: WORKSPACE },
    repo: { name: "acme", remoteUrl: "git@github.com:acme/acme.git" },
  });

  const main = toast.turns.filter((t) => !t.subagent);
  assert.deepEqual(main.map((t) => t.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.equal(textOf(main[0].content), "Why is the build red?");

  // Two stream messages sharing msg_1 coalesce into one assistant turn.
  const first = main[1];
  assert.deepEqual(first.content.map((b) => b.type), ["text", "tool_call"]);
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined });

  const failed = main[2].content[0] as Extract<ToastContentBlock, { type: "tool_result" }>;
  assert.equal(failed.toolCallId, (first.content[1] as Extract<ToastContentBlock, { type: "tool_call" }>).id);
  assert.equal(failed.toolName, "Bash");
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed.content), "Exit code 1");

  // The subagent's turns hang off the turn that called Agent.
  const sub = toast.turns.filter((t) => t.subagent);
  assert.deepEqual(sub.map((t) => t.role), ["assistant", "tool"]);
  for (const t of sub) assert.deepEqual(t.subagent, { id: "toolu_agent", spawnedByTurnId: main[3].id, origin: "claude-sidechain" });
  assert.equal(textOf((sub[1].content[0] as Extract<ToastContentBlock, { type: "tool_result" }>).content), '[\n  {\n    "type": "text",\n    "text": "spec/a_spec.rb"\n  }\n]');

  assert.deepEqual(toast.events.map((e) => e.type), ["system:init", "result"]);
  const result = toast.events[1].value as Record<string, unknown>;
  assert.equal(result.total_cost_usd, 0.42);
  assert.equal("result" in result, false);

  const reasons = toast.losses.map((l) => l.reason);
  assert.ok(reasons.includes("prompt was cancelled before it was sent"));
  assert.ok(reasons.includes("prompt is still queued and has not been sent"));
  assert.ok(reasons.includes("3 system:thinking_tokens stream message(s) are progress ticks; not carried"));
});

test("conductor: reads a Codex session through the same stream shape", async () => {
  const file = await makeFixture();
  const toast = await conductorAdapter.read(`${file}#${CODEX_SESSION}`);
  assert.deepEqual(toast.agents, [{ agent: "conductor", model: "gpt-5.5", provider: "openai" }]);
  assert.deepEqual(toast.turns.map((t) => t.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(textOf(toast.turns[3].content), "Just README.md.");
});

test("conductor: translates to claude and refuses writes", async () => {
  const file = await makeFixture();
  const target = join(mkdtempSync(join(tmpdir(), "toaster-conductor-")), "out.jsonl");
  await translate("claude", `${file}#${SESSION}`, { from: "conductor", targetPath: target });
  const back = await claudeAdapter.read(target);
  const users = back.turns.filter((t) => t.role === "user").map((t) => textOf(t.content));
  assert.ok(users.includes("Why is the build red?"));
  const calls = new Set(back.turns.flatMap((t) => t.content.flatMap((b) => (b.type === "tool_call" ? [b.id] : []))));
  for (const t of back.turns.filter((t) => t.role === "tool")) {
    assert.ok(calls.has((t.content[0] as Extract<ToastContentBlock, { type: "tool_result" }>).toolCallId));
  }

  await assert.rejects(() => conductorAdapter.write(back), /not supported/);
  await assert.rejects(() => conductorAdapter.read(`${file}#missing`), /no conductor session missing/);
});
