import type { RouteContext } from "./types.js";
import { listNativeSessions, mergeSessionHistory } from "../../native-sessions.js";
import { sessionProcessLiveness } from "../../session-process.js";
import { getCodexHookStatus } from "../codex.js";
import { boundStatePayload } from "./state-payload.js";
import { createHash } from "node:crypto";
import {
  ensureDefaultAgentPresetStates,
} from "../../default-agent-presets.js";
import { dashboardSkills } from "./dashboard-cache.js";
import {
  cleanupStaleAgentSessions,
  openStore,
  paths,
  readConfig,
  resolveActiveTaskId,
} from "../../workspace.js";
import {
  getAntigravityHookStatus,
} from "../antigravity.js";
import {
  getClaudeHookStatus,
} from "../claude.js";
import {
  safeRead,
} from "./files.js";
import {
  emptyPortableHandoffState,
  readPortableHandoffState,
} from "./handoff-state.js";
import {
  sendJson,
} from "./http.js";
import {
  filterWorkBoardSessionEvents,
  visibleAgentRequests,
} from "./lookups.js";
import {
  optimizeStats,
  optionalToolsStatus,
  tokenStackStatus,
} from "./status.js";
import {
  enrichTaskChanges,
  taskChangesWithWriteLeases,
  taskContextPath,
} from "./task-changes.js";
import {
  isWatcherRunning,
} from "./watcher.js";
import {
  estimateTokenSavings,
  isLeaderOnlyAgent,
} from "@agent-bridge/core";
import {
  spawn,
} from "node:child_process";

// The single payload the dashboard polls: tasks, memories, sessions, runs,
// requests and config in one response.

export async function routeGetState(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  try {
    const store = openStore(cwd);
    try {
      cleanupStaleAgentSessions(store, cwd);
      let activeTaskId: string | null;
      try { activeTaskId = typeof ctx.url.query.task === "string" && ctx.url.query.task ? ctx.url.query.task : resolveActiveTaskId(store, cwd); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Ambiguous active task")) throw error;
        activeTaskId = null;
      }
      const config = readConfig(cwd);
      const tasks = store.listTasks(30);
      // Handoff History is repository-wide, so it must not inherit either the
      // selected-task filter or the shorter task list used by the main board.
      const handoffPage = store.listLatestTaskHandoffs(51);
      const latestTaskHandoffs = handoffPage.slice(0, 50);
      const currentTask = activeTaskId
        ? store.getTask(activeTaskId)
        : undefined;
      // Keep the live session state separate from durable memories in the UI.
      // Fetch a wide window so the moderate-importance latest response is not
      // dropped before it can be presented as session state.
      const visibleMemories = activeTaskId
        ? store
            .listMemoriesForTask(activeTaskId, 50)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [];
      const sessionState = activeTaskId ? store.getLatestResponse(activeTaskId) : undefined;
      const memories = visibleMemories.slice(0, 50);
      const compiledContext = activeTaskId
        ? safeRead(taskContextPath(activeTaskId, cwd)) ||
          safeRead(paths(cwd).compiledContext)
        : safeRead(paths(cwd).compiledContext);
      const handoff = activeTaskId
        ? store.getLatestHandoff(activeTaskId)
        : undefined;
      const portableHandoff = activeTaskId
        ? readPortableHandoffState(cwd, activeTaskId)
        : emptyPortableHandoffState();
      // Work Board is for direct/human agent sessions. Orchestrated tasks
      // already have a dedicated Runs board, so duplicating their sessions
      // here makes one orchestration look like many unrelated live tasks.
      const activeSessionEvents = store.listActiveSessionEvents(100).map((event) => ({
        ...event, liveness: sessionProcessLiveness(config.sessionWindows?.[event.sessionId]),
      }));
      const orchestratedTaskIds = new Set(
        store.listOrchestrations({ limit: 500 }).map((orchestration) => orchestration.taskId),
      );
      const bridgeSessionHistory = filterWorkBoardSessionEvents(store.listSessionHistory(), orchestratedTaskIds).map((event) => ({
        ...event,
        taskId: event.taskId ?? config.sessionTasks?.[event.sessionId],
        title: store.getTask(event.taskId ?? config.sessionTasks?.[event.sessionId] ?? "")?.title,
        liveness: sessionProcessLiveness(config.sessionWindows?.[event.sessionId]),
      }));
      const sessionHistory = mergeSessionHistory(bridgeSessionHistory, listNativeSessions(cwd), config);
      const workBoardSessionEvents = filterWorkBoardSessionEvents(
        activeSessionEvents.filter((event) => event.liveness === "running"),
        orchestratedTaskIds,
      );
      const liveTaskIds = new Set(
        workBoardSessionEvents
          .map((event) => event.taskId)
          .filter((taskId): taskId is string => Boolean(taskId)),
      );
      const recentActivityTaskIds = new Set([
        ...liveTaskIds,
        ...store.listSessionEvents({ limit: 100 }).map((event) => event.taskId).filter((id): id is string => Boolean(id)),
      ]);
      for (const taskId of recentActivityTaskIds) {
        if (tasks.some((task) => task.id === taskId)) continue;
        const task = store.getTask(taskId);
        if (task) tasks.push(task);
      }
      const workBoardTasks = tasks.map((task) => {
        const event = store.listSessionEvents({ taskId: task.id, limit: 1 })[0];
        const response = store.getLatestResponse(task.id);
        const lastActivityAt = [task.updatedAt, task.createdAt, event?.createdAt, response?.updatedAt, response?.createdAt]
          .filter((time): time is string => Boolean(time) && Number.isFinite(Date.parse(time!)))
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
        return { ...task, lastActivityAt };
      });
      const liveTasks = tasks
        .filter(
          (task) =>
            task.status !== "done" &&
            task.status !== "cancelled" &&
            liveTaskIds.has(task.id),
        )
        .map((task) => {
          const taskMemories = store
            .listMemoriesForTask(task.id, 50)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const taskSessionState = store.getLatestResponse(task.id);
          const taskVisibleMemories = taskMemories.slice(0, 50);
          const taskHandoff = store.getLatestHandoff(task.id);
          const taskCompiledContext = safeRead(taskContextPath(task.id, cwd));
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
            portableHandoff: readPortableHandoffState(cwd, task.id),
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
      sendDashboardState(ctx, {
        workspace: cwd,
        config,
        tasks: workBoardTasks,
        currentTask,
        liveTasks,
        repoMemories,
        repoMemoryCandidates,
        taskLanes,
        fileLeases,
        taskChanges,
        agentRequests,
        // Lets the dashboard tell an orchestration's approval/question apart
        // from a plain Work Board request, so clicking its toast lands on the
        // orchestration that raised it instead of the Work Board.
        orchestrationTaskIds: store
          .listOrchestrations({ limit: 200 })
          .map((item) => item.taskId),
        // Leader rows are plumbing, not staff: they exist only so a plan turn
        // has something to spawn, so they stay out of the Agents tab.
        registeredAgents: store.listRegisteredAgents({ limit: 500 }).filter((agent) => !isLeaderOnlyAgent(agent)),
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
        sessionHistory,
        sessionState,
        memories,
        compiledContext,
        handoff,
        latestTaskHandoffs,
        handoffHistoryPage: { nextOffset: handoffPage.length > 50 ? 50 : null },
        portableHandoff,
        claudeHookInstalled,
        claudeHookStatus,
        codexHookStatus: getCodexHookStatus(cwd),
        antigravityHookStatus,
        watcherRunning: isWatcherRunning(),
        optionalTools: optionalToolsStatus(),
        skills: dashboardSkills(cwd),
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
    sendDashboardState(ctx, {
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
      orchestrationTaskIds: [],
      registeredAgents: [],
      defaultAgentPresets: [],
      credentialRefs: [],
      subtasks: [],
      assignments: [],
      dispatchRuns: [],
      activeSessionEvents: [],
      handoff: undefined,
      latestTaskHandoffs: [],
      portableHandoff: emptyPortableHandoffState(),
      claudeHookInstalled: getClaudeHookStatus(cwd).installed,
      claudeHookStatus: getClaudeHookStatus(cwd),
      codexHookStatus: getCodexHookStatus(cwd),
      antigravityHookStatus: getAntigravityHookStatus(cwd),
      watcherRunning: isWatcherRunning(),
      optionalTools: optionalToolsStatus(),
      skills: [],
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

export function routeGetHandoffHistory(ctx: RouteContext): void {
  const limit = Number(ctx.url.query.limit ?? 50);
  const offset = Number(ctx.url.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 99 || !Number.isInteger(offset) || offset < 0) {
    sendJson(ctx.res, 400, { error: "Invalid handoff pagination" });
    return;
  }
  const store = openStore(ctx.cwd);
  try {
    const page = store.listLatestTaskHandoffs(limit + 1, offset);
    sendJson(ctx.res, 200, { items: page.slice(0, limit), nextOffset: page.length > limit ? offset + limit : null });
  } finally { store.close(); }
}

function sendDashboardState(ctx: RouteContext, data: Record<string, unknown>): void {
  data = ctx.url.pathname === "/api/state/details" ? data : boundStatePayload(data);
  const revision = createHash("sha256").update(JSON.stringify({ ...data, serverTime: undefined })).digest("hex");
  const etag = `"${revision}"`;
  if (ctx.req.headers["if-none-match"] === etag) {
    ctx.res.writeHead(304, { etag, "cache-control": "no-cache" });
    ctx.res.end();
    return;
  }
  ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
  ctx.res.end(JSON.stringify({ ...data, stateRevision: revision }));
}
