import type { RouteContext } from "./types.js";
import {
  getActiveTaskId,
  openStore,
} from "../../workspace.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  contentHash,
  optionalString,
  parseChangeStatus,
  parseChangeType,
  parseLaneMode,
  parseLaneStatus,
  parseRequestType,
  requiredString,
} from "./validation.js";
import {
  type AgentKind,
} from "@agent-bridge/memory";

// Work-Git: lanes, file leases and the change records the Work Board shows,
// plus the spawn requests agents raise.

export async function routePostOrchestrationLane(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostOrchestrationLeaseAcquire(ctx: RouteContext): Promise<void> {

}

export async function routePostOrchestrationLeaseRelease(ctx: RouteContext): Promise<void> {

}

export async function routePostOrchestrationChange(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostOrchestrationRequest(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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
