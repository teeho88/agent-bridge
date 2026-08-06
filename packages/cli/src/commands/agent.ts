import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import type { AgentProvider, AgentRunMode, RegisteredAgent } from "@agent-bridge/memory";
import { getProviderCatalog, listProviderCatalogs, mergeProviderCatalog, type ProviderCatalog } from "@agent-bridge/adapters";
import { openStore, parseList, paths } from "../workspace.js";

export function registerAgent(program: Command): void {
  const agent = program.command("agent").description("Manage registered workforce agents");

  agent
    .command("add")
    .argument("<name>", "agent name")
    .requiredOption("--provider <provider>", "codex | claude | gemini | antigravity | openai-compatible | deepseek | kimi | glm | manual | generic")
    .requiredOption("--mode <mode>", "cli | api | manual")
    .option("--command <command>", "CLI command for cli-mode agents")
    .option("--base-url <url>", "API base URL for api-mode agents")
    .option("--model <model>", "model name")
    .option("--reasoning <level>", "reasoning effort for CLI agents")
    .option("--credential <credentialRef>", "credential reference id")
    .option("--capabilities <items>", "comma-separated capabilities")
    .action((name: string, options: { provider: string; mode: string; command?: string; baseUrl?: string; model?: string; reasoning?: string; credential?: string; capabilities?: string }) => {
      const store = openStore();
      try {
        const created = store.createRegisteredAgent({
          name,
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
    .action((options: { provider?: string }) => {
      const cache = readCatalogCache();
      const catalogs = options.provider
        ? [getProviderCatalog(options.provider)].filter((catalog): catalog is ProviderCatalog => Boolean(catalog))
        : listProviderCatalogs();
      if (options.provider && !catalogs.length) throw new Error(`Unknown provider: ${options.provider}`);
      const merged = catalogs.map((catalog) =>
        cache[catalog.provider] ? mergeProviderCatalog(catalog, cache[catalog.provider]) : catalog,
      );
      console.log(JSON.stringify(merged, null, 2));
    });

  agent
    .command("probe")
    .description("Run `<command> --help` for a provider and cache any extra models/flags it reports")
    .argument("<provider>", "codex | claude | antigravity")
    .option("--command <command>", "override the CLI command to probe")
    .option("--timeout-ms <ms>", "probe timeout", "10000")
    .action((provider: string, options: { command?: string; timeoutMs: string }) => {
      const catalog = getProviderCatalog(provider);
      if (!catalog) throw new Error(`Unknown provider: ${provider}. Only CLI providers have a probe-able catalog.`);
      const executable = options.command ?? catalog.defaultCommand;
      let helpText = "";
      try {
        helpText = execFileSync(executable, ["--help"], {
          encoding: "utf8",
          timeout: Number(options.timeoutMs),
          windowsHide: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(JSON.stringify({ provider, probed: false, reason: `Could not run "${executable} --help": ${message}` }, null, 2));
        return;
      }
      const discoveredModels = extractModelMentions(helpText, catalog.models.map((model) => model.value));
      const cache = readCatalogCache();
      cache[provider] = {
        models: discoveredModels.map((value) => ({ value, label: value })),
        reasoning: cache[provider]?.reasoning ?? [],
      };
      writeCatalogCache(cache);
      console.log(JSON.stringify({ provider, probed: true, discoveredModels }, null, 2));
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

type CatalogCache = Record<string, { models: Array<{ value: string; label: string }>; reasoning: Array<{ value: string; label: string }> }>;

function catalogCachePath(): string {
  return `${paths().memoryDir}/catalog.json`;
}

function readCatalogCache(): CatalogCache {
  try {
    return JSON.parse(readFileSync(catalogCachePath(), "utf8")) as CatalogCache;
  } catch {
    return {};
  }
}

function writeCatalogCache(cache: CatalogCache): void {
  const path = catalogCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2), "utf8");
}

function extractModelMentions(helpText: string, knownModels: string[]): string[] {
  const found = new Set<string>(knownModels.filter((model) => helpText.includes(model)));
  return [...found];
}

function parseMode(value: string): AgentRunMode {
  const allowed: AgentRunMode[] = ["cli", "api", "manual"];
  if (allowed.includes(value as AgentRunMode)) return value as AgentRunMode;
  throw new Error(`Invalid mode "${value}". Use one of: ${allowed.join(", ")}.`);
}
