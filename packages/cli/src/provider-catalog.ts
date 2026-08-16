import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  getProviderCatalog,
  isCommandOnPath,
  listProviderCatalogs,
  type CatalogModel,
  type ProviderCatalog,
  type ReasoningLevel,
} from "@agent-bridge/adapters";
import { paths } from "./workspace.js";

type CatalogOverride = {
  models: CatalogModel[];
  reasoning?: ReasoningLevel[];
  updatedAt?: string;
};

type CatalogCache = Record<string, CatalogOverride>;

export type RuntimeCatalogResult = {
  catalogs: ProviderCatalog[];
  refreshedProviders: string[];
  errors: Record<string, string>;
};

export async function loadRuntimeProviderCatalogs(options: {
  refresh?: boolean;
  provider?: string;
  command?: string;
  timeoutMs?: number;
} = {}): Promise<RuntimeCatalogResult> {
  const cache = readCatalogCache();
  const bases = options.provider
    ? [getProviderCatalog(options.provider)].filter((catalog): catalog is ProviderCatalog => Boolean(catalog))
    : listProviderCatalogs();
  if (options.provider && !bases.length) throw new Error(`Unknown provider: ${options.provider}`);

  const refreshedProviders: string[] = [];
  const errors: Record<string, string> = {};
  if (options.refresh !== false) {
    await Promise.all(bases.map(async (catalog) => {
      const command = options.command ?? catalog.defaultCommand;
      if (!options.command && !isCommandOnPath(command)) return;
      try {
        const discovered = await discoverProviderCatalog(catalog.provider, command, options.timeoutMs ?? 15_000);
        cache[catalog.provider] = { ...discovered, updatedAt: new Date().toISOString() };
        refreshedProviders.push(catalog.provider);
      } catch (error) {
        errors[catalog.provider] = error instanceof Error ? error.message : String(error);
      }
    }));
    if (refreshedProviders.length) writeCatalogCache(cache);
  }

  return {
    catalogs: bases.map((catalog) => applyCatalogOverride(catalog, cache[catalog.provider])),
    refreshedProviders,
    errors,
  };
}

export async function discoverProviderCatalog(
  provider: string,
  command: string,
  timeoutMs: number,
): Promise<CatalogOverride> {
  if (provider === "codex") return parseCodexCatalog(await run(command, ["debug", "models"], timeoutMs));
  if (provider === "antigravity") {
    const needsWindowsShell = process.platform === "win32" && command === "agy";
    const output = needsWindowsShell
      ? runWindowsShell(command, ["models"], timeoutMs)
      : await run(command, ["models"], timeoutMs);
    return { models: parseAntigravityModels(output) };
  }
  if (provider === "claude") return parseClaudeCatalog(await run(command, ["--help"], timeoutMs));
  throw new Error(`Provider does not support model discovery: ${provider}`);
}

export function parseCodexCatalog(output: string): CatalogOverride {
  const payload = JSON.parse(output) as {
    models?: Array<{
      slug?: string;
      display_name?: string;
      visibility?: string;
      supported_reasoning_levels?: Array<{ effort?: string }>;
    }>;
  };
  const models = (payload.models ?? [])
    .filter((model) => model.slug && model.visibility !== "hide")
    .map((model) => ({
      value: model.slug!,
      label: model.display_name || model.slug!,
      reasoning: dedupeReasoning((model.supported_reasoning_levels ?? [])
        .filter((level) => level.effort)
        .map((level) => ({ value: level.effort!, label: labelFor(level.effort!) }))),
    }));
  if (!models.length) throw new Error("Codex returned no visible models.");
  return { models, reasoning: dedupeReasoning(models.flatMap((model) => model.reasoning ?? [])) };
}

export function parseAntigravityModels(output: string): CatalogModel[] {
  const models = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = line.match(/^([^\s]+)\s+(.+)$/);
    return match && /^(?:gemini|claude|gpt)-/i.test(match[1])
      ? [{ value: match[1], label: match[2].trim() }]
      : [];
  });
  if (!models.length) throw new Error("Antigravity returned no models.");
  return dedupeModels(models);
}

export function parseClaudeCatalog(output: string): CatalogOverride {
  const modelBlock = output.match(/--model <model>[\s\S]*?(?=\n\s{2}(?:-|[a-z][\w-]+\s))/i)?.[0] ?? "";
  const values = [...modelBlock.matchAll(/['"]([a-z][a-z0-9.-]+)['"]/gi)]
    .map((match) => match[1])
    .filter((value) => /^(?:default|opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)$/i.test(value));
  const models = dedupeModels(values.map((value) => ({ value, label: labelFor(value) })));
  if (!models.length) throw new Error("Claude help returned no model aliases.");

  const effortBlock = output.match(/--effort <level>[\s\S]*?(?=\n\s{2}(?:-|[a-z][\w-]+\s))/i)?.[0] ?? "";
  const levels = effortBlock.match(/\(([^)]+)\)/)?.[1].split(/\s*,\s*/).filter(Boolean) ?? [];
  return {
    models,
    reasoning: dedupeReasoning(levels.map((value) => ({ value, label: labelFor(value) }))),
  };
}

export function applyCatalogOverride(base: ProviderCatalog, override: CatalogOverride | undefined): ProviderCatalog {
  if (!override?.models.length) return base;
  if (base.provider === "claude") {
    const models = dedupeModels([...base.models, ...override.models]);
    const fullModelFamilies = new Set(models
      .filter((model) => model.value.startsWith("claude-"))
      .flatMap((model) => model.value.toLowerCase().split("-").slice(1)));
    return {
      ...base,
      models: models.filter((model) =>
        !/^(?:opus|sonnet|haiku|fable)$/i.test(model.value) || !fullModelFamilies.has(model.value.toLowerCase())),
      reasoning: override.reasoning?.length ? override.reasoning : base.reasoning,
    };
  }
  return {
    ...base,
    models: override.models,
    reasoning: override.reasoning?.length ? override.reasoning : base.reasoning,
  };
}

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

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = stdout.trim() ? stdout : stderr;
        // Some CLIs (notably agy) print a valid model table and still exit
        // non-zero after a best-effort remote refresh. Let the provider parser
        // validate that output before falling back to the cached catalog.
        if (error && !output.trim()) reject(error);
        else resolve(output);
      });
  });
}

function runWindowsShell(command: string, args: string[], timeoutMs: number): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: true,
  });
  const output = result.stdout.trim() ? result.stdout : result.stderr;
  if (result.error && !output.trim()) throw result.error;
  return output;
}

function labelFor(value: string): string {
  return value.split(/[-_]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function dedupeModels(models: CatalogModel[]): CatalogModel[] {
  return [...new Map(models.map((model) => [model.value, model])).values()];
}

function dedupeReasoning(levels: ReasoningLevel[]): ReasoningLevel[] {
  return [...new Map(levels.map((level) => [level.value, level])).values()];
}
