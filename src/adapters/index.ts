// Adapter registry. Add new agents here and they're wired into `translate()`.
import type { AgentKind } from "../schemas/trace.js";
import type { AgentAdapter } from "./types.js";
import { piAdapter } from "./pi.js";
import { claudeAdapter } from "./claude.js";

export const adapters: Record<AgentKind, AgentAdapter> = {
  pi: piAdapter,
  claude: claudeAdapter,
  // codex: codexAdapter  // next
} as unknown as Record<AgentKind, AgentAdapter>;

export function getAdapter(kind: AgentKind): AgentAdapter {
  const a = adapters[kind];
  if (!a) throw new Error(`no adapter registered for agent "${kind}"`);
  return a;
}

export async function detectAgent(path: string): Promise<AgentKind | null> {
  for (const [kind, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    try {
      if (await adapter.detect(path)) return kind as AgentKind;
    } catch { /* try next */ }
  }
  return null;
}

export { piAdapter, claudeAdapter };
