import type { AgentProvider, AgentRunMode, MemoryStore, RegisteredAgent } from "@agent-bridge/memory";
import {
  deleteGlobalDefaultAgent,
  readGlobalDefaultAgents,
  unhideGlobalDefaultAgents,
  updateGlobalDefaultAgent,
  type GlobalDefaultAgentRecord,
} from "./global-default-agents.js";

export type DefaultAgentPreset = {
  key: string;
  label: string;
  name: string;
  description: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  command: string;
  model: string;
  reasoningEffort?: string;
  capabilities: string[];
};

export type DefaultAgentPresetState = DefaultAgentPreset & {
  selected: boolean;
  custom: boolean;
  agentId?: string;
};

export type CustomDefaultAgentPresetInput = {
  label: string;
  description?: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  command?: string;
  model?: string;
  reasoningEffort?: string;
  capabilities?: string[];
};

export const CUSTOM_PRESET_PREFIX = "custom:";

export const DEFAULT_AGENT_PRESETS: DefaultAgentPreset[] = [
  {
    key: "claude-opus-5",
    label: "Claude Opus 5",
    name: "Claude Opus 5",
    description: "Deep architecture, ambiguous system design, cross-cutting risk analysis, rigorous code review, and final adjudication. Best for high-stakes work where depth matters more than speed.",
    provider: "claude",
    mode: "cli",
    command: "claude",
    model: "claude-opus-5",
    reasoningEffort: "high",
    capabilities: ["implement", "review", "adjudicate", "report"],
  },
  {
    key: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    name: "Claude Sonnet 5",
    description: "Balanced feature implementation, refactoring, debugging, tests, and documentation. Best for broad day-to-day engineering with strong speed and quality.",
    provider: "claude",
    mode: "cli",
    command: "claude",
    model: "claude-sonnet-5",
    reasoningEffort: "medium",
    capabilities: ["implement", "review", "report"],
  },
  {
    key: "codex-gpt-5.6-sol",
    label: "Codex GPT-5.6 Sol",
    name: "Codex GPT-5.6 Sol",
    description: "Frontier repository-scale coding, difficult multi-file implementation, architecture changes, deep debugging, and rigorous review. Best for the hardest coding tasks.",
    provider: "codex",
    mode: "cli",
    command: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    capabilities: ["implement", "review", "adjudicate", "report"],
  },
  {
    key: "codex-gpt-5.6-terra",
    label: "Codex GPT-5.6 Terra",
    name: "Codex GPT-5.6 Terra",
    description: "Balanced everyday coding, refactors, tests, iterative fixes, and practical review. Best when dependable throughput and a speed-quality balance matter.",
    provider: "codex",
    mode: "cli",
    command: "codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    capabilities: ["implement", "review", "report"],
  },
  {
    key: "codex-gpt-5.6-luna",
    label: "Codex GPT-5.6 Luna",
    name: "Codex GPT-5.6 Luna",
    description: "Fast scoped edits, test additions, mechanical refactors, triage, and parallel subtasks. Best when low latency and high throughput matter.",
    provider: "codex",
    mode: "cli",
    command: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    capabilities: ["implement", "review", "report"],
  },
  {
    key: "antigravity-gemini-3.7-flash",
    label: "Antigravity Gemini 3.7 Flash",
    name: "Antigravity Gemini 3.7 Flash",
    description: "Fast exploration, UI and multimodal investigation, concise implementation, and broad parallel work. Best for responsive visual or browser-oriented tasks.",
    provider: "antigravity",
    mode: "cli",
    command: "agy",
    model: "gemini-3.7-flash-high",
    reasoningEffort: "high",
    capabilities: ["implement", "review", "report"],
  },
  {
    key: "antigravity-gemini-3.1-pro",
    label: "Antigravity Gemini 3.1 Pro",
    name: "Antigravity Gemini 3.1 Pro",
    description: "Deep long-context analysis, architecture, complex review, and multimodal or UI investigation. Best for difficult reasoning-heavy Antigravity tasks.",
    provider: "antigravity",
    mode: "cli",
    command: "agy",
    model: "gemini-3.1-pro-high",
    reasoningEffort: "high",
    capabilities: ["implement", "review", "adjudicate", "report"],
  },
];

// The effective roster: the compiled-in built-ins as edited by the user in
// ~/.agent-bridge/default-agents.json, plus any custom agents they added there.
// The file is global on purpose - editing a default agent in one repository
// must change it in every other repository too.
type EffectivePreset = DefaultAgentPreset & {
  selected: boolean;
  hidden: boolean;
  custom: boolean;
};

function applyRecord(
  preset: DefaultAgentPreset,
  record: GlobalDefaultAgentRecord | undefined,
): EffectivePreset {
  return {
    ...preset,
    label: record?.label ?? preset.label,
    name: record?.name ?? preset.name,
    description: record?.description ?? preset.description,
    provider: record?.provider ?? preset.provider,
    mode: record?.mode ?? preset.mode,
    command: record?.command ?? preset.command,
    model: record?.model ?? preset.model,
    reasoningEffort: record?.reasoningEffort ?? preset.reasoningEffort,
    capabilities: record?.capabilities ?? preset.capabilities,
    selected: record?.selected ?? true,
    hidden: record?.hidden ?? false,
    custom: false,
  };
}

function customPreset(key: string, record: GlobalDefaultAgentRecord): EffectivePreset {
  const label = record.label ?? record.name ?? key.slice(CUSTOM_PRESET_PREFIX.length);
  return {
    key,
    label,
    name: record.name ?? label,
    description: record.description ?? "",
    provider: record.provider ?? "codex",
    mode: record.mode ?? "cli",
    command: record.command ?? "",
    model: record.model ?? "",
    reasoningEffort: record.reasoningEffort,
    capabilities: record.capabilities ?? [],
    selected: record.selected ?? true,
    hidden: record.hidden ?? false,
    custom: true,
  };
}

export function listEffectiveDefaultAgentPresets(): EffectivePreset[] {
  const { presets } = readGlobalDefaultAgents();
  const builtIn = DEFAULT_AGENT_PRESETS.map((preset) => applyRecord(preset, presets[preset.key]));
  const custom = Object.entries(presets)
    .filter(([key]) => key.startsWith(CUSTOM_PRESET_PREFIX))
    .map(([key, record]) => customPreset(key, record));
  return [...builtIn, ...custom];
}

function listPresetAgents(store: MemoryStore): RegisteredAgent[] {
  return store.listRegisteredAgents({
    includeUnselectedPresets: true,
    includeHiddenPresets: true,
    limit: 500,
  });
}

function toState(preset: EffectivePreset, agent: RegisteredAgent | undefined): DefaultAgentPresetState {
  const { hidden: _hidden, ...rest } = preset;
  return { ...rest, agentId: agent?.id };
}

// The table is the effective global roster minus the presets the user deleted.
// The repository store only contributes the agent id of each materialized row.
export function listDefaultAgentPresetStates(store: MemoryStore): DefaultAgentPresetState[] {
  const agents = listPresetAgents(store);
  return listEffectiveDefaultAgentPresets()
    .filter((preset) => !preset.hidden)
    .map((preset) => toState(preset, agents.find((agent) => agent.presetKey === preset.key)));
}

// Materializes one effective preset as a repository agent row so runs have an
// agent id to reference, and keeps an existing row in step with the global
// definition.
function syncPresetAgent(
  store: MemoryStore,
  preset: EffectivePreset,
  agents: RegisteredAgent[],
): RegisteredAgent | undefined {
  const existing = agents.find((candidate) => candidate.presetKey === preset.key);
  const fields = {
    description: preset.description,
    provider: preset.provider,
    mode: preset.mode,
    command: preset.command,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort ?? "",
    capabilities: preset.capabilities,
    presetSelected: preset.selected,
    presetHidden: preset.hidden,
  };
  if (existing) return store.updateRegisteredAgent(existing.id, { ...fields, name: preset.name });
  if (!preset.selected) return undefined;
  return store.createRegisteredAgent({
    ...fields,
    name: uniqueName(agents, preset.name),
    presetKey: preset.key,
  });
}

export function addCustomDefaultAgentPreset(
  store: MemoryStore,
  input: CustomDefaultAgentPresetInput,
): RegisteredAgent {
  const label = input.label.trim();
  if (!label) throw new Error("Agent label is required.");
  const presetKey = uniquePresetKey(listEffectiveDefaultAgentPresets(), label);
  updateGlobalDefaultAgent(presetKey, {
    label,
    name: label,
    description: input.description ?? "",
    provider: input.provider,
    mode: input.mode,
    command: input.command ?? "",
    model: input.model ?? "",
    reasoningEffort: input.reasoningEffort,
    capabilities: input.capabilities ?? [],
    selected: true,
    hidden: false,
    custom: true,
  });
  const preset = listEffectiveDefaultAgentPresets().find((candidate) => candidate.key === presetKey);
  const agent = preset ? syncPresetAgent(store, preset, listPresetAgents(store)) : undefined;
  if (!agent) throw new Error(`Failed to create default agent preset: ${presetKey}`);
  return agent;
}

// Deleting a custom preset removes it from the global file outright; a built-in
// one is only marked hidden there, because ensureDefaultAgentPresetStates would
// otherwise re-seed it on the next dashboard load.
export function removeDefaultAgentPreset(store: MemoryStore, presetKey: string): boolean {
  const existing = listPresetAgents(store).find((candidate) => candidate.presetKey === presetKey);
  if (presetKey.startsWith(CUSTOM_PRESET_PREFIX)) {
    const removed = deleteGlobalDefaultAgent(presetKey);
    if (existing) store.deleteRegisteredAgent(existing.id);
    return removed || Boolean(existing);
  }
  const preset = DEFAULT_AGENT_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset) throw new Error(`Unknown default agent preset: ${presetKey}`);
  updateGlobalDefaultAgent(presetKey, { hidden: true, selected: false });
  if (existing) store.updateRegisteredAgent(existing.id, { presetSelected: false, presetHidden: true });
  return true;
}

// Brings deleted built-in presets back into the table, unselected, so the user
// can re-add one without losing the edits stored globally.
export function restoreBuiltInDefaultAgentPresets(store: MemoryStore): DefaultAgentPresetState[] {
  unhideGlobalDefaultAgents(DEFAULT_AGENT_PRESETS.map((preset) => preset.key));
  const agents = listPresetAgents(store);
  for (const preset of listEffectiveDefaultAgentPresets()) {
    if (preset.custom) continue;
    if (agents.some((agent) => agent.presetKey === preset.key)) syncPresetAgent(store, preset, agents);
  }
  return listDefaultAgentPresetStates(store);
}

// A new workspace starts with the user's global roster - the complete
// recommended set until they edit it. Selection lives in the global file, so a
// user's earlier uncheck is never overwritten by a dashboard load in any repo.
export function ensureDefaultAgentPresetStates(store: MemoryStore): DefaultAgentPresetState[] {
  const agents = listPresetAgents(store);
  for (const preset of listEffectiveDefaultAgentPresets()) {
    if (preset.hidden && !agents.some((agent) => agent.presetKey === preset.key)) continue;
    syncPresetAgent(store, preset, agents);
  }
  return listDefaultAgentPresetStates(store);
}

export function setDefaultAgentPresetSelection(
  store: MemoryStore,
  presetKey: string,
  selected: boolean,
): RegisteredAgent | undefined {
  const known = listEffectiveDefaultAgentPresets().some((candidate) => candidate.key === presetKey);
  if (!known) throw new Error(`Unknown default agent preset: ${presetKey}`);
  // Selecting a preset also brings it back into the table if it was deleted.
  updateGlobalDefaultAgent(presetKey, selected ? { selected: true, hidden: false } : { selected: false });
  const preset = listEffectiveDefaultAgentPresets().find((candidate) => candidate.key === presetKey);
  if (!preset) return undefined;
  return syncPresetAgent(store, preset, listPresetAgents(store));
}

// An edit to a materialized agent row is an edit to the default agent itself,
// so it has to land in the global file as well or it would stay in this repo.
export function syncDefaultAgentPresetFromAgent(agent: RegisteredAgent): void {
  if (!agent.presetKey) return;
  updateGlobalDefaultAgent(agent.presetKey, {
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    mode: agent.mode,
    command: agent.command,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? "",
    capabilities: agent.capabilities,
  });
}

function uniquePresetKey(presets: EffectivePreset[], label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const keys = new Set(presets.map((preset) => preset.key));
  const base = `${CUSTOM_PRESET_PREFIX}${slug}`;
  if (!keys.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!keys.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function uniqueName(agents: RegisteredAgent[], base: string): string {
  const names = new Set(agents.map((agent) => agent.name));
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}
