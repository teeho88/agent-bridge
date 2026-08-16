import type { AgentProvider, AgentRunMode, MemoryStore, RegisteredAgent } from "@agent-bridge/memory";

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

// Hidden rows are included so a deleted built-in can be filtered out of the
// table below — the row is the only record that the user removed it.
function listPresetAgents(store: MemoryStore): RegisteredAgent[] {
  return store.listRegisteredAgents({
    includeUnselectedPresets: true,
    includeHiddenPresets: true,
    limit: 500,
  });
}

function toState(preset: DefaultAgentPreset, agent: RegisteredAgent, custom: boolean): DefaultAgentPresetState {
  return {
    ...preset,
    name: agent.name,
    description: agent.description ?? preset.description,
    provider: agent.provider,
    mode: agent.mode,
    command: agent.command ?? preset.command,
    model: agent.model ?? preset.model,
    reasoningEffort: agent.reasoningEffort,
    capabilities: agent.capabilities,
    selected: agent.presetSelected ?? true,
    custom,
    agentId: agent.id,
  };
}

// The table is the built-in roster minus rows the user deleted, plus any custom
// rows they added. A custom preset has no compiled-in definition, so its agent
// row is the only source of truth for it.
export function listDefaultAgentPresetStates(store: MemoryStore): DefaultAgentPresetState[] {
  const agents = listPresetAgents(store);
  const builtIn = DEFAULT_AGENT_PRESETS.filter(
    (preset) =>
      !agents.some((agent) => agent.presetKey === preset.key && agent.presetHidden),
  ).map((preset) => {
    const agent = agents.find((candidate) => candidate.presetKey === preset.key);
    return agent ? toState(preset, agent, false) : { ...preset, selected: false, custom: false };
  });
  const custom = agents
    .filter((agent) => agent.presetKey?.startsWith(CUSTOM_PRESET_PREFIX) && !agent.presetHidden)
    .map((agent) =>
      toState(
        {
          key: agent.presetKey as string,
          label: agent.name,
          name: agent.name,
          description: agent.description ?? "",
          provider: agent.provider,
          mode: agent.mode,
          command: agent.command ?? "",
          model: agent.model ?? "",
          reasoningEffort: agent.reasoningEffort,
          capabilities: agent.capabilities,
        },
        agent,
        true,
      ),
    );
  return [...builtIn, ...custom];
}

export function addCustomDefaultAgentPreset(
  store: MemoryStore,
  input: CustomDefaultAgentPresetInput,
): RegisteredAgent {
  const label = input.label.trim();
  if (!label) throw new Error("Agent label is required.");
  const agents = store.listRegisteredAgents({
    includeUnselectedPresets: true,
    includeHiddenPresets: true,
    limit: 500,
  });
  const presetKey = uniquePresetKey(agents, label);
  return store.createRegisteredAgent({
    name: uniqueName(agents, label),
    description: input.description,
    provider: input.provider,
    mode: input.mode,
    command: input.command,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    capabilities: input.capabilities ?? [],
    presetKey,
    presetSelected: true,
  });
}

// Deleting a custom preset removes it outright; a built-in one is only marked
// hidden, because ensureDefaultAgentPresetStates would otherwise re-seed it on
// the next dashboard load.
export function removeDefaultAgentPreset(store: MemoryStore, presetKey: string): boolean {
  const agents = store.listRegisteredAgents({
    includeUnselectedPresets: true,
    includeHiddenPresets: true,
    limit: 500,
  });
  const existing = agents.find((candidate) => candidate.presetKey === presetKey);
  if (presetKey.startsWith(CUSTOM_PRESET_PREFIX)) {
    if (!existing) return false;
    return store.deleteRegisteredAgent(existing.id);
  }
  const preset = DEFAULT_AGENT_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset) throw new Error(`Unknown default agent preset: ${presetKey}`);
  if (existing) {
    store.updateRegisteredAgent(existing.id, { presetSelected: false, presetHidden: true });
    return true;
  }
  store.createRegisteredAgent({
    name: uniqueName(agents, preset.name),
    description: preset.description,
    provider: preset.provider,
    mode: preset.mode,
    command: preset.command,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort,
    capabilities: preset.capabilities,
    presetKey: preset.key,
    presetSelected: false,
    presetHidden: true,
  });
  return true;
}

// Brings deleted built-in rows back into the table, unselected, so the user can
// re-add one without losing the edits stored on its row.
export function restoreBuiltInDefaultAgentPresets(store: MemoryStore): DefaultAgentPresetState[] {
  const agents = store.listRegisteredAgents({
    includeUnselectedPresets: true,
    includeHiddenPresets: true,
    limit: 500,
  });
  for (const agent of agents) {
    if (!agent.presetHidden) continue;
    if (!agent.presetKey || agent.presetKey.startsWith(CUSTOM_PRESET_PREFIX)) continue;
    store.updateRegisteredAgent(agent.id, { presetHidden: false, presetSelected: false });
  }
  return listDefaultAgentPresetStates(store);
}

// A new workspace starts with the complete recommended roster. Once a preset
// row exists its selected flag is authoritative, so a user's later uncheck is
// never overwritten by subsequent dashboard loads.
export function ensureDefaultAgentPresetStates(store: MemoryStore): DefaultAgentPresetState[] {
  const existingKeys = new Set(
    store
      .listRegisteredAgents({ includeUnselectedPresets: true, includeHiddenPresets: true, limit: 500 })
      .map((agent) => agent.presetKey)
      .filter((key): key is string => Boolean(key)),
  );
  for (const preset of DEFAULT_AGENT_PRESETS) {
    if (!existingKeys.has(preset.key)) setDefaultAgentPresetSelection(store, preset.key, true);
  }
  return listDefaultAgentPresetStates(store);
}

export function setDefaultAgentPresetSelection(
  store: MemoryStore,
  presetKey: string,
  selected: boolean,
): RegisteredAgent | undefined {
  const agents = listPresetAgents(store);
  const existing = agents.find((candidate) => candidate.presetKey === presetKey);
  // A custom preset only exists as its agent row, so there is nothing to
  // recreate from a compiled-in definition once the row is gone.
  if (presetKey.startsWith(CUSTOM_PRESET_PREFIX)) {
    if (!existing) throw new Error(`Unknown default agent preset: ${presetKey}`);
    return store.updateRegisteredAgent(existing.id, { presetSelected: selected });
  }
  const preset = DEFAULT_AGENT_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset) throw new Error(`Unknown default agent preset: ${presetKey}`);
  // Selecting a preset also brings it back into the table if it was deleted.
  if (existing)
    return store.updateRegisteredAgent(existing.id, {
      presetSelected: selected,
      presetHidden: selected ? false : existing.presetHidden,
    });
  if (!selected) return undefined;
  return store.createRegisteredAgent({
    name: uniqueName(agents, preset.name),
    description: preset.description,
    provider: preset.provider,
    mode: preset.mode,
    command: preset.command,
    model: preset.model,
    reasoningEffort: preset.reasoningEffort,
    capabilities: preset.capabilities,
    presetKey: preset.key,
    presetSelected: true,
  });
}

function uniquePresetKey(agents: RegisteredAgent[], label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const keys = new Set(agents.map((agent) => agent.presetKey).filter(Boolean));
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
