import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProvider, AgentRunMode } from "@agent-bridge/memory";

// Default-agent presets are user-level, not repository-level: an edit made in
// one repo's dashboard must show up in every other repo. The repository store
// still holds a materialized agent row per selected preset (runs reference an
// agent id), but this file is the source of truth for what the roster is.

export type GlobalDefaultAgentRecord = {
  label?: string;
  name?: string;
  description?: string;
  provider?: AgentProvider;
  mode?: AgentRunMode;
  command?: string;
  model?: string;
  reasoningEffort?: string;
  capabilities?: string[];
  selected?: boolean;
  hidden?: boolean;
  custom?: boolean;
};

export type GlobalDefaultAgentsFile = {
  version: 1;
  presets: Record<string, GlobalDefaultAgentRecord>;
};

export function globalDefaultAgentsPath(): string {
  const home = process.env.AGENT_BRIDGE_HOME?.trim() || homedir();
  return join(home, ".agent-bridge", "default-agents.json");
}

export function readGlobalDefaultAgents(): GlobalDefaultAgentsFile {
  const file = globalDefaultAgentsPath();
  if (!existsSync(file)) return { version: 1, presets: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GlobalDefaultAgentsFile>;
    const presets = parsed?.presets;
    if (!presets || typeof presets !== "object") return { version: 1, presets: {} };
    return { version: 1, presets: presets as Record<string, GlobalDefaultAgentRecord> };
  } catch {
    // A corrupt or hand-edited file must not break the dashboard; fall back to
    // the compiled-in roster rather than throwing on every load.
    return { version: 1, presets: {} };
  }
}

export function writeGlobalDefaultAgents(data: GlobalDefaultAgentsFile): void {
  const file = globalDefaultAgentsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, presets: data.presets }, null, 2)}\n`, "utf8");
}

export function updateGlobalDefaultAgent(
  presetKey: string,
  patch: GlobalDefaultAgentRecord,
): GlobalDefaultAgentRecord {
  const data = readGlobalDefaultAgents();
  const next: GlobalDefaultAgentRecord = { ...data.presets[presetKey] };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  data.presets[presetKey] = next;
  writeGlobalDefaultAgents(data);
  return next;
}

export function deleteGlobalDefaultAgent(presetKey: string): boolean {
  const data = readGlobalDefaultAgents();
  if (!(presetKey in data.presets)) return false;
  delete data.presets[presetKey];
  writeGlobalDefaultAgents(data);
  return true;
}

export function unhideGlobalDefaultAgents(keys: string[]): void {
  const data = readGlobalDefaultAgents();
  for (const key of keys) {
    const record = data.presets[key];
    if (!record?.hidden) continue;
    data.presets[key] = { ...record, hidden: false, selected: false };
  }
  writeGlobalDefaultAgents(data);
}
