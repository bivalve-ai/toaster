#!/usr/bin/env node
// toaster — local-first universal session store for AI agents.
//
//   toaster scan [--app <agent>] [--limit <n>]
//   toaster list [--pi | --claude | --codex | --opencode | --app <agent> | --saved]
//   toaster resume <path-or-id> --in <agent> [--launch]
//   toaster ingest <path-or-id> [--dir <path>] [--name <slug>]
//   toaster ingest --all [--dir <path>] [--app <agent>] [--limit <n>] [--dry-run] [--yes]
//   toaster save <path-or-id> [--dir <path>] [--name <slug>]
//   toaster save --all [--dir <path>] [--app <agent>] [--limit <n>]
//   toaster export <path-or-id> --to toast [--out <path>]
//   toaster redact <path-or-id-saved-name> [--out <path>] [--provider <local|opf>] [--alias]
//   toaster mirror --cloud-safe-local [--out <path>] [--limit <n>] [--yes]
//   toaster redaction doctor
//   toaster config [path|get|set]
//   toaster translate --to <agent> [--from <agent>] [--strict] [--thinking-policy <drop|note>] <path-or-id>
//   toaster corpus --dir <path> [--to <agent>] [--thinking-policy <drop|note>]
//   toaster pi-to-claude <path-or-id>                      (legacy alias)
//   toaster claude-to-pi <path-or-id>                      (legacy alias)

import { spawn } from "node:child_process";
import { access, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCorpus } from "../corpus.js";
import { translate } from "../translate.js";
import { detectAgent, getAdapter } from "../adapters/index.js";
import { discoverSessions, type DiscoveredSession } from "../discover.js";
import {
  defaultLibraryDir,
  listLibrarySessions,
  readSessionAsToast,
  readToastArtifact,
  saveAllSessionsToLibrary,
  saveSessionToLibrary,
} from "../library.js";
import {
  configPath,
  getConfigValue,
  loadConfig,
  parseConfigValue,
  setConfigValue,
} from "../config.js";
import { redactToast, sanitizeRedactionReport } from "../redaction.js";
import { createCloudSafeMirror } from "../mirror.js";
import type { AgentKind } from "../schemas/toast.js";

const HELP = `toaster — local-first universal session store for AI agents.

commands
  scan [--app <agent>] [--limit <n>]
    inspect native agent stores. Read-only; writes nothing.

  list --saved [--dir <path>]
    list sessions saved in the local TOAST library

  list [--pi | --claude | --codex | --opencode | --app <agent>]
    legacy/native listing. Prefer \`scan\` for native stores and \`list --saved\` for the library.

  resume <path-or-id-saved-name-or-toast.json> --in <agent> [--dir <library>] [--launch]
    make a session resumable in another app. Source is auto-detected.

  ingest <path-or-id> [--dir <path>] [--name <slug>]
    pull one native/saved session into the TOAST library. Default dir: ~/toast-library

  ingest --all [--dir <path>] [--app <agent>] [--limit <n>] [--dry-run] [--yes] [--force]
    update the TOAST library from native stores. Skips unchanged sessions unless --force.

  save ...
    legacy alias for \`ingest ...\`.

  export <path-or-id-saved-name> --to toast [--out <path>] [--dir <library>]
    write a raw TOAST JSON artifact

  redact <path-or-id-saved-name> [--out <path>] [--provider <local|opf>] [--alias] [--dry-run]
    write a redacted TOAST artifact and redaction report

  mirror --cloud-safe-local [--dir <library>] [--out <path>] [--provider <local|opf>] [--alias] [--limit <n>] [--yes]
    write a local redacted/aliased mirror of the TOAST library. Does not upload.
    \`--cloud-safe\` is kept as an alias.

  redaction doctor
    inspect local redaction config, OPF install, and checkpoint status without downloading models

  config path | config get [key] | config set <key> <value>
    inspect or update ~/.config/toaster/config.json

  translate --to <agent> [--from <agent>] [--strict] [--thinking-policy <drop|note>] <path-or-id>
    low-level conversion primitive. Source is auto-detected; use --from only as a fallback.

  corpus --dir <path> [--to <agent>] [--thinking-policy <drop|note>]
    run read/validate/write/reread over a local directory of native trace files

  pi-to-claude <path-or-id>                 legacy alias
  claude-to-pi <path-or-id>                 legacy alias

examples
  toaster scan
  toaster list --saved
  toaster resume 01a516a7 --in claude
  toaster ingest --all --dry-run
  toaster ingest --all --yes --dir ~/toast-library
  toaster export 01a516a7 --to toast --out session.toast.json
  toaster redact 01a516a7 --alias --out safe.toast.json
  toaster mirror --cloud-safe-local --alias --yes
  toaster redaction doctor
  toaster translate --to claude <pi-session-id-or-path>
`;

const KNOWN_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(["pi", "claude", "codex", "opencode"]);

function parseAgent(s: string | undefined): AgentKind | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === "pi" || v === "claude" || v === "codex" || v === "opencode") return v as AgentKind;
  return undefined;
}

function parseRedactionProvider(s: string | undefined): "local" | "opf" | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  return v === "local" || v === "opf" ? v : undefined;
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

async function resolvePathOrId(pathOrId: string, hint?: AgentKind, libraryDir?: string): Promise<{ path: string; from?: AgentKind }> {
  if (pathOrId.includes("/") || pathOrId.endsWith(".jsonl") || pathOrId.endsWith(".json")) {
    return { path: pathOrId, from: hint ?? (await detectAgent(pathOrId)) ?? undefined };
  }
  const rows = await discoverSessions(hint);
  const hit = rows.find((r) => r.id === pathOrId || r.id.startsWith(pathOrId));
  if (hit) return { path: hit.path, from: hit.agent };

  const saved = (await listLibrarySessions(libraryDir)).sessions;
  const savedHit = saved.find((r) => r.name === pathOrId || r.name.startsWith(pathOrId) || r.sourceId === pathOrId || r.sourceId.startsWith(pathOrId));
  if (savedHit) return { path: savedHit.toastPath };

  throw new Error(`no session found matching "${pathOrId}" — try \`toaster scan\` for native sessions or \`toaster list --saved\` for the TOAST library`);
}

async function doTranslate(
  to: AgentKind,
  pathOrId: string,
  fromHint?: AgentKind,
  strict = false,
  thinkingPolicy?: "drop" | "note",
) {
  const { path, from } = await resolvePathOrId(pathOrId, fromHint);
  const result = await translate(to, path, { from: fromHint ?? from, strict, thinkingPolicy });
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
  const hint = launchHint(to, result);
  if (hint) console.error(`\n→ ${hint.text}`);
}

function printSavedList(rows: Awaited<ReturnType<typeof listLibrarySessions>>["sessions"]) {
  if (rows.length === 0) { console.log("(no saved sessions found)"); return; }
  for (const r of rows) {
    console.log(`${r.name.padEnd(48)}  ${r.sourceAgent.padEnd(8)}  ${String(r.turns).padStart(5)} turns  ${r.cwd ?? ""}`);
  }
}

function launchHint(agent: AgentKind, result: { cwd?: string; sessionId: string; target: string }): { text: string; command: string; args: string[]; cwd?: string } | undefined {
  if (agent === "claude") {
    return {
      text: `(cd ${result.cwd ?? "<cwd>"} && claude --resume ${result.sessionId})`,
      command: "claude",
      args: ["--resume", result.sessionId],
      cwd: result.cwd,
    };
  }
  if (agent === "pi") {
    return {
      text: `(cd ${result.cwd ?? "<cwd>"} && pi --session ${result.target})`,
      command: "pi",
      args: ["--session", result.target],
      cwd: result.cwd,
    };
  }
  return undefined;
}

async function launch(spec: { command: string; args: string[]; cwd?: string }): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolveCode(code ?? 0));
  });
}

async function doResume(to: AgentKind, pathOrId: string, fromHint?: AgentKind, shouldLaunch = false, libraryDir?: string) {
  const { path, from } = await resolvePathOrId(pathOrId, fromHint, libraryDir);
  const trace = await readSessionAsToast(path, fromHint ?? from);
  const result = await getAdapter(to).write(trace);
  const hint = launchHint(to, result);
  console.log(JSON.stringify({
    action: "resume",
    localOnly: true,
    reads: [{ kind: "source-session-or-toast", path }],
    writes: [{ kind: `${to}-native-session`, path: result.target }],
    note: "resume writes a target-native session file; it does not launch unless --launch is passed",
    source: path,
    sourceAgent: trace.source.agent,
    target: result.target,
    targetAgent: result.targetAgent,
    sessionId: result.sessionId,
    cwd: result.cwd,
    turns: result.turns,
    events: result.events,
    losses: result.losses.slice(0, 20),
    totalLosses: result.losses.length,
    launch: hint?.text,
  }, null, 2));
  if (hint) console.error(`\n→ ${hint.text}`);
  if (shouldLaunch) {
    if (!hint) throw new Error(`don't know how to launch ${to} yet`);
    return launch(hint);
  }
  return 0;
}

async function doExportToast(pathOrId: string, outPath?: string, fromHint?: AgentKind, libraryDir?: string) {
  const { path, from } = await resolvePathOrId(pathOrId, fromHint, libraryDir);
  const trace = await readSessionAsToast(path, fromHint ?? from);
  const output = JSON.stringify(trace, null, 2) + "\n";
  if (outPath) {
    await writeFile(outPath, output, "utf-8");
    console.log(JSON.stringify({ action: "export", format: "toast", source: path, target: outPath, turns: trace.turns.length, events: trace.events.length }, null, 2));
  } else {
    process.stdout.write(output);
  }
}

async function doRedact(
  pathOrId: string,
  options: { out?: string; reportOut?: string; provider?: "local" | "opf"; alias?: boolean; dryRun?: boolean; dir?: string; from?: AgentKind; device?: "cpu" | "cuda"; checkpoint?: string },
) {
  const config = await loadConfig();
  const { path, from } = await resolvePathOrId(pathOrId, options.from, options.dir);
  const trace = path.endsWith("toast.json") || path.endsWith(".toast.json")
    ? await readToastArtifact(path)
    : await readSessionAsToast(path, options.from ?? from);
  const result = await redactToast(trace, {
    config,
    provider: options.provider,
    alias: options.alias,
    dryRun: options.dryRun,
    device: options.device,
    checkpoint: options.checkpoint,
  });
  const summary = {
    action: "redact",
    localOnly: true,
    reads: [{ kind: "source-session-or-toast", path }],
    writes: options.dryRun
      ? []
      : [
        ...(options.out ? [{ kind: "redacted-toast", path: options.out }] : []),
        ...(options.reportOut ? [{ kind: "sanitized-redaction-report", path: options.reportOut }] : []),
        ...(result.report.alias ? [{ kind: "local-alias-vault", path: "~/.config/toaster/aliases.json" }] : []),
      ],
    note: result.report.alias
      ? "alias mappings are local-only; do not sync ~/.config/toaster"
      : undefined,
    source: path,
    provider: result.report.provider,
    alias: result.report.alias,
    dryRun: !!options.dryRun,
    spanCount: result.report.spanCount,
    byLabel: result.report.byLabel,
    warnings: result.report.warnings,
    target: options.out,
    report: options.reportOut,
  };
  if (options.dryRun) {
    console.log(JSON.stringify({ ...summary, fields: result.report.fields.slice(0, 20) }, null, 2));
    return;
  }
  if (options.out) {
    await writeFile(options.out, JSON.stringify(result.toast, null, 2) + "\n", "utf-8");
    if (options.reportOut) await writeFile(options.reportOut, JSON.stringify(sanitizeRedactionReport(result.report), null, 2) + "\n", "utf-8");
    console.log(JSON.stringify(summary, null, 2));
  } else {
    process.stdout.write(JSON.stringify(result.toast, null, 2) + "\n");
  }
}

async function confirmBulkSave(dir: string, action = "read known local agent session stores and save TOAST artifacts"): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.error(`Toaster is about to ${action}:\n\n  ${dir}\n`);
  console.error("These sessions may include source code, secrets, local paths, prompts, tool outputs, model responses, and private context.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function summarizeDiscovered(rows: DiscoveredSession[]): Record<AgentKind, number> {
  return rows.reduce((acc, row) => {
    acc[row.agent] += 1;
    return acc;
  }, { pi: 0, claude: 0, codex: 0, opencode: 0 } as Record<AgentKind, number>);
}

function nativeStoreHints(filter?: AgentKind): Array<{ agent: AgentKind; path: string; mode: "read" }> {
  const all: Array<{ agent: AgentKind; path: string; mode: "read" }> = [
    { agent: "pi", path: "~/.pi/agent/sessions", mode: "read" },
    { agent: "claude", path: "~/.claude/projects", mode: "read" },
    { agent: "codex", path: "~/.codex/sessions", mode: "read" },
    { agent: "opencode", path: "export-style JSON files only; no native store scan yet", mode: "read" },
  ];
  return filter ? all.filter((s) => s.agent === filter) : all;
}

function parsePositiveLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return limit;
}

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of paths) {
    try {
      await access(join(dir, command));
      return true;
    } catch {
      // try next path entry
    }
  }
  return false;
}

async function checkpointStatus(path: string): Promise<{ path: string; exists: boolean; complete: boolean; bytes?: number; files?: string[] }> {
  try {
    const entries = await readdir(path);
    const files = entries.filter((f) => f === "config.json" || f.endsWith(".safetensors"));
    let bytes = 0;
    for (const file of files) bytes += (await stat(join(path, file))).size;
    return {
      path,
      exists: true,
      complete: entries.includes("config.json") && entries.some((f) => f.endsWith(".safetensors")),
      bytes,
      files,
    };
  } catch {
    return { path, exists: false, complete: false };
  }
}

async function doRedactionDoctor() {
  const config = await loadConfig();
  const provider = config.redaction?.provider ?? "local";
  const checkpoint = config.redaction?.checkpoint ?? join(homedir(), ".opf", "privacy_filter");
  const opfInstalled = await commandExists("opf");
  const checkpointInfo = await checkpointStatus(checkpoint);
  console.log(JSON.stringify({
    action: "redaction-doctor",
    localOnly: true,
    provider,
    configPath: configPath(),
    aliasVault: {
      keyPath: "~/.config/toaster/alias.key",
      aliasesPath: "~/.config/toaster/aliases.json",
      note: "alias vault is local-only; do not sync it",
    },
    localRegex: { available: true },
    opf: {
      installed: opfInstalled,
      command: "opf",
      checkpoint: checkpointInfo,
      firstUseNote: checkpointInfo.complete
        ? "OPF checkpoint is present; no model download should be needed."
        : "OPF checkpoint is missing/incomplete. First OPF use may download ~2.6GB to the checkpoint path.",
      installHint: opfInstalled ? undefined : "Install OPF separately, e.g. from https://github.com/openai/privacy-filter",
    },
  }, null, 2));
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

  if (cmd === "scan") {
    const args = [...rest];
    const app = parseAgent(consumeFlag(args, "--app"))
      ?? (args.includes("--pi")
        ? "pi"
        : args.includes("--claude")
          ? "claude"
          : args.includes("--codex")
            ? "codex"
            : args.includes("--opencode")
              ? "opencode"
              : undefined);
    const limit = parsePositiveLimit(consumeFlag(args, "--limit"));
    const rows = await discoverSessions(app);
    const selected = typeof limit === "number" ? rows.slice(0, limit) : rows;
    console.log(JSON.stringify({
      action: "scan-native-stores",
      localOnly: true,
      reads: nativeStoreHints(app),
      writes: [],
      total: selected.length,
      byAgent: summarizeDiscovered(selected),
      sessions: selected.map((r) => ({ id: r.id, agent: r.agent, path: r.path, cwd: r.cwd, bytes: r.bytes, mtime: r.mtime.toISOString() })),
    }, null, 2));
    return 0;
  }

  if (cmd === "list" || cmd === "library") {
    const args = [...rest];
    const dir = consumeFlag(args, "--dir");
    if (cmd === "library" || args.includes("--saved")) {
      printSavedList((await listLibrarySessions(dir)).sessions);
      return 0;
    }
    const appFlag = parseAgent(consumeFlag(args, "--app"));
    const filter = appFlag
      ?? (args.includes("--pi")
        ? "pi"
        : args.includes("--claude")
          ? "claude"
          : args.includes("--codex")
            ? "codex"
            : args.includes("--opencode")
              ? "opencode"
              : undefined);
    printSessionList(await discoverSessions(filter));
    return 0;
  }

  if (cmd === "resume") {
    const args = [...rest];
    const to = parseAgent(consumeFlag(args, "--in"));
    const from = parseAgent(consumeFlag(args, "--from"));
    const dir = consumeFlag(args, "--dir");
    const shouldLaunch = args.includes("--launch");
    if (shouldLaunch) args.splice(args.indexOf("--launch"), 1);
    const pathOrId = args[0];
    if (!to) { console.error("usage: toaster resume <path-or-id-saved-name-or-toast.json> --in <pi|claude|codex|opencode> [--dir <library>] [--launch]"); return 1; }
    if (!KNOWN_AGENTS.has(to)) { console.error(`target agent "${to}" is not registered yet`); return 1; }
    if (!pathOrId) { console.error("missing <path-or-id-saved-name-or-toast.json>"); return 1; }
    return doResume(to, pathOrId, from, shouldLaunch, dir);
  }

  if (cmd === "save" || cmd === "ingest") {
    const commandName = cmd;
    const args = [...rest];
    const dir = consumeFlag(args, "--dir");
    const name = consumeFlag(args, "--name");
    const app = parseAgent(consumeFlag(args, "--app"));
    const from = parseAgent(consumeFlag(args, "--from"));
    const limitRaw = consumeFlag(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const dryRun = args.includes("--dry-run");
    if (dryRun) args.splice(args.indexOf("--dry-run"), 1);
    const yes = args.includes("--yes");
    if (yes) args.splice(args.indexOf("--yes"), 1);
    const force = args.includes("--force");
    if (force) args.splice(args.indexOf("--force"), 1);
    if (limitRaw && (!Number.isInteger(limit) || limit! < 1)) { console.error("usage: --limit must be a positive integer"); return 1; }
    if (args.includes("--all")) {
      const targetDir = dir ?? defaultLibraryDir();
      const rows = await discoverSessions(app);
      const selected = typeof limit === "number" ? rows.slice(0, limit) : rows;
      if (dryRun) {
        console.log(JSON.stringify({
          action: commandName === "ingest" ? "ingest-all-dry-run" : "save-all-dry-run",
          localOnly: true,
          reads: nativeStoreHints(app),
          writes: [],
          dir: targetDir,
          total: selected.length,
          byAgent: summarizeDiscovered(selected),
          note: "dry run reads native stores only; ingest will skip unchanged sessions by source mtime/bytes unless --force is used",
        }, null, 2));
        return 0;
      }
      if (!yes && !(await confirmBulkSave(targetDir))) {
        console.error(`toaster: bulk ${commandName} cancelled. Re-run with --yes to confirm non-interactively, or use --dry-run first.`);
        return 1;
      }
      const result = await saveAllSessionsToLibrary({ dir, filter: app, limit, force });
      console.log(JSON.stringify({
        action: commandName === "ingest" ? "ingest-all" : "save-all",
        localOnly: true,
        reads: nativeStoreHints(app),
        writes: [{ kind: "raw-toast-library", path: result.dir }],
        dir: result.dir,
        total: result.total,
        saved: result.saved.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
        failures: result.failed.slice(0, 20).map((f) => ({ id: f.session.id, agent: f.session.agent, path: f.session.path, error: f.error })),
      }, null, 2));
      return result.failed.length > 0 ? 2 : 0;
    }
    const pathOrId = args[0];
    if (!pathOrId) { console.error(`usage: toaster ${commandName} <path-or-id> [--dir <path>] [--name <slug>] or toaster ${commandName} --all [--dir <path>]`); return 1; }
    const { path, from: resolvedFrom } = await resolvePathOrId(pathOrId, from);
    const saved = await saveSessionToLibrary(path, { dir, name, from: from ?? resolvedFrom });
    console.log(JSON.stringify({
      action: commandName === "ingest" ? "ingest" : "save",
      localOnly: true,
      reads: [{ kind: "source-session", path }],
      writes: [{ kind: "raw-toast-library-session", path: saved.dir }],
      ...saved,
    }, null, 2));
    return 0;
  }

  if (cmd === "export") {
    const args = [...rest];
    const to = consumeFlag(args, "--to");
    const out = consumeFlag(args, "--out");
    const from = parseAgent(consumeFlag(args, "--from"));
    const dir = consumeFlag(args, "--dir");
    const pathOrId = args[0];
    if (to !== "toast") { console.error("usage: toaster export <path-or-id-saved-name> --to toast [--out <path>] [--dir <library>]"); return 1; }
    if (!pathOrId) { console.error("missing <path-or-id-saved-name>"); return 1; }
    await doExportToast(pathOrId, out, from, dir);
    return 0;
  }

  if (cmd === "redact") {
    const args = [...rest];
    const out = consumeFlag(args, "--out");
    const reportOut = consumeFlag(args, "--report-out") ?? (out ? out.replace(/\.json$/, ".redaction-report.json") : undefined);
    const providerRaw = consumeFlag(args, "--provider");
    const provider = parseRedactionProvider(providerRaw);
    const from = parseAgent(consumeFlag(args, "--from"));
    const dir = consumeFlag(args, "--dir");
    const deviceRaw = consumeFlag(args, "--device");
    const device = deviceRaw === "cpu" || deviceRaw === "cuda" ? deviceRaw : undefined;
    const checkpoint = consumeFlag(args, "--checkpoint");
    const alias = args.includes("--alias");
    if (alias) args.splice(args.indexOf("--alias"), 1);
    const dryRun = args.includes("--dry-run");
    if (dryRun) args.splice(args.indexOf("--dry-run"), 1);
    if (providerRaw && !provider) { console.error("usage: --provider must be local or opf"); return 1; }
    if (deviceRaw && !device) { console.error("usage: --device must be cpu or cuda"); return 1; }
    if (alias && !dryRun) console.error("toaster: --alias writes local-only mappings to ~/.config/toaster/aliases.json; do not sync that directory.");
    const pathOrId = args[0];
    if (!pathOrId) { console.error("usage: toaster redact <path-or-id-saved-name> [--out <path>] [--provider <local|opf>] [--alias] [--dry-run]"); return 1; }
    await doRedact(pathOrId, { out, reportOut, provider, alias: alias || undefined, dryRun, dir, from, device, checkpoint });
    return 0;
  }

  if (cmd === "redaction") {
    const [sub] = rest;
    if (sub === "doctor") {
      await doRedactionDoctor();
      return 0;
    }
    console.error("usage: toaster redaction doctor");
    return 1;
  }

  if (cmd === "mirror") {
    const args = [...rest];
    const cloudFlagIndex = args.findIndex((a) => a === "--cloud-safe-local" || a === "--cloud-safe");
    if (cloudFlagIndex < 0) { console.error("usage: toaster mirror --cloud-safe-local [--dir <library>] [--out <path>] [--provider <local|opf>] [--alias] [--yes]"); return 1; }
    args.splice(cloudFlagIndex, 1);
    const dir = consumeFlag(args, "--dir");
    const out = consumeFlag(args, "--out");
    const providerRaw = consumeFlag(args, "--provider");
    const provider = parseRedactionProvider(providerRaw);
    const deviceRaw = consumeFlag(args, "--device");
    const device = deviceRaw === "cpu" || deviceRaw === "cuda" ? deviceRaw : undefined;
    const checkpoint = consumeFlag(args, "--checkpoint");
    const limitRaw = consumeFlag(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const alias = args.includes("--alias");
    if (alias) args.splice(args.indexOf("--alias"), 1);
    const yes = args.includes("--yes");
    if (yes) args.splice(args.indexOf("--yes"), 1);
    if (providerRaw && !provider) { console.error("usage: --provider must be local or opf"); return 1; }
    if (deviceRaw && !device) { console.error("usage: --device must be cpu or cuda"); return 1; }
    if (limitRaw && (!Number.isInteger(limit) || limit! < 1)) { console.error("usage: --limit must be a positive integer"); return 1; }
    if (alias) console.error("toaster: --alias writes local-only mappings to ~/.config/toaster/aliases.json; do not sync that directory.");
    const config = await loadConfig();
    const targetDir = out ?? config.cloudSafeDir ?? "~/toast-library-cloud";
    if (!yes && !(await confirmBulkSave(targetDir, "write a local redacted/aliased cloud-safe mirror to"))) {
      console.error("toaster: local cloud-safe mirror cancelled. Re-run with --yes to confirm.");
      return 1;
    }
    const result = await createCloudSafeMirror({ config, libraryDir: dir, outDir: out, provider, alias: alias || undefined, device, checkpoint, limit });
    console.log(JSON.stringify({
      action: "mirror-cloud-safe-local",
      localOnly: true,
      uploads: false,
      reads: [{ kind: "raw-toast-library", path: result.sourceDir }],
      writes: [{ kind: "redacted-aliased-local-mirror", path: result.outDir }],
      note: "mirror writes local files only; it does not upload. Alias vault remains under ~/.config/toaster.",
      sourceDir: result.sourceDir,
      outDir: result.outDir,
      total: result.total,
      mirrored: result.mirrored,
      failed: result.failed.length,
      failures: result.failed.slice(0, 20).map((f) => ({ name: f.session.name, error: f.error })),
    }, null, 2));
    return result.failed.length > 0 ? 2 : 0;
  }

  if (cmd === "config") {
    const [sub, ...args] = rest;
    if (!sub || sub === "get") {
      const config = await loadConfig();
      const value = getConfigValue(config, args[0]);
      console.log(JSON.stringify(value, null, 2));
      return 0;
    }
    if (sub === "path") {
      console.log(configPath());
      return 0;
    }
    if (sub === "set") {
      const [key, rawValue] = args;
      if (!key || rawValue === undefined) { console.error("usage: toaster config set <key> <value>"); return 1; }
      const config = await setConfigValue(key, parseConfigValue(rawValue));
      console.log(JSON.stringify(config, null, 2));
      return 0;
    }
    console.error("usage: toaster config path | toaster config get [key] | toaster config set <key> <value>");
    return 1;
  }

  if (cmd === "translate") {
    const args = [...rest];
    const to = parseAgent(consumeFlag(args, "--to"));
    const from = parseAgent(consumeFlag(args, "--from"));
    const thinkingPolicyRaw = consumeFlag(args, "--thinking-policy");
    const thinkingPolicy = thinkingPolicyRaw === "drop" || thinkingPolicyRaw === "note" ? thinkingPolicyRaw : undefined;
    if (thinkingPolicyRaw && !thinkingPolicy) {
      console.error('usage: --thinking-policy must be "drop" or "note"');
      return 1;
    }
    const strict = args.includes("--strict");
    if (strict) args.splice(args.indexOf("--strict"), 1);
    const pathOrId = args[0];
    if (!to) { console.error("usage: toaster translate --to <pi|claude|codex|opencode> [--from <...>] <path-or-id>"); return 1; }
    if (!KNOWN_AGENTS.has(to)) { console.error(`target agent "${to}" is not registered yet`); return 1; }
    if (!pathOrId) { console.error("missing <path-or-id>"); return 1; }
    await doTranslate(to, pathOrId, from, strict, thinkingPolicy);
    return 0;
  }

  if (cmd === "corpus") {
    const args = [...rest];
    const dir = consumeFlag(args, "--dir") ?? args[0];
    const to = parseAgent(consumeFlag(args, "--to"));
    const thinkingPolicyRaw = consumeFlag(args, "--thinking-policy");
    const thinkingPolicy = thinkingPolicyRaw === "drop" || thinkingPolicyRaw === "note" ? thinkingPolicyRaw : undefined;
    if (thinkingPolicyRaw && !thinkingPolicy) {
      console.error('usage: --thinking-policy must be "drop" or "note"');
      return 1;
    }
    if (!dir) { console.error("usage: toaster corpus --dir <path> [--to <pi|claude|codex|opencode>]"); return 1; }
    const report = await runCorpus(dir, {
      targets: to ? [to] : undefined,
      writeOptions: thinkingPolicy ? { thinkingPolicy } : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
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
