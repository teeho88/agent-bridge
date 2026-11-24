import type { SQLiteMemoryStore } from "@agent-bridge/memory";
import { readConfig, writeConfig } from "./workspace-config.js";

export type WorkflowMode = "full" | "single";

export type WorkflowResolution = {
  requestedMode: WorkflowMode;
  mode: WorkflowMode;
  reason: "configured_full" | "spawned_run" | "orchestration" | "missing_session" | "promoted_session" | "active_assignment" | "concurrent_session" | "single_session";
};

export function resolveWorkflowMode(store: SQLiteMemoryStore, cwd: string, sessionId?: string): WorkflowResolution {
  const config = readConfig(cwd);
  const requestedMode = config.workflow?.mode === "single" ? "single" : "full";
  const full = (reason: WorkflowResolution["reason"]): WorkflowResolution => ({ requestedMode, mode: "full", reason });
  if (requestedMode === "full") return full("configured_full");
  if (process.env.AGENT_BRIDGE_SPAWNED_RUN) return full("spawned_run");
  if (process.env.AGENT_BRIDGE_ORCHESTRATION) return full("orchestration");
  if (!sessionId) return full("missing_session");
  if (config.workflow?.promotedSessions?.includes(sessionId)) return full("promoted_session");
  const identity = (id: string) => {
    const terminal = Object.entries(config.terminalNativeSessions ?? {}).find(([, native]) => native === id)?.[0] ?? id;
    const window = config.sessionWindows?.[terminal];
    return window?.windowId ?? window?.hwnd ?? terminal;
  };
  const taskId = config.sessionTasks?.[sessionId];
  if (taskId && store.listAssignments({ taskId, limit: 200 }).some((assignment) => ["queued", "approved", "running", "waiting"].includes(assignment.status))) return full("active_assignment");
  const own = identity(sessionId);
  const concurrent = store.listActiveSessionEvents(200).some((event) => {
    const task = event.taskId ? store.getTask(event.taskId) : undefined;
    return task && !["done", "cancelled"].includes(task.status) && identity(event.sessionId) !== own;
  });
  if (!concurrent) return { requestedMode, mode: "single", reason: "single_session" };
  writeConfig({ ...config, workflow: { ...config.workflow, mode: requestedMode, promotedSessions: [...new Set([
    ...(config.workflow?.promotedSessions ?? []), sessionId,
  ])] } }, cwd);
  return full("concurrent_session");
}

export function effectiveWorkflowMode(store: SQLiteMemoryStore, cwd: string, sessionId?: string): WorkflowMode {
  return resolveWorkflowMode(store, cwd, sessionId).mode;
}
