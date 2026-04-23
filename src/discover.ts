// Session discovery — thin wrapper over adapter.list() across all registered adapters.
// Each agent's list lives in its adapter; this file just aggregates.

import { adapters } from "./adapters/index.js";
import type { DiscoveredSession } from "./adapters/types.js";

export type { DiscoveredSession } from "./adapters/types.js";

export async function discoverSessions(
  filter?: "pi" | "claude" | "codex",
): Promise<DiscoveredSession[]> {
  const kinds = filter
    ? [filter]
    : (Object.keys(adapters) as Array<"pi" | "claude" | "codex">);
  const all: DiscoveredSession[] = [];
  for (const k of kinds) {
    const adapter = adapters[k];
    if (!adapter) continue;
    try {
      const rows = await adapter.list();
      all.push(...rows);
    } catch {
      // skip adapters that fail to list
    }
  }
  return all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
