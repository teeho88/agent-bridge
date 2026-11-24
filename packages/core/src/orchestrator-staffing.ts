import type {
  MemoryStore,
  Orchestration,
  RegisteredAgent,
} from "@agent-bridge/memory";

import {
  agentSupportsCapabilities,
  resolveAgentForPreference,
  uniqueAgentName,
} from "./agent-selector.js";

import { type LeaderAgentPreference } from "./leader-contract.js";

import { type OrchestratorDeps } from "./orchestrator-contracts.js";
type Dependencies = {
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
};
export type StaffingFunctions = ReturnType<typeof createStaffing>;
export function createStaffing(operations: Dependencies) {
  function mustGetTask(
    store: MemoryStore,
    taskId: string,
  ): import("@agent-bridge/memory").Task {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  function mustGetAgent(store: MemoryStore, agentId: string): RegisteredAgent {
    const agent = store.getRegisteredAgent(agentId);
    if (!agent) throw new Error(`Registered agent not found: ${agentId}`);
    return agent;
  }

  function mustGetRole(
    store: MemoryStore,
    roleName: string,
  ): import("@agent-bridge/memory").WorkforceRole {
    const role = store
      .listWorkforceRoles()
      .find((candidate) => candidate.name === roleName);
    if (!role)
      throw new Error(
        `Workforce role not found: ${roleName}. Run ensureDefaultWorkforceRoles first.`,
      );
    return role;
  }

  // Resolution can legitimately fail while building an approval prompt (no
  // provider left to staff): the gate must still be able to ask the question —
  // with the user free to answer it by naming an agent themselves — and the spawn
  // itself reports the real error.
  function tryResolveAgent(
    resolve: () => RegisteredAgent,
  ): RegisteredAgent | undefined {
    try {
      return resolve();
    } catch {
      return undefined;
    }
  }

  function describeAgent(agent: RegisteredAgent | undefined): string {
    return agent
      ? `${agent.name} (${agent.provider}${agent.model ? `/${agent.model}` : ""})`
      : "an agent that still has to be staffed";
  }

  function findDefaultAgent(
    store: MemoryStore,
    capability: string,
  ): RegisteredAgent | undefined {
    return store
      .listRegisteredAgents({ enabled: true, limit: 500 })
      .find((candidate) => agentSupportsCapabilities(candidate, [capability]));
  }

  // The single door every implementer/reviewer spawn goes through.
  //
  // The roster stays the first and preferred answer: an agent the user registered
  // and enabled in the Agents tab. But an empty (or capability-short) roster used
  // to be a hard stop — the leader planned, then every spawn threw "No enabled
  // registered agent available", and the orchestration died with nothing to show.
  // Rather than fail, register the agent the plan calls for and say so in the
  // timeline; it lands in the Agents tab where the user can retune or disable it.
  // Which providers may be staffed is decided in the Agents tab: an agent (or a
  // whole provider) the user disabled there is simply not in the roster.
  function resolveStaffAgent(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
    capability: "implement" | "review",
    preference?: LeaderAgentPreference,
  ): RegisteredAgent {
    if (preference) {
      try {
        return resolveAgentForPreference(store, preference, {
          allowCreate: false,
          requiredCapabilities: [capability],
        });
      } catch (error) {
        const created = autoStaffAgent(
          store,
          orchestration,
          deps,
          capability,
          preference,
        );
        if (!created) throw error;
        return created;
      }
    }
    const existing = findDefaultAgent(store, capability);
    if (existing) return existing;
    const created = autoStaffAgent(store, orchestration, deps, capability);
    if (created) return created;
    throw new Error(
      `No enabled registered agent available for ${capability} work, and none could be registered automatically. ` +
        `Add an agent with the "${capability}" capability in the Agents tab.`,
    );
  }

  // Registers one CLI agent for the best provider the plan/allowlist/machine can
  // agree on. Returns undefined when there is no provider left to try, so the
  // caller can surface the original, more specific error.
  function autoStaffAgent(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
    capability: "implement" | "review",
    preference?: LeaderAgentPreference,
  ): RegisteredAgent | undefined {
    const installed =
      deps.listProviders?.().map((option) => option.provider) ?? [];
    const leaderProvider = store.getRegisteredAgent(
      orchestration.leaderAgentId,
    )?.provider;
    const candidates = [
      preference?.provider,
      ...installed,
      leaderProvider,
    ].filter((provider): provider is string => Boolean(provider));

    for (const provider of [...new Set(candidates)]) {
      // No known command means nothing to launch; skipping is better than
      // registering an agent whose every spawn dies with ENOENT.
      const command = deps.defaultCommandFor
        ? deps.defaultCommandFor(provider)
        : provider;
      if (!command) continue;
      // Model/effort are only carried over when the leader asked for this very
      // provider — pairing another provider's model id with it spawns nothing.
      const forPreference =
        preference?.provider === provider ? preference : undefined;
      const agent = store.createRegisteredAgent({
        name: uniqueAgentName(
          store,
          [provider, forPreference?.model, forPreference?.reasoningEffort]
            .filter(Boolean)
            .join("-"),
        ),
        provider: provider as RegisteredAgent["provider"],
        // Auto-staffing only ever creates CLI agents: an api-mode agent needs a
        // base URL and a credential this code has no way to invent.
        mode: "cli",
        command,
        model: forPreference?.model,
        reasoningEffort: forPreference?.reasoningEffort,
        // Both capabilities, so one auto-staffed agent can also review later
        // instead of triggering a second round of this.
        capabilities: ["implement", "review"],
      });
      operations.recordEvent(
        store,
        orchestration,
        capability === "implement" ? "implement" : "review",
        "user_action",
        `Auto-registered agent "${agent.name}" (${provider}${agent.model ? `/${agent.model}` : ""}) for ${capability} work; the roster had no enabled agent that could take it.`,
      );
      return agent;
    }
    return undefined;
  }

  function findCapabilityAgent(
    store: MemoryStore,
    capability: string,
    excludeAgentId?: string,
  ): RegisteredAgent | undefined {
    return store
      .listRegisteredAgents({ enabled: true, limit: 500 })
      .find(
        (candidate) =>
          candidate.id !== excludeAgentId &&
          agentSupportsCapabilities(candidate, [capability]),
      );
  }

  // What the leader is told it can staff from: the enabled agents in the Agents
  // tab. Installed-but-unregistered CLIs are offered ONLY when that
  // roster comes back empty — otherwise the leader would plan around agents the
  // user chose not to enable. When it is empty, naming the installed providers is
  // the only way to get a usable plan at all, and the spawn path registers
  // whichever one the leader picks (see autoStaffAgent).
  function resolveProviderOptions(
    store: MemoryStore,
    orchestration: Orchestration,
    _deps: OrchestratorDeps,
  ): {
    availableProviders: string[];
    providerModels: Record<string, string[]>;
    agentRoster: Array<{
      name: string;
      description?: string;
      provider: string;
      model?: string;
      capabilities: string[];
    }>;
    autoStaff: boolean;
  } {
    const agents = store
      .listRegisteredAgents({ enabled: true, limit: 500 })
      .filter(
        (agent) =>
          agentSupportsCapabilities(agent, ["implement"]) ||
          agentSupportsCapabilities(agent, ["review"]),
      );
    const collect = (filtered: RegisteredAgent[]) => {
      const providerModels: Record<string, string[]> = {};
      const ordered: string[] = [];
      for (const agent of filtered) {
        if (!ordered.includes(agent.provider)) ordered.push(agent.provider);
        const models = providerModels[agent.provider] ?? [];
        if (agent.model && !models.includes(agent.model))
          models.push(agent.model);
        providerModels[agent.provider] = models;
      }
      return {
        availableProviders: ordered,
        providerModels,
        agentRoster: filtered.map((agent) => ({
          name: agent.name,
          description: agent.description,
          provider: agent.provider,
          model: agent.model,
          capabilities: agent.capabilities,
        })),
        autoStaff: false,
      };
    };
    // Installed CLIs, used only as the empty-roster fallback.
    const fromInstalled = () => {
      const catalogs = _deps.listProviders?.() ?? [];
      const providerModels: Record<string, string[]> = {};
      for (const option of catalogs)
        providerModels[option.provider] = option.models;
      return {
        availableProviders: catalogs.map((option) => option.provider),
        providerModels,
        agentRoster: [],
        autoStaff: catalogs.length > 0,
      };
    };
    return agents.length ? collect(agents) : fromInstalled();
  }
  return {
    mustGetTask,
    mustGetAgent,
    mustGetRole,
    tryResolveAgent,
    describeAgent,
    findDefaultAgent,
    resolveStaffAgent,
    autoStaffAgent,
    findCapabilityAgent,
    resolveProviderOptions,
  };
}
