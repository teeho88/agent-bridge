import type { RouteContext } from "./types.js";
import {
  getActiveTaskId,
  openStore,
  paths,
  policyBudgets,
  readConfig,
  resolveActiveTaskId,
  resolveCurrentTaskId,
  resolveTokenBudget,
  setCurrentTask,
  startAgentSession,
  syncAfterTaskDeleted,
  syncCurrentTaskArtifact,
  writeCurrentTaskArtifact,
} from "../../workspace.js";
import {
  stopAutoRun,
} from "./auto-run.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  inferContextAgent,
} from "./lookups.js";
import {
  writeTaskContext,
} from "./task-changes.js";
import {
  agentLabel,
  optionalString,
  parseAgentKind,
  parseTaskStatus,
  requiredString,
} from "./validation.js";
import {
  compileContext,
} from "@agent-bridge/core";
import {
  renderRepoMap,
  type AgentKind,
  type Task,
} from "@agent-bridge/memory";
import {
  writeFileSync,
} from "node:fs";

// Task lifecycle and the compiled context that travels with a task.

export async function routePostTaskStart(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostTaskUpdate(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostTaskDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostTaskStop(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostTaskPrompt(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostContextCompile(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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
    writeTaskContext(taskId, pack.renderedMarkdown, cwd);
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

export async function routePostContextSave(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const content = requiredString(body.content, "content");
  const taskId = optionalString(body.taskId);
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (taskId) writeTaskContext(taskId, normalized, cwd);
  if (!taskId || taskId === resolveCurrentTaskId())
    writeFileSync(paths(cwd).compiledContext, normalized, "utf8");
  sendJson(res, 200, { ok: true });
  return;
}
