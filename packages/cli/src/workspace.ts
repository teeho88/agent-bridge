import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONSOLIDATE_THRESHOLD,
  DEFAULT_DECAY_HALF_LIFE_DAYS,
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_MAX_POOL_SIZE,
  DEFAULT_MIN_CLUSTER_SIZE,
  loadOptionalEmbeddingProvider,
  SQLiteMemoryStore,
  type AgentKind,
  type LifecycleConfig,
  type RecordSessionEventInput,
  type SessionEvent,
  type Task,
} from "@agent-bridge/memory";
import {
  claudeManagedSection,
  codexManagedSection,
  patchManagedSection,
} from "@agent-bridge/adapters";
import { redactSecrets } from "@agent-bridge/core";

export type BridgeConfig = {
  version: 1;
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
  // Best-effort OS window handles captured when an agent terminal starts a
  // session. Used by the dashboard to focus an existing terminal window.
  sessionWindows?: Record<
    string,
    { hwnd: string; taskId: string; agent: AgentKind; updatedAt: string }
  >;
  pendingNewTasks?: Partial<Record<AgentKind, true>>;
  defaultAgent: AgentKind;
  tokenBudget: number;
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
  // Knowledge-graph settings. injectRepoMap controls whether `context compile`
  // adds the compact repo map; repoMapLimit caps how many files it lists.
  graph?: {
    injectRepoMap?: boolean;
    repoMapLimit?: number;
    includePaths?: string[];
    ignorePaths?: string[];
    // When true (default), Claude's PostToolUse hook auto-briefs each source file
    // it reads/edits, keeping the graph index warm for fast search. The hook is
    // always installed; this flag gates the behavior at runtime.
    autoBriefOnToolUse?: boolean;
    // When true (default), a running `agent-bridge watch` daemon auto-briefs source
    // files as they change on disk — the agent-agnostic path (codex/antigravity).
    // Gates the watcher's behavior so the UI can pause it without stopping it.
    watchAutoBrief?: boolean;
  };
};

export const memoryDir = ".agent-memory";
const terminalSessionKinds = new Set<SessionEvent["kind"]>([
  "session_ended",
  "session_paused",
  "stop_requested",
  "task_cancelled",
]);
export const DEFAULT_SESSION_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_SESSION_WINDOW_CHECK_INTERVAL_MS = 5 * 1000;
export const DEFAULT_UNTRACKED_SESSION_STALE_AFTER_MS = 5 * 1000;
const terminalTaskStatuses = new Set<Task["status"]>(["done", "cancelled"]);
const sessionWindowAliveCache = new Map<
  string,
  { checkedAtMs: number; alive: boolean | undefined }
>();

export function paths(cwd = process.cwd()) {
  return {
    cwd,
    memoryDir: join(cwd, memoryDir),
    database: join(cwd, memoryDir, "memories.db"),
    config: join(cwd, memoryDir, "config.json"),
    currentTask: join(cwd, memoryDir, "current-task.md"),
    compiledContext: join(cwd, memoryDir, "compiled-context.md"),
    handoffJson: join(cwd, memoryDir, "handoff.json"),
    handoffMd: join(cwd, memoryDir, "handoff.md"),
    tokenPolicy: join(cwd, memoryDir, "token-policy.yaml"),
    logs: join(cwd, memoryDir, "logs"),
    artifacts: join(cwd, memoryDir, "artifacts"),
    tasks: join(cwd, memoryDir, "tasks"),
  };
}

export function defaultConfig(): BridgeConfig {
  return {
    version: 1,
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
    graph: {
      injectRepoMap: true,
      repoMapLimit: 30,
      includePaths: [],
      ignorePaths: [],
      autoBriefOnToolUse: true,
      watchAutoBrief: true,
    },
  };
}

export function ensureWorkspace(cwd = process.cwd()): void {
  const p = paths(cwd);
  for (const dir of [p.memoryDir, p.logs, p.artifacts, p.tasks]) {
    mkdirSync(dir, { recursive: true });
  }
  const gitignore = join(p.memoryDir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      ["memories.db", "memories.db-wal", "memories.db-shm", ""].join("\n"),
      "utf8",
    );
  }
  if (!existsSync(p.config)) writeConfig(defaultConfig(), cwd);
  if (!existsSync(p.currentTask))
    writeFileSync(
      p.currentTask,
      "# Current Task\n\nNo current task.\n",
      "utf8",
    );
  if (!existsSync(p.compiledContext))
    writeFileSync(
      p.compiledContext,
      "# Agent Task Brief\n\nNo compiled context yet.\n",
      "utf8",
    );
  if (!existsSync(p.handoffMd))
    writeFileSync(
      p.handoffMd,
      "# Handoff\n\nNo handoff has been created yet.\n",
      "utf8",
    );
  if (!existsSync(p.tokenPolicy)) {
    writeFileSync(
      p.tokenPolicy,
      [
        "token_policy:",
        "  max_prompt_tokens: 4000",
        "  max_file_snippet_tokens: 1200",
        "  max_memory_tokens: 800",
        "  max_logs_tokens: 300",
        "  max_handoff_tokens: 600",
        "  prefer_summary_over_raw: true",
        "  include_tests_first: true",
        "  include_latest_handoff: true",
        "  include_decisions: true",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

export function initializeWorkspace(cwd = process.cwd()): string[] {
  ensureWorkspace(cwd);
  const p = paths(cwd);
  const gitStatus = ensureGitRepository(cwd);
  const store = new SQLiteMemoryStore(p.database);
  store.close();
  const agentsStatus = patchManagedSection(
    join(cwd, "AGENTS.md"),
    codexManagedSection(),
  );
  const claudeStatus = patchManagedSection(
    join(cwd, "CLAUDE.md"),
    claudeManagedSection(),
  );
  return [
    "Initialized agent-bridge.",
    gitStatus,
    `Created ${relativeToCwd(p.database, cwd)}`,
    `${title(agentsStatus)} AGENTS.md managed section`,
    `${title(claudeStatus)} CLAUDE.md managed section`,
    "",
    "Next:",
    '  agent-bridge task start "Your task"',
    "  agent-bridge context compile --agent codex",
  ];
}

function ensureGitRepository(cwd: string): string {
  if (existsSync(join(cwd, ".git"))) return "Git repository already initialized.";
  execFileSync("git", ["init"], { cwd, stdio: "ignore", windowsHide: true });
  return "Initialized git repository.";
}

export type TokenPolicy = {
  maxPromptTokens?: number;
  maxFileSnippetTokens?: number;
  maxMemoryTokens?: number;
  maxLogsTokens?: number;
  maxHandoffTokens?: number;
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
    preferSummaryOverRaw: values["prefer_summary_over_raw"] === true,
  };
}

// Per-section budgets to pass into compileContext, derived from token-policy.yaml.
// Returns undefined fields when the policy does not specify them, so the
// compiler falls back to its default fractions of the prompt budget.
export function policyBudgets(cwd = process.cwd()): {
  memoryTokenBudget?: number;
  fileTokenBudget?: number;
} {
  const policy = readTokenPolicy(cwd);
  return {
    memoryTokenBudget: policy.maxMemoryTokens,
    fileTokenBudget: policy.maxFileSnippetTokens,
  };
}

export function readConfig(cwd = process.cwd()): BridgeConfig {
  const p = paths(cwd);
  if (!existsSync(p.config)) return defaultConfig();
  return JSON.parse(readFileSync(p.config, "utf8")) as BridgeConfig;
}

export function writeConfig(config: BridgeConfig, cwd = process.cwd()): void {
  const p = paths(cwd);
  mkdirSync(p.memoryDir, { recursive: true });
  writeFileSync(p.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function openStore(cwd = process.cwd()): SQLiteMemoryStore {
  ensureWorkspace(cwd);
  return new SQLiteMemoryStore(paths(cwd).database, {
    lifecycle: readConfig(cwd).memory,
  });
}

// Opens the store with an optional embedding provider (loaded from
// AGENT_BRIDGE_EMBEDDING_MODULE). Without one, the store is purely lexical.
export async function openStoreWithEmbeddings(
  cwd = process.cwd(),
): Promise<SQLiteMemoryStore> {
  ensureWorkspace(cwd);
  const embeddingProvider =
    (await loadOptionalEmbeddingProvider()) ?? undefined;
  return new SQLiteMemoryStore(paths(cwd).database, {
    embeddingProvider,
    lifecycle: readConfig(cwd).memory,
  });
}

export function setCurrentTask(
  taskId: string,
  cwd = process.cwd(),
  agent?: AgentKind,
): void {
  const config = readConfig(cwd);
  const currentTasks = { ...(config.currentTasks ?? {}) };
  if (agent) currentTasks[agent] = taskId;
  writeConfig({ ...config, currentTaskId: taskId, currentTasks }, cwd);
}

export function clearCurrentTask(cwd = process.cwd(), agent?: AgentKind): void {
  const config = readConfig(cwd);
  const currentTasks = { ...(config.currentTasks ?? {}) };
  const staleTaskId = agent ? currentTasks[agent] : config.currentTaskId;
  if (agent) delete currentTasks[agent];
  const remainingTaskId =
    Object.values(currentTasks).find(
      (taskId) => taskId && taskId !== staleTaskId,
    ) ?? null;
  const currentTaskId =
    config.currentTaskId === staleTaskId
      ? remainingTaskId
      : config.currentTaskId;
  writeConfig({ ...config, currentTaskId, currentTasks }, cwd);
  writeNoCurrentTaskArtifact(cwd);
}

// Reconcile the agent's active session. Returns true only when the first
// prompt should open a fresh task. Three cases:
//  - Same session id as last time: a plain resume; keep its task. -> false
//  - A different but previously-seen session whose task still exists: restore
//    that task as current instead of clobbering it or duplicating it. -> false
//  - An unseen session: mark it pending so the first prompt starts a new task,
//    and clear the current task so old work is not overwritten. -> true
export function syncAgentSession(
  sessionId: string,
  cwd = process.cwd(),
  agent: AgentKind,
  store?: { getTask(id: string): Task | undefined },
): boolean {
  const config = readConfig(cwd);
  const currentSessions = { ...(config.currentSessions ?? {}) };
  const activeSessions = { ...(config.activeSessions ?? {}), [sessionId]: agent };
  if (config.currentSessions?.[agent] === sessionId) {
    writeConfig({ ...config, activeSessions }, cwd);
    return false;
  }
  const pendingNewTasks = { ...(config.pendingNewTasks ?? {}) };
  currentSessions[agent] = sessionId;

  const knownTaskId = config.sessionTasks?.[sessionId];
  const knownTask = knownTaskId ? store?.getTask(knownTaskId) : undefined;
  if (knownTask && !terminalTaskStatuses.has(knownTask.status)) {
    delete pendingNewTasks[agent];
    const currentTasks = { ...(config.currentTasks ?? {}) };
    currentTasks[agent] = knownTask.id;
    writeConfig(
      {
        ...config,
        currentSessions,
        activeSessions,
        currentTasks,
        currentTaskId: knownTask.id,
        pendingNewTasks,
      },
      cwd,
    );
    writeCurrentTaskArtifact(knownTask, cwd);
    return false;
  }

  pendingNewTasks[agent] = true;
  writeConfig({ ...config, currentSessions, activeSessions, pendingNewTasks }, cwd);
  clearCurrentTask(cwd, agent);
  return true;
}

// Start a session when an agent has no native lifecycle hook. Unlike
// syncAgentSession(), the caller already knows the task, so it must not mark a
// pending task or clear the agent's current task.
export function startAgentSession(
  sessionId: string,
  taskId: string,
  cwd = process.cwd(),
  agent: AgentKind,
): void {
  const config = readConfig(cwd);
  const activeSessions = { ...(config.activeSessions ?? {}), [sessionId]: agent };
  const currentSessions = { ...(config.currentSessions ?? {}), [agent]: sessionId };
  const currentTasks = { ...(config.currentTasks ?? {}), [agent]: taskId };
  const pendingNewTasks = { ...(config.pendingNewTasks ?? {}) };
  delete pendingNewTasks[agent];
  const sessionTasks = { ...(config.sessionTasks ?? {}) };
  delete sessionTasks[sessionId];
  sessionTasks[sessionId] = taskId;
  const keys = Object.keys(sessionTasks);
  if (keys.length > 100) {
    for (const stale of keys.slice(0, keys.length - 100)) delete sessionTasks[stale];
  }
  writeConfig({
    ...config,
    currentTaskId: taskId,
    activeSessions,
    currentSessions,
    currentTasks,
    pendingNewTasks,
    sessionTasks,
  }, cwd);
}

export function endAgentSession(sessionId: string | undefined, cwd = process.cwd()): void {
  if (!sessionId) return;
  const config = readConfig(cwd);
  if (!config.activeSessions?.[sessionId]) return;
  const activeSessions = { ...config.activeSessions };
  delete activeSessions[sessionId];
  const sessionWindows = { ...(config.sessionWindows ?? {}) };
  delete sessionWindows[sessionId];
  const currentSessions = { ...(config.currentSessions ?? {}) };
  const endedAgent = config.activeSessions[sessionId];
  if (endedAgent && currentSessions[endedAgent] === sessionId) {
    const replacement = Object.entries(activeSessions).find(([, agent]) => agent === endedAgent)?.[0];
    if (replacement) currentSessions[endedAgent] = replacement;
    else delete currentSessions[endedAgent];
  }
  writeConfig({ ...config, activeSessions, currentSessions, sessionWindows }, cwd);
}

export function rememberSessionWindowHandle(
  sessionId: string,
  taskId: string,
  agent: AgentKind,
  cwd = process.cwd(),
  hwnd?: string,
): string | undefined {
  const capturedHwnd =
    hwnd ?? captureForegroundWindowHandle(terminalTitle(agent, taskId, sessionId));
  if (!capturedHwnd) return undefined;
  const config = readConfig(cwd);
  writeConfig({
    ...config,
    sessionWindows: {
      ...(config.sessionWindows ?? {}),
      [sessionId]: {
        hwnd: capturedHwnd,
        taskId,
        agent,
        updatedAt: new Date().toISOString(),
      },
    },
  }, cwd);
  return capturedHwnd;
}

function captureForegroundWindowHandle(title?: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) return undefined;
  try {
    const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentBridgeForegroundWindow {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SetConsoleTitle(string lpConsoleTitle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
${title ? `[void][AgentBridgeForegroundWindow]::SetConsoleTitle(${psString(title)})` : ""}
$hwnd = [AgentBridgeForegroundWindow]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit 2 }
$hwnd.ToInt64()
`;
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function terminalTitle(agent: AgentKind, taskId: string, sessionId: string): string {
  return `AgentBridge ${agent} ${taskId} ${sessionId}`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function cleanupStaleAgentSessions(
  store: {
    listActiveSessionEvents(limit?: number): SessionEvent[];
    listSessionEvents(options?: { taskId?: string; sessionId?: string; limit?: number }): SessionEvent[];
    recordSessionEvent(input: RecordSessionEventInput): SessionEvent;
  },
  cwd = process.cwd(),
  options: {
    now?: Date;
    staleAfterMs?: number;
    untrackedStaleAfterMs?: number;
    windowCheckIntervalMs?: number;
    isSessionWindowAlive?: (hwnd: string) => boolean | undefined;
  } = {},
): number {
  const config = readConfig(cwd);
  const activeSessions = config.activeSessions ?? {};
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_SESSION_STALE_AFTER_MS;
  const untrackedStaleAfterMs =
    options.untrackedStaleAfterMs ?? DEFAULT_UNTRACKED_SESSION_STALE_AFTER_MS;
  const windowCheckIntervalMs =
    options.windowCheckIntervalMs ?? DEFAULT_SESSION_WINDOW_CHECK_INTERVAL_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  let closed = 0;

  for (const event of store.listActiveSessionEvents(500)) {
    if (terminalSessionKinds.has(event.kind)) continue;
    const tracked = Boolean(activeSessions[event.sessionId]);
    const ageMs = nowMs - Date.parse(event.createdAt);
    const hwnd = config.sessionWindows?.[event.sessionId]?.hwnd;
    const windowAlive = hwnd
      ? cachedSessionWindowAlive(
          hwnd,
          nowMs,
          options.isSessionWindowAlive ?? isSessionWindowAlive,
          windowCheckIntervalMs,
        )
      : undefined;
    if (windowAlive === true) continue;
    if (!tracked && ageMs > untrackedStaleAfterMs) {
      store.recordSessionEvent({
        sessionId: event.sessionId,
        taskId: event.taskId,
        agent: event.agent,
        kind: "session_ended",
        summary: `${agentLabel(event.agent)} session marked ended after losing active tracking.`,
      });
      endAgentSession(event.sessionId, cwd);
      closed += 1;
      continue;
    }
    if (windowAlive !== false && ageMs <= staleAfterMs) continue;
    store.recordSessionEvent({
      sessionId: event.sessionId,
      taskId: event.taskId,
      agent: event.agent,
      kind: "session_ended",
      summary: `${agentLabel(event.agent)} session marked ended after missing heartbeat.`,
    });
    endAgentSession(event.sessionId, cwd);
    closed += 1;
  }

  return closed;
}

function cachedSessionWindowAlive(
  hwnd: string,
  nowMs: number,
  checker: (hwnd: string) => boolean | undefined,
  cacheMs: number,
): boolean | undefined {
  if (cacheMs > 0) {
    const cached = sessionWindowAliveCache.get(hwnd);
    if (cached && nowMs - cached.checkedAtMs <= cacheMs) return cached.alive;
  }
  const alive = checker(hwnd);
  if (cacheMs > 0) {
    sessionWindowAliveCache.set(hwnd, { checkedAtMs: nowMs, alive });
  }
  return alive;
}

function isSessionWindowAlive(hwnd: string): boolean | undefined {
  if (process.platform !== "win32") return undefined;
  const numericHwnd = Number(hwnd);
  if (!Number.isFinite(numericHwnd) || numericHwnd <= 0) return false;
  const script = `
$hwnd = [IntPtr]${Math.trunc(numericHwnd)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentBridgeWindowAlive {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@
if ([AgentBridgeWindowAlive]::IsWindow($hwnd)) { exit 0 }
exit 2
`;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

// Record which task a session is working so a later resume of that session can
// restore it. Bounded to the most recent 100 sessions to keep config.json small.
export function rememberSessionTask(
  sessionId: string | undefined,
  taskId: string,
  cwd = process.cwd(),
): void {
  if (!sessionId) return;
  const config = readConfig(cwd);
  const sessionTasks = { ...(config.sessionTasks ?? {}) };
  delete sessionTasks[sessionId];
  sessionTasks[sessionId] = taskId;
  const keys = Object.keys(sessionTasks);
  if (keys.length > 100) {
    for (const stale of keys.slice(0, keys.length - 100))
      delete sessionTasks[stale];
  }
  writeConfig({ ...config, sessionTasks }, cwd);
}

// Consume the one-shot marker set at SessionStart. The first prompt in a new
// session must create a task instead of reviving any in-progress task.
export function consumePendingNewTask(
  cwd = process.cwd(),
  agent: AgentKind,
): boolean {
  const config = readConfig(cwd);
  if (!config.pendingNewTasks?.[agent]) return false;
  const pendingNewTasks = { ...config.pendingNewTasks };
  delete pendingNewTasks[agent];
  writeConfig({ ...config, pendingNewTasks }, cwd);
  return true;
}

export function syncAfterTaskDeleted(
  store: {
    getTask(id: string): Task | undefined;
    listTasks(limit?: number): Task[];
  },
  deletedTaskId: string,
  cwd = process.cwd(),
): void {
  const config = readConfig(cwd);
  const currentTasks = Object.fromEntries(
    Object.entries(config.currentTasks ?? {}).filter(
      ([, taskId]) => taskId !== deletedTaskId,
    ),
  ) as Partial<Record<AgentKind, string>>;
  const fallback =
    (config.currentTaskId === deletedTaskId
      ? Object.values(currentTasks).find(Boolean)
      : config.currentTaskId) ??
    store.listTasks(50).find((task) => !terminalTaskStatuses.has(task.status))
      ?.id ??
    null;
  writeConfig({ ...config, currentTaskId: fallback, currentTasks }, cwd);
  if (fallback) {
    const task = store.getTask(fallback);
    if (task) writeCurrentTaskArtifact(task, cwd);
  } else {
    writeNoCurrentTaskArtifact(cwd);
  }
}

// Resolve the active task id without throwing. Precedence: explicit flag,
// then the agent's own current task, then the shared fallback.
export function resolveCurrentTaskId(
  cwd = process.cwd(),
  explicit?: string,
  agent?: AgentKind,
): string | null {
  if (explicit) return explicit;
  const config = readConfig(cwd);
  if (agent && config.currentTasks?.[agent])
    return config.currentTasks[agent] ?? null;
  return config.currentTaskId;
}

export function getCurrentTaskId(
  cwd = process.cwd(),
  explicit?: string,
  agent?: AgentKind,
): string {
  const taskId = resolveCurrentTaskId(cwd, explicit, agent);
  if (!taskId)
    throw new Error(
      'No current task. Run `agent-bridge task start "..."` first.',
    );
  return taskId;
}

export function resolveActiveTaskId(
  store: {
    getTask(id: string): Task | undefined;
    listTasks(limit?: number): Task[];
  },
  cwd = process.cwd(),
  explicit?: string,
  agent?: AgentKind,
): string | null {
  if (explicit) return explicit;

  const configured = resolveCurrentTaskId(cwd, undefined, agent);
  if (configured) {
    const task = store.getTask(configured);
    if (task && !terminalTaskStatuses.has(task.status)) return task.id;
  }

  const fallback = store
    .listTasks(50)
    .find(
      (task) =>
        !terminalTaskStatuses.has(task.status) &&
        (!agent || !task.ownerAgent || task.ownerAgent === agent),
    );
  if (fallback) {
    setCurrentTask(fallback.id, cwd, agent);
    writeCurrentTaskArtifact(fallback, cwd);
    return fallback.id;
  }

  if (configured) clearCurrentTask(cwd, agent);
  return null;
}

export function getActiveTaskId(
  store: {
    getTask(id: string): Task | undefined;
    listTasks(limit?: number): Task[];
  },
  cwd = process.cwd(),
  explicit?: string,
  agent?: AgentKind,
): string {
  const taskId = resolveActiveTaskId(store, cwd, explicit, agent);
  if (!taskId)
    throw new Error(
      'No active task. Run `agent-bridge task start "..."` first.',
    );
  return taskId;
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

export function writeCurrentTaskArtifact(
  task: Task,
  cwd = process.cwd(),
): void {
  writeFileSync(paths(cwd).currentTask, renderCurrentTask(task), "utf8");
}

export function writeNoCurrentTaskArtifact(cwd = process.cwd()): void {
  writeFileSync(
    paths(cwd).currentTask,
    "# Current Task\n\nNo current task.\n",
    "utf8",
  );
}

export function syncCurrentTaskArtifact(
  store: { getTask(id: string): Task | undefined },
  taskId: string,
  cwd = process.cwd(),
): Task {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Current task missing from database: ${taskId}`);
  writeCurrentTaskArtifact(task, cwd);
  return task;
}

// Redact secrets from text before it is persisted, unless the project config
// explicitly disables redaction. Applied at every ingestion point so secrets
// never reach memories.db / handoff files in plaintext.
export function redactIfEnabled(text: string, cwd = process.cwd()): string {
  return readConfig(cwd).security?.redactSecrets === false
    ? text
    : redactSecrets(text);
}

// How long to wait for the FIRST byte on stdin before concluding nothing is
// coming. Once bytes are flowing there is no deadline — a large piped payload
// must never be truncated.
//
// Without this the wait is unbounded, and "unbounded" is not theoretical: a
// spawned agent CLI can hand its own still-open stdin pipe down to the shell it
// runs our commands in, so `echo x | agent-bridge memory add --stdin` never sees
// EOF. Observed live — an agy implementer finished editing the project, ran its
// completion commands, and the whole run sat at "running" with an empty log
// forever because one `memory add --stdin` was blocked on a pipe nobody would
// ever close. Failing fast turns that into the CLI's normal "No memory content"
// error, which the agent can see and act on.
export const STDIN_FIRST_BYTE_TIMEOUT_MS = 10_000;

export async function readStdinUtf8(
  timeoutMs = STDIN_FIRST_BYTE_TIMEOUT_MS,
  stream: NodeJS.ReadableStream & { isTTY?: boolean; destroy?: () => void } = process.stdin,
): Promise<string> {
  if (stream.isTTY) return "";
  const chunks: Buffer[] = [];
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<"idle">((resolve) => {
    timer = setTimeout(() => resolve("idle"), timeoutMs);
    timer.unref?.();
  });

  const read = (async (): Promise<"read"> => {
    for await (const chunk of stream) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return "read";
  })();
  // Destroying the stream below rejects this iteration; swallowing it here keeps
  // that from surfacing as an unhandled rejection.
  read.catch(() => undefined);

  const outcome = await Promise.race([read, idle]);
  if (outcome === "idle") {
    // destroy(), not pause(): a paused pipe is still an active libuv handle, so
    // the process would sit at the shell prompt after printing its error instead
    // of exiting — the same hang, one step later.
    stream.destroy?.();
    return "";
  }
  if (timer) clearTimeout(timer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function parseList(value?: string): string[] {
  return value
    ? value
        .split(/[,\n;]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function title(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function agentLabel(agent: AgentKind | undefined): string {
  if (!agent) return "Agent";
  return agent === "antigravity" ? "Antigravity" : agent[0].toUpperCase() + agent.slice(1);
}

function relativeToCwd(value: string, cwd: string): string {
  return resolve(value)
    .replace(resolve(cwd) + "\\", "")
    .replace(resolve(cwd) + "/", "");
}
