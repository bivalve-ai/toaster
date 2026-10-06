// Builds tests/fixtures/pi-durable/session.sqlite with @earendil-works/pi-durable itself (a devDependency).
// Run once from the repo root: node tests/fixtures/pi-durable/build.mjs
// The committed .sqlite is what the tests read; the tests also reopen a copy with pi-durable to compare the
// adapter's projection with the Harness's own context().
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const out = join(dirname(fileURLToPath(import.meta.url)), "session.sqlite");
for (const f of [out, `${out}-wal`, `${out}-shm`]) if (existsSync(f)) rmSync(f);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	// conversation 1, turn 1: thinking + a tool call, then the answer
	fauxAssistantMessage([fauxThinking("Use the calculator."), fauxToolCall("calc", { expr: "2+2" }, { id: "call|1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("4")]),
	// conversation 1, turn 2 (before the fork point is taken)
	fauxAssistantMessage([fauxText("Paris.")]),
	// conversation 1, after the reset
	fauxAssistantMessage([fauxText("Continuing from the handoff.")]),
	// the fork's own turn
	fauxAssistantMessage([fauxText("Forked answer.")]),
]);
const calc = defineTool({
	name: "calc",
	description: "Evaluate an arithmetic expression.",
	parameters: Type.Object({ expr: Type.String() }),
	replay: "safe",
	execute: async () => ({ content: [{ type: "text", text: "4" }] }),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "fixture", tools: [calc] }));
const harness = await Harness.open(await openNodeSqliteStorage(out), { models, registry }, ctx);
const model = { provider: "faux", modelId: "faux-1" };
const ask = async (conv, content) => (await (await conv.submit({ type: "input", content }, ctx)).wait(ctx)).status;

// 1 · root: a tool round with thinking, a second turn, a reset with a handoff, one more turn. cwd set by a later
// configure(), so it is a delta revision of pi.agent, not the base.
const root = await harness.root(ctx, { agent: { model } });
await root.configure({ cwd: "/work/demo" }, ctx);
console.log("1:", await ask(root, "What is 2+2?"));
console.log("1:", await ask(root, [{ type: "text", text: "Capital of France?" }]));
const forkPoint = (await root.entries({}, 1, undefined, ctx)).items[0].id;
await root.reset("Handoff: we were doing arithmetic and geography. Continue.", ctx);
await root.waitForIdle(ctx);
console.log("1:", await ask(root, "Go on."));

// 2 · a fork of the root before the reset: inherits entries through the fork point.
const fork = await root.fork(forkPoint, { ownership: { kind: "ownerless" } }, ctx);
console.log("2:", await ask(fork, "And in the fork?"));

// 3 · hand-written entries: an omit edit, a replace edit, an aborted assistant, a call with no result.
const manual = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
const user = (text) => ({ role: "user", content: text, timestamp: 1_700_000_000_000 });
const assistant = (content, stopReason = "stop") => ({
	role: "assistant", content, api: "faux", provider: "faux", model: "faux-1", stopReason, timestamp: 1_700_000_000_001,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
await manual.commit(async (tx) => {
	const a = await tx.appendEntry(manual.id, { kind: "fixture.user", model: [user("secret, please forget")] });
	const b = await tx.appendEntry(manual.id, { kind: "fixture.user", model: [user("draft question")] });
	await tx.appendEntry(manual.id, { kind: "fixture.assistant", model: [assistant([{ type: "text", text: "half an ans" }], "aborted")] });
	await tx.appendEntry(manual.id, { kind: "fixture.note", data: { note: "bookkeeping only" } });
	await tx.appendEntry(manual.id, {
		kind: "fixture.edit",
		edits: [{ target: a.id, action: "omit" }, { target: b.id, action: "replace", messages: [user("final question")] }],
	});
	await tx.appendEntry(manual.id, { kind: "fixture.assistant", model: [assistant([{ type: "toolCall", id: "orphan-1", name: "calc", arguments: { expr: "1+1" } }], "toolUse")] });
	await tx.appendEntry(manual.id, { kind: "fixture.user", model: [user("still there?")] });
}, ctx);

await harness.close(ctx);
console.log(`wrote ${out}: conversations 1 (root, reset), ${fork.id} (fork), ${manual.id} (edits)`);
