import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { listLibrarySessions, readToastArtifact, type SavedSession } from "./library.js";
import { redactToast, sanitizeRedactionReport, type RedactionOptions } from "./redaction.js";

export interface CloudSafeMirrorOptions extends RedactionOptions {
  libraryDir?: string;
  outDir?: string;
  limit?: number;
}

export interface CloudSafeMirrorResult {
  sourceDir: string;
  outDir: string;
  total: number;
  mirrored: number;
  failed: Array<{ session: SavedSession; error: string }>;
}

export async function createCloudSafeMirror(options: CloudSafeMirrorOptions = {}): Promise<CloudSafeMirrorResult> {
  const config = options.config ?? await loadConfig();
  const sourceDir = resolve(options.libraryDir ?? config.libraryDir ?? "~/toast-library");
  const outDir = resolve(options.outDir ?? config.cloudSafeDir ?? "~/toast-library-cloud");
  const library = await listLibrarySessions(sourceDir);
  const selected = typeof options.limit === "number" ? library.sessions.slice(0, options.limit) : library.sessions;
  const failed: Array<{ session: SavedSession; error: string }> = [];
  let mirrored = 0;

  for (const session of selected) {
    try {
      const toast = await readToastArtifact(session.toastPath);
      const redacted = await redactToast(toast, { ...options, config });
      const sessionDir = join(outDir, "sessions", session.sourceAgent, session.name);
      await mkdir(sessionDir, { recursive: true });
      const safeMeta = {
        ...session,
        dir: sessionDir,
        toastPath: join(sessionDir, "toast.json"),
        metaPath: join(sessionDir, "meta.json"),
        readmePath: join(sessionDir, "README.md"),
        sourcePath: undefined,
        cloudSafe: true,
        redaction: {
          provider: redacted.report.provider,
          alias: redacted.report.alias,
          spanCount: redacted.report.spanCount,
          byLabel: redacted.report.byLabel,
        },
      };
      await writeFile(join(sessionDir, "toast.json"), JSON.stringify(redacted.toast, null, 2) + "\n", "utf-8");
      await writeFile(join(sessionDir, "meta.json"), JSON.stringify(safeMeta, null, 2) + "\n", "utf-8");
      await writeFile(join(sessionDir, "redaction-report.json"), JSON.stringify(sanitizeRedactionReport(redacted.report), null, 2) + "\n", "utf-8");
      await writeFile(join(sessionDir, "README.md"), renderCloudSafeReadme(session.name, redacted.report.spanCount), "utf-8");
      mirrored += 1;
    } catch (err) {
      failed.push({ session, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const index = { dir: outDir, sourceDir, sessions: selected.length, mirrored, failed: failed.length };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf-8");
  return { sourceDir, outDir, total: selected.length, mirrored, failed };
}

function renderCloudSafeReadme(name: string, spanCount: number): string {
  return `# ${name}\n\nCloud-safe TOAST mirror artifact.\n\nThis session was redacted/aliased for safer storage outside the local raw TOAST library.\n\nRedacted spans: ${spanCount}\n\nRaw source material and alias mappings are not included in this mirror.\n`;
}
