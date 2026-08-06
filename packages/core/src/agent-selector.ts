import type { AgentProvider, AgentRunMode, MemoryStore, RegisteredAgent } from "@agent-bridge/memory";
import type { LeaderAgentPreference } from "./leader-contract.js";

export type ResolveAgentDefaults = {
  mode?: AgentRunMode;
  command?: string;
  capabilities?: string[];
  requiredCapabilities?: string[];
  // When false, never register a new agent: resolve only against agents the
  // user enabled in the Agents tab, and throw if none of them can serve the
  // preference. This is what the orchestrator uses, so the roster stays the
  // single place that decides who may run.
  allowCreate?: boolean;
};

// Maps a leader's agentPreference to a concrete RegisteredAgent, reusing an
// existing agent when the provider/mode/model/reasoning already match and
// creating a new one only when nothing fits. This intentionally never
// mutates an existing agent in place — resolveAgentVariant in run.ts already
// owns that (with the "is this agent still live elsewhere" safety check);
// this function's only job is find-or-create.
export function resolveAgentForPreference(
  store: MemoryStore,
  preference: LeaderAgentPreference,
  defaults: ResolveAgentDefaults = {},
): RegisteredAgent {
  const provider = preference.provider as AgentProvider;
  const mode = preference.mode ?? defaults.mode ?? "cli";
  const requiredCapabilities = normalizeCapabilities(defaults.requiredCapabilities ?? []);
  const candidates = store
    .listRegisteredAgents({ provider, enabled: true, limit: 500 })
    .filter((agent) => agentSupportsCapabilities(agent, requiredCapabilities));

  const exactMatch = candidates.find(
    (agent) =>
      agent.mode === mode &&
      (preference.model ? agent.model === preference.model : true) &&
      (preference.reasoningEffort ? agent.reasoningEffort === preference.reasoningEffort : true),
  );
  if (exactMatch) return exactMatch;

  if (defaults.allowCreate === false) {
    // No exact match, and we may not register one. Fall back within the roster
    // rather than failing the whole step over a model/effort detail the leader
    // guessed at: same provider and mode is close enough to do the work, and
    // the user's roster is what decides the rest. Only a provider with no
    // enabled agent at all is a real dead end.
    const sameMode = candidates.find((agent) => agent.mode === mode);
    if (sameMode) return sameMode;
    if (candidates[0]) return candidates[0];
    throw new Error(
      `No enabled registered agent for provider "${provider}"` +
        (requiredCapabilities.length ? ` with capabilities: ${requiredCapabilities.join(", ")}` : "") +
        `. The leader may only staff agents listed and enabled in the Agents tab — add the required capabilities or enable a matching agent first.`,
    );
  }

  const name = uniqueAgentName(store, agentNameFor(provider, preference.model, preference.reasoningEffort));
  return store.createRegisteredAgent({
    name,
    provider,
    mode,
    command: defaults.command ?? provider,
    model: preference.model,
    reasoningEffort: preference.reasoningEffort,
    capabilities: defaults.capabilities ?? (requiredCapabilities.length ? requiredCapabilities : ["implement"]),
  });
}

export function agentSupportsCapabilities(agent: RegisteredAgent, required: string[]): boolean {
  if (!required.length) return true;
  const available = new Set(normalizeCapabilities(agent.capabilities));
  return normalizeCapabilities(required).every((capability) => available.has(capability));
}

function normalizeCapabilities(capabilities: string[]): string[] {
  return [...new Set(capabilities.map((capability) => capability.trim().toLowerCase()).filter(Boolean))];
}

// Seeds one enabled agent per requested provider that has none yet, and returns
// the providers that ended up with a usable agent.
//
// The leader may only staff from the roster, so the roster has to be populated
// before the run starts or a freshly ticked provider would simply be invisible.
// This is the user's own choice (the Team providers checkboxes) being written
// down as agent records — not the leader inventing staff mid-run — and the
// result shows up in the Agents tab where it can be edited or disabled.
export function ensureAgentsForProviders(
  store: MemoryStore,
  providers: string[],
  defaultCommandFor: (provider: string) => string | undefined = () => undefined,
): string[] {
  const staffed: string[] = [];
  for (const provider of [...new Set(providers)]) {
    const existing = store.listRegisteredAgents({ provider: provider as AgentProvider, enabled: true, limit: 1 });
    if (existing.length) {
      staffed.push(provider);
      continue;
    }
    const command = defaultCommandFor(provider);
    // No known command means nothing to launch; leave it out rather than
    // register an agent whose every spawn would fail.
    if (!command) continue;
    store.createRegisteredAgent({
      name: uniqueAgentName(store, provider),
      provider: provider as AgentProvider,
      mode: "cli",
      command,
      capabilities: ["implement", "review"],
    });
    staffed.push(provider);
  }
  return staffed;
}

function agentNameFor(provider: string, model: string | undefined, reasoningEffort: string | undefined): string {
  return [provider, model, reasoningEffort].filter(Boolean).join("-");
}

// agents.name is unique, and this function's whole job is find-OR-create —
// e.g. an existing "claude-opus" (reasoningEffort "medium") plus a new
// preference for the same provider/model at "high" reasoning: no exact
// match, but the naive name would collide with the existing row and throw a
// raw SQLite UNIQUE constraint error that crashes the entire orchestration
// step instead of just creating a second, differently-tuned agent.
function uniqueAgentName(store: MemoryStore, base: string): string {
  const existingNames = new Set(store.listRegisteredAgents({ limit: 5000 }).map((agent) => agent.name));
  if (!existingNames.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
