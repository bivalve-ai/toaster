import { mkdtemp, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { AgentKind, Toast } from "./schemas/toast.js";
import type { ValidationResult, WriteOptions } from "./adapters/types.js";
import { adapters, detectAgent, getAdapter } from "./adapters/index.js";

export interface CorpusOptions {
  targets?: AgentKind[];
  writeOptions?: Pick<WriteOptions, "thinkingPolicy" | "strict" | "defaultModel" | "agentVersion">;
}

export interface CorpusTraceSummary {
  turns: number;
  events: number;
  hasSessionModel: boolean;
  hasTurnModel: boolean;
  hasProvider: boolean;
  hasUsage: boolean;
  hasCost: boolean;
}

export interface CorpusTargetReport {
  target: AgentKind;
  validate: ValidationResult;
  writeOk: boolean;
  rereadOk: boolean;
  losses: number;
  outputPath?: string;
  error?: string;
}

export interface CorpusCaseReport {
  path: string;
  detectedAgent: AgentKind | null;
  readOk: boolean;
  summary?: CorpusTraceSummary;
  targets: CorpusTargetReport[];
  error?: string;
}

export interface CorpusSummary {
  files: number;
  detected: number;
  readOk: number;
  writeOk: number;
  rereadOk: number;
  bySource: Partial<Record<AgentKind, number>>;
  byTarget: Partial<Record<AgentKind, {
    validateErrors: number;
    validateWarnings: number;
    writeOk: number;
    writeFailed: number;
    rereadOk: number;
    losses: number;
  }>>;
}

export interface CorpusReport {
  root: string;
  cases: CorpusCaseReport[];
  summary: CorpusSummary;
}

function summarizeToast(toast: Toast): CorpusTraceSummary {
  return {
    turns: toast.turns.length,
    events: toast.events.length,
    hasSessionModel: toast.agents.some((agent) => typeof agent.model === "string" && agent.model.length > 0),
    hasTurnModel: toast.turns.some((turn) => typeof turn.model === "string" && turn.model.length > 0),
    hasProvider: toast.agents.some((agent) => typeof agent.provider === "string" && agent.provider.length > 0)
      || toast.turns.some((turn) => typeof turn.provider === "string" && turn.provider.length > 0),
    hasUsage: toast.turns.some((turn) => turn.usage !== undefined),
    hasCost: toast.turns.some((turn) => typeof turn.usage?.costUsd === "number"),
  };
}

async function walkTraceFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && (full.endsWith(".jsonl") || full.endsWith(".json"))) {
        out.push(full);
      }
    }
  }

  await walk(root);
  return out.sort();
}

function emptyTargetSummary() {
  return {
    validateErrors: 0,
    validateWarnings: 0,
    writeOk: 0,
    writeFailed: 0,
    rereadOk: 0,
    losses: 0,
  };
}

export async function runCorpus(root: string, options: CorpusOptions = {}): Promise<CorpusReport> {
  const absRoot = resolve(root);
  const files = await walkTraceFiles(absRoot);
  const tempRoot = await mkdtemp(join(tmpdir(), "toaster-corpus-"));
  const targets = options.targets && options.targets.length > 0
    ? options.targets
    : (Object.keys(adapters) as AgentKind[]);

  const cases: CorpusCaseReport[] = [];
  const summary: CorpusSummary = {
    files: files.length,
    detected: 0,
    readOk: 0,
    writeOk: 0,
    rereadOk: 0,
    bySource: {},
    byTarget: {},
  };

  for (const path of files) {
    const detectedAgent = await detectAgent(path);
    const row: CorpusCaseReport = {
      path,
      detectedAgent,
      readOk: false,
      targets: [],
    };

    if (detectedAgent) {
      summary.detected += 1;
      summary.bySource[detectedAgent] = (summary.bySource[detectedAgent] ?? 0) + 1;
    } else {
      row.error = "could not detect source agent";
      cases.push(row);
      continue;
    }

    try {
      const sourceAdapter = getAdapter(detectedAgent);
      const toast = await sourceAdapter.read(path);
      row.readOk = true;
      row.summary = summarizeToast(toast);
      summary.readOk += 1;

      for (const target of targets) {
        const bucket = summary.byTarget[target] ?? emptyTargetSummary();
        summary.byTarget[target] = bucket;

        const targetAdapter = getAdapter(target);
        const validate = targetAdapter.validateWrite
          ? targetAdapter.validateWrite(toast, options.writeOptions)
          : { ok: true, errors: [], warnings: [] };
        bucket.validateErrors += validate.errors.length;
        bucket.validateWarnings += validate.warnings.length;

        const outputPath = join(tempRoot, `${basename(path, ".jsonl")}.${target}.${randomUUID()}.jsonl`);
        const targetRow: CorpusTargetReport = {
          target,
          validate,
          writeOk: false,
          rereadOk: false,
          losses: 0,
          outputPath,
        };

        try {
          const writeResult = await targetAdapter.write(toast, {
            ...options.writeOptions,
            targetPath: outputPath,
            sessionId: `corpus-${randomUUID()}`,
          });
          targetRow.writeOk = true;
          targetRow.losses = writeResult.losses.length;
          bucket.writeOk += 1;
          bucket.losses += writeResult.losses.length;
          summary.writeOk += 1;

          try {
            await targetAdapter.read(outputPath);
            targetRow.rereadOk = true;
            bucket.rereadOk += 1;
            summary.rereadOk += 1;
          } catch (error) {
            targetRow.error = error instanceof Error ? error.message : String(error);
          }
        } catch (error) {
          targetRow.error = error instanceof Error ? error.message : String(error);
          bucket.writeFailed += 1;
        }

        row.targets.push(targetRow);
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }

    cases.push(row);
  }

  return {
    root: absRoot,
    cases,
    summary,
  };
}
