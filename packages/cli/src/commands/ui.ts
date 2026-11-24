import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { parse as parseUrl } from "node:url";
import type { RouteTable } from "./routes/types.js";
import {
  routeGetState,
  routeGetHandoffHistory,
} from "./routes/state.js";
import {
  routeGetApplicationUpdateProgress,
  routeGetApplicationUpdateStatus,
  routePostApplicationUpdateApply,
} from "./routes/application-update.js";
import {
  routeGetCacheReport,
  routePostAntigravityInstallHooks,
  routePostClaudeInstallHooks,
  routePostCodexInstallHooks,
  routePostConfigCliApprovals,
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
  routePostRepoMemoryCandidateReview,
  routePostRepoMemoryDelete,
  routePostRepoMemoryUpdate,
} from "./routes/knowledge.js";
import {
  routePostContextCompile,
  routePostContextSave,
  routePostTaskPrompt,
  routePostTaskStart,
} from "./routes/task.js";
import {
  routePostSessionEnd,
  routePostSessionDelete,
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
  routePostWorkforceDefaultAgentUpdate,
  routePostWorkforceRunAdopt,
  routePostWorkforceRunSetModel,
  routePostWorkforceRunStop,
  routePostWorkforceSubtaskAddAndSpawn,
} from "./routes/workforce.js";
import {
  routePostWorkforceOrchestrationAnswerQuestions,
  routePostWorkforceOrchestrationAddCycles,
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
import { sendJson } from "./routes/http.js";
import type { Command } from "commander";
import { routePostRepositoryEnabled } from "./routes/repository.js";
import { repositoryEnabled } from "../repository.js";


export function registerUi(program: Command): void {
  program.command("tui", { isDefault: true }).alias("ui")
    .description("Open the interactive terminal dashboard")
    .option("--project <path>", "project path", process.cwd())
    .option("--snapshot", "print dashboard once without an interactive terminal")
    .action(async (options: { project: string; snapshot?: boolean }) => {
      const { startTui } = await import("../tui/app.js");
      await startTui(resolve(options.project), { snapshot: options.snapshot });
    });
}

const ROUTES: RouteTable = {
  "POST /api/repo/enabled": routePostRepositoryEnabled,
  "GET /api/state": routeGetState,
  "GET /api/state/details": routeGetState,
  "GET /api/handoff/history": routeGetHandoffHistory,
  "GET /api/update/status": routeGetApplicationUpdateStatus,
  "POST /api/update/apply": routePostApplicationUpdateApply,
  "GET /api/update/progress": routeGetApplicationUpdateProgress,
  "POST /api/task/start": routePostTaskStart,
  "POST /api/workforce/agent": routePostWorkforceAgent,
  "POST /api/workforce/agent/toggle": routePostWorkforceAgentToggle,
  "POST /api/workforce/default-agent/toggle": routePostWorkforceDefaultAgentToggle,
  "POST /api/workforce/default-agent/create": routePostWorkforceDefaultAgentCreate,
  "POST /api/workforce/default-agent/update": routePostWorkforceDefaultAgentUpdate,
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
  "POST /api/session/delete": routePostSessionDelete,
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
  "POST /api/repo-memory/candidates/review": routePostRepoMemoryCandidateReview,
  "GET /api/memory/search": routeGetMemorySearch,
  "GET /api/skills/github/search": routeGetSkillsGithubSearch,
  "POST /api/skills/github/install": routePostSkillsGithubInstall,
  "POST /api/skills/save": routePostSkillsSave,
  "POST /api/skills/delete": routePostSkillsDelete,
  "POST /api/tools/install": routePostToolsInstall,
  "POST /api/antigravity/install-hooks": routePostAntigravityInstallHooks,
  "POST /api/claude/install-hooks": routePostClaudeInstallHooks,
  "POST /api/codex/install-hooks": routePostCodexInstallHooks,
  "POST /api/context/compile": routePostContextCompile,
  "POST /api/context/save": routePostContextSave,
  "POST /api/handoff/save": routePostHandoffSave,
  "POST /api/graph/build": routePostGraphBuild,
  "GET /api/cache-report": routeGetCacheReport,
  "GET /api/graph": routeGetGraph,
  "POST /api/graph/brief-auto-all": routePostGraphBriefAutoAll,
  "POST /api/graph/brief": routePostGraphBrief,
  "POST /api/config/graph": routePostConfigGraph,
  "POST /api/config/cli-approvals": routePostConfigCliApprovals,
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
  "POST /api/workforce/orchestration/add-cycles": routePostWorkforceOrchestrationAddCycles,
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


export function uiRouteManifest(): string[] {
  return Object.keys(ROUTES).sort();
}

export async function dispatchUiRequest(
  cwd: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = parseUrl(req.url ?? "/", true);
    const method = req.method ?? "GET";
    if (method === "POST" && url.pathname !== "/api/repo/enabled" && !url.pathname?.startsWith("/api/update/") && !repositoryEnabled(cwd)) {
      sendJson(res, 409, { error: "Agent Bridge is disabled for this repository. Enable it in Tools → Repository or run agent-bridge repo enable." });
      return;
    }
    const handler = ROUTES[`${method} ${url.pathname ?? "/"}`];
    if (!handler) {
      sendJson(res, 404, { error: "Unknown dashboard action" });
      return;
    }
    await handler({ req, res, url, method, cwd, port: 0 });
    if (!res.writableEnded) {
      sendJson(res, 501, { error: "This action is not implemented by the backend." });
    }
  } catch (error: unknown) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

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
