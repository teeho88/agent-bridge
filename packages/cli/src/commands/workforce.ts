import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  buildSpawnPreview,
  defaultCommandForProvider,
  listStaffableProviderCatalogs,
  reapAgentRuns,
  spawnAgentRun,
  stopAgentRun,
} from "@agent-bridge/adapters";
import {
  CONTEXT_ROOT,
  createContextStore,
  resolveLeaderAgent,
  resumeStatusFor,
  stepOrchestration,
  type ContextStoreIO,
  type OrchestratorDeps,
} from "@agent-bridge/core";
import type { Orchestration, OrchestrationAutonomy } from "@agent-bridge/memory";
import { openStore, paths } from "../workspace.js";

type Store = ReturnType<typeof openStore>;

export function registerOrchestration(program: Command): void {
  const workforce = program
    .command("orchestration")
    .alias("workforce")
    .description("Drive a leader-led orchestration: plan, execute, review, adjudicate");


  workforce
    .command("start")
    .description("Start a leader-driven orchestration: create a task, pick a leader, and spawn its plan turn")
    .argument("<prompt>", "the user's request/goal")
    .requiredOption("--leader-provider <provider>", "codex | claude | gemini | ...")
    .option("--leader-mode <mode>", "cli | api | manual", "cli")
    .option("--leader-model <model>", "leader model")
    .option("--leader-reasoning <level>", "leader reasoning effort")
    .option("--leader-command <command>", "override CLI command for the leader")
    .option("--autonomy <autonomy>", "manual | approve-each | auto", "approve-each")
    .option("--max-parallel <n>", "max concurrent implementers", "3")
    .option("--max-cycles <n>", "max plan/execute/review/adjudicate cycles", "8")
    .action(
      (
        prompt: string,
        options: {
          leaderProvider: string;
          leaderMode: string;
          leaderModel?: string;
          leaderReasoning?: string;
          leaderCommand?: string;
          autonomy: string;
          maxParallel: string;
          maxCycles: string;
        },
      ) => {
        const store = openStore();
        try {
          const autonomy = parseAutonomy(options.autonomy);
          const leaderAgent = resolveLeaderAgent(
            store,
            {
              provider: options.leaderProvider,
              mode: options.leaderMode as "cli" | "api" | "manual",
              model: options.leaderModel,
              reasoningEffort: options.leaderReasoning,
            },
            { mode: options.leaderMode as "cli" | "api" | "manual", command: options.leaderCommand },
          );
          const task = store.createTask({ title: prompt, goal: prompt, ownerAgent: "codex" });

          const orchestration = store.createOrchestration({
            taskId: task.id,
            leaderAgentId: leaderAgent.id,
            autonomy,
            maxParallel: Number(options.maxParallel),
            maxCycles: Number(options.maxCycles),
          });

          const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store));
          console.log(
            JSON.stringify(
              { task, orchestration: stepResult.orchestration, summary: stepResult.summary, spawnedRunIds: stepResult.spawnedRunIds },
              null,
              2,
            ),
          );
        } finally {
          store.close();
        }
      },
    );

  workforce
    .command("step")
    .description("Advance a task's orchestration by one step")
    .requiredOption("--task <taskId>", "task id")
    .action((options: { task: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        reapAgentRuns(store, { taskId: options.task });
        const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store));
        console.log(JSON.stringify(stepResult, null, 2));
      } finally {
        store.close();
      }
    });

  workforce
    .command("status")
    .description("Show an orchestration's subtasks, runs, reviews, and recent activity")
    .requiredOption("--task <taskId>", "task id")
    .action((options: { task: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        console.log(
          JSON.stringify(
            {
              orchestration,
              subtasks: store.listSubtasks({ parentTaskId: options.task, limit: 500 }),
              runs: store.listAgentRuns({ taskId: options.task, limit: 200 }),
              reviews: store.listReviews({ taskId: options.task, limit: 200 }),
              events: store.listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 100 }),
            },
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
    });

  workforce
    .command("pause")
    .description("Pause an orchestration; it will not advance until resumed")
    .requiredOption("--task <taskId>", "task id")
    .action((options: { task: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        console.log(JSON.stringify(store.updateOrchestration(orchestration.id, { status: "paused" }), null, 2));
      } finally {
        store.close();
      }
    });

  workforce
    .command("resume")
    .description("Resume a paused orchestration back into execution")
    .requiredOption("--task <taskId>", "task id")
    .action((options: { task: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        if (orchestration.status !== "paused") {
          throw new Error(`Orchestration is not paused (status: ${orchestration.status}).`);
        }
        const status = resumeStatusFor(store, orchestration.id);
        console.log(JSON.stringify(store.updateOrchestration(orchestration.id, { status, lastError: null }), null, 2));
      } finally {
        store.close();
      }
    });

  workforce
    .command("stop")
    .description("Stop an orchestration and every one of its active runs")
    .requiredOption("--task <taskId>", "task id")
    .action(async (options: { task: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        const activeRuns = store
          .listAgentRuns({ taskId: options.task, limit: 500 })
          .filter((run) => ["starting", "running", "waiting"].includes(run.status));
        for (const run of activeRuns) await stopAgentRun(store, run.id);
        const updated = store.updateOrchestration(orchestration.id, { status: "failed", lastError: "Stopped by user." });
        console.log(JSON.stringify({ orchestration: updated, stoppedRuns: activeRuns.map((run) => run.id) }, null, 2));
      } finally {
        store.close();
      }
    });

  workforce
    .command("autonomy")
    .description("Change how much the orchestration decides on its own, while it is running")
    .requiredOption("--task <taskId>", "task id")
    .requiredOption("--mode <autonomy>", "manual | approve-each | auto")
    .action((options: { task: string; mode: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        const autonomy = parseAutonomy(options.mode);
        const updated = store.updateOrchestration(orchestration.id, { autonomy }) ?? orchestration;
        console.log(JSON.stringify({ orchestration: updated, previousAutonomy: orchestration.autonomy }, null, 2));
      } finally {
        store.close();
      }
    });

  workforce
    .command("watch")
    .description('Repeatedly step an "auto" orchestration until it is done, failed, or paused')
    .requiredOption("--task <taskId>", "task id")
    .option("--interval-ms <ms>", "delay between steps", "4000")
    .option("--max-steps <n>", "safety cap on total steps", "200")
    .action(async (options: { task: string; intervalMs: string; maxSteps: string }) => {
      const store = openStore();
      try {
        const orchestration = mustGetOrchestrationByTask(store, options.task);
        if (orchestration.autonomy !== "auto") {
          throw new Error(
            `Orchestration autonomy is "${orchestration.autonomy}"; only "auto" orchestrations can run unattended. ` +
              'Use `workforce step` to advance manually, or `workforce start --autonomy auto`.',
          );
        }
        const terminal = new Set(["done", "failed", "paused"]);
        for (let i = 0; i < Number(options.maxSteps); i += 1) {
          // Autonomy is re-read every lap: the user can switch this
          // orchestration to manual or approve-each from the dashboard while
          // the loop is running, and unattended stepping has to stop when they
          // do — otherwise the switch is honoured only by new watchers.
          const current = store.getOrchestration(orchestration.id);
          if (current && current.autonomy !== "auto") {
            console.log(`Autonomy changed to "${current.autonomy}"; stopping unattended stepping.`);
            break;
          }
          reapAgentRuns(store, { taskId: options.task });
          const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store));
          console.log(stepResult.summary);
          if (terminal.has(stepResult.orchestration.status)) break;
          await delay(Number(options.intervalMs));
        }
      } finally {
        store.close();
      }
    });
}

// `cwd` must be passed by any caller that is not itself running inside the
// target project. The UI server runs from wherever it was launched but serves
// `--project <path>`, so defaulting to process.cwd() there would spawn every
// agent in the wrong directory and scatter run logs and plans into the tool's
// own repo instead of the user's project.
export function makeOrchestratorDeps(store: Store, cwd: string = paths().cwd): OrchestratorDeps {
  const projectPaths = paths(cwd);
  const runsDir = join(projectPaths.artifacts, "runs");
  return {
    spawn: (input) => {
      mkdirSync(runsDir, { recursive: true });
      const promptPath = join(runsDir, `${randomUUID()}-prompt.md`);
      writeFileSync(promptPath, input.prompt, "utf8");
      const preview = buildSpawnPreview(input.agent, promptPath, projectPaths.cwd);
      if (preview.mode !== "cli" || !preview.executable) {
        throw new Error(
          `Orchestrator spawning currently supports CLI-mode agents only (got mode "${preview.mode}" for ${input.agent.name}).`,
        );
      }
      return spawnAgentRun(store, {
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        assignmentId: input.assignmentId,
        agentId: input.agent.id,
        roleId: input.roleId,
        cycle: input.cycle,
        phase: input.phase,
        runsDir,
        preview,
      }, {
        // A step call (CLI command or HTTP handler) closes its store as soon as
        // it returns, while the agent it just launched runs for minutes. Without
        // a reopen the exit code never lands and every run ends up "detached",
        // so a failed implementer is indistinguishable from a finished one.
        reopenStore: () => openStore(projectPaths.cwd),
      });
    },
    listProviders: () =>
      listStaffableProviderCatalogs().map((catalog) => ({
        provider: catalog.provider,
        models: catalog.models.map((model) => model.value),
      })),
    defaultCommandFor: (provider) => defaultCommandForProvider(provider),
    readLog: (run) => (run.logPath && existsSync(run.logPath) ? readFileSync(run.logPath, "utf8") : ""),
    writePlanFile: (markdown) => {
      const plansDir = join(projectPaths.memoryDir, "plans");
      mkdirSync(plansDir, { recursive: true });
      const planPath = join(plansDir, `${Date.now()}-plan.md`);
      writeFileSync(planPath, markdown, "utf8");
      return planPath;
    },
    contextStoreFor: (orchestrationId) => {
      ensureContextIgnored(projectPaths.cwd);
      return createContextStore(contextStoreIO(projectPaths.cwd), orchestrationId);
    },
  };
}

// Core builds workspace-relative paths — they go straight into prompts, and the
// agents run with the workspace as their working directory — so resolving them
// is this side's job.
function contextStoreIO(cwd: string): ContextStoreIO {
  const resolve = (path: string) => join(cwd, path);
  const ensureDir = (path: string) => {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (dir) mkdirSync(join(cwd, dir), { recursive: true });
  };
  return {
    exists: (path) => existsSync(resolve(path)),
    read: (path) => (existsSync(resolve(path)) ? readFileSync(resolve(path), "utf8") : undefined),
    write: (path, content) => {
      ensureDir(path);
      writeFileSync(resolve(path), content, "utf8");
    },
    append: (path, content) => {
      ensureDir(path);
      appendFileSync(resolve(path), content, "utf8");
    },
  };
}

// The orchestration runs in the *user's* project, which has no reason to ignore
// `.agent-memory/` already. Left unignored the context store shows up as
// hundreds of untracked files in their diff, and the implementer agents start
// committing the orchestrator's own notes alongside the work.
function ensureContextIgnored(cwd: string): void {
  if (!existsSync(join(cwd, ".git"))) return;
  const gitignorePath = join(cwd, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (/^\s*\.agent-memory\/?\s*$/m.test(existing) || existing.includes(CONTEXT_ROOT)) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(
    gitignorePath,
    `${prefix}\n# Agent Bridge orchestration context and run data\n.agent-memory/\n`,
    "utf8",
  );
}

function mustGetOrchestrationByTask(store: Store, taskId: string): Orchestration {
  const orchestration = store.getOrchestrationByTask(taskId);
  if (!orchestration) throw new Error(`No orchestration found for task: ${taskId}`);
  return orchestration;
}

function parseAutonomy(value: string): OrchestrationAutonomy {
  const allowed: OrchestrationAutonomy[] = ["manual", "approve-each", "auto"];
  if (allowed.includes(value as OrchestrationAutonomy)) return value as OrchestrationAutonomy;
  throw new Error(`Invalid autonomy "${value}". Use one of: ${allowed.join(", ")}.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



