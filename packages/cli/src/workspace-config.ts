

import { readPersistedConfig, writePersistedConfig } from "./config-persistence.js";

﻿

import { existsSync, readFileSync } from "node:fs";

import { join } from "node:path";

import { DEFAULT_CONSOLIDATE_THRESHOLD, DEFAULT_DECAY_HALF_LIFE_DAYS, DEFAULT_DEDUPE_THRESHOLD, DEFAULT_MAX_POOL_SIZE, DEFAULT_MIN_CLUSTER_SIZE, type AgentKind, type LifecycleConfig, type Task } from "@agent-bridge/memory";





import { redactSecrets } from "@agent-bridge/core";


export type BridgeConfig = {
  version: 1;
  enabled?: boolean;
  currentTaskId: string | null;
  // Per-agent current task, so claude + codex can work the same repo without
  // clobbering each other's task. currentTaskId stays as the shared fallback
  // for callers that do not specify an agent.
  currentTasks?: Partial<Record<AgentKind, string>>;
  // Last session observed for each agent. Integrations use this to avoid
  // silently attaching a new session's first prompt to an earlier task.
  currentSessions?: Partial<Record<AgentKind, string>>;
  // Sessions currently running in this repository. Unlike currentSessions,
  // this keeps every concurrent session so the dashboard can show live work.
  activeSessions?: Record<string, AgentKind>;
  // Which task each session opened. Lets us restore the right task when an
  // earlier session is resumed instead of clobbering the current one or
  // spawning a duplicate. Keyed by session id (unique across agents).
  sessionTasks?: Record<string, string>;
  // Native agent session currently hosted by a stable Work Board terminal.
  // The terminal id survives commands such as Codex /clear; the native id
  // changes and is used to decide when that window should move to a new task.
  terminalNativeSessions?: Record<string, string>;
  deletedSessionIds?: Record<string, true>;
  // Stable Windows Terminal ids and best-effort process/window handles used
  // by the dashboard to track and focus an existing agent terminal.
  sessionWindows?: Record<
    string,
    {
      hwnd?: string;
      windowId?: string;
      pid?: number;
      processStartedAt?: string;
      taskId: string;
      agent: AgentKind;
      updatedAt: string;
    }
  >;
  pendingNewTasks?: Partial<Record<AgentKind, true>>;
  defaultAgent: AgentKind;
  tokenBudget: number;
  invocationBudget?: { inputTokenBudget?: number; outputReserve?: number; contextWindowTokens?: number; safetyMargin?: number };
  logs?: { segmentBytes?: number; maxSegments?: number };
  workflow?: { mode: "full" | "single"; promotedSessions?: string[] };
  contextEfficiency?: { bootstrap?: boolean; query?: boolean; delta?: boolean; runtimeBookkeeping?: boolean };
  memoryPath: string;
  databasePath: string;
  managedFiles: Record<string, boolean>;
  security: {
    redactSecrets: boolean;
    ignorePaths: string[];
  };
  // Memory-pool tuning (dedupe/consolidate/decay/eviction/hybrid). Optional;
  // omitted fields fall back to the library DEFAULT_* constants.
  memory?: LifecycleConfig;
  repoMemory?: {
    // Capture clearly repo-wide Claude instructions, constraints, and decisions
    // into the reviewable inbox. Ordinary prompts stay scoped to their task.
    autoCapture?: boolean;
  };
  // Provider-level CLI permission behavior used by every spawned agent of
  // that provider. Keeping this outside RegisteredAgent makes the safety
  // choice consistent across model presets.
  cliApprovalPolicies?: {
    codex?: "default" | "auto-review" | "never" | "bypass";
    codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
    antigravity?: "default" | "accept-edits" | "plan" | "bypass";
    antigravityMode?: "default" | "auto" | "accept-edits" | "plan";
    claude?: "manual" | "auto" | "accept-edits" | "dont-ask" | "plan" | "bypass";
  };
  // Knowledge-graph navigation settings; repoMapLimit caps manual map output.
  graph?: {
    enabled?: boolean;
    repoMapLimit?: number;
    includePaths?: string[];
    ignorePaths?: string[];
    // When true (default), a running `agent-bridge watch` daemon auto-briefs source
    // files as they change on disk, regardless of which agent or editor changed them.
    // Gates the watcher's behavior so the UI can pause it without stopping it.
    watchAutoBrief?: boolean;
  };
};


export const memoryDir = ".agent-memory";


export function paths(cwd = process.cwd()) {
  return {
    cwd,
    memoryDir: join(cwd, memoryDir),
    database: join(cwd, memoryDir, "memories.db"),
    config: join(cwd, memoryDir, "config.json"),
    currentTask: join(cwd, memoryDir, "current-task.md"),
    compiledContext: join(cwd, memoryDir, "compiled-context.md"),
    tokenPolicy: join(cwd, memoryDir, "token-policy.yaml"),
    logs: join(cwd, memoryDir, "logs"),
    artifacts: join(cwd, memoryDir, "artifacts"),
    tasks: join(cwd, memoryDir, "tasks"),
  };
}


export function defaultConfig(): BridgeConfig {
  return {
    version: 1,
    enabled: true,
    currentTaskId: null,
    currentTasks: {},
    currentSessions: {},
    activeSessions: {},
    sessionTasks: {},
    sessionWindows: {},
    pendingNewTasks: {},
    defaultAgent: "codex",
    tokenBudget: 4000,
    memoryPath: ".agent-memory",
    databasePath: ".agent-memory/memories.db",
    managedFiles: {
      "AGENTS.md": true,
      "CLAUDE.md": true,
    },
    security: {
      redactSecrets: true,
      ignorePaths: [
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        "node_modules/",
        "dist/",
        "build/",
        ".git/",
      ],
    },
    memory: {
      maintenanceEnabled: true,
      dedupeThreshold: DEFAULT_DEDUPE_THRESHOLD,
      consolidateThreshold: DEFAULT_CONSOLIDATE_THRESHOLD,
      minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
      decayHalfLifeDays: DEFAULT_DECAY_HALF_LIFE_DAYS,
      maxPoolSize: DEFAULT_MAX_POOL_SIZE,
      hybrid: { alpha: 0.5, beta: 0.5 },
    },
    repoMemory: {
      autoCapture: true,
    },
    cliApprovalPolicies: {
      codex: "never",
      codexSandbox: "workspace-write",
      antigravity: "default",
      antigravityMode: "accept-edits",
      claude: "auto",
    },
    graph: {
      enabled: true,
      repoMapLimit: 30,
      includePaths: [],
      ignorePaths: [],
      watchAutoBrief: true,
    },
  };
}


export type TokenPolicy = {
  maxPromptTokens?: number;
  maxFileSnippetTokens?: number;
  maxMemoryTokens?: number;
  maxLogsTokens?: number;
  maxHandoffTokens?: number;
  maxRepoMapTokens?: number;
  maxConstraintTokens?: number;
  maxDecisionTokens?: number;
  preferSummaryOverRaw?: boolean;
};


// Minimal parser for the flat token-policy.yaml we generate (one level of
// indentation under `token_policy:`). Avoids pulling in a YAML dependency for
// a fixed, simple shape. Unknown keys are ignored.
function parseSimpleYaml(
  text: string,
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+([a-z0-9_]+):\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (/^-?\d+$/.test(rawValue)) out[key] = Number(rawValue);
    else if (rawValue === "true" || rawValue === "false")
      out[key] = rawValue === "true";
    else out[key] = rawValue.replace(/^["']|["']$/g, "");
  }
  return out;
}


export function readTokenPolicy(cwd = process.cwd()): TokenPolicy {
  const p = paths(cwd);
  if (!existsSync(p.tokenPolicy)) return {};
  const values = parseSimpleYaml(readFileSync(p.tokenPolicy, "utf8"));
  const num = (key: string): number | undefined =>
    typeof values[key] === "number" ? (values[key] as number) : undefined;
  return {
    maxPromptTokens: num("max_prompt_tokens"),
    maxFileSnippetTokens: num("max_file_snippet_tokens"),
    maxMemoryTokens: num("max_memory_tokens"),
    maxLogsTokens: num("max_logs_tokens"),
    maxHandoffTokens: num("max_handoff_tokens"),
    maxRepoMapTokens: num("max_repo_map_tokens"),
    maxConstraintTokens: num("max_constraint_tokens"),
    maxDecisionTokens: num("max_decision_tokens"),
    preferSummaryOverRaw: values["prefer_summary_over_raw"] === true,
  };
}


// Per-section budgets to pass into compileContext, derived from token-policy.yaml.
// Returns undefined fields when the policy does not specify them, so the
// compiler falls back to its default fractions of the prompt budget.
export function policyBudgets(cwd = process.cwd()): {
  memoryTokenBudget?: number;
  fileTokenBudget?: number;
  handoffTokenBudget?: number;
  repoMapTokenBudget?: number;
  constraintTokenBudget?: number;
  decisionTokenBudget?: number;
} {
  const policy = readTokenPolicy(cwd);
  return {
    memoryTokenBudget: policy.maxMemoryTokens,
    fileTokenBudget: policy.maxFileSnippetTokens,
    handoffTokenBudget: policy.maxHandoffTokens,
    repoMapTokenBudget: policy.maxRepoMapTokens,
    constraintTokenBudget: policy.maxConstraintTokens,
    decisionTokenBudget: policy.maxDecisionTokens,
  };
}


// max_prompt_tokens is the authority for the whole pack budget; config.json's
// tokenBudget is the fallback for workspaces without a policy file. An explicit
// caller value (the `context --budget` flag) still wins, so the flag is never
// silently overridden by the policy.
export function resolveTokenBudget(
  cwd = process.cwd(),
  explicit?: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return readTokenPolicy(cwd).maxPromptTokens ?? readConfig(cwd).tokenBudget;
}


export function readConfig(cwd = process.cwd()): BridgeConfig {
  const config = readPersistedConfig(cwd, defaultConfig());
  if (config.graph) {
    delete (config.graph as Record<string, unknown>).autoBriefOnToolUse;
    delete (config.graph as Record<string, unknown>).injectRepoMap;
  }
  return config;
}


export function writeConfig(config: BridgeConfig, cwd = process.cwd()): void {
  writePersistedConfig(cwd, config);
}


export function renderCurrentTask(task: Task): string {
  return [
    "# Current Task",
    "",
    "## Title",
    task.title,
    "",
    "## Status",
    task.status,
    "",
    "## Goal",
    task.goal || "No explicit goal recorded.",
    "",
    "## Next Actions",
    "- Compile context for the next agent.",
    "- Inspect relevant files.",
    "- Run focused verification.",
    "",
  ].join("\n");
}


// Redact secrets from text before it is persisted, unless the project config
// explicitly disables redaction. Applied at every ingestion point so secrets
// never reach memories.db / handoff files in plaintext.
export function redactIfEnabled(text: string, cwd = process.cwd()): string {
  return readConfig(cwd).security?.redactSecrets === false
    ? text
    : redactSecrets(text);
}
