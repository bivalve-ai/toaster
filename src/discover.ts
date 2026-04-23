// Discover sessions written by agents in their conventional on-disk locations.
// Used by `toaster list` so users don't have to know the exact paths.

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredSession {
  agent: "pi" | "claude";
  path: string;
  id: string;
  mtime: Date;
  bytes: number;
  cwd?: string;
}

async function walkPiSessions(): Promise<DiscoveredSession[]> {
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return [];
  const out: DiscoveredSession[] = [];
  const cwdDirs = await readdir(root, { withFileTypes: true });
  for (const d of cwdDirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(root, d.name);
    // Recover the cwd from the encoded dir name: `--a-b-c--` → `/a/b/c`
    const cwd = d.name.replace(/^--/, "").replace(/--$/, "").replace(/-/g, "/").replace(/^/, "/");
    const files = await readdir(dirPath);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dirPath, f);
      const s = await stat(full);
      // pi filename: `<ts>_<id>.jsonl` — id is everything after the first underscore.
      const base = f.replace(/\.jsonl$/, "");
      const underscore = base.indexOf("_");
      const id = underscore >= 0 ? base.slice(underscore + 1) : base;
      out.push({ agent: "pi", path: full, id, mtime: s.mtime, bytes: s.size, cwd });
    }
  }
  return out;
}

async function walkClaudeSessions(): Promise<DiscoveredSession[]> {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out: DiscoveredSession[] = [];
  const cwdDirs = await readdir(root, { withFileTypes: true });
  for (const d of cwdDirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(root, d.name);
    // Recover the cwd: claude encodes `/a/b/c` as `-a-b-c`
    const cwd = "/" + d.name.replace(/^-/, "").replace(/-/g, "/");
    const files = await readdir(dirPath);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dirPath, f);
      const s = await stat(full);
      const id = f.replace(/\.jsonl$/, "");
      out.push({ agent: "claude", path: full, id, mtime: s.mtime, bytes: s.size, cwd });
    }
  }
  return out;
}

export async function discoverSessions(filter?: "pi" | "claude"): Promise<DiscoveredSession[]> {
  const all: DiscoveredSession[] = [];
  if (filter !== "claude") all.push(...(await walkPiSessions()));
  if (filter !== "pi") all.push(...(await walkClaudeSessions()));
  all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return all;
}
