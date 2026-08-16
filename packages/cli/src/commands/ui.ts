import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, parse as parseUrl } from "node:url";
import type { Command } from "commander";
import {
  compileContext,
  defaultTokenStackModules,
  estimateTokenSavings,
} from "@agent-bridge/core";
import {
  extractGraph,
  renderRepoMap,
  type AgentKind,
  type AgentProvider,
  type AgentRequest,
  type AgentRequestStatus,
  type AgentRequestType,
  type AgentRunMode,
  type AgentRun,
  type AssignmentStatus,
  type FileLease,
  type FileLeaseMode,
  type MemoryType,
  type OrchestrationAutonomy,
  type RegisteredAgent,
  type SessionEvent,
  type Subtask,
  type SubtaskStatus,
  type Task,
  type TaskChange,
  type TaskChangeStatus,
  type TaskStatus,
} from "@agent-bridge/memory";
import {
  buildSpawnPreview,
  defaultCommandForProvider,
  listInstalledProviderCatalogs,
  listStaffableProviderCatalogs,
  providerDefaultCommands,
  reapAgentRuns,
  spawnAgentRun,
  stopAgentRun,
} from "@agent-bridge/adapters";
import { loadRuntimeProviderCatalogs } from "../provider-catalog.js";
import {
  addCustomDefaultAgentPreset,
  ensureDefaultAgentPresetStates,
  removeDefaultAgentPreset,
  restoreBuiltInDefaultAgentPresets,
  setDefaultAgentPresetSelection,
} from "../default-agent-presets.js";
import {
  CHANGE_REQUEST_EVENT_PREFIX,
  ensureAgentsForProviders,
  resolveAgentForPreference,
  resumeStatusFor,
  stepOrchestration,
  type ChangeRequestPayload,
  type QuestionAnswersPayload,
  type SpawnApprovalResponse,
} from "@agent-bridge/core";
import { getClaudeHookStatus, installClaudeHooks } from "./claude.js";
import { getAntigravityHookStatus, installAntigravityHooks } from "./antigravity.js";
import { executeSpawnRequest } from "./request.js";
import { listAdoptableSessions, respawnRun } from "./run.js";
import { makeOrchestratorDeps } from "./workforce.js";
import { generateReport } from "./report.js";
import {
  getActiveTaskId,
  ensureWorkspace,
  openStore,
  parseList,
  paths,
  policyBudgets,
  readConfig,
  resolveCurrentTaskId,
  resolveActiveTaskId,
  resolveTokenBudget,
  setCurrentTask,
  startAgentSession,
  endAgentSession,
  cleanupStaleAgentSessions,
  syncAfterTaskDeleted,
  syncCurrentTaskArtifact,
  writeCurrentTaskArtifact,
  writeConfig,
} from "../workspace.js";
import { renderDashboardHtml } from "../ui-page.js";
import { applyTaskLabelSuggestion } from "../task-suggestions.js";
import {
  computeBaseline,
  formatBaselineRunSummary,
  parseBaselineRun,
} from "../optimize-baseline.js";
import { refreshBriefs } from "../graph-brief.js";

type JsonBody = Record<string, unknown>;

const execFileAsync = promisify(execFile);

export function recordDirectSubtaskRunOutcome(store: ReturnType<typeof openStore>, run: AgentRun): void {
  const succeeded = run.status === "done";
  if (run.assignmentId) {
    store.updateAssignment(run.assignmentId, {
      status: succeeded ? "done" : "failed",
      resultSummary: succeeded
        ? "Agent process completed successfully; subtask is awaiting review."
        : `Agent process failed${run.exitCode == null ? "" : ` with exit code ${run.exitCode}`}.`,
    });
  }
  if (run.subtaskId) {
    store.updateSubtask(run.subtaskId, { status: succeeded ? "review" : "blocked" });
  }
  if (run.orchestrationId) {
    store.recordOrchestrationEvent({
      orchestrationId: run.orchestrationId,
      cycle: run.cycle ?? 0,
      phase: run.phase ?? "implement",
      kind: succeeded ? "run_ended" : "error",
      summary: succeeded
        ? `Agent run ${run.id} completed successfully; subtask is awaiting review.`
        : `Agent run ${run.id} failed${run.exitCode == null ? "" : ` with exit code ${run.exitCode}`}.`,
    });
  }
}

export function filterWorkBoardSessionEvents(
  events: SessionEvent[],
  orchestratedTaskIds: ReadonlySet<string>,
): SessionEvent[] {
  return events.filter((event) => !event.taskId || !orchestratedTaskIds.has(event.taskId));
}

export function inferContextAgent(
  task: Pick<Task, "id" | "ownerAgent"> | undefined,
  activeSessions: SessionEvent[],
  defaultAgent: AgentKind,
): AgentKind {
  return (
    activeSessions.find((event) => event.taskId === task?.id && event.agent)?.agent ??
    task?.ownerAgent ??
    defaultAgent
  );
}
const installableTools = new Map([
  ["repomix", "repomix"],
  ["ccusage", "ccusage"],
]);

// The watcher runs as a child of the UI server so the dashboard can start/stop it.
// Tracked at module scope; killed when the UI process exits to avoid orphans.
let uiWorkspace = process.cwd();
let watcherProcess: ChildProcess | null = null;
const defaultUiPort = 4783;

function isWatcherRunning(): boolean {
  return (
    watcherProcess !== null &&
    watcherProcess.exitCode === null &&
    !watcherProcess.killed
  );
}

function startWatcher(cwd: string): boolean {
  if (isWatcherRunning()) return true;
  const child = spawn(
    process.execPath,
    [process.argv[1], "watch", "--project", cwd],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const clear = (): void => {
    if (watcherProcess === child) watcherProcess = null;
  };
  child.on("exit", clear);
  child.on("error", clear);
  watcherProcess = child;
  return isWatcherRunning();
}

function stopWatcher(): void {
  if (watcherProcess) {
    watcherProcess.kill();
    watcherProcess = null;
  }
}

/**
 * Rebuilds the CLI package in place. Returns false when this is not a real
 * checkout (no package.json with a build script) so the caller can fall back
 * to telling the user what to run.
 */
function rebuildCliPackage(packageRoot: string): boolean {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (!manifest.scripts?.build) return false;
  } catch {
    return false;
  }

  console.log("Dashboard build is stale; rebuilding @agent-bridge/cli…");
  // Not every machine has a standalone `pnpm` on PATH — a Corepack-managed
  // Node install exposes only `corepack` and `npm`. Try each runner rather
  // than failing the rebuild on the first one that is missing.
  const runners: [string, string[]][] = [
    ["pnpm", ["run", "build"]],
    ["corepack", ["pnpm", "run", "build"]],
    ["npm", ["run", "build"]],
  ];
  for (const [command, args] of runners) {
    try {
      execFileSync(command, args, {
        cwd: packageRoot,
        stdio: "inherit",
        // These are shell shims (.cmd/.ps1) on Windows; without a shell,
        // spawning them fails outright with EINVAL.
        shell: process.platform === "win32",
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The published CLI serves the statically imported `dist/ui-page.js`. In a
 * checkout, editing `ui-page.ts` leaves that bundle stale, so the dashboard
 * would silently serve an outdated page. Rebuild it automatically instead of
 * making every UI edit cost a manual build step, and only refuse to launch
 * when the rebuild is impossible or did not take.
 */
export function assertUiPageFreshness(
  packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): void {
  const sourcePath = join(packageRoot, "src", "ui-page.ts");
  if (!existsSync(sourcePath)) return;

  const builtPath = join(packageRoot, "dist", "ui-page.js");
  const isStale = (): boolean =>
    !existsSync(builtPath) ||
    statSync(sourcePath).mtimeMs > statSync(builtPath).mtimeMs;
  if (!isStale()) return;

  if (rebuildCliPackage(packageRoot) && !isStale()) return;

  throw new Error(
    "UI source is newer than the compiled dashboard and the automatic rebuild failed. Run `pnpm --filter @agent-bridge/cli build` and start `agent-bridge ui` again.",
  );
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("Start the local agent-bridge management UI")
    .option("--port <port>", "port to listen on", String(defaultUiPort))
    .option("--project <path>", "project path", process.cwd())
    .action((options: { port: string; project: string }, command: Command) => {
      assertUiPageFreshness();
      const project = prepareUiWorkspace(options.project);
      const port = parseUiPort(options.port);
      const allowPortFallback =
        command.getOptionValueSource("port") === "default";
      const server = createServer((req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { error: message });
        });
      });

      listenUiServer(server, port, project, allowPortFallback);
      resumeAutoRuns(project);

      // Don't leave the watcher running after the UI server is gone.
      const cleanup = (): void => stopWatcher();
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
      });
    });
}

function listenUiServer(
  server: Server,
  port: number,
  project: string,
  allowPortFallback: boolean,
): void {
  const onListening = (): void => {
    server.off("error", onError);
    const address = server.address();
    const boundPort =
      typeof address === "object" && address ? address.port : port;
    console.log(`agent-bridge UI running at http://127.0.0.1:${boundPort}`);
    console.log(`Workspace: ${project}`);
  };
  const onError = (error: NodeJS.ErrnoException): void => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && allowPortFallback && port < 65535) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use; trying ${nextPort}.`);
      listenUiServer(server, nextPort, project, true);
      return;
    }
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Choose another port with --port.`
        : `Failed to start UI: ${error.message}`,
    );
    process.exitCode = 1;
  };

  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, "127.0.0.1");
}
export function parseUiPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UI port must be an integer from 1 to 65535.");
  }
  return port;
}
export function prepareUiWorkspace(projectPath: string): string {
  const project = resolve(projectPath);
  ensureWorkspace(project);
  uiWorkspace = project;
  return project;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = parseUrl(req.url ?? "/", true);
  const method = req.method ?? "GET";
  const cwd = uiWorkspace;

  if (method === "GET" && url.pathname === "/") {
    sendHtml(res, renderUiHtml(cwd));
    return;
  }

  if (method === "GET" && url.pathname === "/api/state") {
    try {
      const store = openStore(cwd);
      try {
        cleanupStaleAgentSessions(store);
        const activeTaskId = resolveActiveTaskId(store, cwd);
        const config = readConfig(cwd);
        const tasks = store.listTasks(30);
        const currentTask = activeTaskId
          ? store.getTask(activeTaskId)
          : undefined;
        // Keep the live session state separate from durable memories in the UI.
        // Fetch a wide window so the moderate-importance latest response is not
        // dropped before it can be presented as session state.
        const visibleMemories = activeTaskId
          ? store
              .listMemoriesForTask(activeTaskId, 1000)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          : [];
        const sessionState = visibleMemories.find((memory) =>
          memory.tags.includes("latest-response"),
        );
        const memories = visibleMemories.slice(0, 50);
        const compiledContext = activeTaskId
          ? safeRead(taskContextPath(activeTaskId)) ||
            safeRead(paths(cwd).compiledContext)
          : safeRead(paths(cwd).compiledContext);
        const handoff = activeTaskId
          ? store.getLatestHandoff(activeTaskId)
          : undefined;
        // Work Board is for direct/human agent sessions. Orchestrated tasks
        // already have a dedicated Runs board, so duplicating their sessions
        // here makes one orchestration look like many unrelated live tasks.
        const activeSessionEvents = store.listActiveSessionEvents(100);
        const orchestratedTaskIds = new Set(
          store.listOrchestrations({ limit: 500 }).map((orchestration) => orchestration.taskId),
        );
        const workBoardSessionEvents = filterWorkBoardSessionEvents(
          activeSessionEvents,
          orchestratedTaskIds,
        );
        const liveTaskIds = new Set(
          workBoardSessionEvents
            .map((event) => event.taskId)
            .filter((taskId): taskId is string => Boolean(taskId)),
        );
        const liveTasks = tasks
          .filter(
            (task) =>
              task.status !== "done" &&
              task.status !== "cancelled" &&
              liveTaskIds.has(task.id),
          )
          .map((task) => {
            const taskMemories = store
              .listMemoriesForTask(task.id, 1000)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            const taskSessionState = taskMemories.find((memory) =>
              memory.tags.includes("latest-response"),
            );
            const taskVisibleMemories = taskMemories.slice(0, 50);
            const taskHandoff = store.getLatestHandoff(task.id);
            const taskCompiledContext = safeRead(taskContextPath(task.id));
            const leases = store.listFileLeases({
              taskId: task.id,
              activeOnly: true,
              limit: 100,
            });
            const changes = taskChangesWithWriteLeases(
              cwd,
              store.listTaskChanges(task.id, 100),
              leases,
            );
            return {
              task,
              hasActiveSession: liveTaskIds.has(task.id),
              sessions: workBoardSessionEvents
                .filter((event) => event.taskId === task.id)
                .map((event) => ({
                  ...event,
                  hasWindow: Boolean(
                    config.sessionWindows?.[event.sessionId]?.windowId ||
                    config.sessionWindows?.[event.sessionId]?.hwnd,
                  ),
                })),
              events: store.listSessionEvents({ taskId: task.id, limit: 12 }),
              sessionState: taskSessionState,
              memories: taskVisibleMemories,
              handoff: taskHandoff,
              compiledContext: taskCompiledContext,
              tokenStats: estimateTokenSavings({
                task,
                memories: taskSessionState
                  ? [taskSessionState, ...taskVisibleMemories]
                  : taskVisibleMemories,
                compiledContext: taskCompiledContext,
                handoff: taskHandoff,
              }),
              lane: store.getTaskLane(task.id),
              changes: enrichTaskChanges(cwd, changes),
              leases,
              requests: visibleAgentRequests(store.listAgentRequests({
                taskId: task.id,
                status: "pending",
                limit: 100,
              })),
            };
          });
        const repoMemories = store.listRepoMemories(50);
        const repoMemoryCandidates = store.listMemoryCandidates("pending", 50);
        const taskLanes = store.listTaskLanes(undefined, 100);
        const fileLeases = store.listFileLeases({
          activeOnly: true,
          limit: 200,
        });
        const taskChanges = activeTaskId
          ? enrichTaskChanges(
              cwd,
              taskChangesWithWriteLeases(
                cwd,
                store.listTaskChanges(activeTaskId, 200),
                fileLeases.filter((lease) => lease.taskId === activeTaskId),
              ),
            )
          : [];
        const agentRequests = visibleAgentRequests(store.listAgentRequests({
          limit: 100,
        }));
        const claudeHookStatus = getClaudeHookStatus(cwd);
        const claudeHookInstalled = claudeHookStatus.installed;
        const antigravityHookStatus = getAntigravityHookStatus(cwd);
        const tokenStats = estimateTokenSavings({
          task: currentTask,
          memories: sessionState ? [sessionState, ...memories] : memories,
          compiledContext,
          handoff,
        });
        const defaultAgentPresets = ensureDefaultAgentPresetStates(store);
        sendJson(res, 200, {
          workspace: cwd,
          config,
          tasks,
          currentTask,
          liveTasks,
          repoMemories,
          repoMemoryCandidates,
          taskLanes,
          fileLeases,
          taskChanges,
          agentRequests,
          registeredAgents: store.listRegisteredAgents({ limit: 500 }),
          defaultAgentPresets,
          credentialRefs: store.listCredentialRefs(),
          subtasks: activeTaskId
            ? store.listSubtasks({ parentTaskId: activeTaskId, limit: 500 })
            : [],
          assignments: activeTaskId
            ? store.listAssignments({ taskId: activeTaskId, limit: 500 })
            : [],
          dispatchRuns: activeTaskId
            ? store.listDispatchRuns({ taskId: activeTaskId, limit: 100 })
            : [],
          activeSessionEvents,
          sessionState,
          memories,
          compiledContext,
          handoff,
          claudeHookInstalled,
          claudeHookStatus,
          antigravityHookStatus,
          watcherRunning: isWatcherRunning(),
          optionalTools: optionalToolsStatus(),
          tokenStack: tokenStackStatus(),
          tokenStats,
          graphStats: store.getGraphStats(),
          optimizeStats: optimizeStats(store),
          serverTime: new Date().toISOString(),
        });
      } finally {
        store.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 200, {
        workspace: cwd,
        config: readConfig(cwd),
        tasks: [],
        currentTask: undefined,
        memories: [],
        compiledContext: safeRead(paths(cwd).compiledContext),
        liveTasks: [],
        repoMemories: [],
        repoMemoryCandidates: [],
        taskLanes: [],
        fileLeases: [],
        taskChanges: [],
        agentRequests: [],
        registeredAgents: [],
        defaultAgentPresets: [],
        credentialRefs: [],
        subtasks: [],
        assignments: [],
        dispatchRuns: [],
        activeSessionEvents: [],
        handoff: undefined,
        claudeHookInstalled: getClaudeHookStatus(cwd).installed,
        claudeHookStatus: getClaudeHookStatus(cwd),
        antigravityHookStatus: getAntigravityHookStatus(cwd),
        watcherRunning: isWatcherRunning(),
        optionalTools: optionalToolsStatus(),
        tokenStack: tokenStackStatus(),
        tokenStats: estimateTokenSavings({
          memories: [],
          compiledContext: safeRead(paths(cwd).compiledContext),
        }),
        dbError: message,
        serverTime: new Date().toISOString(),
      });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/task/start") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = parseAgentKind(optionalString(body.agent) ?? "claude");
      const task = store.createTask({
        title: requiredString(body.title, "title"),
        goal: optionalString(body.goal),
        ownerAgent: agent,
      });
      setCurrentTask(task.id, cwd, agent);
      const sessionId = readConfig(cwd).currentSessions?.[agent];
      if (sessionId) {
        startAgentSession(sessionId, task.id, cwd, agent);
        store.recordSessionEvent({
          sessionId,
          taskId: task.id,
          agent,
          kind: "session_resumed",
          summary: `${agentLabel(agent)} session bound to UI-started task.`,
        });
      }
      store.addMemory({
        taskId: task.id,
        type: "task",
        content: task.goal ? `${task.title}: ${task.goal}` : task.title,
        importance: 5,
        sourceAgent: task.ownerAgent,
      });
      writeCurrentTaskArtifact(task, cwd);
      sendJson(res, 200, { task });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/agent") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = store.createRegisteredAgent({
        name: requiredString(body.name, "name"),
        description: optionalString(body.description),
        provider: parseAgentProvider(requiredString(body.provider, "provider")),
        mode: parseAgentRunMode(requiredString(body.mode, "mode")),
        command: optionalString(body.command),
        baseUrl: optionalString(body.baseUrl),
          model: optionalString(body.model),
          reasoningEffort: optionalString(body.reasoningEffort),
        credentialRef: optionalString(body.credentialRef),
        capabilities: parseItems(body.capabilities),
      });
      sendJson(res, 200, { agent });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/agent/toggle") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = resolveRegisteredAgent(
        store.listRegisteredAgents({ limit: 500 }),
        requiredString(body.agentId, "agentId"),
      );
      if (!agent) throw new Error("Agent not found.");
      const enabledValue = optionalString(body.enabled);
      const enabled = enabledValue === "true" || body.enabled === true;
      const updated = store.updateRegisteredAgent(agent.id, { enabled });
      sendJson(res, 200, { agent: updated });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/default-agent/toggle") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const selectedValue = optionalString(body.selected);
      const selected = selectedValue === "true" || body.selected === true;
      const agent = setDefaultAgentPresetSelection(
        store,
        requiredString(body.presetKey, "presetKey"),
        selected,
      );
      sendJson(res, 200, { agent, selected });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/default-agent/create") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = addCustomDefaultAgentPreset(store, {
        label: requiredString(body.label ?? body.name, "label"),
        description: optionalString(body.description),
        provider: parseAgentProvider(requiredString(body.provider, "provider")),
        mode: parseAgentRunMode(optionalString(body.mode) ?? "cli"),
        command: optionalString(body.command),
        model: optionalString(body.model),
        reasoningEffort: optionalString(body.reasoningEffort),
        capabilities: parseItems(body.capabilities),
      });
      sendJson(res, 200, { agent, presets: ensureDefaultAgentPresetStates(store) });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/default-agent/delete") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const removed = removeDefaultAgentPreset(store, requiredString(body.presetKey, "presetKey"));
      sendJson(res, 200, { removed });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/default-agent/restore") {
    const store = openStore(cwd);
    try {
      sendJson(res, 200, { presets: restoreBuiltInDefaultAgentPresets(store) });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/agent/update") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = resolveRegisteredAgent(
        store.listRegisteredAgents({ limit: 500 }),
        requiredString(body.agentId, "agentId"),
      );
      if (!agent) throw new Error("Agent not found.");
      const updated = store.updateRegisteredAgent(agent.id, {
        name: optionalString(body.name),
        description: optionalString(body.description),
        provider: body.provider ? parseAgentProvider(requiredString(body.provider, "provider")) : undefined,
        mode: body.mode ? parseAgentRunMode(requiredString(body.mode, "mode")) : undefined,
        command: optionalString(body.command),
        baseUrl: optionalString(body.baseUrl),
        model: optionalString(body.model),
        // The dashboard always sends this field, so an empty value is the user
        // picking "default" — store it as such instead of letting the update's
        // keep-current fallback pin the agent to its old effort level forever.
        reasoningEffort:
          body.reasoningEffort === undefined
            ? undefined
            : (optionalString(body.reasoningEffort) ?? ""),
        credentialRef: optionalString(body.credentialRef),
        capabilities: body.capabilities !== undefined ? parseItems(body.capabilities) : undefined,
      });
      sendJson(res, 200, { agent: updated });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/agent/delete") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = resolveRegisteredAgent(
        store.listRegisteredAgents({ limit: 500 }),
        requiredString(body.agentId, "agentId"),
      );
      if (!agent) throw new Error("Agent not found.");
      if (agent.presetKey) {
        setDefaultAgentPresetSelection(store, agent.presetKey, false);
        sendJson(res, 200, { deleted: false, presetDeselected: true });
      } else {
        const deleted = store.deleteRegisteredAgent(agent.id);
        sendJson(res, 200, { deleted });
      }
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/start") {
    const body = await readJson(req);
    const agent = parseAgentKind(optionalString(body.agent) ?? "codex");
    const store = openStore(cwd);
    try {
      const taskId =
        optionalString(body.taskId) ??
        resolveActiveTaskId(store, cwd, undefined, agent);
      const task = taskId ? store.getTask(taskId) : undefined;
      if (!task)
        throw new Error("Choose an active task before starting a session.");
      const sessionId = `${agent}-${randomUUID()}`;
      startAgentSession(sessionId, task.id, cwd, agent);
      store.recordSessionEvent({
        sessionId,
        taskId: task.id,
        agent,
        kind: "session_started",
        summary: `${agentLabel(agent)} session started.`,
      });
      writeCurrentTaskArtifact(task, cwd);
      sendJson(res, 200, { sessionId, task });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/terminal") {
    const body = await readJson(req);
    const agent = parseAgentKind(requiredString(body.agent, "agent"));
    if (!(["claude", "codex", "antigravity"] as AgentKind[]).includes(agent)) {
      throw new Error("Terminal launcher supports Claude, Codex, and Antigravity.");
    }
    if (process.platform !== "win32") {
      throw new Error("Agent terminal launch is currently implemented for Windows.");
    }
    const command = agent === "antigravity" ? "agy" : agent;
    if (!commandExists(command)) throw new Error(`${command} is not installed or not on PATH.`);
    const store = openStore(cwd);
    try {
      const task = store.createTask({
        title: `${agentLabel(agent)} terminal`,
        goal: `Interactive ${agentLabel(agent)} CLI opened from Work Board.`,
        ownerAgent: agent,
      });
      const sessionId = `${agent}-terminal-${randomUUID()}`;
      startAgentSession(sessionId, task.id, cwd, agent);
      store.recordSessionEvent({
        sessionId,
        taskId: task.id,
        agent,
        kind: "session_started",
        summary: `${agentLabel(agent)} terminal opened from Work Board.`,
      });
      writeCurrentTaskArtifact(task, cwd);
      try {
        const terminal = launchAgentTerminal(
          cwd,
          task,
          agent,
          sessionId,
          command,
          req.socket.localPort ?? defaultUiPort,
        );
        sendJson(res, 200, { task, sessionId, terminal });
      } catch (error) {
        endAgentSession(sessionId, cwd);
        throw error;
      }
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/window") {
    const body = await readJson(req);
    const sessionId = requiredString(body.sessionId, "sessionId");
    const windowId = requiredString(body.windowId, "windowId");
    const pid = Number(body.pid);
    const hwnd = optionalString(body.hwnd);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer.");
    if (hwnd && (!Number.isFinite(Number(hwnd)) || Number(hwnd) <= 0)) {
      throw new Error("hwnd must be a positive integer string.");
    }
    const config = readConfig(cwd);
    const agent = config.activeSessions?.[sessionId];
    const taskId = config.sessionTasks?.[sessionId];
    if (!agent || !taskId) throw new Error("The terminal session is no longer active.");
    writeConfig({
      ...config,
      sessionWindows: {
        ...(config.sessionWindows ?? {}),
        [sessionId]: {
          ...config.sessionWindows?.[sessionId],
          windowId,
          pid,
          hwnd,
          taskId,
          agent,
          updatedAt: new Date().toISOString(),
        },
      },
    }, cwd);
    sendJson(res, 200, { sessionId, windowId, pid });
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/focus") {
    const body = await readJson(req);
    const requestedTaskId = optionalString(body.taskId);
    const requestedSessionId = optionalString(body.sessionId);
    const requestedAgent = optionalString(body.agent)
      ? parseAgentKind(requiredString(body.agent, "agent"))
      : undefined;
    const store = openStore(cwd);
    try {
      const activeSessions = store.listActiveSessionEvents(200);
      const event =
        (requestedSessionId
          ? activeSessions.find(
              (item) =>
                item.sessionId === requestedSessionId &&
                (!requestedAgent || item.agent === requestedAgent),
            )
          : undefined) ??
        (requestedTaskId
          ? activeSessions.find(
              (item) =>
                item.taskId === requestedTaskId &&
                (!requestedAgent || item.agent === requestedAgent),
            )
          : undefined) ??
        (requestedTaskId
          ? activeSessions.find((item) => item.taskId === requestedTaskId)
          : undefined);
      const taskId = requestedTaskId ?? event?.taskId;
      const task = taskId ? store.getTask(taskId) : undefined;
      if (!task) throw new Error("No active task found for this window.");
      const agent = parseAgentKind(
        requestedAgent ?? event?.agent ?? task.ownerAgent ?? "codex",
      );
      const sessionId = requestedSessionId ?? event?.sessionId;
      if (!sessionId)
        throw new Error("No active agent session found for this task.");
      const config = readConfig(cwd);
      const focus = focusAgentTerminal(task, agent, sessionId, config.sessionWindows?.[sessionId]);
      sendJson(res, 200, { task, sessionId, focus });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/summary") {
    const body = await readJson(req);
    const agent = parseAgentKind(optionalString(body.agent) ?? "codex");
    const config = readConfig(cwd);
    const sessionId = config.currentSessions?.[agent];
    if (!sessionId)
      throw new Error(`No active ${agent} session. Start one first.`);
    const store = openStore(cwd);
    try {
      const taskId =
        optionalString(body.taskId) ??
        config.sessionTasks?.[sessionId] ??
        resolveActiveTaskId(store, cwd, undefined, agent);
      if (!taskId || !store.getTask(taskId))
        throw new Error("No active task for this session.");
      const text = requiredString(body.text, "state");
      store.upsertLatestMemory(
        {
          taskId,
          type: "note",
          content: `${agentLabel(agent)} latest response: ${text}`,
          importance: 3,
          sourceAgent: agent,
          tags: [agent, "latest-response"],
        },
        {
          latestTag: "latest-response",
          legacyContentPrefix: `${agentLabel(agent)} latest response:`,
        },
      );
      const task = applyTaskLabelSuggestion(store, taskId, { titleText: text, goalText: text });
      if (task) writeCurrentTaskArtifact(task, cwd);
      store.recordSessionEvent({
        sessionId,
        taskId,
        agent,
        kind: "assistant_summary",
        summary: `${agentLabel(agent)} updated session state.`,
      });
      sendJson(res, 200, { ok: true });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/end") {
    const body = await readJson(req);
    const agent = parseAgentKind(optionalString(body.agent) ?? "codex");
    const config = readConfig(cwd);
    const sessionId = config.currentSessions?.[agent];
    if (!sessionId) throw new Error(`No active ${agent} session.`);
    const store = openStore(cwd);
    try {
      const taskId =
        optionalString(body.taskId) ?? config.sessionTasks?.[sessionId];
      store.recordSessionEvent({
        sessionId,
        taskId,
        agent,
        kind: "session_ended",
        summary: `${agentLabel(agent)} session ended.`,
      });
      endAgentSession(sessionId, cwd);
      sendJson(res, 200, { ok: true });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/task/update") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = optionalString(body.agent) as AgentKind | undefined;
      const taskId =
        optionalString(body.taskId) ??
        getActiveTaskId(store, cwd, undefined, agent);
      const task = store.updateTask(taskId, {
        title: optionalString(body.title),
        goal: typeof body.goal === "string" ? body.goal.trim() : undefined,
        status: parseTaskStatus(optionalString(body.status)),
        ownerAgent: agent,
      });
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const currentId = resolveCurrentTaskId();
      if (!optionalString(body.taskId) || currentId === task.id) {
        setCurrentTask(task.id, cwd, agent ?? task.ownerAgent);
        writeCurrentTaskArtifact(task, cwd);
      }
      store.addMemory({
        taskId: task.id,
        type: "task",
        content: `Task updated: ${task.title} (${task.status})`,
        importance: 4,
        sourceAgent: agent ?? task.ownerAgent,
      });
      sendJson(res, 200, { task });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/task/delete") {
    const body = await readJson(req);
    const taskId = requiredString(body.taskId, "taskId");
    const store = openStore(cwd);
    try {
      // Kill any auto-run loop first: once the rows are gone its next tick
      // would step an orchestration that no longer exists.
      const doomed = store.getOrchestrationByTask(taskId);
      if (doomed) stopAutoRun(doomed.id);
      const deleted = store.deleteTask(taskId);
      if (!deleted) throw new Error(`Task not found: ${taskId}`);
      syncAfterTaskDeleted(store, taskId, cwd);
      sendJson(res, 200, { ok: true });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/task/stop") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      const task = store.updateTaskStatus(taskId, "blocked");
      const agent = optionalString(body.agent) as AgentKind | undefined;
      store.recordSessionEvent({
        sessionId:
          optionalString(body.sessionId) ?? `${agent ?? "generic"}-control`,
        taskId,
        agent,
        kind: "stop_requested",
        summary:
          optionalString(body.reason) ?? "Stop requested from dashboard.",
      });
      sendJson(res, 200, { task });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/task/prompt") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      const agent = optionalString(body.agent) as AgentKind | undefined;
      const text = requiredString(body.text, "text");
      const event = store.recordSessionEvent({
        sessionId:
          optionalString(body.sessionId) ?? `${agent ?? "generic"}-prompt`,
        taskId,
        agent,
        kind: "user_prompt",
        summary: text,
      });
      sendJson(res, 200, { event });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/orchestration/lane") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      const lane = store.upsertTaskLane({
        taskId,
        mode: parseLaneMode(optionalString(body.mode) ?? "patch"),
        baseRef: optionalString(body.baseRef),
        baseCommit: optionalString(body.baseCommit),
        worktreePath: optionalString(body.worktreePath),
        status: parseLaneStatus(optionalString(body.status) ?? "active"),
      });
      sendJson(res, 200, { lane });
    } finally {
      store.close();
    }
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/api/orchestration/lease/acquire"
  ) {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = optionalString(body.agent) as AgentKind | undefined;
      const taskId =
        optionalString(body.taskId) ??
        getActiveTaskId(store, cwd, undefined, agent);
      const result = store.acquireFileLease({
        taskId,
        path: requiredString(body.path, "path").replace(/\\/g, "/"),
        mode: parseLeaseMode(optionalString(body.mode) ?? "write"),
        agent,
        sessionId: optionalString(body.sessionId),
        baseHash: optionalString(body.baseHash),
        currentHash: optionalString(body.currentHash),
        ttlSeconds: Number(body.ttlSeconds ?? 3600),
      });
      sendJson(res, 200, result);
    } finally {
      store.close();
    }
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/api/orchestration/lease/release"
  ) {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const lease = store.releaseFileLease(
        requiredString(body.leaseId, "leaseId"),
      );
      if (!lease) throw new Error("Lease not found.");
      sendJson(res, 200, { lease });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/orchestration/change") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      const filePath = requiredString(body.path, "path").replace(/\\/g, "/");
      const change = store.upsertTaskChange({
        taskId,
        path: filePath,
        changeType: parseChangeType(
          optionalString(body.changeType) ?? "modified",
        ),
        baseHash: optionalString(body.baseHash),
        currentHash:
          optionalString(body.currentHash) ??
          contentHash(cwd, filePath),
        diffSummary: optionalString(body.diffSummary),
        status: parseChangeStatus(optionalString(body.status) ?? "pending"),
      });
      sendJson(res, 200, { change });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/orchestration/request") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const agent = optionalString(body.agent) as AgentKind | undefined;
      const taskId =
        optionalString(body.taskId) ??
        getActiveTaskId(store, cwd, undefined, agent);
      const request = store.createAgentRequest({
        taskId,
        sessionId: optionalString(body.sessionId),
        agent,
        type: parseRequestType(optionalString(body.type) ?? "question"),
        title: requiredString(body.title, "title"),
        payload: optionalString(body.payload),
      });
      store.recordSessionEvent({
        sessionId: request.sessionId ?? `${agent ?? "generic"}-request`,
        taskId,
        agent,
        kind: "request_created",
        summary: request.title,
      });
      sendJson(res, 200, { request });
    } finally {
      store.close();
    }
    return;
  }

  const requestSelectTaskMatch =
    /^\/api\/orchestration\/request\/([^/]+)\/select-task$/.exec(
      url.pathname ?? "",
    );
  if (method === "POST" && requestSelectTaskMatch) {
    const body = await readJson(req);
    const requestId = decodeURIComponent(requestSelectTaskMatch[1]!);
    const store = openStore(cwd);
    try {
      const request = store
        .listAgentRequests({ limit: 500 })
        .find((item) => item.id === requestId);
      if (!request) throw new Error("Request not found.");
      const taskId = request.taskId ?? optionalString(body.taskId);
      const task = taskId ? store.getTask(taskId) : undefined;
      if (!task) throw new Error("Request does not belong to an active task.");
      const agent = parseAgentKind(request.agent ?? task.ownerAgent ?? "codex");
      const sessionId = request.sessionId ?? `${agent}-${randomUUID()}`;
      startAgentSession(sessionId, task.id, cwd, agent);
      writeCurrentTaskArtifact(task, cwd);
      store.recordSessionEvent({
        sessionId,
        taskId: task.id,
        agent,
        kind: "session_resumed",
        summary: `Selected ${agentLabel(agent)} request task from dashboard.`,
      });
      sendJson(res, 200, { ok: true, sessionId, task });
    } finally {
      store.close();
    }
    return;
  }
  const requestExecuteMatch =
    /^\/api\/orchestration\/request\/([^/]+)\/execute$/.exec(
      url.pathname ?? "",
    );
  if (method === "POST" && requestExecuteMatch) {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const requestId = decodeURIComponent(requestExecuteMatch[1]!);
      if (Boolean(body.autoAccept) && !Boolean(body.dryRun)) {
        const accepted = store.resolveAgentRequest(
          requestId,
          "accepted",
          "Accepted from dashboard Execute.",
        );
        if (!accepted) throw new Error("Request not found.");
      }
      const result = await executeSpawnRequest(
        store,
        requestId,
        {
          dryRun: Boolean(body.dryRun),
          json: Boolean(body.json),
        },
      );
      sendJson(res, 200, { result });
    } finally {
      store.close();
    }
    return;
  }

  const requestResolveMatch =
    /^\/api\/orchestration\/request\/([^/]+)\/resolve$/.exec(
      url.pathname ?? "",
    );
  if (method === "POST" && requestResolveMatch) {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const request = store.resolveAgentRequest(
        decodeURIComponent(requestResolveMatch[1]!),
        parseRequestStatus(optionalString(body.status) ?? "resolved"),
        optionalString(body.response),
      );
      if (!request) throw new Error("Request not found.");
      store.recordSessionEvent({
        sessionId: request.sessionId ?? `${request.agent ?? "generic"}-request`,
        taskId: request.taskId,
        agent: request.agent,
        kind: "request_resolved",
        summary: `${request.title}: ${request.status}`,
      });
      sendJson(res, 200, { request });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/request/delete") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const deleted = store.deleteAgentRequest(requiredString(body.requestId, "requestId"));
      sendJson(res, 200, { deleted });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/request/clear") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : undefined;
      const targets = ids ?? store.listAgentRequests({
        taskId: optionalString(body.taskId),
        status: body.status ? parseRequestStatus(requiredString(body.status, "status")) : "pending",
        limit: 1000,
      }).map((request) => request.id);
      const deleted = store.deleteAgentRequests(targets);
      sendJson(res, 200, { deleted });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/memory/add") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId =
        optionalString(body.scope) === "repo"
          ? undefined
          : (optionalString(body.taskId) ?? getActiveTaskId(store, cwd));
      const memory = store.addMemory({
        taskId,
        type: (optionalString(body.type) ?? "note") as MemoryType,
        content: requiredString(body.content, "content"),
        tags: parseList(optionalString(body.tags)),
        importance: Number(body.importance ?? 3),
        sourceAgent: optionalString(body.agent) as AgentKind | undefined,
      });
      sendJson(res, 200, { memory });
    } finally {
      store.close();
    }
    return;
  }

  const candidateReviewMatch =
    /^\/api\/repo-memory\/candidates\/([^/]+)\/review$/.exec(
      url.pathname ?? "",
    );
  if (method === "POST" && candidateReviewMatch) {
    const body = await readJson(req);
    const action = requiredString(body.action, "action");
    if (action !== "promote" && action !== "reject") {
      throw new Error("action must be promote or reject");
    }
    const store = openStore(cwd);
    try {
      const candidate = store.reviewMemoryCandidate(
        decodeURIComponent(candidateReviewMatch[1]!),
        action,
      );
      if (!candidate)
        sendJson(res, 404, { error: "Memory candidate not found" });
      else sendJson(res, 200, { candidate });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/memory/search") {
    const query = String(url.query.q ?? "");
    const store = openStore(cwd);
    try {
      const results = query ? store.searchMemories(query, { limit: 30 }) : [];
      sendJson(res, 200, { results });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/tools/install") {
    const body = await readJson(req);
    const toolName = optionalString(body.name);
    if (!toolName || !installableTools.has(toolName)) {
      sendJson(res, 400, {
        error: "Unsupported tool. Allowed tools: repomix, ccusage.",
      });
      return;
    }

    const packageName = installableTools.get(toolName)!;
    try {
      const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = await execFileAsync(
        npmCommand,
        ["install", "-g", packageName],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      );
      sendJson(res, 200, {
        name: toolName,
        installed: commandExists(toolName),
        stdout: result.stdout.slice(-4000),
        stderr: result.stderr.slice(-4000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/antigravity/install-hooks") {
    try {
      const output = installAntigravityHooks(cwd);
      const antigravityHookStatus = getAntigravityHookStatus(cwd);
      sendJson(res, 200, {
        installed: antigravityHookStatus.installed,
        antigravityHookStatus,
        output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/claude/install-hooks") {
    try {
      const output = installClaudeHooks(cwd);
      const claudeHookStatus = getClaudeHookStatus(cwd);
      sendJson(res, 200, {
        installed: claudeHookStatus.installed,
        claudeHookStatus,
        output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/context/compile") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const config = readConfig(cwd);
      const taskId =
        optionalString(body.taskId) ??
        getActiveTaskId(store, cwd);
      const agent = inferContextAgent(
        store.getTask(taskId),
        store.listActiveSessionEvents(200),
        config.defaultAgent,
      );
      syncCurrentTaskArtifact(store, taskId, cwd);
      const tokenBudget = resolveTokenBudget(
        cwd,
        body.budget === undefined ? undefined : Number(body.budget),
      );
      let repoMap: string | undefined;
      if (
        config.graph?.injectRepoMap !== false &&
        store.getGraphStats().files > 0
      ) {
        const handoff = store.getLatestHandoff(taskId);
        const task = store.getTask(taskId);
        repoMap = renderRepoMap(
          store.buildRepoMap({
            limit: config.graph?.repoMapLimit ?? 30,
            recentTaskFiles: handoff?.filesChanged,
            task: task
              ? { id: task.id, title: task.title, goal: task.goal }
              : undefined,
          }),
        );
      }
      const pack = compileContext(store, {
        taskId,
        agent,
        tokenBudget,
        repoMap,
        ...policyBudgets(cwd),
      });
      writeTaskContext(taskId, pack.renderedMarkdown);
      if (resolveActiveTaskId(store, cwd) === taskId) {
        writeFileSync(
          paths(cwd).compiledContext,
          `${pack.renderedMarkdown}\n`,
          "utf8",
        );
      }
      sendJson(res, 200, { pack });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/context/save") {
    const body = await readJson(req);
    const content = requiredString(body.content, "content");
    const taskId = optionalString(body.taskId);
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    if (taskId) writeTaskContext(taskId, normalized);
    if (!taskId || taskId === resolveCurrentTaskId())
      writeFileSync(paths(cwd).compiledContext, normalized, "utf8");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/handoff/update") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const handoffId = requiredString(body.handoffId, "handoffId");
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      syncCurrentTaskArtifact(store, taskId, cwd);
      const handoff = store.updateHandoff({
        id: handoffId,
        taskId,
        fromAgent: optionalString(body.from) as AgentKind | undefined,
        toAgent: optionalString(body.to) as AgentKind | undefined,
        summary: requiredString(body.summary, "summary"),
        done: parseList(optionalString(body.done)),
        next: parseList(optionalString(body.next)),
        risks: parseList(optionalString(body.risks)),
        filesChanged: parseList(optionalString(body.filesChanged)),
      });
      writeFileSync(
        paths(cwd).handoffJson,
        `${JSON.stringify(handoff, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(paths(cwd).handoffMd, renderHandoffMarkdown(handoff), "utf8");
      sendJson(res, 200, { handoff });
    } finally {
      store.close();
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/handoff/create") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
      syncCurrentTaskArtifact(store, taskId, cwd);
      const handoff = store.upsertTaskHandoff({
        taskId,
        fromAgent: optionalString(body.from) as AgentKind | undefined,
        toAgent: optionalString(body.to) as AgentKind | undefined,
        summary: requiredString(body.summary, "summary"),
        done: parseList(optionalString(body.done)),
        next: parseList(optionalString(body.next)),
        risks: parseList(optionalString(body.risks)),
        filesChanged: parseList(optionalString(body.filesChanged)),
      });
      writeFileSync(
        paths(cwd).handoffJson,
        `${JSON.stringify(handoff, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(paths(cwd).handoffMd, renderHandoffMarkdown(handoff), "utf8");
      store.addMemory({
        taskId,
        type: "handoff",
        content: handoff.summary,
        summary: handoff.summary,
        importance: 5,
        sourceAgent: handoff.fromAgent,
      });
      sendJson(res, 200, { handoff });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/graph/build") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const root = optionalString(body.root) ?? cwd;
      const config = readConfig(cwd);
      const include =
        body.includePaths != null
          ? parseList(optionalString(body.includePaths))
          : (config.graph?.includePaths ?? []);
      const graphIgnore =
        body.ignorePaths != null
          ? parseList(optionalString(body.ignorePaths))
          : (config.graph?.ignorePaths ?? []);
      const ignore = [...(config.security?.ignorePaths ?? []), ...graphIgnore];
      const extracted = extractGraph(root, { ignore, include });
      store.replaceGraph(extracted);
      sendJson(res, 200, { stats: store.getGraphStats() });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/graph") {
    const store = openStore(cwd);
    try {
      const limit = Math.min(Number(url.query.limit ?? 120) || 120, 400);
      const focus = String(url.query.focus ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const taskId = resolveActiveTaskId(store, cwd);
      const task = taskId ? store.getTask(taskId) : undefined;
      const handoff = taskId ? store.getLatestHandoff(taskId) : undefined;
      sendJson(
        res,
        200,
        buildGraphView(
          store,
          limit,
          focus.length ? focus : undefined,
          task
            ? {
                task: { id: task.id, title: task.title, goal: task.goal },
                recentTaskFiles: handoff?.filesChanged,
              }
            : undefined,
        ),
      );
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/graph/brief-auto-all") {
    const store = openStore(cwd);
    try {
      if (store.getGraphStats().files === 0) {
        sendJson(res, 200, {
          refreshed: 0,
          message: "No graph yet. Build it first.",
        });
        return;
      }
      const results = refreshBriefs(store, cwd, { all: true });
      sendJson(res, 200, { refreshed: results.length });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/graph/brief") {
    const body = await readJson(req);
    const filePath = requiredString(body.path, "path").replace(/\\/g, "/");
    const store = openStore(cwd);
    try {
      const taskEdited = Boolean(body.taskEdited);
      const taskId = taskEdited
        ? getActiveTaskId(store, cwd)
        : optionalString(body.taskId);
      const file = store.upsertFileSummary({
        path: filePath,
        summary: requiredString(body.summary, "summary"),
        manualPriority:
          body.manualPriority == null || body.manualPriority === ""
            ? undefined
            : Number(body.manualPriority),
        importantRanges: parseList(optionalString(body.ranges)),
        lastSeenHash: contentHash(cwd, filePath),
        lastTaskId: taskId,
        markTaskEdited: taskEdited,
      });
      sendJson(res, 200, { file });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/config/graph") {
    const body = await readJson(req);
    const config = readConfig(cwd);
    const graph = { ...(config.graph ?? {}) };
    if (typeof body.injectRepoMap === "boolean")
      graph.injectRepoMap = body.injectRepoMap;
    if (typeof body.autoBriefOnToolUse === "boolean")
      graph.autoBriefOnToolUse = body.autoBriefOnToolUse;
    if (typeof body.watchAutoBrief === "boolean")
      graph.watchAutoBrief = body.watchAutoBrief;
    if (
      body.repoMapLimit != null &&
      Number.isFinite(Number(body.repoMapLimit))
    ) {
      graph.repoMapLimit = Math.max(
        1,
        Math.min(Number(body.repoMapLimit), 500),
      );
    }
    if (body.includePaths != null)
      graph.includePaths = parseList(optionalString(body.includePaths));
    if (body.ignorePaths != null)
      graph.ignorePaths = parseList(optionalString(body.ignorePaths));
    writeConfig({ ...config, graph });
    sendJson(res, 200, { graph });
    return;
  }

  if (method === "POST" && url.pathname === "/api/watch/start") {
    const running = startWatcher(cwd);
    sendJson(res, 200, { watcherRunning: running });
    return;
  }

  if (method === "POST" && url.pathname === "/api/watch/stop") {
    stopWatcher();
    sendJson(res, 200, { watcherRunning: false });
    return;
  }

  if (method === "POST" && url.pathname === "/api/optimize/baseline") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      if (store.getGraphStats().files === 0) {
        sendJson(res, 200, {
          result: null,
          message: "No graph yet. Build the graph first.",
        });
        return;
      }
      const config = readConfig(cwd);
      const limit = Number(body.limit ?? config.graph?.repoMapLimit ?? 40);
      const focusPaths =
        body.focus != null ? parseList(optionalString(body.focus)) : undefined;
      const result = computeBaseline(store, cwd, {
        limit,
        focusPaths,
        topN: 10,
      });
      if (!result) {
        sendJson(res, 200, {
          result: null,
          message: "Repo map is empty for that focus. Nothing to compare.",
        });
        return;
      }
      store.addRun({
        taskId: resolveCurrentTaskId() ?? undefined,
        agent: config.defaultAgent,
        command: "optimize baseline",
        resultSummary: formatBaselineRunSummary(result.summary),
        tokenEstimate: result.summary.optimizedTokens,
      });
      sendJson(res, 200, { result });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/workforce/catalog") {
    // `installed` is the subset whose CLI is on PATH, each flagged with whether
    // it can answer headlessly. The Start Orchestration form offers only the
    // headless ones as team providers — anything else would either fail at
    // spawn time or (Antigravity) open a GUI and return an empty log.
    const staffable = new Set(listStaffableProviderCatalogs().map((catalog) => catalog.provider));
    const provider = String(url.query.provider ?? "").trim();
    const runtimeCatalog = await loadRuntimeProviderCatalogs({ provider: provider || undefined });
    sendJson(res, 200, {
      catalogs: runtimeCatalog.catalogs,
      installed: listInstalledProviderCatalogs().map((catalog) => ({
        provider: catalog.provider,
        staffable: staffable.has(catalog.provider),
      })),
      // provider -> cli command, so the agent form can prefill Command the
      // moment a provider is picked (antigravity -> agy, and so on). Covers
      // providers with no model catalog too, which `catalogs` does not.
      defaultCommands: providerDefaultCommands(),
      catalogWarnings: runtimeCatalog.errors,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/workforce/board") {
    const requestedTaskId = String(url.query.task ?? "");
    const store = openStore(cwd);
    try {
      // Always report every orchestration so the UI can offer a picker.
      const allOrchestrations = store.listOrchestrations({ limit: 100 });
      const tasksById = new Map(store.listTasks(500).map((task) => [task.id, task]));
      const orchestrations = allOrchestrations.map((item) => ({
        id: item.id,
        taskId: item.taskId,
        status: item.status,
        updatedAt: item.updatedAt,
        taskTitle: tasksById.get(item.taskId)?.title ?? item.taskId,
      }));

      // The active task is only a *default*, not a hard filter: a spawned
      // sub-agent (or simply working on something else) can leave the active
      // task pointing at something with no orchestration, and silently
      // rendering an empty board makes a running fleet look dead. Fall back
      // to the most recently updated orchestration instead.
      const orchestration =
        (requestedTaskId ? store.getOrchestrationByTask(requestedTaskId) : undefined) ??
        (allOrchestrations.length ? allOrchestrations[0] : undefined);
      if (!orchestration) {
        sendJson(res, 200, { orchestration: null, orchestrations });
        return;
      }
      const taskId = orchestration.taskId;
      reapAgentRuns(store, { taskId });

      const wantsAllRuns = String(url.query.runs ?? "") === "all";
      const allRuns = store.listAgentRuns({ taskId, limit: 200 });
      // Runs with no cycle (adopted, manual, or spawned before the column
      // existed) only surface under "all" — guessing a cycle for them would
      // put stale rows on a board that is meant to show the current round.
      const scopedRuns = allRuns.filter(
        (run) => run.cycle === orchestration.cycle || ACTIVE_RUN_STATUSES.has(run.status),
      );
      // An idle orchestration, or one whose runs all predate the cycle column,
      // would otherwise get a completely empty board. The client cannot fall
      // back to rows it was never sent, so seed a few here.
      const boardRuns = wantsAllRuns ? allRuns : scopedRuns.length ? scopedRuns : allRuns.slice(0, 3);
      sendJson(res, 200, {
        orchestration,
        orchestrations,
        // Tells the UI it is showing something other than what was asked for,
        // so it can say so instead of looking like the active task's board.
        // So the toggle survives a page reload: auto-run lives in the server
        // process, not in the browser.
        autoRun: isAutoRunning(orchestration.id),
        // The Orchestrator tab answers these inline; without them on the board
        // a paused-for-questions orchestration looks simply stuck.
        questions: store
          .listAgentRequests({ taskId, status: "pending", limit: 100 })
          .filter((request) => request.type === "question"),
        // approve-each parks the orchestration on these; the Orchestrator tab
        // approves or rejects them inline.
        approvals: store
          .listAgentRequests({ taskId, status: "pending", limit: 100 })
          .filter((request) => request.type === "approval"),
        fellBackFromTaskId: requestedTaskId && requestedTaskId !== taskId ? requestedTaskId : undefined,
        taskTitle: tasksById.get(taskId)?.title ?? taskId,
        subtasks: store.listSubtasks({ parentTaskId: taskId, limit: 500 }),
        // Scoped to the current cycle by default. A project that went through
        // a few change requests accumulates dozens of finished runs, and
        // shipping all of them every 3s is pure waste when the board only
        // shows the current round. `?runs=all` opts back in.
        runs: boardRuns.map((run) => ({
          ...run,
          // logTail only for runs that are still going: a finished run's tail
          // never changes, and re-sending all of them was ~19KB per poll.
          // Finished cards link to the full log instead.
          logTail: ACTIVE_RUN_STATUSES.has(run.status) ? readLogTail(run.logPath) : undefined,
        })),
        // So the board can say "3 of 37" even when it was only sent 3.
        runsTotal: allRuns.length,
        runsScope: wantsAllRuns ? "all" : "cycle",
        reviews: store.listReviews({ taskId, limit: 200 }),
        // Without the payloads: the Activity panel renders only time/kind/phase
        // /summary, while payload carries subtask+reviewer plan meta and — for
        // a change request — the entire previous plan and report. That was
        // ~71KB of the board response, re-sent every 3 seconds, for data the
        // dashboard never reads.
        events: store
          .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 100 })
          .map(({ payload, ...event }) => event),
        registeredAgents: store.listRegisteredAgents({ limit: 500 }),
        adoptable: listAdoptableSessions(store),
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/workforce/run/log") {
    const runId = String(url.query.run ?? "");
    const tail = Number(url.query.tail ?? 200);
    const store = openStore(cwd);
    try {
      const run = store.getAgentRun(runId);
      if (!run) {
        sendJson(res, 404, { error: "Run not found" });
        return;
      }
      const log =
        run.logPath && existsSync(run.logPath)
          ? readFileSync(run.logPath, "utf8").split(/\r?\n/).slice(-tail).join("\n")
          : "";
      sendJson(res, 200, { run, log });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/start") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const prompt = requiredString(body.prompt, "prompt");
      // Only the starting position: the Orchestration panel can move this at
      // any point during the run via /api/workforce/orchestration/autonomy.
      const autonomy = optionalString(body.autonomy) ?? "manual";
      if (!["manual", "approve-each", "auto"].includes(autonomy)) {
        throw new Error(`Invalid autonomy "${autonomy}". Use one of: manual, approve-each, auto.`);
      }
      const leaderProvider = requiredString(body.leaderProvider, "leaderProvider");
      const leaderAgent = resolveAgentForPreference(
        store,
        {
          provider: leaderProvider,
          mode: (optionalString(body.leaderMode) as "cli" | "api" | "manual" | undefined) ?? "cli",
          model: optionalString(body.leaderModel),
          reasoningEffort: optionalString(body.leaderReasoning),
        },
        // Without a command the find-or-create falls back to the provider name,
        // which is only a real binary by coincidence: antigravity's CLI is
        // `agy`, so such a row spawns nothing and every turn dies instantly with
        // "spawn antigravity ENOENT".
        { command: optionalString(body.leaderCommand) ?? defaultCommandForProvider(leaderProvider) },
      );
      const task = store.createTask({ title: prompt, goal: prompt, ownerAgent: "codex" });

      // The leader can only staff registered, enabled agents, so a ticked
      // provider has to exist in the roster before the first planning turn.
      const requestedProviders = parseTeamProviders(body.teamProviders);
      const teamProviders = requestedProviders
        ? ensureAgentsForProviders(store, requestedProviders, defaultCommandForProvider)
        : undefined;

      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leaderAgent.id,
        autonomy: autonomy as OrchestrationAutonomy,
        maxParallel: Number(body.maxParallel ?? 3),
        maxCycles: Number(body.maxCycles ?? 8),
        teamProviders: teamProviders?.length ? teamProviders : undefined,
      });

      const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
      // Autonomy is the starting position of the Auto-run switch: picking
      // "auto" here is what makes the orchestration actually run unattended,
      // instead of being a field that only ever got written to the database.
      if (autonomy === "auto") startAutoRun(cwd, orchestration.id);
      sendJson(res, 200, {
        task,
        orchestration: stepResult.orchestration,
        summary: stepResult.summary,
        spawnedRunIds: stepResult.spawnedRunIds,
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/step") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      reapAgentRuns(store, { taskId });
      const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
      sendJson(res, 200, stepResult);
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/report") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      mustGetOrchestrationForUi(store, taskId);
      // Reap first: the reporter run usually finished between the click that
      // spawned it and this one, and generateReport reads run.status.
      reapAgentRuns(store, { taskId });
      sendJson(res, 200, generateReport(store, { taskId, cwd, forceFallback: Boolean(body.forceFallback) }));
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/answer-questions") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      const dismiss = body.dismiss === true;

      const pending = store
        .listAgentRequests({ taskId, status: "pending", limit: 200 })
        .filter((request) => request.type === "question");
      if (!pending.length) throw new Error("There are no pending questions to answer.");

      const submitted = new Map<string, string>();
      for (const entry of Array.isArray(body.answers) ? body.answers : []) {
        const id = optionalString((entry as Record<string, unknown>)?.id);
        const answer = optionalString((entry as Record<string, unknown>)?.answer)?.trim();
        if (id && answer) submitted.set(id, answer);
      }
      if (!dismiss && !submitted.size) throw new Error("Answer at least one question, or dismiss them.");

      const answers: Array<{ question: string; answer: string }> = [];
      for (const request of pending) {
        const answer = submitted.get(request.id);
        // Unanswered ones are resolved too — leaving them pending would
        // re-park the orchestration the moment the leader repeats them.
        store.resolveAgentRequest(request.id, "resolved", answer);
        if (answer) answers.push({ question: request.title, answer });
      }

      if (answers.length) {
        const payload: QuestionAnswersPayload = { type: "question-answers", answers };
        store.recordOrchestrationEvent({
          orchestrationId: orchestration.id,
          cycle: orchestration.cycle,
          phase: "plan",
          kind: "user_action",
          summary: `Answered ${answers.length} leader question(s).`,
          payload: JSON.stringify(payload),
        });
        // Answers change the requirements, so the plan that prompted them is
        // stale — consume it and let the leader plan again knowing the answers.
        for (const run of store
          .listAgentRuns({ orchestrationId: orchestration.id, limit: 500 })
          .filter((run) => run.phase === "plan")) {
          store.recordOrchestrationEvent({
            orchestrationId: orchestration.id,
            cycle: orchestration.cycle,
            phase: "plan",
            kind: "run_ended",
            summary: `Consumed plan run ${run.id} (superseded by answered questions).`,
          });
        }
      }

      store.updateOrchestration(orchestration.id, { status: "planning", lastError: null });
      const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
      sendJson(res, 200, {
        orchestration: stepResult.orchestration,
        summary: stepResult.summary,
        spawnedRunIds: stepResult.spawnedRunIds,
        answered: answers.length,
        dismissed: pending.length - answers.length,
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/approve-spawn") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const requestId = requiredString(body.requestId, "requestId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      const request = store
        .listAgentRequests({ taskId, limit: 500 })
        .find((candidate) => candidate.id === requestId && candidate.type === "approval");
      if (!request) throw new Error(`Approval not found: ${requestId}`);
      if (request.status !== "pending") throw new Error(`This approval was already ${request.status}.`);
      const approve = body.approve !== false;
      // Approving with a different agent is a third answer, not a variant of
      // yes: the work is authorised but somebody else does it. It is validated
      // here rather than at spawn time so a bad pick is a 400 the user can fix,
      // not a step that throws minutes later.
      const agentId = approve ? optionalString(body.agentId) : undefined;
      if (agentId) {
        const agent = store.getRegisteredAgent(agentId);
        if (!agent) throw new Error(`Registered agent not found: ${agentId}`);
        if (!agent.enabled) throw new Error(`Agent "${agent.name}" is disabled; enable it in the Agents tab first.`);
        if (orchestration.teamProviders?.length && !orchestration.teamProviders.includes(agent.provider)) {
          throw new Error(
            `Agent "${agent.name}" uses provider "${agent.provider}", which is not in this orchestration's team providers (${orchestration.teamProviders.join(", ")}).`,
          );
        }
      }
      const note = optionalString(body.note);
      const response = agentId
        ? JSON.stringify({ type: "spawn-approval-response", agentId, note } satisfies SpawnApprovalResponse)
        : note;
      store.resolveAgentRequest(requestId, approve ? "accepted" : "rejected", response);

      // A rejection is handled by the step itself (it pauses and records why),
      // so both paths just step once and report what happened.
      if (orchestration.status === "paused") {
        store.updateOrchestration(orchestration.id, { status: resumeStatusFor(store, orchestration.id), lastError: null });
      }
      const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
      // Auto-run stops itself when an approval has gone unanswered for a while
      // (see the tick below). Answering one is exactly the signal to pick the
      // loop back up, otherwise the run would sit there approved but stopped.
      if (
        approve &&
        stepResult.orchestration.autonomy !== "manual" &&
        !AUTO_RUN_HALTED.has(stepResult.orchestration.status)
      ) {
        startAutoRun(cwd, orchestration.id);
      }
      sendJson(res, 200, {
        approved: approve,
        reassignedTo: agentId,
        orchestration: stepResult.orchestration,
        summary: stepResult.summary,
        spawnedRunIds: stepResult.spawnedRunIds,
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/auto-run") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      if (body.enabled === false) {
        stopAutoRun(orchestration.id);
      } else {
        if (AUTO_RUN_HALTED.has(orchestration.status)) {
          throw new Error(`Orchestration is ${orchestration.status}; there is nothing for auto-run to advance.`);
        }
        startAutoRun(cwd, orchestration.id);
      }
      // Keep the stored autonomy in step with the switch, so a restarted
      // server (and the CLI's `workforce watch`) agree with what the UI shows.
      const autoRun = isAutoRunning(orchestration.id);
      // Auto-run and the approval gate are two separate switches. An
      // approve-each orchestration is allowed to keep stepping on the server —
      // it simply stops at every gate until you approve — so arming the timer
      // must not erase the gate, and disarming it must not drop it either.
      const nextAutonomy = autoRun
        ? orchestration.autonomy === "approve-each"
          ? "approve-each"
          : "auto"
        : orchestration.autonomy === "auto"
          ? "manual"
          : orchestration.autonomy;
      const updated = store.updateOrchestration(orchestration.id, { autonomy: nextAutonomy }) ?? orchestration;
      sendJson(res, 200, { autoRun, orchestration: updated });
    } finally {
      store.close();
    }
    return;
  }

  // Autonomy is a live setting, not a launch-time one: every step re-reads it
  // from the row, so switching here takes effect on the very next transition.
  // That is the whole point — a run you started unattended can be pulled back
  // under per-agent approval the moment it starts staffing something you did
  // not expect, and handed back to itself afterwards.
  if (method === "POST" && url.pathname === "/api/workforce/orchestration/autonomy") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const autonomy = requiredString(body.autonomy, "autonomy");
      if (!["manual", "approve-each", "auto"].includes(autonomy)) {
        throw new Error(`Invalid autonomy "${autonomy}". Use one of: manual, approve-each, auto.`);
      }
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      const updated =
        store.updateOrchestration(orchestration.id, { autonomy: autonomy as OrchestrationAutonomy }) ?? orchestration;
      // Autonomy is now the only switch: "manual" means the user drives, so the
      // stepping timer is off; everything else means the server advances the
      // run. "approve-each" still steps — it just parks at each gate until the
      // user answers, and answering restarts it immediately, which is far less
      // work than approving and then having to press Step as well.
      if (autonomy === "manual") {
        stopAutoRun(orchestration.id);
      } else if (!AUTO_RUN_HALTED.has(updated.status)) {
        startAutoRun(cwd, orchestration.id);
      }
      sendJson(res, 200, {
        orchestration: updated,
        autoRun: isAutoRunning(orchestration.id),
        previousAutonomy: orchestration.autonomy,
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/request-changes") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const request = requiredString(body.request, "request").trim();
      if (!request) throw new Error("request must not be empty.");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      const requestedProviders = Array.isArray(body.teamProviders)
        ? parseTeamProviders(body.teamProviders)
        : undefined;
      if (Array.isArray(body.teamProviders) && !requestedProviders?.length) {
        throw new Error("Pick at least one team provider.");
      }
      const teamProviders = requestedProviders
        ? ensureAgentsForProviders(store, requestedProviders, defaultCommandForProvider)
        : orchestration.teamProviders;

      // Stop anything still running for the old round first, so its output
      // can't land as a result for the new plan.
      const activeRuns = store
        .listAgentRuns({ taskId, limit: 500 })
        .filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
      for (const run of activeRuns) await stopAgentRun(store, run.id);

      // Every prior plan run is marked consumed so stepPlanning spawns a fresh
      // turn instead of re-applying the plan that produced the current build.
      const priorPlanRuns = store
        .listAgentRuns({ orchestrationId: orchestration.id, limit: 500 })
        .filter((run) => run.phase === "plan");
      for (const run of priorPlanRuns) {
        store.recordOrchestrationEvent({
          orchestrationId: orchestration.id,
          cycle: orchestration.cycle,
          phase: "plan",
          kind: "run_ended",
          summary: `Consumed plan run ${run.id} (superseded by a change request).`,
        });
      }

      const payload: ChangeRequestPayload = {
        type: "change-request",
        request,
        previousPlan: readTextIfExists(orchestration.planPath),
        previousReport: readTextIfExists(orchestration.reportPath),
      };
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: orchestration.cycle,
        phase: "plan",
        kind: "user_action",
        summary: `${CHANGE_REQUEST_EVENT_PREFIX} ${request.split(/\r?\n/)[0].slice(0, 160)}`,
        payload: JSON.stringify(payload),
      });

      store.updateOrchestration(orchestration.id, {
        status: "planning",
        // applyPlanTurn resets cycle to 1, so the budget has to cover a whole
        // fresh round rather than whatever was left of the previous one.
        maxCycles: Math.max(orchestration.maxCycles, 8),
        teamProviders,
        lastError: null,
      });

      // Spawn the re-planning turn right here. Leaving it parked at "planning"
      // means the button appears to do nothing at all until the user happens to
      // press Step — the same immediate-start behaviour `workforce start` has.
      const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
      sendJson(res, 200, {
        orchestration: stepResult.orchestration,
        summary: stepResult.summary,
        spawnedRunIds: stepResult.spawnedRunIds,
        stoppedRuns: activeRuns.map((run) => run.id),
      });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/pause") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const orchestration = mustGetOrchestrationForUi(store, requiredString(body.taskId, "taskId"));
      // Pausing a finished orchestration used to be the only way back in:
      // pause then resume flipped `done` to `executing`. That is a change
      // request, and it has its own endpoint now — this one stays honest.
      if (orchestration.status === "done" || orchestration.status === "failed") {
        throw new Error(
          `Orchestration is already ${orchestration.status}; use Request changes to reopen it.`,
        );
      }
      sendJson(res, 200, { orchestration: store.updateOrchestration(orchestration.id, { status: "paused" }) });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/resume") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const orchestration = mustGetOrchestrationForUi(store, requiredString(body.taskId, "taskId"));
      if (orchestration.status !== "paused") {
        throw new Error(`Orchestration is not paused (status: ${orchestration.status}).`);
      }
      const status = resumeStatusFor(store, orchestration.id);
      sendJson(res, 200, { orchestration: store.updateOrchestration(orchestration.id, { status, lastError: null }) });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/orchestration/stop") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      // Otherwise the loop keeps stepping the orchestration the user just stopped.
      stopAutoRun(orchestration.id);
      const activeRuns = store
        .listAgentRuns({ taskId, limit: 500 })
        .filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
      for (const run of activeRuns) await stopAgentRun(store, run.id);
      const updated = store.updateOrchestration(orchestration.id, { status: "failed", lastError: "Stopped by user." });
      sendJson(res, 200, { orchestration: updated, stoppedRuns: activeRuns.map((run) => run.id) });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/subtask/add-and-spawn") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const taskId = requiredString(body.taskId, "taskId");
      const orchestration = mustGetOrchestrationForUi(store, taskId);
      const title = requiredString(body.title, "title");
      const roles = store.ensureDefaultWorkforceRoles();
      const role = roles.find((candidate) => candidate.name === "implementer");
      if (!role) throw new Error("Implementer role not found.");

      const subtask = store.createSubtask({
        parentTaskId: taskId,
        title,
        goal: optionalString(body.goal),
        acceptanceCriteria: parseItems(body.criteria),
      });
      const provider = requiredString(body.provider, "provider");
      if (orchestration.teamProviders?.length && !orchestration.teamProviders.includes(provider as AgentProvider)) {
        throw new Error(
          `Provider "${provider}" is not allowed for this orchestration. Allowed team providers: ${orchestration.teamProviders.join(", ")}.`,
        );
      }
      const agent = resolveAgentForPreference(store, {
        provider,
        mode: optionalString(body.mode) as "cli" | "api" | "manual" | undefined,
        model: optionalString(body.model),
        reasoningEffort: optionalString(body.reasoningEffort),
      }, {
        requiredCapabilities: ["implement"],
      });
      const promptLines = [`Subtask: ${title}`];
      if (subtask.goal) promptLines.push(`Goal: ${subtask.goal}`);
      if (subtask.acceptanceCriteria.length) {
        promptLines.push("Acceptance criteria:", ...subtask.acceptanceCriteria.map((item) => `- ${item}`));
      }
      const prompt = promptLines.join("\n");

      const assignment = store.createAssignment({
        taskId,
        subtaskId: subtask.id,
        agentId: agent.id,
        roleId: role.id,
        status: "running",
        prompt,
      });
      store.updateSubtask(subtask.id, { status: "in_progress" });

      const runsDir = join(paths(cwd).artifacts, "runs");
      mkdirSync(runsDir, { recursive: true });
      const promptPath = join(runsDir, `${randomUUID()}-prompt.md`);
      writeFileSync(promptPath, prompt, "utf8");
      const preview = buildSpawnPreview(agent, promptPath, cwd);
      if (preview.mode !== "cli" || !preview.executable) {
        throw new Error(`Agent ${agent.name} is not CLI-spawnable (mode: ${preview.mode}).`);
      }
      const run = spawnAgentRun(store, {
        orchestrationId: orchestration.id,
        taskId,
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        agentId: agent.id,
        roleId: role.id,
        cycle: orchestration.cycle,
        phase: "implement",
        runsDir,
        preview,
      }, {
        // This handler closes its store as soon as it replies, long before the
        // agent finishes; without this the exit code is lost and the run is
        // later reaped as "detached" no matter how it actually ended.
        reopenStore: () => openStore(cwd),
        onExit: (finished) => {
          let completionStore: ReturnType<typeof openStore> | undefined;
          try {
            completionStore = openStore(cwd);
            recordDirectSubtaskRunOutcome(completionStore, finished);
          } catch (error) {
            console.error(`Failed to record completion for agent run ${finished.id}:`, error);
          } finally {
            completionStore?.close();
          }
        },
      });
      sendJson(res, 200, { subtask, assignment, run });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/run/stop") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const runId = requiredString(body.runId, "runId");
      const before = store.getAgentRun(runId);
      if (!before) throw new Error(`Run not found: ${runId}`);
      const stopped = await stopAgentRun(store, runId);
      if (before.assignmentId) {
        store.updateAssignment(before.assignmentId, {
          status: "cancelled",
          resultSummary: optionalString(body.reason) ?? "Stopped from the UI.",
        });
      }
      if (body.cancelSubtask && before.subtaskId) store.updateSubtask(before.subtaskId, { status: "cancelled" });
      sendJson(res, 200, { run: stopped });
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/run/set-model") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const result = await respawnRun(store, requiredString(body.runId, "runId"), {
        model: optionalString(body.model),
        reasoningEffort: optionalString(body.reasoningEffort),
      });
      sendJson(res, 200, result);
    } finally {
      store.close();
    }
    return;
  }

  if (method === "POST" && url.pathname === "/api/workforce/run/adopt") {
    const body = await readJson(req);
    const store = openStore(cwd);
    try {
      const sessionId = requiredString(body.sessionId, "sessionId");
      const roleName = requiredString(body.role, "role");
      const events = store.listSessionEvents({ sessionId, limit: 50 });
      if (!events.length) throw new Error(`No session events found for session: ${sessionId}`);
      const latest = events[0]!;
      const taskId = optionalString(body.taskId) ?? latest.taskId;
      if (!taskId) throw new Error("Could not determine a task id for this session.");

      const roles = store.ensureDefaultWorkforceRoles();
      const role = roles.find((candidate) => candidate.name === roleName);
      if (!role) throw new Error(`Role not found: ${roleName}`);

      const existingAgentId = optionalString(body.agentId);
      const agent = existingAgentId
        ? mustFindAgentForUi(store, existingAgentId)
        : store.createRegisteredAgent({
            name: `adopted-${sessionId.slice(0, 8)}`,
            provider: latest.agent ?? "generic",
            mode: "manual",
            capabilities: ["adopted"],
          });

      const subtaskId = optionalString(body.subtaskId);
      const subtask = subtaskId
        ? mustFindSubtaskForUi(store, taskId, subtaskId)
        : store.createSubtask({
            parentTaskId: taskId,
            title: `External work: ${latest.summary ?? sessionId}`,
            status: "in_progress",
          });

      const assignment = store.createAssignment({
        taskId,
        subtaskId: subtask.id,
        agentId: agent.id,
        roleId: role.id,
        status: "running",
        prompt:
          "Adopted from an externally-running session; this agent is working independently outside orchestrator control.",
      });

      const run = store.createAgentRun({
        taskId,
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        agentId: agent.id,
        roleId: role.id,
        origin: "adopted",
        sessionId,
        status: "detached",
        phase: "implement",
      });

      sendJson(res, 200, { agent, subtask, assignment, run });
    } finally {
      store.close();
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// Server-side equivalent of `agent-bridge workforce watch`: keeps calling
// stepOrchestration until the orchestration finishes, so the dashboard can
// drive a whole run without the user clicking Step for every single
// transition (or keeping a terminal open).
const autoRunTimers = new Map<string, NodeJS.Timeout>();
const AUTO_RUN_INTERVAL_MS = 5000;
const AUTO_RUN_HALTED = new Set(["done", "failed", "paused"]);
// How long the loop keeps re-asking an unanswered approval before it stops on
// its own. Long enough to cover stepping away from the desk, short enough that
// an overnight run does not tick 7000 times against a question nobody saw.
const APPROVAL_IDLE_STOP_MS = 15 * 60 * 1000;
// A run that is still going; the only kind whose log tail is worth re-sending.
const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

export function isAutoRunning(orchestrationId: string): boolean {
  return autoRunTimers.has(orchestrationId);
}

export function stopAutoRun(orchestrationId: string): void {
  const timer = autoRunTimers.get(orchestrationId);
  if (!timer) return;
  clearTimeout(timer);
  autoRunTimers.delete(orchestrationId);
}

// Auto-run only ever lived in this process's timer map, so closing the tool
// mid-run left the orchestration frozen: the rows still said "executing", the
// UI still offered Step, but nothing advanced again until the user noticed and
// re-armed the toggle by hand. Autonomy is the durable record of who advances
// the run — anything but "manual" means the server does — so honour it at
// startup. An approve-each run resumes too: it steps up to its next gate and
// waits there, which is exactly where the user left it.
export function resumeAutoRuns(cwd: string): string[] {
  const store = openStore(cwd);
  try {
    const resumable = store
      .listOrchestrations({ limit: 100 })
      .filter((orchestration) => orchestration.autonomy !== "manual" && !AUTO_RUN_HALTED.has(orchestration.status));
    for (const orchestration of resumable) startAutoRun(cwd, orchestration.id);
    if (resumable.length) {
      console.log(`Resumed auto-run for ${resumable.length} orchestration(s) left running.`);
    }
    return resumable.map((orchestration) => orchestration.id);
  } finally {
    store.close();
  }
}

export function startAutoRun(cwd: string, orchestrationId: string): void {
  if (autoRunTimers.has(orchestrationId)) return;

  const tick = (): void => {
    const store = openStore(cwd);
    let keepGoing = false;
    try {
      const orchestration = store.getOrchestration(orchestrationId);
      if (orchestration && !AUTO_RUN_HALTED.has(orchestration.status)) {
        reapAgentRuns(store, { taskId: orchestration.taskId });
        if (orchestration.status === "reporting") {
          // stepOrchestration deliberately no-ops here, so a loop that only
          // stepped would spin forever one click short of the finish line.
          // Drive the reporter too: generateReport spawns it, then consumes
          // its output on a later tick and flips the orchestration to done.
          const report = generateReport(store, { taskId: orchestration.taskId, cwd });
          keepGoing = report.status !== "written";
        } else {
          const stepped = stepOrchestration(store, orchestrationId, makeOrchestratorDeps(store, cwd));
          keepGoing = !AUTO_RUN_HALTED.has(stepped.orchestration.status);
          // Nobody is coming. An approval that has gone unanswered this long is
          // not a transient wait, and re-stepping it every few seconds until
          // morning only burns a store handle per tick to produce the same
          // noop. Stop the loop and leave the reason on the board; approving
          // (or rejecting) restarts it from the approve-spawn handler.
          if (keepGoing && stepped.awaitingApprovalSince) {
            const waitedMs = Date.now() - Date.parse(stepped.awaitingApprovalSince);
            if (Number.isFinite(waitedMs) && waitedMs >= APPROVAL_IDLE_STOP_MS) {
              keepGoing = false;
              store.updateOrchestration(orchestrationId, {
                lastError:
                  `Auto-run paused after waiting ${Math.round(waitedMs / 60000)} min for your approval. ` +
                  "Approve or reject the pending agent assignment to continue.",
              });
            }
          }
        }
      }
    } catch (error) {
      // A throwing step is a real fault, not a transient one — retrying it on
      // a timer would just spin. Stop and leave the reason on the board.
      keepGoing = false;
      try {
        store.updateOrchestration(orchestrationId, {
          lastError: `Auto-run stopped: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // the store is already in trouble; the loop still has to stop cleanly
      }
    } finally {
      store.close();
    }

    // A Stop/Remove between ticks deletes the entry; don't resurrect it.
    if (keepGoing && autoRunTimers.has(orchestrationId)) {
      autoRunTimers.set(orchestrationId, setTimeout(tick, AUTO_RUN_INTERVAL_MS).unref());
    } else {
      autoRunTimers.delete(orchestrationId);
    }
  };

  autoRunTimers.set(orchestrationId, setTimeout(tick, 0).unref());
}

// Last few lines of a run's log, for the Runs board cards. Reads only the tail
// of the file — an implementer log can reach hundreds of KB and this is polled
// for every run on the board.
export function readLogTail(logPath: string | undefined, lines = 14, maxBytes = 24_000): string {
  if (!logPath || !existsSync(logPath)) return "";
  try {
    const { size } = statSync(logPath);
    const handle = openSync(logPath, "r");
    try {
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      // A mid-character/mid-line start is unavoidable when slicing bytes; drop
      // the first partial line rather than showing mojibake.
      const usable = size > maxBytes ? text.slice(text.indexOf("\n") + 1) : text;
      return usable.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");
    } finally {
      closeSync(handle);
    }
  } catch {
    return "";
  }
}

function readTextIfExists(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function mustGetOrchestrationForUi(store: ReturnType<typeof openStore>, taskId: string) {
  const orchestration = store.getOrchestrationByTask(taskId);
  if (!orchestration) throw new Error(`No orchestration found for task: ${taskId}`);
  return orchestration;
}

function mustFindAgentForUi(store: ReturnType<typeof openStore>, agentId: string): RegisteredAgent {
  const found = store.getRegisteredAgent(agentId);
  if (!found) throw new Error(`Agent not found: ${agentId}`);
  return found;
}

function mustFindSubtaskForUi(store: ReturnType<typeof openStore>, taskId: string, subtaskId: string): Subtask {
  const found = store.listSubtasks({ parentTaskId: taskId, limit: 500 }).find((candidate) => candidate.id === subtaskId);
  if (!found) throw new Error(`Subtask not found: ${subtaskId}`);
  return found;
}

// Cheap, DB-only optimize stats for the live dashboard: the compiled-context size
// trend and the recorded `optimize baseline` savings trend. No file IO here — the
// live baseline measurement is run on demand via POST /api/optimize/baseline.
function optimizeStats(store: ReturnType<typeof openStore>): {
  compiled: {
    count: number;
    latest: number;
    average: number;
    min: number;
    max: number;
  } | null;
  baseline: {
    count: number;
    latest: ReturnType<typeof parseBaselineRun>;
    averagePct: number;
    history: NonNullable<ReturnType<typeof parseBaselineRun>>[];
  } | null;
} {
  const runs = store.listRuns({ limit: 100 });
  const compiledTokens = runs
    .filter(
      (run) =>
        run.command !== "optimize baseline" &&
        typeof run.tokenEstimate === "number",
    )
    .map((run) => run.tokenEstimate as number);
  const compiled = compiledTokens.length
    ? {
        count: compiledTokens.length,
        latest: compiledTokens[0],
        average: Math.round(
          compiledTokens.reduce((total, value) => total + value, 0) /
            compiledTokens.length,
        ),
        min: Math.min(...compiledTokens),
        max: Math.max(...compiledTokens),
      }
    : null;

  const points = runs
    .map(parseBaselineRun)
    .filter((point): point is NonNullable<typeof point> => point !== null);
  const baseline = points.length
    ? {
        count: points.length,
        latest: points[0],
        averagePct:
          Math.round(
            (points.reduce((total, point) => total + point.savedPct, 0) /
              points.length) *
              10,
          ) / 10,
        history: points.slice(0, 10),
      }
    : null;

  return { compiled, baseline };
}

// Assemble a bounded graph view for the UI: the `limit` highest-degree files and
// the import edges among them, plus the repo map. Keeping it degree-ranked means
// the most architecturally central files always make the cut.
function buildGraphView(
  store: ReturnType<typeof openStore>,
  limit: number,
  focus?: string[],
  taskContext?: {
    task: { id: string; title: string; goal?: string };
    recentTaskFiles?: string[];
  },
): {
  stats: ReturnType<ReturnType<typeof openStore>["getGraphStats"]>;
  nodes: Array<{
    id: string;
    path: string;
    language?: string;
    symbols: number;
    usedBy: number;
    imports: number;
    brief?: string;
    manualPriority?: number;
    briefStale?: boolean;
    recentKind?: "read" | "edit";
    recentRank?: number;
    recentTotal?: number;
  }>;
  edges: Array<{ source: string; target: string }>;
  repoMap: string;
} {
  const stats = store.getGraphStats();
  const repoMapFiles = store.buildRepoMap({
    limit: Math.min(limit, 60),
    focusPaths: focus,
    ...taskContext,
  });
  const files = store.listGraphFiles(5000);
  const summaries = new Map(
    store.listFileSummaries().map((summary) => [summary.path, summary]),
  );
  const recentLimit = Math.min(24, Math.max(6, Math.ceil(limit * 0.25)));
  const recentRows = [...summaries.values()]
    .map((summary) => ({
      path: summary.path,
      kind: summary.lastTaskEditedAt ? ("edit" as const) : ("read" as const),
      timestamp: summary.lastTaskEditedAt ?? summary.updatedAt,
    }))
    .filter((item) => item.timestamp)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, recentLimit);
  const recent = new Map(
    recentRows.map((item, index) => [
      item.path,
      { ...item, rank: index + 1, total: recentRows.length },
    ]),
  );

  const degree = new Map<string, { usedBy: number; imports: number }>();
  for (const file of files) degree.set(file.path, { usedBy: 0, imports: 0 });
  const internalEdges: Array<{ source: string; target: string }> = [];
  for (const file of files) {
    const imports = store.getImports(file.path);
    const entry = degree.get(file.path);
    if (entry) entry.imports = imports.internal.length;
    for (const target of imports.internal) {
      internalEdges.push({ source: file.path, target });
      const targetEntry = degree.get(target);
      if (targetEntry) targetEntry.usedBy += 1;
    }
  }

  let ranked = files;
  if (focus?.length) {
    const needles = focus.map((value) => value.toLowerCase());
    ranked = ranked.filter((file) =>
      needles.some((needle) => file.path.toLowerCase().includes(needle)),
    );
  }
  ranked = [...ranked].sort((a, b) => {
    const da = degree.get(a.path) ?? { usedBy: 0, imports: 0 };
    const db = degree.get(b.path) ?? { usedBy: 0, imports: 0 };
    const recentA = recent.get(a.path);
    const recentB = recent.get(b.path);
    const recentScoreA = recentA
      ? 1000 - recentA.rank * 20 + (recentA.kind === "edit" ? 10 : 0)
      : 0;
    const recentScoreB = recentB
      ? 1000 - recentB.rank * 20 + (recentB.kind === "edit" ? 10 : 0)
      : 0;
    return (
      recentScoreB +
        db.usedBy +
        db.imports -
        (recentScoreA + da.usedBy + da.imports) || a.path.localeCompare(b.path)
    );
  });

  const selected = ranked.slice(0, limit);
  const selectedPaths = new Set(selected.map((file) => file.path));
  const nodes = selected.map((file) => {
    const entry = degree.get(file.path) ?? { usedBy: 0, imports: 0 };
    const summary = summaries.get(file.path);
    const recentInfo = recent.get(file.path);
    return {
      id: file.path,
      path: file.path,
      language: file.language,
      symbols: store.getFileSymbols(file.path).length,
      usedBy: entry.usedBy,
      imports: entry.imports,
      brief: summary?.summary,
      manualPriority: summary?.manualPriority,
      briefStale: Boolean(
        summary?.summary &&
        summary.lastSeenHash &&
        file.contentHash &&
        summary.lastSeenHash !== file.contentHash,
      ),
      recentKind: recentInfo?.kind,
      recentRank: recentInfo?.rank,
      recentTotal: recentInfo?.total,
    };
  });
  const edges = internalEdges.filter(
    (edge) => selectedPaths.has(edge.source) && selectedPaths.has(edge.target),
  );

  return { stats, nodes, edges, repoMap: renderRepoMap(repoMapFiles) };
}

function renderHandoffMarkdown(handoff: {
  fromAgent?: string;
  toAgent?: string;
  summary: string;
  done: string[];
  next: string[];
  risks: string[];
  filesChanged: string[];
}): string {
  return [
    "# Handoff",
    "",
    `From: ${handoff.fromAgent ?? "unknown"}`,
    `To: ${handoff.toAgent ?? "unknown"}`,
    "",
    "## Summary",
    handoff.summary,
    "",
    "## Done",
    bullets(handoff.done),
    "",
    "## Next",
    bullets(handoff.next),
    "",
    "## Risks",
    bullets(handoff.risks),
    "",
    "## Files Changed",
    bullets(handoff.filesChanged),
    "",
  ].join("\n");
}

function bullets(items: string[]): string {
  return items.length
    ? items.map((item) => `- ${item}`).join("\n")
    : "- None recorded.";
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function taskContextPath(taskId: string, cwd = uiWorkspace): string {
  return join(paths(cwd).tasks, taskId, "compiled-context.md");
}

type UiTaskChange = TaskChange & {
  insertions: number;
  deletions: number;
  diff?: string;
  diffStat?: string;
};

export function taskChangesWithWriteLeases(
  root: string,
  changes: TaskChange[],
  leases: FileLease[],
): TaskChange[] {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  for (const lease of leases) {
    if (lease.mode !== "write" || byPath.has(lease.path)) continue;
    const gitStatus = gitPathStatus(root, lease.path);
    const changeType = gitStatus
      ? gitStatus.changeType
      : existsSync(resolve(root, lease.path))
        ? "modified"
        : "deleted";
    byPath.set(lease.path, {
      id: `lease-change-${lease.id}`,
      taskId: lease.taskId,
      path: lease.path,
      changeType,
      baseHash: lease.baseHash,
      currentHash: contentHash(root, lease.path) ?? lease.currentHash,
      diffSummary: gitStatus?.summary ?? `write lease ${lease.path}`,
      status: "pending",
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    });
  }
  return Array.from(byPath.values());
}

function enrichTaskChanges(root: string, changes: TaskChange[]): UiTaskChange[] {
  return changes.map((change) => {
    const stat = gitDiffStat(root, change.path);
    const fallback =
      stat.insertions === 0 &&
      stat.deletions === 0 &&
      change.changeType === "added"
        ? addedFileDiff(root, change.path)
        : undefined;
    const diff = gitDiff(root, change.path) || fallback?.diff;
    return {
      ...change,
      insertions: stat.insertions || fallback?.insertions || 0,
      deletions: stat.deletions,
      diff: truncateDiff(diff),
      diffStat: stat.raw || fallback?.raw,
    };
  });
}

function gitPathStatus(
  root: string,
  path: string,
): { changeType: TaskChange["changeType"]; summary: string } | undefined {
  const raw = runGit(root, ["status", "--porcelain", "--", path]);
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trimEnd())
    .find(Boolean);
  if (!line) return undefined;
  const status = line.slice(0, 2);
  const rest = line.slice(3).trim();
  const changedPath = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
  const changeType = status.includes("D")
    ? "deleted"
    : status.includes("R")
      ? "renamed"
      : status.includes("A") || status.includes("?")
        ? "added"
        : "modified";
  return {
    changeType,
    summary: `${status.trim() || "changed"} ${changedPath || path}`,
  };
}

function gitDiffStat(
  root: string,
  path: string,
): { insertions: number; deletions: number; raw?: string } {
  const raw =
    runGit(root, ["diff", "--no-ext-diff", "--numstat", "HEAD", "--", path]) ||
    runGit(root, ["diff", "--no-ext-diff", "--numstat", "--", path]);
  if (!raw.trim()) return { insertions: 0, deletions: 0 };
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce(
      (total, line) => {
        const [added, deleted] = line.split(/\t/);
        return {
          insertions: total.insertions + parseNumstat(added),
          deletions: total.deletions + parseNumstat(deleted),
          raw,
        };
      },
      { insertions: 0, deletions: 0, raw },
    );
}

function gitDiff(root: string, path: string): string | undefined {
  const diff =
    runGit(root, ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", path]) ||
    runGit(root, ["diff", "--no-ext-diff", "--unified=80", "--", path]);
  return diff.trim() ? diff : undefined;
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 5,
    });
  } catch {
    return "";
  }
}

function parseNumstat(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addedFileDiff(
  root: string,
  path: string,
): { insertions: number; raw: string; diff: string } | undefined {
  const full = resolve(root, path);
  const workspaceRoot = resolve(root);
  if (!full.startsWith(workspaceRoot) || !existsSync(full)) return undefined;
  const content = safeRead(full);
  const lines = content ? content.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return {
    insertions: lines.length,
    raw: `${lines.length}\t0\t${path}`,
    diff: [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      ...lines.map((line) => `+${line}`),
    ].join("\n"),
  };
}

function truncateDiff(diff: string | undefined): string | undefined {
  if (!diff) return undefined;
  const limit = 60000;
  return diff.length > limit
    ? `${diff.slice(0, limit)}\n... diff truncated ...`
    : diff;
}

function writeTaskContext(
  taskId: string,
  content: string,
  cwd = uiWorkspace,
): void {
  const filePath = taskContextPath(taskId, cwd);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
}

function optionalToolsStatus(): Array<{
  name: string;
  purpose: string;
  usage: string;
  installed: boolean;
  installable: boolean;
  command?: string;
}> {
  return [
    {
      name: "repomix",
      purpose: "Pack repository context for agents",
      usage:
        "Run repomix in a project to create compact repository context for Claude/Codex.",
      installed: commandExists("repomix"),
      installable: true,
      command: "repomix --help",
    },
    {
      name: "ccusage",
      purpose: "Inspect Claude Code token/cost usage",
      usage: "Run ccusage to inspect Claude Code token and cost history.",
      installed: commandExists("ccusage"),
      installable: true,
      command: "ccusage --help",
    },
  ];
}

function tokenStackStatus(): Array<{
  id: string;
  label: string;
  purpose: string;
  usage: string;
  enabled: boolean;
  installed?: boolean;
  installable: boolean;
  installName?: string;
}> {
  const installedByName = new Map(
    optionalToolsStatus().map((tool) => [tool.name, tool.installed]),
  );
  return defaultTokenStackModules().map((module) => ({
    ...module,
    installed:
      module.id === "repomix" || module.id === "ccusage"
        ? (installedByName.get(module.id) ?? false)
        : true,
    installable: module.id === "repomix" || module.id === "ccusage",
    installName:
      module.id === "repomix" || module.id === "ccusage"
        ? module.id
        : undefined,
  }));
}

function commandExists(command: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function focusAgentTerminal(
  task: Task,
  agent: AgentKind,
  sessionId: string,
  sessionWindow?: { hwnd?: string; windowId?: string; pid?: number },
): { focused: boolean; patterns: string[]; hwnd?: string; windowId?: string; reason?: string } {
  const patterns = [
    terminalTitle(agent, task.id, sessionId),
    sessionId,
  ];
  const hwnd = sessionWindow?.hwnd;
  const windowId = sessionWindow?.windowId;
  if (process.platform !== "win32") {
    return {
      focused: false,
      patterns,
      hwnd,
      windowId,
      reason: "Window focus is currently implemented for Windows terminals.",
    };
  }
  if (hwnd) {
    const byHandle = focusWindowByHandle(hwnd);
    if (byHandle.focused) return { ...byHandle, patterns, windowId };
  }
  if (windowId) {
    if (sessionWindow?.pid && !isProcessAlive(sessionWindow.pid)) {
      return { focused: false, patterns, hwnd, windowId, reason: "The terminal process has closed." };
    }
    try {
      execFileSync("wt.exe", ["-w", windowId, "focus-tab", "-t", "0"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      return { focused: true, patterns, hwnd, windowId };
    } catch (error) {
      return {
        focused: false,
        patterns,
        hwnd,
        windowId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const script = `
$patterns = @(${patterns.map((pattern) => psString(pattern)).join(", ")})
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AgentBridgeWindowFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$script:found = [IntPtr]::Zero
[AgentBridgeWindowFocus]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [AgentBridgeWindowFocus]::IsWindowVisible($hWnd)) { return $true }
  $text = New-Object System.Text.StringBuilder 512
  [void][AgentBridgeWindowFocus]::GetWindowText($hWnd, $text, $text.Capacity)
  $title = $text.ToString()
  foreach ($pattern in $patterns) {
    if ($title -like "*$pattern*") {
      $script:found = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:found -eq [IntPtr]::Zero) { exit 2 }
[void][AgentBridgeWindowFocus]::ShowWindowAsync($script:found, 9)
[void][AgentBridgeWindowFocus]::SetForegroundWindow($script:found)
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
    return { focused: true, patterns, hwnd };
  } catch (error) {
    return {
      focused: false,
      patterns,
      hwnd,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function focusWindowByHandle(hwnd: string): { focused: boolean; hwnd: string; reason?: string } {
  const numericHwnd = Number(hwnd);
  if (!Number.isFinite(numericHwnd) || numericHwnd <= 0) {
    return { focused: false, hwnd, reason: "Invalid window handle." };
  }
  const script = `
$hwnd = [IntPtr]${Math.trunc(numericHwnd)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentBridgeWindowHandleFocus {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
}
"@
if (-not [AgentBridgeWindowHandleFocus]::IsWindow($hwnd)) { exit 2 }
[void][AgentBridgeWindowHandleFocus]::ShowWindowAsync($hwnd, 9)
[AgentBridgeWindowHandleFocus]::SwitchToThisWindow($hwnd, $true)
[void][AgentBridgeWindowHandleFocus]::SetForegroundWindow($hwnd)
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
    return { focused: true, hwnd };
  } catch (error) {
    return {
      focused: false,
      hwnd,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function terminalTitle(agent: AgentKind, taskId: string, sessionId: string): string {
  return `AgentBridge ${agent} ${taskId} ${sessionId}`;
}

function launchAgentTerminal(
  cwd: string,
  task: Task,
  agent: AgentKind,
  sessionId: string,
  command: string,
  uiPort: number,
): { launcherPid?: number; title: string; windowId: string } {
  const title = terminalTitle(agent, task.id, sessionId);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AgentBridgeTerminalWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
  $script:terminalHwnd = [IntPtr]::Zero
  $deadline = [DateTime]::UtcNow.AddSeconds(1)
  do {
    [AgentBridgeTerminalWindow]::EnumWindows({
      param($hWnd, $lParam)
      if (-not [AgentBridgeTerminalWindow]::IsWindowVisible($hWnd)) { return $true }
      $text = New-Object System.Text.StringBuilder 512
      [void][AgentBridgeTerminalWindow]::GetWindowText($hWnd, $text, $text.Capacity)
      if ($text.ToString() -eq ${psString(title)}) { $script:terminalHwnd = $hWnd; return $false }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:terminalHwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 50 }
  } while ($script:terminalHwnd -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
  $registration = @{ sessionId = ${psString(sessionId)}; windowId = ${psString(sessionId)}; pid = $PID }
  if ($script:terminalHwnd -ne [IntPtr]::Zero) { $registration.hwnd = $script:terminalHwnd.ToInt64().ToString() }
  $payload = $registration | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri ${psString(`http://127.0.0.1:${uiPort}/api/session/window`)} -Method Post -ContentType 'application/json' -Body $payload | Out-Null
} catch {
  Write-Warning 'Agent Bridge could not register this terminal window.'
}
$env:AGENT_BRIDGE_TERMINAL_SESSION_ID = ${psString(sessionId)}
& ${psString(command)}
`;
  if (!commandExists("wt.exe")) {
    throw new Error("Windows Terminal (wt.exe) is required to open a visible agent terminal.");
  }
  const child = spawn(
    "wt.exe",
    [
      "-w",
      sessionId,
      "new-tab",
      "--title",
      title,
      "--suppressApplicationTitle",
      "-d",
      cwd,
      "powershell.exe",
      "-NoLogo",
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { cwd, detached: true, stdio: "ignore", windowsHide: false },
  );
  child.on("error", () => undefined);
  child.unref();
  return { launcherPid: child.pid, title, windowId: sessionId };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function contentHash(root: string, path: string): string | undefined {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  return createHash("sha256").update(readFileSync(full, "utf8")).digest("hex");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseItems(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// The team-provider allowlist arrives as an array of checkbox values. Each one
// is validated as a real provider so a typo becomes an error at start time,
// not an unstaffable plan several minutes in.
export function parseTeamProviders(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const providers = [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  if (!providers.length) return undefined;
  return providers.map((provider) => parseAgentProvider(provider.trim()));
}

function parseAgentProvider(value: string): AgentProvider {
  const allowed: AgentProvider[] = [
    "codex",
    "claude",
    "gemini",
    "antigravity",
    "openai-compatible",
    "deepseek",
    "kimi",
    "glm",
    "manual",
    "generic",
  ];
  if (allowed.includes(value as AgentProvider)) return value as AgentProvider;
  throw new Error(`Invalid provider "${value}". Use one of: ${allowed.join(", ")}.`);
}

function parseAgentRunMode(value: string): AgentRunMode {
  const allowed: AgentRunMode[] = ["cli", "api", "manual"];
  if (allowed.includes(value as AgentRunMode)) return value as AgentRunMode;
  throw new Error(`Invalid mode "${value}". Use one of: ${allowed.join(", ")}.`);
}


function parseSubtaskStatus(value: string): SubtaskStatus {
  const allowed: SubtaskStatus[] = [
    "todo",
    "assigned",
    "in_progress",
    "testing",
    "review",
    "blocked",
    "done",
    "cancelled",
  ];
  if (allowed.includes(value as SubtaskStatus)) return value as SubtaskStatus;
  throw new Error(`Invalid subtask status "${value}". Use one of: ${allowed.join(", ")}.`);
}

function parseAssignmentStatus(value: string): AssignmentStatus {
  const allowed: AssignmentStatus[] = [
    "queued",
    "approved",
    "running",
    "waiting",
    "done",
    "failed",
    "cancelled",
  ];
  if (allowed.includes(value as AssignmentStatus)) return value as AssignmentStatus;
  throw new Error(`Invalid assignment status "${value}". Use one of: ${allowed.join(", ")}.`);
}

function assignmentStatusToSubtaskStatus(
  status: AssignmentStatus,
): SubtaskStatus | undefined {
  if (status === "running") return "in_progress";
  if (status === "done") return "done";
  if (status === "failed") return "blocked";
  if (status === "cancelled") return "cancelled";
  if (status === "queued" || status === "approved") return "assigned";
  return undefined;
}

function resolveRegisteredAgent(
  agents: RegisteredAgent[],
  value: string,
): RegisteredAgent | undefined {
  return agents.find((agent) => agent.id === value || agent.name === value);
}

function resolveSubtask(subtasks: Subtask[], value: string): Subtask | undefined {
  return subtasks.find((subtask) => subtask.id === value || subtask.title === value);
}

function ownerAgentKind(agent: RegisteredAgent): AgentKind {
  if (["claude", "codex", "antigravity", "generic"].includes(agent.provider)) {
    return agent.provider as AgentKind;
  }
  return "generic";
}

function parseTaskStatus(value?: string): TaskStatus | undefined {
  if (!value) return undefined;
  const allowed: TaskStatus[] = [
    "todo",
    "in_progress",
    "blocked",
    "done",
    "cancelled",
  ];
  if (!allowed.includes(value as TaskStatus)) {
    throw new Error(
      `Invalid status "${value}". Use one of: ${allowed.join(", ")}.`,
    );
  }
  return value as TaskStatus;
}

function parseLaneMode(value: string): "patch" | "worktree" {
  if (value === "patch" || value === "worktree") return value;
  throw new Error('Invalid lane mode. Use "patch" or "worktree".');
}

function parseLaneStatus(
  value: string,
): "active" | "merged" | "discarded" | "conflict" {
  const allowed = ["active", "merged", "discarded", "conflict"];
  if (allowed.includes(value))
    return value as "active" | "merged" | "discarded" | "conflict";
  throw new Error(
    `Invalid lane status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

function parseLeaseMode(value: string): FileLeaseMode {
  if (value === "read" || value === "write") return value;
  throw new Error('Invalid lease mode. Use "read" or "write".');
}

function parseChangeType(
  value: string,
): "added" | "modified" | "deleted" | "renamed" {
  const allowed = ["added", "modified", "deleted", "renamed"];
  if (allowed.includes(value))
    return value as "added" | "modified" | "deleted" | "renamed";
  throw new Error(
    `Invalid change type "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

function parseChangeStatus(value: string): TaskChangeStatus {
  const allowed: TaskChangeStatus[] = [
    "pending",
    "accepted",
    "discarded",
    "conflict",
  ];
  if (allowed.includes(value as TaskChangeStatus))
    return value as TaskChangeStatus;
  throw new Error(
    `Invalid change status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

function visibleAgentRequests(requests: AgentRequest[]): AgentRequest[] {
  return requests.filter((request) => !isIgnoredClaudeIdlePrompt(request));
}

function isIgnoredClaudeIdlePrompt(request: AgentRequest): boolean {
  return request.agent === "claude" &&
    request.status === "pending" &&
    /(^|\n)Notification type:\s*\n?\s*idle_prompt(\n|$)/i.test(request.payload ?? "");
}

function parseRequestType(value: string): AgentRequestType {
  const allowed: AgentRequestType[] = [
    "approval",
    "command",
    "merge",
    "question",
  ];
  if (allowed.includes(value as AgentRequestType))
    return value as AgentRequestType;
  throw new Error(
    `Invalid request type "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

function parseRequestStatus(value: string): AgentRequestStatus {
  const allowed: AgentRequestStatus[] = [
    "pending",
    "accepted",
    "rejected",
    "resolved",
  ];
  if (allowed.includes(value as AgentRequestStatus))
    return value as AgentRequestStatus;
  throw new Error(
    `Invalid request status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

function parseAgentKind(value: string): AgentKind {
  const allowed: AgentKind[] = ["claude", "codex", "gemini", "antigravity", "generic"];
  if (!allowed.includes(value as AgentKind)) {
    throw new Error(
      `Invalid agent "${value}". Use one of: ${allowed.join(", ")}.`,
    );
  }
  return value as AgentKind;
}

function agentLabel(agent: AgentKind): string {
  return agent === "antigravity"
    ? "Antigravity"
    : agent[0].toUpperCase() + agent.slice(1);
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as JsonBody) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function renderUiHtml(cwd: string): string {
  return renderDashboardHtml(cwd);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --line: #d7dce2;
      --text: #17202a;
      --muted: #5c6670;
      --accent: #0f766e;
      --accent-2: #2563eb;
      --danger: #b42318;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header {
      height: 56px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 20px; border-bottom: 1px solid var(--line); background: var(--panel);
      position: sticky; top: 0; z-index: 2;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0; }
    main { max-width: 1320px; margin: 0 auto; padding: 18px; }
    .status { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .panel h2 { font-size: 14px; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .section { padding: 14px; }
    .stack { display: grid; gap: 12px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 600; }
    input, textarea, select {
      width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px;
      font: inherit; font-size: 14px; color: var(--text); background: #fff;
    }
    textarea { min-height: 76px; resize: vertical; }
    button {
      border: 1px solid transparent; border-radius: 6px; padding: 9px 12px; font-weight: 700;
      cursor: pointer; background: var(--accent); color: #fff;
    }
    button.secondary { background: #fff; color: var(--accent-2); border-color: var(--line); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .task-list { display: grid; gap: 8px; max-height: 360px; overflow: auto; }
    .task-item { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; }
    .task-item strong { display: block; font-size: 13px; margin-bottom: 4px; }
    .task-item span, .meta { color: var(--muted); font-size: 12px; }
    .memory-item { border-top: 1px solid var(--line); padding: 10px 0; }
    .memory-item:first-child { border-top: 0; padding-top: 0; }
    .tag { display: inline-block; padding: 2px 6px; border-radius: 999px; background: #eef6f5; color: var(--accent); font-size: 12px; margin-right: 4px; }
    pre {
      margin: 0; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 520px;
      background: #101828; color: #f8fafc; padding: 14px; border-radius: 8px; font-size: 12px; line-height: 1.5;
    }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .error { color: var(--danger); font-size: 13px; }
    @media (max-width: 900px) {
      .layout, .grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; height: auto; gap: 4px; flex-direction: column; padding: 12px 16px; }
      main { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>agent-bridge</h1>
    <div class="status" id="status">Loading local workspace...</div>
  </header>
  <main class="layout">
    <aside class="stack">
      <section class="panel">
        <h2>Current Task</h2>
        <div class="section stack">
          <div id="currentTask" class="meta">No task loaded.</div>
          <form id="taskForm" class="stack">
            <label>Title <input name="title" required placeholder="Fix checkout validation bug"></label>
            <label>Goal <textarea name="goal" placeholder="Expected outcome"></textarea></label>
            <label>Agent
              <select name="agent">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="generic">Generic</option>
              </select>
            </label>
            <button type="submit">Start Task</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <h2>Recent Tasks</h2>
        <div class="section task-list" id="tasks"></div>
      </section>
    </aside>

    <section class="stack">
      <div class="grid">
        <section class="panel">
          <h2>Add Memory</h2>
          <div class="section">
            <form id="memoryForm" class="stack">
              <label>Content <textarea name="content" required placeholder="Important fact, bug, decision, or constraint"></textarea></label>
              <div class="grid">
                <label>Type
                  <select name="type">
                    <option value="note">note</option>
                    <option value="bug">bug</option>
                    <option value="constraint">constraint</option>
                    <option value="decision">decision</option>
                    <option value="test">test</option>
                    <option value="file">file</option>
                  </select>
                </label>
                <label>Importance <input name="importance" type="number" min="1" max="5" value="3"></label>
              </div>
              <label>Tags <input name="tags" placeholder="auth,cookie,session"></label>
              <button type="submit">Save Memory</button>
            </form>
          </div>
        </section>

        <section class="panel">
          <h2>Compile Context</h2>
          <div class="section stack">
            <form id="compileForm" class="stack">
              <div class="grid">
                <label>Agent
                  <select name="agent">
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="generic">Generic</option>
                    <option value="antigravity">Antigravity</option>
                  </select>
                </label>
                <label>Budget <input name="budget" type="number" value="4000"></label>
              </div>
              <button type="submit">Compile</button>
            </form>
            <div class="toolbar">
              <input id="searchQuery" placeholder="Search memory">
              <button class="secondary" id="searchButton" type="button">Search</button>
            </div>
            <div id="searchResults"></div>
          </div>
        </section>
      </div>

      <section class="panel">
        <h2>Handoff</h2>
        <div class="section">
          <form id="handoffForm" class="stack">
            <div class="grid">
              <label>From <select name="from"><option value="claude">Claude</option><option value="codex">Codex</option><option value="generic">Generic</option></select></label>
              <label>To <select name="to"><option value="codex">Codex</option><option value="claude">Claude</option><option value="generic">Generic</option></select></label>
            </div>
            <label>Summary <textarea name="summary" required placeholder="What changed or what was found"></textarea></label>
            <div class="grid">
              <label>Done <textarea name="done" placeholder="Comma or newline separated"></textarea></label>
              <label>Next <textarea name="next" placeholder="Comma or newline separated"></textarea></label>
            </div>
            <label>Risks <input name="risks" placeholder="Do not touch payment flow"></label>
            <button type="submit">Create Handoff</button>
          </form>
        </div>
      </section>

      <section class="panel">
        <h2>Memories</h2>
        <div class="section" id="memories"></div>
      </section>

      <section class="panel">
        <h2>Compiled Context</h2>
        <div class="section"><pre id="compiled"></pre></div>
      </section>
    </section>
  </main>

  <script>
    const statusEl = document.getElementById('status');
    const currentTaskEl = document.getElementById('currentTask');
    const tasksEl = document.getElementById('tasks');
    const memoriesEl = document.getElementById('memories');
    const compiledEl = document.getElementById('compiled');
    const searchResultsEl = document.getElementById('searchResults');

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function load() {
      try {
        const state = await api('/api/state');
        statusEl.textContent = state.currentTask ? 'Current: ' + state.currentTask.title : 'No current task';
        currentTaskEl.innerHTML = state.currentTask
          ? '<strong>' + escapeHtml(state.currentTask.title) + '</strong><br><span>' + escapeHtml(state.currentTask.goal || 'No goal recorded') + '</span>'
          : 'No current task.';
        tasksEl.innerHTML = state.tasks.map(task => '<div class="task-item"><strong>' + escapeHtml(task.title) + '</strong><span>' + escapeHtml(task.status) + ' · ' + escapeHtml(task.id) + '</span></div>').join('') || '<div class="meta">No tasks yet.</div>';
        memoriesEl.innerHTML = state.memories.map(renderMemory).join('') || '<div class="meta">No memories for current task.</div>';
        compiledEl.textContent = state.compiledContext || 'No compiled context yet.';
      } catch (error) {
        statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      }
    }

    function renderMemory(memory) {
      const tags = (memory.tags || []).map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
      return '<div class="memory-item"><div class="meta">' + escapeHtml(memory.type) + ' · importance ' + memory.importance + '</div><div>' + escapeHtml(memory.content) + '</div><div>' + tags + '</div></div>';
    }

    function formData(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    function bindForm(id, path, after) {
      document.getElementById(id).addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await api(path, { method: 'POST', body: JSON.stringify(formData(form)) });
          form.reset();
          if (after) after();
          await load();
        } catch (error) {
          statusEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
        }
      });
    }

    bindForm('taskForm', '/api/task/start');
    bindForm('memoryForm', '/api/memory/add');
    bindForm('compileForm', '/api/context/compile');
    bindForm('handoffForm', '/api/handoff/create');

    document.getElementById('searchButton').addEventListener('click', async () => {
      try {
        const q = document.getElementById('searchQuery').value;
        const data = await api('/api/memory/search?q=' + encodeURIComponent(q));
        searchResultsEl.innerHTML = data.results.map(renderMemory).join('') || '<div class="meta">No matches.</div>';
      } catch (error) {
        searchResultsEl.innerHTML = '<span class="error">' + escapeHtml(error.message) + '</span>';
      }
    });

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }

    load();
  </script>
</body>
</html>`;
}














