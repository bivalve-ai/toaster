// The N + N orchestrator: any source adapter → Toast → any target adapter.

import type { AgentKind } from "./schemas/toast.js";
import type { WriteOptions, WriteResult } from "./adapters/types.js";
import { getAdapter, detectAgent } from "./adapters/index.js";

export interface TranslateOptions extends WriteOptions {
  from?: AgentKind;
}

export async function translate(
  to: AgentKind,
  path: string,
  options: TranslateOptions = {},
): Promise<WriteResult> {
  const fromKind = options.from ?? (await detectAgent(path));
  if (!fromKind) throw new Error(`could not auto-detect source agent for ${path}; pass {from: "pi" | "claude" | "codex" | "opencode"} only as a fallback`);
  const src = getAdapter(fromKind);
  const dst = getAdapter(to);
  const trace = await src.read(path);
  return dst.write(trace, options);
}
