import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { detectAgent, getAdapter } from "./adapters/index.js";
import type { DiscoveredSession } from "./adapters/types.js";
import { discoverSessions } from "./discover.js";
import type { AgentKind, Toast, ToastContentBlock } from "./schemas/toast.js";

export function defaultLibraryDir(): string {
  return join(homedir(), "toast-library");
}

export interface SavedSession {
  name: string;
  dir: string;
  toastPath: string;
  readmePath: string;
  metaPath: string;
  sourceAgent: AgentKind;
  sourcePath?: string;
  sourceId: string;
  sourceMtime?: string;
  sourceBytes?: number;
  cwd?: string;
  turns: number;
  events: number;
  losses: number;
  savedAt: string;
}

export interface SaveToastOptions {
  dir?: string;
  name?: string;
  sourcePath?: string;
  overwrite?: boolean;
  sourceMtime?: string;
  sourceBytes?: number;
}

export interface SaveSessionOptions extends SaveToastOptions {
  from?: AgentKind;
}

export interface SaveAllOptions {
  dir?: string;
  filter?: AgentKind;
  limit?: number;
  /** Re-read and rewrite even if source mtime/bytes match existing metadata. */
  force?: boolean;
}

export interface SaveAllResult {
  dir: string;
  total: number;
  saved: SavedSession[];
  skipped: SavedSession[];
  failed: Array<{ session: DiscoveredSession; error: string }>;
}

export interface LibraryIndex {
  dir: string;
  sessions: SavedSession[];
}

export function isToast(value: unknown): value is Toast {
  const candidate = value as Partial<Toast> | null;
  return !!candidate
    && candidate.traceVersion === 1
    && typeof candidate.id === "string"
    && !!candidate.source
    && Array.isArray(candidate.turns)
    && Array.isArray(candidate.events)
    && Array.isArray(candidate.losses);
}

export async function readToastArtifact(path: string): Promise<Toast> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  if (!isToast(parsed)) throw new Error(`${path} is not a TOAST artifact`);
  return parsed;
}

export async function readSessionAsToast(path: string, from?: AgentKind): Promise<Toast> {
  if (path.endsWith(".json")) {
    try {
      return await readToastArtifact(path);
    } catch {
      // Not a TOAST artifact; fall through to adapter detection.
    }
  }
  const sourceAgent = from ?? await detectAgent(path);
  if (!sourceAgent) throw new Error(`could not detect source agent for ${path}`);
  return getAdapter(sourceAgent).read(path);
}

export async function saveSessionToLibrary(path: string, options: SaveSessionOptions = {}): Promise<SavedSession> {
  const trace = await readSessionAsToast(path, options.from);
  return saveToastToLibrary(trace, { ...options, sourcePath: path });
}

export async function saveToastToLibrary(trace: Toast, options: SaveToastOptions = {}): Promise<SavedSession> {
  const root = resolve(options.dir ?? defaultLibraryDir());
  const savedAt = new Date().toISOString();
  const name = slugify(options.name ?? defaultSessionName(trace));
  const sessionDir = join(root, "sessions", trace.source.agent, name);
  if (existsSync(sessionDir) && options.overwrite === false) {
    throw new Error(`saved session already exists: ${sessionDir}`);
  }
  await mkdir(sessionDir, { recursive: true });

  const toastPath = join(sessionDir, "toast.json");
  const readmePath = join(sessionDir, "README.md");
  const metaPath = join(sessionDir, "meta.json");

  const saved: SavedSession = {
    name,
    dir: sessionDir,
    toastPath,
    readmePath,
    metaPath,
    sourceAgent: trace.source.agent,
    sourcePath: options.sourcePath ?? trace.source.path,
    sourceId: trace.id,
    sourceMtime: options.sourceMtime,
    sourceBytes: options.sourceBytes,
    cwd: trace.cwd,
    turns: trace.turns.length,
    events: trace.events.length,
    losses: trace.losses.length + trace.turns.reduce((n, t) => n + (t.losses?.length ?? 0), 0),
    savedAt,
  };

  await writeFile(toastPath, JSON.stringify(trace, null, 2) + "\n", "utf-8");
  await writeFile(metaPath, JSON.stringify(saved, null, 2) + "\n", "utf-8");
  await writeFile(readmePath, renderReadme(trace, saved), "utf-8");
  await updateIndex(root);
  return saved;
}

export async function saveAllSessionsToLibrary(options: SaveAllOptions = {}): Promise<SaveAllResult> {
  const root = resolve(options.dir ?? defaultLibraryDir());
  const rows = await discoverSessions(options.filter);
  const selected = typeof options.limit === "number" ? rows.slice(0, options.limit) : rows;
  const saved: SavedSession[] = [];
  const skipped: SavedSession[] = [];
  const failed: Array<{ session: DiscoveredSession; error: string }> = [];
  const existing = await listLibrarySessions(root);
  const bySourceKey = new Map(existing.sessions.map((s) => [sourceKey(s.sourceAgent, s.sourceId, s.sourcePath), s]));

  for (const row of selected) {
    try {
      const prior = bySourceKey.get(sourceKey(row.agent, row.id, row.path));
      const rowMtime = row.mtime.toISOString();
      if (!options.force && prior?.sourceMtime === rowMtime && prior.sourceBytes === row.bytes) {
        skipped.push(prior);
        continue;
      }
      saved.push(await saveSessionToLibrary(row.path, {
        dir: root,
        from: row.agent,
        name: prior?.name ?? defaultDiscoveredSessionName(row),
        sourceMtime: rowMtime,
        sourceBytes: row.bytes,
      }));
    } catch (err) {
      failed.push({ session: row, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await updateIndex(root);
  return { dir: root, total: selected.length, saved, skipped, failed };
}

function sourceKey(agent: AgentKind, id: string, path?: string): string {
  return `${agent}:${id}:${path ?? ""}`;
}

export async function listLibrarySessions(dir = defaultLibraryDir()): Promise<LibraryIndex> {
  const root = resolve(dir);
  const sessionsRoot = join(root, "sessions");
  const sessions: SavedSession[] = [];
  if (!existsSync(sessionsRoot)) return { dir: root, sessions };

  for (const metaPath of await findFiles(sessionsRoot, "meta.json")) {
    try {
      const parsed = JSON.parse(await readFile(metaPath, "utf-8")) as SavedSession;
      sessions.push(parsed);
    } catch {
      // Ignore malformed metadata; the toast.json may still be usable directly.
    }
  }

  sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return { dir: root, sessions };
}

export async function updateIndex(dir = defaultLibraryDir()): Promise<LibraryIndex> {
  const index = await listLibrarySessions(dir);
  await mkdir(index.dir, { recursive: true });
  await writeFile(join(index.dir, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf-8");
  return index;
}

function defaultSessionName(trace: Toast): string {
  const date = (trace.createdAt ?? new Date().toISOString()).slice(0, 10);
  const cwd = trace.cwd ? basename(trace.cwd) : "session";
  return `${date}-${trace.source.agent}-${cwd}-${trace.id}`;
}

function defaultDiscoveredSessionName(row: DiscoveredSession): string {
  const date = row.mtime.toISOString().slice(0, 10);
  const cwd = row.cwd ? basename(row.cwd) : "session";
  return `${date}-${row.agent}-${cwd}-${row.id}`;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "session";
}

function renderReadme(trace: Toast, saved: SavedSession): string {
  const preview = renderTranscriptPreview(trace, 12);
  return `# ${saved.name}

Saved TOAST session artifact.

## Summary

- Source agent: ${saved.sourceAgent}
- Source id: ${saved.sourceId}
- Source path: ${saved.sourcePath ?? ""}
- CWD: ${saved.cwd ?? ""}
- Turns: ${saved.turns}
- Events: ${saved.events}
- Losses recorded: ${saved.losses}
- Saved at: ${saved.savedAt}

## Files

- \`toast.json\` — canonical TOAST artifact
- \`meta.json\` — save metadata
- \`README.md\` — this summary

## Resume

\`\`\`bash
toaster resume ./toast.json --in claude
toaster resume ./toast.json --in pi
toaster resume ./toast.json --in codex
toaster resume ./toast.json --in opencode
\`\`\`

## Preview

${preview}
`;
}

function renderTranscriptPreview(trace: Toast, maxTurns: number): string {
  const lines: string[] = [];
  for (const turn of trace.turns.slice(0, maxTurns)) {
    const text = turn.content.map(renderBlock).filter(Boolean).join("\n").trim();
    lines.push(`### ${turn.role}${turn.timestamp ? ` — ${turn.timestamp}` : ""}`);
    lines.push("");
    lines.push(text ? truncate(text, 2000) : "_(no renderable text)_");
    lines.push("");
  }
  if (trace.turns.length > maxTurns) {
    lines.push(`_Preview truncated: ${trace.turns.length - maxTurns} more turns in toast.json._`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderBlock(block: ToastContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "thinking": return `[thinking]\n${block.text}`;
    case "note": return `[note:${block.kind}]\n${block.text}`;
    case "tool_call": return `[tool_call:${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
    case "tool_result": return `[tool_result:${block.toolName ?? block.toolCallId}]\n${block.content.map(renderBlock).join("\n")}`;
    case "unknown": return `[unknown:${block.originalType ?? "unknown"}]`;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n… truncated ${text.length - max} chars`;
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === fileName) {
        out.push(full);
      }
    }
  }
  try {
    await stat(root);
    await walk(root);
  } catch {
    // Missing library is an empty library.
  }
  return out;
}
