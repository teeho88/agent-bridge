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
  syncCurrentTaskArtifact,
  writeCurrentTaskArtifact,
} from "../../workspace.js";
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
  optionalBoolean,
  optionalString,
  parseAgentKind,
  requiredString,
} from "./validation.js";
import {
  markTaskGoalOmitted,
} from "../../task-suggestions.js";
import {
  compileContext,
} from "@agent-bridge/core";
import {
  type AgentKind,
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
    const createGoal = optionalBoolean(body.createGoal, false);
    let task = store.createTask({
      title: requiredString(body.title, "title"),
      goal: createGoal ? optionalString(body.goal) : undefined,
      ownerAgent: agent,
    });
    if (!createGoal) task = markTaskGoalOmitted(store, task.id, agent) ?? task;
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
    const pack = compileContext(store, {
      taskId,
      agent,
      tokenBudget,
      includeFiles: false,
      graphEnabled: config.graph?.enabled !== false,
      ...policyBudgets(cwd),
    });
    writeTaskContext(taskId, pack.renderedMarkdown, cwd);
    if (resolveActiveTaskId(store, cwd) === taskId) {
      writeFileSync(
        paths(cwd).compiledContext,
        pack.renderedMarkdown,
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
