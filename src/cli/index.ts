#!/usr/bin/env node
// toaster — agent session / trace translator.
//
//   toaster list [--pi | --claude | --codex]
//   toaster translate --to <agent> [--from <agent>] <path-or-id>
//   toaster pi-to-claude <path-or-id>                      (legacy alias)
//   toaster claude-to-pi <path-or-id>                      (legacy alias)

import { translate } from "../translate.js";
import { detectAgent } from "../adapters/index.js";
import { discoverSessions, type DiscoveredSession } from "../discover.js";
import type { AgentKind } from "../schemas/trace.js";

const HELP = `toaster — translate agent traces between formats.

commands
  list [--pi | --claude | --codex]
    list recent sessions on disk

  translate --to <agent> [--from <agent>] <path-or-id>
    translate a session between agents. --from is auto-detected if omitted.

  pi-to-claude <path-or-id>                 legacy alias
  claude-to-pi <path-or-id>                 legacy alias

examples
  toaster list
  toaster translate --to claude $(toaster list --pi | head -1 | awk '{print $1}')
  toaster pi-to-claude <id>

output
  Translation commands print JSON to stdout with target path + session id.
  Pipe into \`jq\` if scripting.
`;

const KNOWN_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(["pi", "claude"]);

function parseAgent(s: string | undefined): AgentKind | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === "pi" || v === "claude" || v === "codex") return v as AgentKind;
  return undefined;
}

function printSessionList(rows: DiscoveredSession[]) {
  if (rows.length === 0) { console.log("(no sessions found)"); return; }
  const now = Date.now();
  for (const r of rows) {
    const age = Math.max(0, Math.round((now - r.mtime.getTime()) / 60000));
    const ageStr = age < 60 ? `${age}m` : age < 1440 ? `${Math.round(age / 60)}h` : `${Math.round(age / 1440)}d`;
    const kb = Math.round(r.bytes / 1024);
    console.log(`${r.id.padEnd(36)}  ${r.agent.padEnd(6)}  ${ageStr.padStart(4)}  ${String(kb).padStart(5)}K  ${r.cwd ?? ""}`);
  }
}

async function resolvePathOrId(pathOrId: string, hint?: AgentKind): Promise<{ path: string; from?: AgentKind }> {
  if (pathOrId.includes("/") || pathOrId.endsWith(".jsonl")) {
    return { path: pathOrId, from: hint ?? (await detectAgent(pathOrId)) ?? undefined };
  }
  const rows = await discoverSessions(hint);
  const hit = rows.find((r) => r.id === pathOrId || r.id.startsWith(pathOrId));
  if (!hit) throw new Error(`no session found matching "${pathOrId}" — try \`toaster list\``);
  return { path: hit.path, from: hit.agent };
}

async function doTranslate(to: AgentKind, pathOrId: string, fromHint?: AgentKind) {
  const { path, from } = await resolvePathOrId(pathOrId, fromHint);
  const result = await translate(to, path, { from: fromHint ?? from });
  console.log(JSON.stringify({
    source: path,
    sourceAgent: result.sourceAgent,
    target: result.target,
    targetAgent: result.targetAgent,
    sessionId: result.sessionId,
    cwd: result.cwd,
    turns: result.turns,
    events: result.events,
    losses: result.losses.slice(0, 20),
    totalLosses: result.losses.length,
  }, null, 2));
  const hint = to === "claude"
    ? `(cd ${result.cwd ?? "<cwd>"} && claude --resume ${result.sessionId})`
    : to === "pi"
      ? `(cd ${result.cwd ?? "<cwd>"} && pi --session ${result.target})`
      : "";
  if (hint) console.error(`\n→ ${hint}`);
}

function consumeFlag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return undefined;
  if (args[i].includes("=")) {
    const [, v] = args[i].split("=", 2);
    args.splice(i, 1);
    return v;
  }
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return 0; }

  if (cmd === "list") {
    const filter = rest.includes("--pi") ? "pi" : rest.includes("--claude") ? "claude" : rest.includes("--codex") ? "codex" : undefined;
    printSessionList(await discoverSessions(filter));
    return 0;
  }

  if (cmd === "translate") {
    const args = [...rest];
    const to = parseAgent(consumeFlag(args, "--to"));
    const from = parseAgent(consumeFlag(args, "--from"));
    const pathOrId = args[0];
    if (!to) { console.error("usage: toaster translate --to <pi|claude|codex> [--from <...>] <path-or-id>"); return 1; }
    if (!KNOWN_AGENTS.has(to)) { console.error(`target agent "${to}" is not registered yet`); return 1; }
    if (!pathOrId) { console.error("missing <path-or-id>"); return 1; }
    await doTranslate(to, pathOrId, from);
    return 0;
  }

  // Legacy aliases.
  if (cmd === "pi-to-claude" || cmd === "p2c") {
    if (!rest[0]) { console.error("usage: toaster pi-to-claude <path-or-id>"); return 1; }
    await doTranslate("claude", rest[0], "pi");
    return 0;
  }
  if (cmd === "claude-to-pi" || cmd === "c2p") {
    if (!rest[0]) { console.error("usage: toaster claude-to-pi <path-or-id>"); return 1; }
    await doTranslate("pi", rest[0], "claude");
    return 0;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.error(HELP);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { console.error(`toaster: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); },
);
