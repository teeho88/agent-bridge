import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { RouteContext } from "./types.js";
import {
  daysAgoStamp,
  readCacheUsage,
} from "../../cache-report.js";
import {
  computeBaseline,
  formatBaselineRunSummary,
} from "../../optimize-baseline.js";
import {
  getActiveTaskId,
  openStore,
  parseList,
  readConfig,
  resolveCurrentTaskId,
  syncCurrentTaskArtifact,
  writeConfig,
} from "../../workspace.js";
import {
  getAntigravityHookStatus,
  installAntigravityHooks,
} from "../antigravity.js";
import {
  getClaudeHookStatus,
  installClaudeHooks,
} from "../claude.js";
import {
  writeHandoffArtifacts,
} from "../handoff.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  installableTools,
} from "./status.js";
import {
  commandExists,
} from "./terminal.js";
import {
  optionalString,
  requiredString,
} from "./validation.js";
import {
  startWatcher,
  stopWatcher,
} from "./watcher.js";
import {
  type AgentKind,
} from "@agent-bridge/memory";

// Environment and one-off actions: optional CLI installs, agent hooks, the
// file watcher, graph config, the cache report, the optimize baseline and the
// handoff packet.

export async function routePostToolsInstall(ctx: RouteContext): Promise<void> {
  const { req, res } = ctx;
  const body = await readJson(req);
  const toolName = optionalString(body.name);
  if (!toolName || !installableTools.has(toolName)) {
    sendJson(res, 400, {
      error: "Unsupported tool. Allowed tools: repomix, ccusage.",
    });
    return;
  }

  const packageName = installableTools.get(toolName)!;
  try {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await execFileAsync(
      npmCommand,
      ["install", "-g", packageName],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        shell: process.platform === "win32",
      },
    );
    sendJson(res, 200, {
      name: toolName,
      installed: commandExists(toolName),
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
  return;
}

export async function routePostAntigravityInstallHooks(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  try {
    const output = installAntigravityHooks(cwd);
    const antigravityHookStatus = getAntigravityHookStatus(cwd);
    sendJson(res, 200, {
      installed: antigravityHookStatus.installed,
      antigravityHookStatus,
      output,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
  return;
}

export async function routePostClaudeInstallHooks(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  try {
    const output = installClaudeHooks(cwd);
    const claudeHookStatus = getClaudeHookStatus(cwd);
    sendJson(res, 200, {
      installed: claudeHookStatus.installed,
      claudeHookStatus,
      output,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
  return;
}

export async function routePostHandoffSave(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = optionalString(body.taskId) ?? getActiveTaskId(store, cwd);
    syncCurrentTaskArtifact(store, taskId, cwd);
    const handoff = store.upsertTaskHandoff({
      taskId,
      fromAgent: optionalString(body.from) as AgentKind | undefined,
      summary: requiredString(body.summary, "summary"),
      done: parseList(optionalString(body.done)),
      next: parseList(optionalString(body.next)),
      risks: parseList(optionalString(body.risks)),
      filesChanged: parseList(optionalString(body.filesChanged)),
    });
    writeHandoffArtifacts(cwd, handoff, {
      archive: true,
      task: store.getTask(taskId),
    });
    store.addMemory({
      taskId,
      type: "handoff",
      content: handoff.summary,
      summary: handoff.summary,
      importance: 5,
      sourceAgent: handoff.fromAgent,
    });
    sendJson(res, 200, { handoff });
  } finally {
    store.close();
  }
  return;
}

export async function routeGetCacheReport(ctx: RouteContext): Promise<void> {
  const { res, url } = ctx;
  const days = Math.min(Math.max(Number(url.query.days ?? 7) || 7, 1), 90);
  const result = readCacheUsage(daysAgoStamp(days));
  sendJson(
    res,
    200,
    // `summary.days` counts the days ccusage actually has data for, which is
    // the number worth showing; `days` is only the requested window.
    result.ok ? { ok: true, window: days, ...result.summary } : { ok: false, window: days, reason: result.reason },
  );
  return;
}

export async function routePostConfigGraph(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const config = readConfig(cwd);
  const graph = { ...(config.graph ?? {}) };
  if (typeof body.injectRepoMap === "boolean")
    graph.injectRepoMap = body.injectRepoMap;
  if (typeof body.autoBriefOnToolUse === "boolean")
    graph.autoBriefOnToolUse = body.autoBriefOnToolUse;
  if (typeof body.watchAutoBrief === "boolean")
    graph.watchAutoBrief = body.watchAutoBrief;
  if (
    body.repoMapLimit != null &&
    Number.isFinite(Number(body.repoMapLimit))
  ) {
    graph.repoMapLimit = Math.max(
      1,
      Math.min(Number(body.repoMapLimit), 500),
    );
  }
  if (body.includePaths != null)
    graph.includePaths = parseList(optionalString(body.includePaths));
  if (body.ignorePaths != null)
    graph.ignorePaths = parseList(optionalString(body.ignorePaths));
  writeConfig({ ...config, graph });
  sendJson(res, 200, { graph });
  return;
}

export async function routePostWatchStart(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  const running = startWatcher(cwd);
  sendJson(res, 200, { watcherRunning: running });
  return;
}

export async function routePostWatchStop(ctx: RouteContext): Promise<void> {
  const { res } = ctx;
  stopWatcher();
  sendJson(res, 200, { watcherRunning: false });
  return;
}

export async function routePostOptimizeBaseline(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    if (store.getGraphStats().files === 0) {
      sendJson(res, 200, {
        result: null,
        message: "No graph yet. Build the graph first.",
      });
      return;
    }
    const config = readConfig(cwd);
    const limit = Number(body.limit ?? config.graph?.repoMapLimit ?? 40);
    const focusPaths =
      body.focus != null ? parseList(optionalString(body.focus)) : undefined;
    const result = computeBaseline(store, cwd, {
      limit,
      focusPaths,
      topN: 10,
    });
    if (!result) {
      sendJson(res, 200, {
        result: null,
        message: "Repo map is empty for that focus. Nothing to compare.",
      });
      return;
    }
    store.addRun({
      taskId: resolveCurrentTaskId() ?? undefined,
      agent: config.defaultAgent,
      command: "optimize baseline",
      resultSummary: formatBaselineRunSummary(result.summary),
      tokenEstimate: result.summary.optimizedTokens,
    });
    sendJson(res, 200, { result });
  } finally {
    store.close();
  }
  return;
}
