import {
  getApplicationUpdateStatus,
  readApplicationUpdateProgress,
  startApplicationUpdate,
  type ApplicationUpdateProgress,
  type ApplicationUpdateStatus,
} from "../../application-update.js";
import { sendJson } from "./http.js";
import type { RouteContext } from "./types.js";

function refreshRequested(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

export function sanitizeApplicationUpdateProgress(
  progress: ApplicationUpdateProgress | undefined,
): ApplicationUpdateProgress | undefined {
  if (!progress) return undefined;
  const normalized = progress.logFile?.replace(/\\/g, "/");
  const safeLogFile =
    normalized && /^\.agent-memory\/update\/[A-Za-z0-9._-]+$/.test(normalized)
      ? normalized
      : undefined;
  return {
    ...progress,
    ...(safeLogFile ? { logFile: safeLogFile } : { logFile: undefined }),
  };
}

export async function routeGetApplicationUpdateStatus(ctx: RouteContext): Promise<void> {
  const status = await getApplicationUpdateStatus({
    force: refreshRequested(ctx.url.query.refresh),
  });
  sendJson(ctx.res, 200, status);
}

export async function routePostApplicationUpdateApply(ctx: RouteContext): Promise<void> {
  try {
    const started = await startApplicationUpdate({
      workspace: ctx.cwd,
      port: ctx.port,
      uiPid: process.pid,
    });
    sendJson(ctx.res, 202, started);
  } catch (error) {
    const typed = error as Error & { status?: ApplicationUpdateStatus };
    if (typed.status) {
      sendJson(ctx.res, 409, typed.status);
      return;
    }
    throw error;
  }
}

export function routeGetApplicationUpdateProgress(ctx: RouteContext): void {
  sendJson(ctx.res, 200, {
    progress: sanitizeApplicationUpdateProgress(readApplicationUpdateProgress()),
  });
}
