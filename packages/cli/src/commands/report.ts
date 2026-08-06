import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { buildSpawnPreview, spawnAgentRun } from "@agent-bridge/adapters";
import {
  agentSupportsCapabilities,
  CHANGE_REQUEST_EVENT_PREFIX,
  renderFallbackReport,
  renderReporterPrompt,
  type ReportContext,
} from "@agent-bridge/core";
import type { RegisteredAgent } from "@agent-bridge/memory";
import { getActiveTaskId, openStore, paths } from "../workspace.js";

type Store = ReturnType<typeof openStore>;

export function registerReport(program: Command): void {
  const report = program.command("report").description("Generate the final project report for a task");

  report
    .command("generate")
    .description(
      "Spawn a reporter turn (or reuse its last finished output); falls back to a deterministic report if the reporter fails",
    )
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--reporter <agentId>", "registered agent id to act as reporter")
    .option("--force-fallback", "skip the reporter agent and write the deterministic report directly")
    .action(async (options: { task?: string; reporter?: string; forceFallback?: boolean }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store);
        console.log(JSON.stringify(generateReport(store, { ...options, taskId }), null, 2));
      } finally {
        store.close();
      }
    });
}

export type GenerateReportResult =
  | { status: "written"; source: string; reportPath: string; note?: string }
  | { status: "pending" | "spawned"; runId: string; message: string };

// Shared by the CLI's `report generate` and the UI's Report button. An
// orchestration parks in `reporting` until this runs, and stepOrchestration
// deliberately no-ops there — so without a caller the run is finished but
// never closes out.
export function generateReport(
  store: Store,
  options: { taskId: string; reporter?: string; forceFallback?: boolean; cwd?: string },
): GenerateReportResult {
  const { taskId } = options;
  // The UI server's process.cwd() is wherever it was launched, not the
  // --project it serves, so every path here has to come from the explicit cwd.
  const projectPaths = paths(options.cwd ?? paths().cwd);
  const context = buildReportContext(store, taskId);

  if (options.forceFallback) {
    return finalizeReport(store, taskId, context, renderFallbackReport(context), "fallback", undefined, projectPaths.memoryDir);
  }

  // A change request reopens the same orchestration, so the previous round's
  // reporter run is still on the task. Reusing it silently republishes the old
  // report — the change the user just asked for would be missing from it.
  const reopenedAt = latestChangeRequestAt(store, context.orchestration?.id);
  const pendingRun = store
    .listAgentRuns({ taskId, limit: 200 })
    .filter((run) => run.phase === "report")
    .filter((run) => !reopenedAt || run.createdAt > reopenedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (pendingRun && ["starting", "running", "waiting"].includes(pendingRun.status)) {
    return {
      status: "pending",
      runId: pendingRun.id,
      message: "Reporter is still running; call `report generate` again once it finishes.",
    };
  }

  // "detached"/"stopped" are as final as done/failed — a reaped CLI process
  // very often still wrote a complete reply. Leaving them out means every
  // click spawns yet another reporter instead of consuming the finished one,
  // and the orchestration never leaves "reporting". Same terminal set the
  // orchestrator uses.
  if (pendingRun && ["done", "failed", "detached", "stopped"].includes(pendingRun.status)) {
    const output = pendingRun.logPath && existsSync(pendingRun.logPath)
      ? extractFinalAgentMessage(readFileSync(pendingRun.logPath, "utf8"))
      : "";
    if (pendingRun.status !== "failed" && output) {
      return finalizeReport(store, taskId, context, output, "reporter", undefined, projectPaths.memoryDir);
    }
    return finalizeReport(
      store,
      taskId,
      context,
      renderFallbackReport(context),
      "fallback",
      "Reporter run produced no usable output; used the deterministic report instead.",
      projectPaths.memoryDir,
    );
  }

  const reporterAgent = resolveReporterAgent(store, taskId, options.reporter);
  if (!reporterAgent) {
    return finalizeReport(
      store,
      taskId,
      context,
      renderFallbackReport(context),
      "fallback",
      "No enabled agent with capability `report` is available inside Team providers; used the deterministic report instead.",
      projectPaths.memoryDir,
    );
  }
  const prompt = renderReporterPrompt(context);
  const runsDir = join(projectPaths.artifacts, "runs");
  mkdirSync(runsDir, { recursive: true });
  const promptPath = join(runsDir, `${taskId}-report-prompt.md`);
  writeFileSync(promptPath, prompt, "utf8");
  const preview = buildSpawnPreview(reporterAgent, promptPath, projectPaths.cwd);
  if (preview.mode !== "cli" || !preview.executable) {
    return finalizeReport(
      store,
      taskId,
      context,
      renderFallbackReport(context),
      "fallback",
      `Reporter agent ${reporterAgent.name} is not CLI-spawnable (mode: ${preview.mode}); used the deterministic report instead.`,
      projectPaths.memoryDir,
    );
  }
  const run = spawnAgentRun(store, {
    taskId,
    orchestrationId: context.orchestration?.id,
    agentId: reporterAgent.id,
    phase: "report",
    runsDir,
    preview,
  }, {
    // The caller closes its store as soon as this returns; without a reopen the
    // reporter's exit code is dropped and the run is reaped as "detached".
    reopenStore: () => openStore(projectPaths.cwd),
  });
  return {
    status: "spawned",
    runId: run.id,
    message: "Reporter turn spawned; call `report generate` again once it finishes.",
  };
}

// A run log is the whole CLI session, not the answer: codex prints a banner,
// echoes the entire prompt back, streams its tool calls, and only then repeats
// its final message after a `tokens used\n<count>` footer. Writing the log
// verbatim produced a "report" whose first page was our own reporter prompt.
// Take everything after the LAST such footer; if the shape doesn't match
// (another provider, a truncated log) fall back to the full text rather than
// silently emitting nothing.
export function extractFinalAgentMessage(log: string): string {
  const lines = log.split(/\r?\n/);
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (lines[index].trim() !== "tokens used") continue;
    if (!/^[\d,._\s]+$/.test(lines[index + 1] ?? "")) continue;
    const message = lines.slice(index + 2).join("\n").trim();
    if (message) return message;
  }
  return log.trim();
}

// When the orchestration was last reopened by a change request, if ever.
// Anything produced before that timestamp belongs to a previous round.
function latestChangeRequestAt(store: Store, orchestrationId: string | undefined): string | undefined {
  if (!orchestrationId) return undefined;
  return store
    .listOrchestrationEvents({ orchestrationId, limit: 1000 })
    .find((event) => event.kind === "user_action" && event.summary?.startsWith(CHANGE_REQUEST_EVENT_PREFIX))
    ?.createdAt;
}

export function buildReportContext(store: Store, taskId: string): ReportContext {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const orchestration = store.getOrchestrationByTask(taskId);
  const planMarkdown = orchestration?.planPath && existsSync(orchestration.planPath) ? readFileSync(orchestration.planPath, "utf8") : undefined;
  return {
    task,
    orchestration,
    subtasks: store.listSubtasks({ parentTaskId: taskId, limit: 500 }),
    reviews: store.listReviews({ taskId, limit: 500 }),
    assignments: store.listAssignments({ taskId, limit: 500 }),
    agents: store.listRegisteredAgents({ limit: 500 }),
    taskChanges: store.listTaskChanges(taskId, 500),
    decisions: store.listDecisions(taskId),
    handoff: store.getLatestHandoff(taskId),
    planMarkdown,
  };
}

export function finalizeReport(
  store: Store,
  taskId: string,
  context: ReportContext,
  content: string,
  source: "reporter" | "fallback",
  note?: string,
  memoryDir: string = paths().memoryDir,
): { status: "written"; source: string; reportPath: string; note?: string } {
  const reportsDir = join(memoryDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${taskId}-report.md`);
  writeFileSync(reportPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  if (context.orchestration) {
    store.updateOrchestration(context.orchestration.id, { status: "done", reportPath });
  }
  return { status: "written", source, reportPath, note };
}

export function resolveReporterAgent(store: Store, taskId: string, explicitAgentId: string | undefined): RegisteredAgent | undefined {
  const orchestration = store.getOrchestrationByTask(taskId);
  const allowed = orchestration?.teamProviders?.length ? new Set(orchestration.teamProviders) : undefined;
  const eligible = (agent: RegisteredAgent | undefined): agent is RegisteredAgent =>
    Boolean(
      agent?.enabled &&
      (!allowed || allowed.has(agent.provider)) &&
      agentSupportsCapabilities(agent, ["report"]),
    );
  if (explicitAgentId) {
    const found = store.getRegisteredAgent(explicitAgentId);
    if (!found) throw new Error(`Agent not found: ${explicitAgentId}`);
    if (!found.enabled) throw new Error(`Reporter agent ${found.name} is disabled.`);
    if (allowed && !allowed.has(found.provider)) {
      throw new Error(
        `Reporter provider "${found.provider}" is outside Team providers: ${orchestration?.teamProviders?.join(", ")}.`,
      );
    }
    if (!agentSupportsCapabilities(found, ["report"])) {
      throw new Error(`Reporter agent ${found.name} does not have capability \`report\`.`);
    }
    return found;
  }
  return store.listRegisteredAgents({ enabled: true, limit: 500 }).find(eligible);
}
