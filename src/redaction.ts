import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Toast } from "./schemas/toast.js";
import type { RedactionProvider, ToasterConfig } from "./config.js";

export type RedactionLabel =
  | "account_number"
  | "private_address"
  | "private_date"
  | "private_email"
  | "private_person"
  | "private_phone"
  | "private_url"
  | "secret"
  | "private_path";

export interface RedactionSpan {
  label: RedactionLabel;
  start: number;
  end: number;
  text: string;
  replacement: string;
  detector: string;
}

export interface RedactionFieldReport {
  path: string;
  spans: RedactionSpan[];
}

export interface RedactionReport {
  provider: RedactionProvider;
  alias: boolean;
  createdAt: string;
  spanCount: number;
  byLabel: Partial<Record<RedactionLabel, number>>;
  fields: RedactionFieldReport[];
  warnings: string[];
}

export interface RedactionOptions {
  provider?: RedactionProvider;
  alias?: boolean;
  device?: "cpu" | "cuda";
  checkpoint?: string;
  dryRun?: boolean;
  config?: ToasterConfig;
}

export interface RedactionResult {
  toast: Toast;
  report: RedactionReport;
}

export function sanitizeRedactionReport(report: RedactionReport): RedactionReport {
  return {
    ...report,
    fields: report.fields.map((field) => ({
      ...field,
      spans: field.spans.map((span) => ({ ...span, text: "" })),
    })),
  };
}

interface OpfJsonSpan {
  label: string;
  start: number;
  end: number;
  text?: string;
  placeholder?: string;
}

export async function redactToast(trace: Toast, options: RedactionOptions = {}): Promise<RedactionResult> {
  const provider = options.provider ?? options.config?.redaction?.provider ?? "local";
  const alias = options.alias ?? options.config?.redaction?.alias ?? false;
  const working = JSON.parse(JSON.stringify(trace)) as Toast;
  const fields: RedactionFieldReport[] = [];
  const warnings: string[] = [];

  await redactStringLeaves(working as unknown, "$", async (text, path) => {
    const spans = provider === "opf"
      ? await detectOpf(text, options).catch((err) => {
        warnings.push(`OPF failed at ${path}: ${err instanceof Error ? err.message : String(err)}; fell back to local redaction`);
        return detectLocal(text);
      })
      : detectLocal(text);
    return applyDetectedSpans(text, path, spans, alias, !options.dryRun, fields);
  });

  const byLabel: Partial<Record<RedactionLabel, number>> = {};
  for (const field of fields) {
    for (const span of field.spans) byLabel[span.label] = (byLabel[span.label] ?? 0) + 1;
  }

  working.metadata = {
    ...working.metadata,
    redaction: {
      provider,
      alias,
      createdAt: new Date().toISOString(),
      spanCount: fields.reduce((n, f) => n + f.spans.length, 0),
      byLabel,
    },
  };

  return {
    toast: options.dryRun ? trace : working,
    report: {
      provider,
      alias,
      createdAt: new Date().toISOString(),
      spanCount: fields.reduce((n, f) => n + f.spans.length, 0),
      byLabel,
      fields,
      warnings,
    },
  };
}

export function detectLocal(text: string): RedactionSpan[] {
  const specs: Array<{ label: RedactionLabel; detector: string; regex: RegExp }> = [
    { label: "secret", detector: "regex:openai-key", regex: /\bsk-[A-Za-z0-9_-]{10,}\b/g },
    { label: "secret", detector: "regex:huggingface-token", regex: /\bhf_[A-Za-z0-9]{20,}\b/g },
    { label: "secret", detector: "regex:github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
    { label: "secret", detector: "regex:aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { label: "secret", detector: "regex:private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { label: "private_email", detector: "regex:email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { label: "private_phone", detector: "regex:phone", regex: /(?<!\w)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\w)/g },
    { label: "private_url", detector: "regex:url", regex: /https?:\/\/[^\s)"']+/g },
    { label: "account_number", detector: "regex:account-number", regex: /\b(?:\d[ -]*?){13,19}\b/g },
    { label: "private_path", detector: "regex:absolute-path", regex: /\/(?:Users|home)\/[^\s:'")]+/g },
  ];

  const spans: RedactionSpan[] = [];
  for (const spec of specs) {
    for (const match of text.matchAll(spec.regex)) {
      if (match.index === undefined) continue;
      spans.push({
        label: spec.label,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        replacement: defaultReplacement(spec.label),
        detector: spec.detector,
      });
    }
  }
  return normalizeSpans(spans);
}

async function detectOpf(text: string, options: RedactionOptions): Promise<RedactionSpan[]> {
  if (!text.trim()) return [];
  const args = ["--format", "json", "--no-print-color-coded-text", "--device", options.device ?? options.config?.redaction?.device ?? "cpu"];
  const checkpoint = options.checkpoint ?? options.config?.redaction?.checkpoint;
  if (checkpoint) args.push("--checkpoint", checkpoint);
  args.push(text);

  const { stdout, stderr, code } = await runProcess("opf", args);
  if (code !== 0) throw new Error(stderr.trim() || `opf exited ${code}`);
  const parsed = JSON.parse(stdout) as { detected_spans?: OpfJsonSpan[] };
  return normalizeSpans((parsed.detected_spans ?? []).flatMap((span) => toRedactionSpan(span, text, "opf")));
}

function toRedactionSpan(span: { label: string; start: number; end: number; text?: string }, sourceText: string, detector: string): RedactionSpan[] {
  const label = normalizeOpfLabel(span.label);
  if (!label) return [];
  return [{
    label,
    start: span.start,
    end: span.end,
    text: span.text ?? sourceText.slice(span.start, span.end),
    replacement: defaultReplacement(label),
    detector,
  }];
}

function normalizeOpfLabel(label: string): RedactionLabel | undefined {
  const map: Record<string, RedactionLabel> = {
    account_number: "account_number",
    private_address: "private_address",
    private_date: "private_date",
    private_email: "private_email",
    private_person: "private_person",
    private_phone: "private_phone",
    private_url: "private_url",
    secret: "secret",
    personal_name: "private_person",
    personal_email: "private_email",
    personal_phone: "private_phone",
    personal_location: "private_address",
    personal_url: "private_url",
    personal_date: "private_date",
    personal_fin_id: "account_number",
    personal_gov_id: "account_number",
    secret_url: "secret",
  };
  return map[label];
}

function defaultReplacement(label: RedactionLabel): string {
  return `[${label.toUpperCase()}]`;
}

function applySpans(text: string, spans: RedactionSpan[]): string {
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += span.replacement;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

function normalizeSpans(spans: RedactionSpan[]): RedactionSpan[] {
  return spans
    .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
    .reduce<RedactionSpan[]>((acc, span) => {
      const last = acc[acc.length - 1];
      if (last && span.start < last.end) return acc;
      acc.push(span);
      return acc;
    }, []);
}

async function applyDetectedSpans(
  text: string,
  path: string,
  spans: RedactionSpan[],
  alias: boolean,
  rememberAliases: boolean,
  fields: RedactionFieldReport[],
): Promise<string> {
  if (spans.length === 0) return text;
  const spansWithReplacements: RedactionSpan[] = [];
  for (const span of spans) {
    spansWithReplacements.push({
      ...span,
      replacement: alias ? await aliasReplacement(span.label, span.text, rememberAliases) : defaultReplacement(span.label),
    });
  }
  fields.push({ path, spans: spansWithReplacements });
  return applySpans(text, spansWithReplacements);
}

async function redactStringLeaves(value: unknown, path: string, redact: (text: string, path: string) => Promise<string>): Promise<void> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === "string") value[i] = await redact(value[i], `${path}[${i}]`);
      else await redactStringLeaves(value[i], `${path}[${i}]`, redact);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    const childPath = `${path}.${key}`;
    if (typeof child === "string") obj[key] = await redact(child, childPath);
    else await redactStringLeaves(child, childPath, redact);
  }
}

async function aliasReplacement(label: RedactionLabel, original: string, remember: boolean): Promise<string> {
  // Dry runs must not create or read the local alias vault. Use a process-local
  // placeholder key; the output is preview-only and should not be treated as a
  // stable cloud-safe alias mapping.
  const key = remember ? await aliasKey() : Buffer.from("toaster-dry-run-alias-preview");
  const digest = createHmac("sha256", key).update(label).update("\0").update(original).digest("hex").slice(0, 12);
  const replacement = `[${label.toUpperCase()}_${digest}]`;
  if (remember) await rememberAlias(replacement, label, original);
  return replacement;
}

async function aliasKey(): Promise<Buffer> {
  const path = join(homedir(), ".config", "toaster", "alias.key");
  if (existsSync(path)) return Buffer.from((await readFile(path, "utf-8")).trim(), "hex");
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  await writeFile(path, key.toString("hex") + "\n", "utf-8");
  await chmod(path, 0o600).catch(() => undefined);
  return key;
}

async function rememberAlias(alias: string, label: RedactionLabel, original: string): Promise<void> {
  const path = join(homedir(), ".config", "toaster", "aliases.json");
  let aliases: Record<string, { label: RedactionLabel; value: string }> = {};
  if (existsSync(path)) aliases = JSON.parse(await readFile(path, "utf-8")) as Record<string, { label: RedactionLabel; value: string }>;
  aliases[alias] = { label, value: original };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(aliases, null, 2) + "\n", "utf-8");
  await chmod(path, 0o600).catch(() => undefined);
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}
