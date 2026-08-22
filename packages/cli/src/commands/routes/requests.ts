import type { RouteContext } from "./types.js";
import {
  openStore,
} from "../../workspace.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  optionalString,
  parseRequestStatus,
  requiredString,
} from "./validation.js";

// Agent requests raised from a session and cleared from the dashboard.

export async function routePostRequestDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostRequestClear(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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
