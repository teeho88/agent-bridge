import type { RouteContext } from "./types.js";
import {
  refreshBriefs,
} from "../../graph-brief.js";
import {
  getActiveTaskId,
  openStore,
  parseList,
  readConfig,
  resolveActiveTaskId,
} from "../../workspace.js";
import {
  buildGraphView,
} from "./graph-view.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  contentHash,
  optionalString,
  requiredString,
} from "./validation.js";
import {
  extractGraph,
  type AgentKind,
  type MemoryType,
} from "@agent-bridge/memory";

// The repository graph and the memories attached to a task or the repo.

export async function routePostMemoryAdd(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routePostRepoMemoryUpdate(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const importance = Number(body.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new Error("importance must be an integer from 1 to 5");
  }
  const store = openStore(cwd);
  try {
    const memory = store.updateRepoMemory(requiredString(body.id, "id"), {
      type: requiredString(body.type, "type") as MemoryType,
      content: requiredString(body.content, "content"),
      tags: parseList(optionalString(body.tags)),
      importance,
    });
    if (!memory) sendJson(res, 404, { error: "Repository memory not found" });
    else sendJson(res, 200, { memory });
  } finally {
    store.close();
  }
  return;
}

export async function routePostRepoMemoryDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const deleted = store.deleteRepoMemory(requiredString(body.id, "id"));
    if (!deleted) sendJson(res, 404, { error: "Repository memory not found" });
    else sendJson(res, 200, { deleted });
  } finally {
    store.close();
  }
  return;
}

export async function routeGetMemorySearch(ctx: RouteContext): Promise<void> {
  const { res, url, cwd } = ctx;
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

export async function routePostGraphBuild(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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

export async function routeGetGraph(ctx: RouteContext): Promise<void> {
  const { res, url, cwd } = ctx;
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

export async function routePostGraphBriefAutoAll(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
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

export async function routePostGraphBrief(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
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
