import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentProvider, AgentRunMode } from "@agent-bridge/memory";

export type ReasoningLevel = { value: string; label: string };

export type CatalogModel = { value: string; label: string; reasoning?: ReasoningLevel[] };

export type ReasoningFlagStyle = "codex-config" | "claude-effort" | "none";

export type ProviderCatalog = {
  provider: AgentProvider;
  mode: AgentRunMode;
  defaultCommand: string;
  models: CatalogModel[];
  reasoning: ReasoningLevel[];
  reasoningFlag: ReasoningFlagStyle;
  // Whether the CLI can run one prompt to completion with the reply on stdout.
  // Only headless providers can be staffed onto an orchestration: the
  // orchestrator's whole loop is spawn -> wait for exit -> parse the log, and a
  // CLI that answers inside a GUI window gives it an empty log and no verdict.
  headless: boolean;
};

const CODEX_REASONING: ReasoningLevel[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

const CLAUDE_REASONING: ReasoningLevel[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// Seed catalog: known CLI providers with their published models and reasoning
// levels. `agent probe` can refresh this at runtime into .agent-memory/catalog.json
// since CLI vendors add/rename models faster than this file gets updated.
export const PROVIDER_CATALOGS: Record<string, ProviderCatalog> = {
  codex: {
    provider: "codex",
    mode: "cli",
    defaultCommand: "codex",
    // Verified against the real catalog (`codex debug models`) — codex has no
    // bare "gpt-5.6"; only these suffixed slugs exist, and this account's
    // ChatGPT auth rejects anything outside its model list with a 400.
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { value: "gpt-5.5", label: "GPT-5.5" },
    ],
    reasoning: CODEX_REASONING,
    reasoningFlag: "codex-config",
    headless: true,
  },
  claude: {
    provider: "claude",
    mode: "cli",
    defaultCommand: "claude",
    // Bare aliases (opus/sonnet/fable) resolve to "latest in that family" per
    // `claude --help`, which silently drifts to a newer model over time and
    // hides that there are multiple real, distinct versions live at once —
    // verified from this machine's own session history (~/.claude/projects):
    // claude-opus-5 and the still-working claude-opus-4-8 are BOTH real,
    // different models today, not just an alias vs. its resolved target.
    // Pin the full, versioned ids so picking one is an explicit choice.
    models: [
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      { value: "claude-fable-5", label: "Fable 5" },
    ],
    reasoning: CLAUDE_REASONING,
    reasoningFlag: "claude-effort",
    headless: true,
  },
  // Replaces the deprecated gemini CLI. The command is `agy` (agy 1.1.10) — NOT
  // `antigravity`, which is only the IDE launcher of a VS Code fork and answers
  // inside its own window. `agy --print` is a real headless agent: it reads and
  // writes files, runs to completion, and prints the final answer to stdout.
  //
  // Models are `agy models` verbatim. Most of them already encode an effort
  // level in the id (…-high/-medium/-low); --effort is still accepted and is
  // forwarded separately when the agent record sets one.
  antigravity: {
    provider: "antigravity",
    mode: "cli",
    defaultCommand: "agy",
    models: [
      { value: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (high)" },
      { value: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (high)" },
      { value: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (medium)" },
      { value: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (low)" },
      { value: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (high)" },
      { value: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (medium)" },
      { value: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (low)" },
      { value: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (high)" },
      { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (low)" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (thinking)" },
      { value: "gpt-oss-120b-medium", label: "GPT-OSS 120B (medium)" },
    ],
    // `--effort` accepts exactly low|medium|high — anything else is rejected,
    // so codex's xhigh/minimal are deliberately absent here.
    reasoning: CLAUDE_REASONING,
    reasoningFlag: "claude-effort",
    headless: true,
  },
};

// The reasoning levels `agy --effort` accepts. A value outside this set (e.g.
// codex's "xhigh", carried over on an agent record that was retuned from one
// provider to another) makes the CLI reject the whole invocation, so it is
// dropped rather than forwarded.
export const AGY_EFFORT_LEVELS = new Set(["low", "medium", "high"]);

// Whether `command` resolves to something launchable on PATH. Deliberately a
// filesystem lookup rather than spawning `which`/`where`: this runs on every
// planning turn, and spawning a probe per provider (each of which may print a
// banner or, worse, start an interactive session) is far more expensive and
// far less predictable than a stat.
export function isCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  // On Windows the CLIs are almost always `codex.cmd`/`claude.cmd` shims, so a
  // bare-name check finds nothing; PATHEXT is what makes them resolvable.
  const extensions =
    process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  return dirs.some((dir) => extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))));
}

// The provider catalogs whose CLI is actually installed on this machine. An
// entry here that is not really runnable would turn into a spawn failure
// mid-project, which is why this is a PATH check and not a static list.
export function listInstalledProviderCatalogs(env: NodeJS.ProcessEnv = process.env): ProviderCatalog[] {
  return listProviderCatalogs().filter((catalog) => isCommandOnPath(catalog.defaultCommand, env));
}

// What the orchestrator may offer the leader as staffable providers: installed
// AND able to answer headlessly. A CLI that only drives a GUI would be excluded
// here — staffing it would hand the leader an agent whose runs never produce a
// parseable reply.
export function listStaffableProviderCatalogs(env: NodeJS.ProcessEnv = process.env): ProviderCatalog[] {
  return listInstalledProviderCatalogs(env).filter((catalog) => catalog.headless);
}

export function getProviderCatalog(provider: string): ProviderCatalog | undefined {
  return PROVIDER_CATALOGS[provider];
}

// The binary each provider is launched as in cli mode. PROVIDER_CATALOGS only
// covers the providers we ship models for, but the agent form offers every
// AgentProvider, and a cli-mode agent with an empty command is a spawn failure
// waiting to happen — so the providers without a catalog get their command
// named here too. `gemini` is the deprecated CLI that antigravity's `agy`
// replaced; it keeps its own name because an agent registered against an old
// install should still launch what it was pointed at.
const PROVIDER_DEFAULT_COMMANDS: Record<string, string> = {
  gemini: "gemini",
  deepseek: "deepseek",
  kimi: "kimi",
  glm: "glm",
  generic: "generic",
};

// The command to prefill for `provider` in cli mode, or undefined for providers
// that have no CLI at all (api-only or human-driven).
export function defaultCommandForProvider(provider: string): string | undefined {
  return PROVIDER_CATALOGS[provider]?.defaultCommand ?? PROVIDER_DEFAULT_COMMANDS[provider];
}

// provider -> cli command, for clients (the dashboard) that need the whole map
// in one payload rather than a lookup per keystroke.
export function providerDefaultCommands(): Record<string, string> {
  const commands: Record<string, string> = { ...PROVIDER_DEFAULT_COMMANDS };
  for (const catalog of listProviderCatalogs()) commands[catalog.provider] = catalog.defaultCommand;
  return commands;
}

export function listProviderCatalogs(): ProviderCatalog[] {
  return Object.values(PROVIDER_CATALOGS);
}

export function mergeProviderCatalog(
  base: ProviderCatalog,
  overrides: Partial<Pick<ProviderCatalog, "models" | "reasoning">>,
): ProviderCatalog {
  return {
    ...base,
    models: overrides.models?.length ? dedupeModels([...base.models, ...overrides.models]) : base.models,
    reasoning: overrides.reasoning?.length
      ? dedupeReasoning([...base.reasoning, ...overrides.reasoning])
      : base.reasoning,
  };
}

function dedupeModels(models: CatalogModel[]): CatalogModel[] {
  const seen = new Map<string, CatalogModel>();
  for (const model of models) seen.set(model.value, model);
  return [...seen.values()];
}

function dedupeReasoning(levels: ReasoningLevel[]): ReasoningLevel[] {
  const seen = new Map<string, ReasoningLevel>();
  for (const level of levels) seen.set(level.value, level);
  return [...seen.values()];
}
