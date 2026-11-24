import { paths, readConfig, defaultConfig, renderCurrentTask, writeConfig } from './workspace-config.js';
import { readSessionProcessStart, sessionProcessLiveness } from "./session-process.js";
export { paths, memoryDir, policyBudgets, readTokenPolicy, type TokenPolicy, readConfig, type BridgeConfig, defaultConfig, redactIfEnabled, renderCurrentTask, resolveTokenBudget, writeConfig } from './workspace-config.js';

﻿import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOptionalEmbeddingProvider, SQLiteMemoryStore, type AgentKind, type Handoff, type RecordSessionEventInput, type SessionEvent, type Task } from "@agent-bridge/memory";
import { shouldSeedTitle } from "./task-suggestions.js";
import {
  claudeManagedSection,
  codexManagedSection,
  patchManagedSection,
  type CliApprovalPolicy,
  type CliInvocationSettings,
} from "@agent-bridge/adapters";

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
        "  max_repo_map_tokens: 1000",
        "  max_constraint_tokens: 400",
        "  max_decision_tokens: 400",
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

export function endAgentSession(
  sessionId: string | undefined,
  cwd = process.cwd(),
  completion?: { taskId: string; agent: AgentKind; writersStopped: true; reason: string },
): void {
  if (!sessionId) return;
  const config = readConfig(cwd);
  if (completion) {
    if (config.sessionTasks?.[sessionId] !== completion.taskId ||
        (config.activeSessions?.[sessionId] && config.activeSessions[sessionId] !== completion.agent)) {
      throw new Error("Session/task/agent ownership mismatch");
    }
    const pid = config.sessionWindows?.[sessionId]?.pid;
    if (pid && isSessionProcessAlive(pid)) throw new Error("Session writers are still running");
    const store = openStore(cwd);
    try {
      store.releaseSessionFileLeases({ ...completion, sessionId }, completion.reason);
    } finally {
      store.close();
    }
  }
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
  const config = readConfig(cwd);
  const existing = config.sessionWindows?.[sessionId];
  const host = existing?.processStartedAt ? undefined : captureSessionHost(agent, terminalTitle(agent, taskId, sessionId));
  const capturedHwnd =
    hwnd ?? existing?.hwnd ?? host?.hwnd;
  if (!capturedHwnd && !existing && !host?.pid) return undefined;
  writeConfig({
    ...config,
    sessionWindows: {
      ...(config.sessionWindows ?? {}),
      [sessionId]: {
        ...existing,
        pid: host?.pid ?? existing?.pid,
        processStartedAt: host?.processStartedAt ?? existing?.processStartedAt,
        hwnd: capturedHwnd ?? existing?.hwnd,
        taskId,
        agent,
        updatedAt: new Date().toISOString(),
      },
    },
  }, cwd);
  return capturedHwnd ?? existing?.hwnd;
}

function captureSessionHost(agent: AgentKind, title: string): { hwnd?: string; pid?: number; processStartedAt?: string } | undefined {
  if (process.platform !== "win32") return undefined;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_TEST_CONTEXT) return undefined;
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
[void][AgentBridgeForegroundWindow]::SetConsoleTitle(${psString(title)})
$hwnd = [AgentBridgeForegroundWindow]::GetForegroundWindow()
$agentPid = $null
$agentStartedAt = $null
$cursorPid = ${process.ppid}
for ($depth = 0; $depth -lt 8 -and $cursorPid -gt 0; $depth++) {
  $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $cursorPid" -ErrorAction Stop
  if (-not $ancestor) { break }
  $nativeAgent = $ancestor.Name -ieq (${psString(agent === "antigravity" ? "agy" : agent)} + '.exe')
  $nodeAgent = $ancestor.Name -ieq 'node.exe' -and ([string]$ancestor.CommandLine).Replace([char]92, [char]47) -match '(@openai/codex|@anthropic-ai/claude-code|antigravity)'
  if (($nativeAgent -or $nodeAgent) -and $ancestor.CommandLine -notmatch '\\bapp-server\\b') {
    $agentPid = [int]$ancestor.ProcessId
    $agentStartedAt = $ancestor.CreationDate.ToUniversalTime().ToString('o')
    break
  }
  $cursorPid = [int]$ancestor.ParentProcessId
}
@{ hwnd = if ($hwnd -ne [IntPtr]::Zero) { $hwnd.ToInt64().ToString() } else { $null }; pid = $agentPid; processStartedAt = $agentStartedAt } | ConvertTo-Json -Compress
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
    const host = JSON.parse(output) as { hwnd?: string; pid?: number; processStartedAt?: string };
    return { hwnd: host.hwnd || undefined, pid: host.pid || undefined,
      processStartedAt: host.processStartedAt ? new Date(host.processStartedAt).toISOString() : undefined };
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
    isSessionProcessAlive?: (pid: number) => boolean;
    readSessionProcessStart?: (pid: number) => string | null | undefined;
  } = {},
): number {
  const config = readConfig(cwd);
  let closed = 0;

  for (const event of store.listActiveSessionEvents(500)) {
    if (terminalSessionKinds.has(event.kind)) continue;
    const sessionWindow = config.sessionWindows?.[event.sessionId];
    const liveness = options.isSessionProcessAlive && sessionWindow?.pid
      ? options.isSessionProcessAlive(sessionWindow.pid) ? "running" : "ended"
      : sessionProcessLiveness(sessionWindow, options.readSessionProcessStart ?? readSessionProcessStart);
    const processAlive = liveness === "running" ? true : liveness === "ended" ? false : undefined;
    if (processAlive === false) {
      store.recordSessionEvent({
        sessionId: event.sessionId,
        taskId: event.taskId,
        agent: event.agent,
        kind: "session_ended",
        summary: `${agentLabel(event.agent)} session marked ended after its terminal process closed.`,
      });
      endAgentSession(event.sessionId, cwd);
      closed += 1;
      continue;
    }
  }

  return closed;
}

function isSessionProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runtime bindings are durable in SQLite so old sessions can be resumed.
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
  writeConfig({ ...config, sessionTasks }, cwd);
}

export function syncTerminalNativeSession(
  terminalSessionId: string,
  nativeSessionId: string,
  cwd = process.cwd(),
): "initial" | "same" | "changed" {
  const config = readConfig(cwd);
  const previous = config.terminalNativeSessions?.[terminalSessionId];
  if (previous === nativeSessionId) return "same";
  const terminalNativeSessions = { ...(config.terminalNativeSessions ?? {}) };
  delete terminalNativeSessions[terminalSessionId];
  terminalNativeSessions[terminalSessionId] = nativeSessionId;
  writeConfig({ ...config, terminalNativeSessions }, cwd);
  return previous ? "changed" : "initial";
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

  const candidates = store
    .listTasks(50)
    .filter(
      (task) =>
        !terminalTaskStatuses.has(task.status) &&
        (!agent || !task.ownerAgent || task.ownerAgent === agent),
    );
  if (candidates.length > 1) throw new Error("Ambiguous active task. Pass --task or use the session binding.");
  const fallback = candidates[0];
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

// Every unfinished task can carry its own handoff, so "which handoff do I
// continue?" is really "which task is this prompt about?". Score the prompt
// against each open task's title, goal and handoff text; an explicit
// continuation phrase ("tiếp tục", "continue", ...) lowers the bar but never
// replaces evidence, so an unrelated new request still starts a new task.
const continuationPhrase =
  /(ti[eế]p t[uụ]c|l[aà]m ti[eế]p|l[aà]m n[oố]t|ho[aà]n thi[eệ]n|continue|resume|carry on|pick up where|finish the)/i;
const stopWords = new Set([
  "that", "this", "with", "from", "into", "have", "then", "when", "what",
  "please", "should", "would", "could", "there", "their", "about", "cho",
  "cua", "cùng", "được", "duoc", "trong", "theo", "nhung", "nhưng", "này",
  "nay", "vào", "vao", "task", "file", "code", "hãy", "hay", "cần", "can",
]);

export type ContinuationMatch = {
  task: Task;
  handoff?: Handoff;
  score: number;
};

type ContinuationStore = {
  getTask(id: string): Task | undefined;
  listTasks(limit?: number): Task[];
  getLatestHandoff(taskId: string): Handoff | undefined;
};

export function findContinuationTask(
  store: ContinuationStore,
  prompt: string,
  options: { excludeTaskId?: string; agent?: AgentKind } = {},
): ContinuationMatch | undefined {
  const promptTerms = significantTerms(prompt);
  if (!promptTerms.size) return undefined;
  const explicit = continuationPhrase.test(prompt);
  // Similar vocabulary is not enough evidence that a brand-new terminal
  // should take over an old task. That used to make the first prompt replace
  // the launcher's card (and even inherit another provider's card). Cross-task
  // adoption is reserved for an explicit continue/resume request.
  if (!explicit) return undefined;

  let best: ContinuationMatch | undefined;
  for (const task of store.listTasks(50)) {
    if (terminalTaskStatuses.has(task.status)) continue;
    if (task.id === options.excludeTaskId) continue;
    const handoff = store.getLatestHandoff(task.id);
    const haystack = significantTerms(
      [
        task.title,
        task.goal ?? "",
        handoff?.summary ?? "",
        ...(handoff?.next ?? []),
        ...(handoff?.filesChanged ?? []),
      ].join(" "),
    );
    let overlap = 0;
    for (const term of promptTerms) if (haystack.has(term)) overlap += 1;
    if (!overlap) continue;
    // A handoff is what makes a task resumable at all, so it outweighs a bare
    // title match; an explicit "continue" phrase is worth one extra term.
    const score = overlap + (handoff ? 1 : 0) + (explicit ? 1 : 0);
    if (!best || score > best.score) best = { task, handoff, score };
  }

  return best && best.score >= 3 ? best : undefined;
}

export function readCliApprovalPolicy(cwd: string, provider: string): CliApprovalPolicy | undefined {
  const policies = readConfig(cwd).cliApprovalPolicies;
  if (provider === "codex") return policies?.codex;
  if (provider === "antigravity") return policies?.antigravity;
  if (provider === "claude") return policies?.claude;
  return undefined;
}

export function readCliInvocationSettings(cwd: string, provider: string): CliInvocationSettings {
  const policies = readConfig(cwd).cliApprovalPolicies;
  return {
    policy: provider === "codex" ? policies?.codex : provider === "antigravity" ? policies?.antigravity : provider === "claude" ? policies?.claude : undefined,
    codexSandbox: provider === "codex" ? policies?.codexSandbox : undefined,
    antigravityMode: provider === "antigravity" ? policies?.antigravityMode : undefined,
  };
}

function significantTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !stopWords.has(word)),
  );
}

// Rebind this session to the task the prompt is continuing. Returns the task id
// to work with: the matched one when the prompt continues earlier work, the
// caller's own otherwise. A placeholder task the integration had just opened
// for this session is removed so the board does not fill with empty shells.
export function adoptContinuationTask(
  store: SQLiteMemoryStore,
  cwd: string,
  input: {
    prompt: string;
    agent: AgentKind;
    sessionId?: string;
    currentTaskId: string | null;
  },
): { taskId: string | null; adopted?: ContinuationMatch } {
  const current = input.currentTaskId
    ? store.getTask(input.currentTaskId)
    : undefined;
  // A task that already has real work on it is the session's task, not a shell
  // waiting to be reassigned; only an unnamed placeholder may be replaced.
  if (current && !shouldSeedTitle(current)) {
    return { taskId: current.id };
  }
  const match = findContinuationTask(store, input.prompt, {
    excludeTaskId: input.currentTaskId ?? undefined,
    agent: input.agent,
  });
  if (!match) return { taskId: input.currentTaskId };

  if (!store.getTaskContract(match.task.id))
    store.updateTask(match.task.id, { status: "in_progress" });
  rememberSessionTask(input.sessionId, match.task.id, cwd);
  setCurrentTask(match.task.id, cwd, input.agent);
  writeCurrentTaskArtifact(
    store.getTask(match.task.id) ?? match.task,
    cwd,
  );
  store.recordSessionEvent({
    sessionId: input.sessionId ?? `${input.agent}-continuation`,
    taskId: match.task.id,
    agent: input.agent,
    kind: "session_resumed",
    summary: `${input.agent} continued task "${match.task.title}" from its handoff.`,
  });
  if (current && store.listMemoriesForTask(current.id, 1).length === 0) {
    store.deleteTask(current.id);
    syncAfterTaskDeleted(store, current.id, cwd);
    setCurrentTask(match.task.id, cwd, input.agent);
  }
  return { taskId: match.task.id, adopted: match };
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
