import type { RouteContext } from "./types.js";
import { listNativeSessions, mergeSessionHistory, readNativeSessionContext, type NativeSession } from "../../native-sessions.js";
import { readSessionProcessStart, sessionProcessLiveness } from "../../session-process.js";
import {
  applyTaskLabelSuggestion,
  markTaskGoalOmitted,
} from "../../task-suggestions.js";
import {
  endAgentSession,
  openStore,
  readConfig,
  redactIfEnabled,
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
  optionalBoolean,
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
  if (!commandExists("wt.exe")) throw new Error("Windows Terminal (wt.exe) is required to open a visible agent terminal.");
  const store = openStore(cwd);
  try {
    const requestedTaskId = optionalString(body.taskId);
    const createGoal = optionalBoolean(body.createGoal, false);
    const sourceSessionId = optionalString(body.sessionId);
    const config = readConfig(cwd);
    const sourceEvent = sourceSessionId ? store.listSessionEvents({ sessionId: sourceSessionId, limit: 1 })[0] : undefined;
    const nativeId = sourceSessionId ? config.terminalNativeSessions?.[sourceSessionId] ?? sourceSessionId : undefined;
    const nativeSource = sourceSessionId ? listNativeSessions(cwd).find((session) => session.sessionId === sourceSessionId ||
      (session.nativeSessionId === nativeId && (!sourceEvent?.agent || session.agent === sourceEvent.agent))) : undefined;
    let nativeContext: string | undefined;
    if (nativeSource) {
      if (requestedTaskId && requestedTaskId !== (sourceEvent?.taskId ?? config.sessionTasks?.[sourceSessionId!]))
        throw new Error("Session does not belong to the selected task.");
      const switching = nativeSource.agent !== agent;
      const mode = optionalString(body.sessionMode);
      if (switching && mode !== "clone" && mode !== "transfer") throw new Error("Choose transfer or clone when changing agents.");
      if (switching && mode === "transfer" && nativeSource.liveness === "running") throw new Error("Close the source terminal before transferring this session, or choose clone.");
      nativeContext = switching ? redactIfEnabled(await readNativeSessionContext(nativeSource), cwd) : undefined;
      importNativeSession(store, cwd, nativeSource, sourceSessionId!, nativeContext);
    }
    if (sourceSessionId) {
      const source = store.listSessionEvents({ sessionId: sourceSessionId, limit: 1 })[0];
      const binding = readConfig(cwd).sessionWindows?.[sourceSessionId];
      const sourceTaskId = source?.taskId ?? readConfig(cwd).sessionTasks?.[sourceSessionId];
      if (requestedTaskId && sourceTaskId !== requestedTaskId) throw new Error("Session does not belong to the selected task.");
      if (source?.agent === agent && binding && sessionProcessLiveness(binding) === "running") {
        const task = store.getTask(source.taskId ?? binding.taskId);
        if (task) {
          const focus = focusAgentTerminal(task, agent, sourceSessionId, binding);
          if (!focus.focused) throw new Error(focus.reason ?? "Could not focus the running session.");
          sendJson(res, 200, { task, sessionId: sourceSessionId, focus, continued: true });
          return;
        }
      }
    }
    const prepared = sourceSessionId
      ? prepareSessionReopen(store, cwd, sourceSessionId, agent, optionalString(body.sessionMode), requestedTaskId)
      : { ...prepareAgentTerminalTask(store, agent, requestedTaskId, body.transferOwnership === true, createGoal), source: undefined, nativeSessionId: undefined, sessionMode: undefined };
    const { task, continued, source, nativeSessionId, sessionMode } = prepared;
    const sessionId = `${agent}-terminal-${randomUUID()}`;
    startAgentSession(sessionId, task.id, cwd, agent);
    try {
      store.recordSessionEvent({
        sessionId,
        taskId: task.id,
        agent,
        kind: "session_started",
        summary: source
          ? `${agentLabel(agent)} ${sessionMode ?? "resumed"} from ${source.agent}/${source.sessionId}.`
          : continued
          ? `${agentLabel(agent)} continued task from Work Board handoff.`
          : `${agentLabel(agent)} terminal opened from Work Board.`,
      });
      writeCurrentTaskArtifact(task, cwd);
      const terminal = launchAgentTerminal(
        cwd,
        task,
        agent,
        sessionId,
        command,
        { nativeSessionId, continuedTaskId: continued ? task.id : undefined },
      );
      if (source && sessionMode === "transfer") {
        store.recordSessionEvent({ sessionId: source.sessionId, taskId: source.taskId, agent: source.agent,
          kind: "session_paused", summary: `Transferred to ${agent}/${sessionId}.` });
        endAgentSession(source.sessionId, cwd);
      }
      sendJson(res, 200, { task, sessionId, terminal, continued, sourceSessionId, sessionMode });
    } catch (error) {
      store.recordSessionEvent({ sessionId, taskId: task.id, agent, kind: "session_ended", summary: "Terminal launch failed." });
      endAgentSession(sessionId, cwd);
      throw error;
    }
  } finally {
    store.close();
  }
  return;
}

export function importNativeSession(store: ReturnType<typeof openStore>, cwd: string, native: NativeSession, sessionId: string, context?: string): void {
  const config = readConfig(cwd);
  const event = store.listSessionEvents({ sessionId, limit: 1 })[0];
  let taskId = event?.taskId ?? config.sessionTasks?.[sessionId];
  if (!taskId || !store.getTask(taskId)) {
    const task = store.createTask({ title: native.title, ownerAgent: native.agent });
    taskId = task.id;
    store.recordSessionEvent({ sessionId, taskId, agent: native.agent, kind: "session_ended", summary: `Imported native ${native.agent} conversation ${native.nativeSessionId}.`, createdAt: native.lastActivityAt });
  }
  if (context !== undefined) store.upsertLatestMemory({ taskId, type: "note", content: context, importance: 5, sourceAgent: native.agent,
    tags: ["native-session-context", native.nativeSessionId] }, { latestTag: native.nativeSessionId });
  const latest = readConfig(cwd);
  writeConfig({ ...latest, sessionTasks: { ...latest.sessionTasks, [sessionId]: taskId },
    terminalNativeSessions: { ...latest.terminalNativeSessions, [sessionId]: native.nativeSessionId } }, cwd);
}

export function prepareSessionReopen(
  store: ReturnType<typeof openStore>, cwd: string, sourceSessionId: string, agent: AgentKind,
  mode?: string, requestedTaskId?: string,
) {
  const source = store.listSessionEvents({ sessionId: sourceSessionId, limit: 1 })[0];
  if (!source) throw new Error(`Session not found: ${sourceSessionId}`);
  const config = readConfig(cwd);
  const taskId = source.taskId ?? config.sessionTasks?.[sourceSessionId];
  if (requestedTaskId && requestedTaskId !== taskId) throw new Error("Session does not belong to the selected task.");
  const original = taskId ? store.getTask(taskId) : undefined;
  if (!original) throw new Error("The source session has no saved task context.");
  const switching = source.agent !== agent;
  if (mode && mode !== "transfer" && mode !== "clone") throw new Error("Choose transfer or clone for session mode.");
  if (switching && !mode) throw new Error("Choose transfer or clone when changing agents.");
  const sessionMode = switching ? mode : undefined;
  if (sessionMode === "transfer" && sessionProcessLiveness(config.sessionWindows?.[sourceSessionId]) === "running")
    throw new Error("Close the source terminal before transferring this session, or choose clone.");
  let task;
  if (sessionMode === "clone") {
    task = store.createTask({ title: original.title, goal: original.goal, ownerAgent: agent });
    for (const memory of store.listMemoriesForTask(original.id, 500)) {
      if (memory.tags.some((tag) => ["secret", "private"].includes(tag))) continue;
      store.addMemory({ taskId: task.id, type: memory.type, content: memory.content,
        importance: memory.importance, tags: memory.tags, sourceAgent: memory.sourceAgent });
    }
    const handoff = store.getLatestHandoff(original.id);
    if (handoff) store.createHandoff({ ...handoff, taskId: task.id });
    const decisions = store.listDecisions(original.id);
    if (decisions.length) store.addMemory({ taskId: task.id, type: "note", importance: 5,
      content: `Source task decisions:\n${JSON.stringify(decisions)}`, tags: ["session-context"], sourceAgent: source.agent });
    store.addMemory({ taskId: task.id, type: "note", importance: 5, sourceAgent: source.agent,
      tags: ["session-context"], content: `Cloned from ${source.agent}/${sourceSessionId} (task ${original.id}).\n` +
        store.listSessionEvents({ sessionId: sourceSessionId, limit: 20 }).reverse().map((event) => `${event.kind}: ${event.summary ?? ""}`).join("\n") });
  } else {
    task = prepareAgentTerminalTask(store, agent, original.id, switching).task;
  }
  const native = config.terminalNativeSessions?.[sourceSessionId] ?? sourceSessionId;
  const nativeSessionId = !switching && (config.terminalNativeSessions?.[sourceSessionId] ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(native)) ? native : undefined;
  return { task, continued: true, source, sessionMode, nativeSessionId };
}

export function prepareAgentTerminalTask(
  store: ReturnType<typeof openStore>,
  agent: AgentKind,
  taskId?: string,
  transferOwnership = false,
  createGoal = false,
) {
  if (!taskId) {
    const created = store.createTask({
      title: `${agentLabel(agent)} terminal`,
      goal: createGoal ? `Interactive ${agentLabel(agent)} CLI opened from Work Board.` : undefined,
      ownerAgent: agent,
    });
    return {
      task: createGoal ? created : (markTaskGoalOmitted(store, created.id, agent) ?? created),
      continued: false,
    };
  }
  const existing = store.getTask(taskId);
  if (!existing) throw new Error(`Task not found: ${taskId}`);
  if (store.getTaskContract(taskId)) {
    const claim = store.getTaskOwnerClaim(taskId);
    if (claim) throw new Error(`Managed task is claimed by ${claim.agent}/${claim.sessionId}; release the claim before opening a new terminal session`);
    if (transferOwnership && existing.ownerAgent && existing.ownerAgent !== agent)
      throw new Error("Managed task ownership must change through an explicit claim");
    return { task: existing, continued: true };
  }
  const task = store.updateTask(taskId, {
    status: "in_progress",
    ownerAgent: transferOwnership ? agent : undefined,
  });
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { task, continued: true };
}

export async function routePostSessionWindow(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const sessionId = requiredString(body.sessionId, "sessionId");
  const windowId = requiredString(body.windowId, "windowId");
  const pid = Number(body.pid);
  const processStartedAt = readSessionProcessStart(pid, true);
  const hwnd = optionalString(body.hwnd);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer.");
  if (!processStartedAt) throw new Error("Cannot register a terminal without verifying its process identity.");
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
        processStartedAt,
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

export async function routePostSessionDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const sessionId = requiredString(body.sessionId, "sessionId");
  const config = readConfig(cwd);
  const store = openStore(cwd);
  try {
    const session = mergeSessionHistory(store.listSessionHistory(), listNativeSessions(cwd), config)
      .find((item) => item.sessionId === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const nativeId = config.terminalNativeSessions?.[sessionId] ?? sessionId.replace(/^native:(?:claude|codex|antigravity):/, "");
    writeConfig({ ...config, deletedSessionIds: { ...config.deletedSessionIds,
      [sessionId]: true, [`${session.agent}:${nativeId}`]: true,
    } }, cwd);
    sendJson(res, 200, { ok: true, sessionId });
  } finally {
    store.close();
  }
}
