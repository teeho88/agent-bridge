import type { RouteContext } from "./types.js";
import { readJson, sendJson } from "./http.js";
import { setRepositoryEnabled } from "../../repository.js";
import { openStore } from "../../workspace.js";
import { stopAutoRun, resumeAutoRuns } from "./auto-run.js";
import { stopWatcher } from "./watcher.js";

export async function routePostRepositoryEnabled(ctx: RouteContext): Promise<void> {
  const body = await readJson(ctx.req);
  if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
  const result = setRepositoryEnabled(ctx.cwd, body.enabled);
  if (!body.enabled) {
    stopWatcher();
    const store = openStore(ctx.cwd);
    try { for (const run of store.listOrchestrations({ limit: 1000 })) stopAutoRun(run.id); }
    finally { store.close(); }
  } else resumeAutoRuns(ctx.cwd);
  sendJson(ctx.res, 200, result);
}
