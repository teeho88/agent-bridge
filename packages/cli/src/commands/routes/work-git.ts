import type { RouteContext } from "./types.js";
import {
  getActiveTaskId,
  openStore,
  readConfig,
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
  parseLeaseMode,
  parseAgentKind,
  parseRequestType,
  requiredString,
} from "./validation.js";
import { normalizeLeasePath } from "../file.js";
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
  const body = await readJson(ctx.req);
  const store = openStore(ctx.cwd);
  try {
    const owner = leaseOwner(body, ctx.cwd, store);
    const ttlSeconds = Number(body.ttl ?? 3600);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error("Lease duration must be positive.");
    const result = store.acquireFileLease({
      ...owner,
      path: normalizeLeasePath(requiredString(body.path, "path")),
      mode: parseLeaseMode(optionalString(body.mode) ?? "write"),
      ttlSeconds,
    });
    sendJson(ctx.res, 200, result);
  } finally { store.close(); }
}

export async function routePostOrchestrationLeaseRelease(ctx: RouteContext): Promise<void> {
  const body = await readJson(ctx.req);
  const store = openStore(ctx.cwd);
  try {
    const owner = leaseOwner(body, ctx.cwd, store);
    const lease = store.releaseFileLease(requiredString(body.leaseId, "leaseId"), owner);
    if (!lease) sendJson(ctx.res, 404, { error: "File lease not found" });
    else sendJson(ctx.res, 200, { lease });
  } finally { store.close(); }
}

function leaseOwner(body: Record<string, unknown>, cwd: string, store: ReturnType<typeof openStore>) {
  const agent = parseAgentKind(optionalString(body.agent) ?? "codex");
  const config = readConfig(cwd);
  const sessionId = optionalString(body.sessionId) ?? config.currentSessions?.[agent];
  const boundTask = sessionId ? config.sessionTasks?.[sessionId] : undefined;
  if (body.sessionId && !boundTask) throw new Error("Unknown lease session");
  const requestedTask = optionalString(body.taskId);
  if (requestedTask && boundTask && requestedTask !== boundTask) throw new Error("Lease session/task mismatch");
  return { taskId: requestedTask ?? boundTask ?? getActiveTaskId(store, cwd, undefined, agent), agent, sessionId: boundTask ? sessionId : undefined };
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
