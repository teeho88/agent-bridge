import type { Command } from "commander";
import type { AgentProvider, AgentRunMode, RegisteredAgent } from "@agent-bridge/memory";
import { openStore, parseList } from "../workspace.js";
import { loadRuntimeProviderCatalogs } from "../provider-catalog.js";

export function registerAgent(program: Command): void {
  const agent = program.command("agent").description("Manage registered workforce agents");

  agent
    .command("add")
    .argument("<name>", "agent name")
    .option("--description <text>", "expertise profile used by orchestration leaders")
    .requiredOption("--provider <provider>", "codex | claude | gemini | antigravity | openai-compatible | deepseek | kimi | glm | manual | generic")
    .requiredOption("--mode <mode>", "cli | api | manual")
    .option("--command <command>", "CLI command for cli-mode agents")
    .option("--base-url <url>", "API base URL for api-mode agents")
    .option("--model <model>", "model name")
    .option("--reasoning <level>", "reasoning effort for CLI agents")
    .option("--credential <credentialRef>", "credential reference id")
    .option("--capabilities <items>", "comma-separated capabilities")
    .action((name: string, options: { description?: string; provider: string; mode: string; command?: string; baseUrl?: string; model?: string; reasoning?: string; credential?: string; capabilities?: string }) => {
      const store = openStore();
      try {
        const created = store.createRegisteredAgent({
          name,
          description: options.description,
          provider: parseProvider(options.provider),
          mode: parseMode(options.mode),
          command: options.command,
          baseUrl: options.baseUrl,
          model: options.model,
          reasoningEffort: options.reasoning,
          credentialRef: options.credential,
          capabilities: parseList(options.capabilities),
        });
        console.log(JSON.stringify(created, null, 2));
      } finally {
        store.close();
      }
    });

  agent.command("list").option("--enabled", "only enabled agents").option("--provider <provider>", "filter by provider").action((options: { enabled?: boolean; provider?: string }) => {
    const store = openStore();
    try {
      console.log(JSON.stringify(store.listRegisteredAgents({ enabled: options.enabled ? true : undefined, provider: options.provider }), null, 2));
    } finally {
      store.close();
    }
  });

  agent.command("show").argument("<agent>", "agent id or name").action((value: string) => {
    const store = openStore();
    try {
      const found = resolveAgent(store.listRegisteredAgents({ limit: 500 }), value);
      if (!found) throw new Error(`Agent not found: ${value}`);
      console.log(JSON.stringify(found, null, 2));
    } finally {
      store.close();
    }
  });

  for (const enabled of [true, false]) {
    agent.command(enabled ? "enable" : "disable").argument("<agent>", "agent id or name").action((value: string) => {
      const store = openStore();
      try {
        const found = resolveAgent(store.listRegisteredAgents({ limit: 500 }), value);
        if (!found) throw new Error(`Agent not found: ${value}`);
        console.log(JSON.stringify(store.updateRegisteredAgent(found.id, { enabled }), null, 2));
      } finally {
        store.close();
      }
    });
  }

  agent
    .command("update")
    .argument("<agent>", "agent id or name")
    .option("--name <name>", "new agent name")
    .option("--description <text>", "expertise profile used by orchestration leaders")
    .option("--provider <provider>", "codex | claude | gemini | antigravity | openai-compatible | deepseek | kimi | glm | manual | generic")
    .option("--mode <mode>", "cli | api | manual")
    .option("--command <command>", "CLI command for cli-mode agents")
    .option("--base-url <url>", "API base URL for api-mode agents")
    .option("--model <model>", "model name")
    .option("--reasoning <level>", "reasoning effort for CLI agents")
    .option("--credential <credentialRef>", "credential reference id")
    .option("--capabilities <items>", "comma-separated capabilities")
    .action(
      (
        value: string,
        options: {
          name?: string;
          description?: string;
          provider?: string;
          mode?: string;
          command?: string;
          baseUrl?: string;
          model?: string;
          reasoning?: string;
          credential?: string;
          capabilities?: string;
        },
      ) => {
        const store = openStore();
        try {
          const found = resolveAgent(store.listRegisteredAgents({ limit: 500 }), value);
          if (!found) throw new Error(`Agent not found: ${value}`);
          const updated = store.updateRegisteredAgent(found.id, {
            name: options.name,
            description: options.description,
            provider: options.provider ? parseProvider(options.provider) : undefined,
            mode: options.mode ? parseMode(options.mode) : undefined,
            command: options.command,
            baseUrl: options.baseUrl,
            model: options.model,
            reasoningEffort: options.reasoning,
            credentialRef: options.credential,
            capabilities: options.capabilities !== undefined ? parseList(options.capabilities) : undefined,
          });
          console.log(JSON.stringify(updated, null, 2));
        } finally {
          store.close();
        }
      },
    );

  agent
    .command("delete")
    .description("Archive an agent (frees its name for reuse; historical assignments/runs keep referencing it by id)")
    .argument("<agent>", "agent id or name")
    .action((value: string) => {
      const store = openStore();
      try {
        const found = resolveAgent(store.listRegisteredAgents({ limit: 500 }), value);
        if (!found) throw new Error(`Agent not found: ${value}`);
        console.log(JSON.stringify({ deleted: store.deleteRegisteredAgent(found.id) }, null, 2));
      } finally {
        store.close();
      }
    });

  agent.command("test").argument("<agent>", "agent id or name").description("Validate agent configuration without spawning it").action((value: string) => {
    const store = openStore();
    try {
      const found = resolveAgent(store.listRegisteredAgents({ limit: 500 }), value);
      if (!found) throw new Error(`Agent not found: ${value}`);
      if (!found.enabled) throw new Error(`Agent is disabled: ${found.name}`);
      if (found.mode === "cli" && !found.command) throw new Error("CLI agent is missing --command.");
      if (found.mode === "api") {
        if (!found.baseUrl) throw new Error("API agent is missing --base-url.");
        if (!found.model) throw new Error("API agent is missing --model.");
        if (found.credentialRef) {
          const credential = store.listCredentialRefs().find((item) => item.id === found.credentialRef);
          if (!credential) throw new Error(`Credential reference not found: ${found.credentialRef}`);
          if (credential.kind === "env" && !process.env[credential.ref]) throw new Error(`Environment variable is not set: ${credential.ref}`);
        }
      }
      console.log(`Agent ${found.name} configuration is valid.`);
    } finally {
      store.close();
    }
  });

  agent
    .command("catalog")
    .description("List known models and reasoning levels per CLI provider")
    .option("--provider <provider>", "codex | claude | antigravity")
    .action(async (options: { provider?: string }) => {
      const result = await loadRuntimeProviderCatalogs({ provider: options.provider });
      console.log(JSON.stringify(result.catalogs, null, 2));
    });

  agent
    .command("probe")
    .description("Query a provider CLI for its current model catalog and cache the result")
    .argument("<provider>", "codex | claude | antigravity")
    .option("--command <command>", "override the CLI command to probe")
    .option("--timeout-ms <ms>", "probe timeout", "10000")
    .action(async (provider: string, options: { command?: string; timeoutMs: string }) => {
      const result = await loadRuntimeProviderCatalogs({
        provider,
        command: options.command,
        timeoutMs: Number(options.timeoutMs),
      });
      const error = result.errors[provider];
      console.log(JSON.stringify(error
        ? { provider, probed: false, reason: error }
        : { provider, probed: true, models: result.catalogs[0]?.models ?? [] }, null, 2));
    });
}

function resolveAgent(agents: RegisteredAgent[], value: string): RegisteredAgent | undefined {
  return agents.find((agent) => agent.id === value || agent.name === value);
}

function parseProvider(value: string): AgentProvider {
  const allowed: AgentProvider[] = ["codex", "claude", "gemini", "antigravity", "openai-compatible", "deepseek", "kimi", "glm", "manual", "generic"];
  if (allowed.includes(value as AgentProvider)) return value as AgentProvider;
  throw new Error(`Invalid provider "${value}". Use one of: ${allowed.join(", ")}.`);
}

function parseMode(value: string): AgentRunMode {
  const allowed: AgentRunMode[] = ["cli", "api", "manual"];
  if (allowed.includes(value as AgentRunMode)) return value as AgentRunMode;
  throw new Error(`Invalid mode "${value}". Use one of: ${allowed.join(", ")}.`);
}
