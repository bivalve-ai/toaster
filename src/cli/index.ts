#!/usr/bin/env node
// toaster — agent session translator.
//
//   toaster list [--pi | --claude]         List discovered sessions.
//   toaster pi-to-claude <path-or-id>      Translate pi session → claude.
//   toaster claude-to-pi <path-or-id>      Translate claude session → pi.
//
// On success prints a JSON summary with the new session path + id, so you can
// pipe into shell. Try `toaster pi-to-claude <id> | jq -r .sessionId`.

import { migratePiSessionToClaude } from "../translators/pi-to-claude.js";
import { migrateClaudeSessionToPi } from "../translators/claude-to-pi.js";
import { discoverSessions, type DiscoveredSession } from "../discover.js";

const HELP = `toaster — translate agent sessions between pi and claude code.

commands
  list [--pi | --claude]          list recent sessions on disk
  pi-to-claude <path-or-id>       translate a pi session → claude
  claude-to-pi <path-or-id>       translate a claude session → pi
  help                            show this

examples
  # peek at what you have
  toaster list

  # grab your most recent pi session + open it as claude
  toaster pi-to-claude $(toaster list --pi | head -1 | awk '{print $1}')

output
  Translation commands print a JSON summary — source/target paths, new
  session id, event count. Pipe into \`jq\` if scripting.
`;

function printSessionList(rows: DiscoveredSession[]) {
  if (rows.length === 0) {
    console.log("(no sessions found)");
    return;
  }
  const now = Date.now();
  for (const r of rows) {
    const age = Math.max(0, Math.round((now - r.mtime.getTime()) / 60000)); // minutes
    const ageStr = age < 60 ? `${age}m` : age < 1440 ? `${Math.round(age / 60)}h` : `${Math.round(age / 1440)}d`;
    const kb = Math.round(r.bytes / 1024);
    console.log(`${r.id.padEnd(36)}  ${r.agent.padEnd(6)}  ${ageStr.padStart(4)}  ${String(kb).padStart(5)}K  ${r.cwd ?? ""}`);
  }
}

async function resolveSessionPath(agent: "pi" | "claude", pathOrId: string): Promise<string> {
  // If it looks like a path, use it directly.
  if (pathOrId.includes("/") || pathOrId.endsWith(".jsonl")) return pathOrId;
  // Otherwise look it up via discover.
  const rows = await discoverSessions(agent);
  const hit = rows.find((r) => r.id === pathOrId || r.id.startsWith(pathOrId));
  if (!hit) {
    throw new Error(`no ${agent} session found matching "${pathOrId}" — try \`toaster list --${agent}\``);
  }
  return hit.path;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }

  if (cmd === "list") {
    const filter = rest.includes("--pi") ? "pi" : rest.includes("--claude") ? "claude" : undefined;
    const rows = await discoverSessions(filter);
    printSessionList(rows);
    return 0;
  }

  if (cmd === "pi-to-claude" || cmd === "p2c") {
    const arg = rest[0];
    if (!arg) { console.error("usage: toaster pi-to-claude <path-or-id>"); return 1; }
    const path = await resolveSessionPath("pi", arg);
    const result = await migratePiSessionToClaude(path);
    console.log(JSON.stringify(result, null, 2));
    console.error(`\n→ claude --resume ${result.sessionId}   (from ${result.cwd})`);
    return 0;
  }

  if (cmd === "claude-to-pi" || cmd === "c2p") {
    const arg = rest[0];
    if (!arg) { console.error("usage: toaster claude-to-pi <path-or-id>"); return 1; }
    const path = await resolveSessionPath("claude", arg);
    const result = await migrateClaudeSessionToPi(path);
    console.log(JSON.stringify(result, null, 2));
    console.error(`\n→ pi --session ${result.target}   (cwd ${result.cwd})`);
    return 0;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.error(HELP);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`toaster: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
