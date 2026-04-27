import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RedactionProvider = "local" | "opf";

export interface ToasterConfig {
  libraryDir?: string;
  cloudSafeDir?: string;
  redaction?: {
    provider?: RedactionProvider;
    device?: "cpu" | "cuda";
    checkpoint?: string;
    alias?: boolean;
  };
}

export function configPath(): string {
  return join(homedir(), ".config", "toaster", "config.json");
}

export function defaultConfig(): ToasterConfig {
  return {
    libraryDir: join(homedir(), "toast-library"),
    cloudSafeDir: join(homedir(), "toast-library-cloud"),
    redaction: {
      provider: "local",
      device: "cpu",
      alias: false,
    },
  };
}

export async function loadConfig(): Promise<ToasterConfig> {
  const defaults = defaultConfig();
  const path = configPath();
  if (!existsSync(path)) return defaults;
  const parsed = JSON.parse(await readFile(path, "utf-8")) as ToasterConfig;
  return mergeConfig(defaults, parsed);
}

export async function saveConfig(config: ToasterConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await chmod(path, 0o600).catch(() => undefined);
}

export async function setConfigValue(key: string, value: unknown): Promise<ToasterConfig> {
  const config = await loadConfig();
  setPath(config as Record<string, unknown>, key, value);
  await saveConfig(config);
  return config;
}

export function getConfigValue(config: ToasterConfig, key?: string): unknown {
  if (!key) return config;
  return key.split(".").reduce<unknown>((cur, part) => {
    if (cur && typeof cur === "object" && part in cur) return (cur as Record<string, unknown>)[part];
    return undefined;
  }, config);
}

export function parseConfigValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("config key must not be empty");
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cur[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function mergeConfig(base: ToasterConfig, override: ToasterConfig): ToasterConfig {
  return {
    ...base,
    ...override,
    redaction: {
      ...base.redaction,
      ...override.redaction,
    },
  };
}
