import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  execFileSync,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, parse as parseUrl } from "node:url";
import type { RouteContext, RouteTable } from "./routes/types.js";
import {
  routeGetState,
} from "./routes/state.js";
import {
  routeGetCacheReport,
  routePostAntigravityInstallHooks,
  routePostClaudeInstallHooks,
  routePostConfigGraph,
  routePostHandoffSave,
  routePostOptimizeBaseline,
  routePostToolsInstall,
  routePostWatchStart,
  routePostWatchStop,
} from "./routes/environment.js";
import {
  routeGetSkillsGithubSearch,
  routePostSkillsDelete,
  routePostSkillsGithubInstall,
  routePostSkillsSave,
} from "./routes/skills.js";
import {
  routePostRequestClear,
  routePostRequestDelete,
} from "./routes/requests.js";
import {
  routePostOrchestrationChange,
  routePostOrchestrationLane,
  routePostOrchestrationLeaseAcquire,
  routePostOrchestrationLeaseRelease,
  routePostOrchestrationRequest,
} from "./routes/work-git.js";
import {
  routeGetGraph,
  routeGetMemorySearch,
  routePostGraphBrief,
  routePostGraphBriefAutoAll,
  routePostGraphBuild,
  routePostMemoryAdd,
  routePostRepoMemoryDelete,
  routePostRepoMemoryUpdate,
} from "./routes/knowledge.js";
import {
  routePostContextCompile,
  routePostContextSave,
  routePostTaskDelete,
  routePostTaskPrompt,
  routePostTaskStart,
  routePostTaskStop,
  routePostTaskUpdate,
} from "./routes/task.js";
import {
  routePostSessionEnd,
  routePostSessionFocus,
  routePostSessionStart,
  routePostSessionSummary,
  routePostSessionTerminal,
  routePostSessionWindow,
} from "./routes/session.js";
import {
  routeGetWorkforceBoard,
  routeGetWorkforceCatalog,
  routeGetWorkforceRunLog,
  routePostWorkforceAgent,
  routePostWorkforceAgentDelete,
  routePostWorkforceAgentToggle,
  routePostWorkforceAgentUpdate,
  routePostWorkforceAgentsProviderEnabled,
  routePostWorkforceDefaultAgentCreate,
  routePostWorkforceDefaultAgentDelete,
  routePostWorkforceDefaultAgentRestore,
  routePostWorkforceDefaultAgentToggle,
  routePostWorkforceRunAdopt,
  routePostWorkforceRunSetModel,
  routePostWorkforceRunStop,
  routePostWorkforceSubtaskAddAndSpawn,
} from "./routes/workforce.js";
import {
  routePostWorkforceOrchestrationAnswerQuestions,
  routePostWorkforceOrchestrationApproveSpawn,
  routePostWorkforceOrchestrationAutoRun,
  routePostWorkforceOrchestrationAutonomy,
  routePostWorkforceOrchestrationLeader,
  routePostWorkforceOrchestrationPause,
  routePostWorkforceOrchestrationReport,
  routePostWorkforceOrchestrationRequestChanges,
  routePostWorkforceOrchestrationResume,
  routePostWorkforceOrchestrationStart,
  routePostWorkforceOrchestrationStep,
  routePostWorkforceOrchestrationStop,
} from "./routes/orchestration-runs.js";
import {
  resumeAutoRuns,
} from "./routes/auto-run.js";
import { stopWatcher } from "./routes/watcher.js";
import { buildGraphView } from "./routes/graph-view.js";
import {
  renderUiHtml,
} from "./routes/lookups.js";
import {
  defaultUiPort,
  sendClientModule,
  sendHtml,
  sendJson,
} from "./routes/http.js";
import type { Command } from "commander";
import { loadRuntimeProviderCatalogs } from "../provider-catalog.js";
import { executeSpawnRequest } from "./request.js";
import { makeOrchestratorDeps } from "./workforce.js";
import { generateReport } from "./report.js";
import { writeHandoffArtifacts } from "./handoff.js";
import {
  ensureWorkspace,
} from "../workspace.js";
import { renderDashboardHtml } from "../ui-page.js";
import { applyTaskLabelSuggestion } from "../task-suggestions.js";
import { refreshBriefs } from "../graph-brief.js";

type JsonBody = Record<string, unknown>;






// The watcher runs as a child of the UI server so the dashboard can start/stop it.
// Tracked at module scope; killed when the UI process exits to avoid orphans.
let uiWorkspace = process.cwd();




/**
 * Rebuilds the CLI package in place. Returns false when this is not a real
 * checkout (no package.json with a build script) so the caller can fall back
 * to telling the user what to run.
 */
function rebuildCliPackage(packageRoot: string): boolean {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (!manifest.scripts?.build) return false;
  } catch {
    return false;
  }

  console.log("Dashboard build is stale; rebuilding @agent-bridge/cli…");
  // Not every machine has a standalone `pnpm` on PATH — a Corepack-managed
  // Node install exposes only `corepack` and `npm`. Try each runner rather
  // than failing the rebuild on the first one that is missing.
  const runners: [string, string[]][] = [
    ["pnpm", ["run", "build"]],
    ["corepack", ["pnpm", "run", "build"]],
    ["npm", ["run", "build"]],
  ];
  for (const [command, args] of runners) {
    try {
      execFileSync(command, args, {
        cwd: packageRoot,
        stdio: "inherit",
        // These are shell shims (.cmd/.ps1) on Windows; without a shell,
        // spawning them fails outright with EINVAL.
        shell: process.platform === "win32",
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The published CLI serves the statically imported `dist/ui-page.js` plus the
 * compiled client in `dist/ui-client`. In a checkout, editing either source
 * leaves the build stale, so the dashboard
 * would silently serve an outdated page. Rebuild it automatically instead of
 * making every UI edit cost a manual build step, and only refuse to launch
 * when the rebuild is impossible or did not take.
 */
export function assertUiPageFreshness(
  packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): void {
  const sourcePath = join(packageRoot, "src", "ui-page.ts");
  if (!existsSync(sourcePath)) return;

  // The page shell and the client module are built by two tsc projects, so
  // both have to be checked - a stale client is just as invisible as a stale
  // page was before the script moved out of the template literal.
  const pairs: Array<[string, string]> = [
    [sourcePath, join(packageRoot, "dist", "ui-page.js")],
    [
      join(packageRoot, "src", "ui-client", "main.ts"),
      join(packageRoot, "dist", "ui-client", "main.js"),
    ],
  ];
  const isStale = (): boolean =>
    pairs.some(
      ([source, built]) =>
        existsSync(source) &&
        (!existsSync(built) ||
          statSync(source).mtimeMs > statSync(built).mtimeMs),
    );
  if (!isStale()) return;

  if (rebuildCliPackage(packageRoot) && !isStale()) return;

  throw new Error(
    "UI source is newer than the compiled dashboard and the automatic rebuild failed. Run `pnpm --filter @agent-bridge/cli build` and start `agent-bridge ui` again.",
  );
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description("Start the local agent-bridge management UI")
    .option("--port <port>", "port to listen on", String(defaultUiPort))
    .option("--project <path>", "project path", process.cwd())
    .action((options: { port: string; project: string }, command: Command) => {
      assertUiPageFreshness();
      const project = prepareUiWorkspace(options.project);
      const port = parseUiPort(options.port);
      const allowPortFallback =
        command.getOptionValueSource("port") === "default";
      const server = createServer((req, res) => {
        void serveRequest(req, res);
      });

      listenUiServer(server, port, project, allowPortFallback);
      resumeAutoRuns(project);

      // Don't leave the watcher running after the UI server is gone.
      const cleanup = (): void => stopWatcher();
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
      });
    });
}

function listenUiServer(
  server: Server,
  port: number,
  project: string,
  allowPortFallback: boolean,
): void {
  const onListening = (): void => {
    server.off("error", onError);
    const address = server.address();
    const boundPort =
      typeof address === "object" && address ? address.port : port;
    console.log(`agent-bridge UI running at http://127.0.0.1:${boundPort}`);
    console.log(`Workspace: ${project}`);
  };
  const onError = (error: NodeJS.ErrnoException): void => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && allowPortFallback && port < 65535) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use; trying ${nextPort}.`);
      listenUiServer(server, nextPort, project, true);
      return;
    }
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Choose another port with --port.`
        : `Failed to start UI: ${error.message}`,
    );
    process.exitCode = 1;
  };

  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port, "127.0.0.1");
}
export function parseUiPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UI port must be an integer from 1 to 65535.");
  }
  return port;
}
export function prepareUiWorkspace(projectPath: string): string {
  const project = resolve(projectPath);
  ensureWorkspace(project);
  uiWorkspace = project;
  return project;
}

/**
 * The route bodies signal failure by throwing; turning that into a 500 is the
 * server's job. Named so tests drive the same path a browser does - calling
 * `handleRequest` directly would let a rejection escape instead of answering.
 */
export async function serveRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await handleRequest(req, res);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
}

async function routeGetRoot(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  sendHtml(res, renderUiHtml(cwd));
  return;
}







































































/**
 * Exact-match table for every route the dashboard serves. Keeping it as data
 * rather than a 2,300-line if-chain is what makes the set enumerable: the
 * manifest test asserts against `uiRouteManifest()`, so a route that is
 * dropped or renamed during a refactor fails a test instead of 404-ing in the
 * browser.
 */
const ROUTES: RouteTable = {
  "GET /": routeGetRoot,
  "GET /api/state": routeGetState,
  "POST /api/task/start": routePostTaskStart,
  "POST /api/workforce/agent": routePostWorkforceAgent,
  "POST /api/workforce/agent/toggle": routePostWorkforceAgentToggle,
  "POST /api/workforce/default-agent/toggle": routePostWorkforceDefaultAgentToggle,
  "POST /api/workforce/default-agent/create": routePostWorkforceDefaultAgentCreate,
  "POST /api/workforce/default-agent/delete": routePostWorkforceDefaultAgentDelete,
  "POST /api/workforce/default-agent/restore": routePostWorkforceDefaultAgentRestore,
  "POST /api/workforce/agent/update": routePostWorkforceAgentUpdate,
  "POST /api/workforce/agent/delete": routePostWorkforceAgentDelete,
  "POST /api/session/start": routePostSessionStart,
  "POST /api/session/terminal": routePostSessionTerminal,
  "POST /api/session/window": routePostSessionWindow,
  "POST /api/session/focus": routePostSessionFocus,
  "POST /api/session/summary": routePostSessionSummary,
  "POST /api/session/end": routePostSessionEnd,
  "POST /api/task/update": routePostTaskUpdate,
  "POST /api/task/delete": routePostTaskDelete,
  "POST /api/task/stop": routePostTaskStop,
  "POST /api/task/prompt": routePostTaskPrompt,
  "POST /api/orchestration/lane": routePostOrchestrationLane,
  "POST /api/orchestration/lease/acquire": routePostOrchestrationLeaseAcquire,
  "POST /api/orchestration/lease/release": routePostOrchestrationLeaseRelease,
  "POST /api/orchestration/change": routePostOrchestrationChange,
  "POST /api/orchestration/request": routePostOrchestrationRequest,
  "POST /api/request/delete": routePostRequestDelete,
  "POST /api/request/clear": routePostRequestClear,
  "POST /api/memory/add": routePostMemoryAdd,
  "POST /api/repo-memory/update": routePostRepoMemoryUpdate,
  "POST /api/repo-memory/delete": routePostRepoMemoryDelete,
  "GET /api/memory/search": routeGetMemorySearch,
  "GET /api/skills/github/search": routeGetSkillsGithubSearch,
  "POST /api/skills/github/install": routePostSkillsGithubInstall,
  "POST /api/skills/save": routePostSkillsSave,
  "POST /api/skills/delete": routePostSkillsDelete,
  "POST /api/tools/install": routePostToolsInstall,
  "POST /api/antigravity/install-hooks": routePostAntigravityInstallHooks,
  "POST /api/claude/install-hooks": routePostClaudeInstallHooks,
  "POST /api/context/compile": routePostContextCompile,
  "POST /api/context/save": routePostContextSave,
  "POST /api/handoff/save": routePostHandoffSave,
  "POST /api/graph/build": routePostGraphBuild,
  "GET /api/cache-report": routeGetCacheReport,
  "GET /api/graph": routeGetGraph,
  "POST /api/graph/brief-auto-all": routePostGraphBriefAutoAll,
  "POST /api/graph/brief": routePostGraphBrief,
  "POST /api/config/graph": routePostConfigGraph,
  "POST /api/watch/start": routePostWatchStart,
  "POST /api/watch/stop": routePostWatchStop,
  "POST /api/optimize/baseline": routePostOptimizeBaseline,
  "GET /api/workforce/catalog": routeGetWorkforceCatalog,
  "GET /api/workforce/board": routeGetWorkforceBoard,
  "GET /api/workforce/run/log": routeGetWorkforceRunLog,
  "POST /api/workforce/orchestration/start": routePostWorkforceOrchestrationStart,
  "POST /api/workforce/orchestration/step": routePostWorkforceOrchestrationStep,
  "POST /api/workforce/orchestration/report": routePostWorkforceOrchestrationReport,
  "POST /api/workforce/orchestration/answer-questions": routePostWorkforceOrchestrationAnswerQuestions,
  "POST /api/workforce/orchestration/approve-spawn": routePostWorkforceOrchestrationApproveSpawn,
  "POST /api/workforce/orchestration/auto-run": routePostWorkforceOrchestrationAutoRun,
  "POST /api/workforce/orchestration/autonomy": routePostWorkforceOrchestrationAutonomy,
  "POST /api/workforce/agents/provider-enabled": routePostWorkforceAgentsProviderEnabled,
  "POST /api/workforce/orchestration/leader": routePostWorkforceOrchestrationLeader,
  "POST /api/workforce/orchestration/request-changes": routePostWorkforceOrchestrationRequestChanges,
  "POST /api/workforce/orchestration/pause": routePostWorkforceOrchestrationPause,
  "POST /api/workforce/orchestration/resume": routePostWorkforceOrchestrationResume,
  "POST /api/workforce/orchestration/stop": routePostWorkforceOrchestrationStop,
  "POST /api/workforce/subtask/add-and-spawn": routePostWorkforceSubtaskAddAndSpawn,
  "POST /api/workforce/run/stop": routePostWorkforceRunStop,
  "POST /api/workforce/run/set-model": routePostWorkforceRunSetModel,
  "POST /api/workforce/run/adopt": routePostWorkforceRunAdopt,
};

/** Sorted `"<METHOD> <path>"` keys, for tests and diagnostics. */
export function uiRouteManifest(): string[] {
  return Object.keys(ROUTES).sort();
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = parseUrl(req.url ?? "/", true);
  const method = req.method ?? "GET";
  const cwd = uiWorkspace;

  // The only prefix route: everything else is an exact match.
  if (method === "GET" && url.pathname?.startsWith("/ui-client/")) {
    sendClientModule(res, url.pathname);
    return;
  }

  const handler = ROUTES[`${method} ${url.pathname ?? "/"}`];
  if (handler) {
    await handler({ req, res, url, method, cwd });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}
























































































// Re-exported so `./ui.js` stays the entry point for the command's surface
// while the implementations live in ./routes.
export {
  isAutoRunning,
  resumeAutoRuns,
  startAutoRun,
  stopAutoRun,
} from "./routes/auto-run.js";
export { isWatcherRunning, startWatcher, stopWatcher } from "./routes/watcher.js";
export {
  readPortableHandoffState,
  type PortableHandoffState,
} from "./routes/handoff-state.js";
export {
  taskChangesWithWriteLeases,
  taskContextPath,
  writeTaskContext,
} from "./routes/task-changes.js";
export {
  answeredQuestionRouting,
  filterWorkBoardSessionEvents,
  inferContextAgent,
  recordDirectSubtaskRunOutcome,
} from "./routes/lookups.js";
