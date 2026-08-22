import type { RouteContext } from "./types.js";
import { defaultUiPort } from "./http.js";
import {
  applyTaskLabelSuggestion,
} from "../../task-suggestions.js";
import {
  endAgentSession,
  openStore,
  readConfig,
  resolveActiveTaskId,
  startAgentSession,
  writeConfig,
  writeCurrentTaskArtifact,
} from "../../workspace.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  commandExists,
  focusAgentTerminal,
  launchAgentTerminal,
} from "./terminal.js";
import {
  agentLabel,
  optionalString,
  parseAgentKind,
  requiredString,
} from "./validation.js";
import {
  type AgentKind,
} from "@agent-bridge/memory";
import {
  randomUUID,
} from "node:crypto";

// Agent sessions: starting and ending them, the terminal window they run in,
// and the summary the dashboard shows.

export async function routePostSessionStart(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostSessionTerminal(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostSessionWindow(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostSessionFocus(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostSessionSummary(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostSessionEnd(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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
