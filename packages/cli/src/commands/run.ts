import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { buildSpawnPreview, reapAgentRuns, spawnAgentRun, stopAgentRun } from "@agent-bridge/adapters";
import { compressLog } from "@agent-bridge/core";
import type { AgentRun, Assignment, RegisteredAgent, SessionEvent, Subtask } from "@agent-bridge/memory";
import type { AgentRunStatus } from "@agent-bridge/memory";
import { getActiveTaskId, openStore, paths } from "../workspace.js";

type Store = ReturnType<typeof openStore>;

export function registerRun(program: Command): void {
  const run = program.command("run").description("Manage live agent runs (spawned, adopted, or manual)");

  run
    .command("list")
    .description("List agent runs, reconciling any that died without updating their status")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--status <status>", "starting|running|waiting|stopping|stopped|done|failed|detached")
    .action((options: { task?: string; status?: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store);
        reapAgentRuns(store, { taskId });
        console.log(
          JSON.stringify(
            store.listAgentRuns({
              taskId,
              status: options.status ? parseStatus(options.status) : undefined,
              limit: 200,
            }),
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
    });

  run
    .command("log")
    .description("Print a run's status and the tail of its output log")
    .argument("<runId>", "agent run id")
    .option("--tail <lines>", "number of lines from the end of the log", "200")
    .action((runId: string, options: { tail: string }) => {
      const store = openStore();
      try {
        const found = store.getAgentRun(runId);
        if (!found) throw new Error(`Run not found: ${runId}`);
        const log = found.logPath ? tailLines(readFileSync(found.logPath, "utf8"), Number(options.tail)) : "";
        console.log(JSON.stringify({ run: found, log }, null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("stop")
    .description("Stop a live agent run and cancel its assignment")
    .argument("<runId>", "agent run id")
    .option("--reason <text>", "reason recorded on the assignment/orchestration event")
    .option("--cancel-subtask", "also cancel the parent subtask")
    .action(async (runId: string, options: { reason?: string; cancelSubtask?: boolean }) => {
      const store = openStore();
      try {
        const before = store.getAgentRun(runId);
        if (!before) throw new Error(`Run not found: ${runId}`);
        const stopped = await stopAgentRun(store, runId);
        if (before.assignmentId) {
          store.updateAssignment(before.assignmentId, {
            status: "cancelled",
            resultSummary: options.reason ?? "Stopped by user.",
          });
        }
        if (options.cancelSubtask && before.subtaskId) {
          store.updateSubtask(before.subtaskId, {
            status: "cancelled",
            statusReason: options.reason ?? "Stopped by user.",
          });
        }
        if (before.orchestrationId) {
          store.recordOrchestrationEvent({
            orchestrationId: before.orchestrationId,
            phase: before.phase ?? "implement",
            kind: "user_action",
            summary: `Stopped run ${runId}${options.reason ? `: ${options.reason}` : ""}`,
          });
        }
        console.log(JSON.stringify(stopped, null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("set-model")
    .description("Stop a run and respawn it with a different model/reasoning, preserving context via a resume artifact")
    .argument("<runId>", "agent run id")
    .option("--model <model>", "new model")
    .option("--reasoning <level>", "new reasoning effort")
    .action(async (runId: string, options: { model?: string; reasoning?: string }) => {
      if (!options.model && !options.reasoning) throw new Error("Provide --model and/or --reasoning.");
      const store = openStore();
      try {
        const result = await respawnRun(store, runId, { model: options.model, reasoningEffort: options.reasoning });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("reassign")
    .description("Stop a run and respawn its assignment on a different registered agent")
    .argument("<runId>", "agent run id")
    .requiredOption("--agent <agent>", "target registered agent id or name")
    .action(async (runId: string, options: { agent: string }) => {
      const store = openStore();
      try {
        const target = resolveAgent(store.listRegisteredAgents({ limit: 500 }), options.agent);
        if (!target) throw new Error(`Agent not found: ${options.agent}`);
        const result = await respawnRun(store, runId, { agentId: target.id });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("progress")
    .description("Record progress for a live run (intended for the running agent itself to call)")
    .requiredOption("--run <runId>", "agent run id")
    .option("--percent <percent>", "0-100")
    .option("--note <text>", "short progress note")
    .action((options: { run: string; percent?: string; note?: string }) => {
      const store = openStore();
      try {
        const found = store.getAgentRun(options.run);
        if (!found) throw new Error(`Run not found: ${options.run}`);
        const updated = store.updateAgentRun(options.run, {
          progressPercent: options.percent != null ? clampPercent(Number(options.percent)) : found.progressPercent,
          progressNote: options.note ?? found.progressNote,
          heartbeatAt: new Date().toISOString(),
        });
        console.log(JSON.stringify(updated, null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("adoptable")
    .description("List active hook-driven sessions in this repo that are not yet part of any team")
    .action(() => {
      const store = openStore();
      try {
        console.log(JSON.stringify(listAdoptableSessions(store), null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("adopt")
    .description("Adopt an agent session already working in this repo (via hooks) into the team")
    .requiredOption("--session <sessionId>", "session id to adopt (see `run adoptable`)")
    .requiredOption("--role <role>", "role name to assign, e.g. implementer, reviewer")
    .option("--task <taskId>", "task id (defaults to the session's own active task)")
    .option("--subtask <subtaskId>", "existing subtask id to attach to (creates one if omitted)")
    .option("--agent <agentId>", "existing registered agent id (creates a manual agent if omitted)")
    .action(
      (options: {
        session: string;
        role: string;
        task?: string;
        subtask?: string;
        agent?: string;
      }) => {
        const store = openStore();
        try {
          const events = store.listSessionEvents({ sessionId: options.session, limit: 50 });
          if (!events.length) throw new Error(`No session events found for session: ${options.session}`);
          const latest = events[0]!;
          const taskId = options.task ?? latest.taskId;
          if (!taskId) throw new Error("Could not determine a task id for this session; pass --task explicitly.");

          const agent = options.agent
            ? mustFindAgent(store, options.agent)
            : store.createRegisteredAgent({
                name: `adopted-${options.session.slice(0, 8)}`,
                provider: latest.agent ?? "generic",
                mode: "manual",
                capabilities: ["adopted"],
              });

          const roles = store.ensureDefaultWorkforceRoles();
          const role = roles.find((candidate) => candidate.name === options.role);
          if (!role) throw new Error(`Role not found: ${options.role}`);

          const subtask = options.subtask
            ? mustFindSubtask(store, taskId, options.subtask)
            : store.createSubtask({
                parentTaskId: taskId,
                title: `External work: ${latest.summary ?? options.session}`,
                status: "in_progress",
              });

          const assignment = store.createAssignment({
            taskId,
            subtaskId: subtask.id,
            agentId: agent.id,
            roleId: role.id,
            status: "running",
            prompt:
              "Adopted from an externally-running session; this agent is working independently outside orchestrator control.",
          });

          // No pid: this run is tracked by session_events (the hook), not by
          // a process this store spawned, so it cannot be stopped/killed —
          // only observed and eventually released.
          const run = store.createAgentRun({
            taskId,
            subtaskId: subtask.id,
            assignmentId: assignment.id,
            agentId: agent.id,
            roleId: role.id,
            origin: "adopted",
            sessionId: options.session,
            status: "detached",
            phase: "implement",
          });

          console.log(JSON.stringify({ agent, subtask, assignment, run }, null, 2));
        } finally {
          store.close();
        }
      },
    );

  run
    .command("release")
    .description("Release an adopted run back out of the team, keeping its history")
    .argument("<runId>", "agent run id")
    .action((runId: string) => {
      const store = openStore();
      try {
        const found = store.getAgentRun(runId);
        if (!found) throw new Error(`Run not found: ${runId}`);
        if (found.origin !== "adopted") {
          throw new Error(`Run ${runId} was not adopted (origin: ${found.origin}); nothing to release.`);
        }
        const updated = store.updateAgentRun(runId, { status: "stopped", endedAt: new Date().toISOString() });
        console.log(JSON.stringify(updated, null, 2));
      } finally {
        store.close();
      }
    });
}

export function listAdoptableSessions(store: Store): SessionEvent[] {
  const adoptedSessionIds = new Set(
    store
      .listAgentRuns({ limit: 1000 })
      .map((run) => run.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  return store.listActiveSessionEvents(200).filter((event) => !adoptedSessionIds.has(event.sessionId));
}

function mustFindAgent(store: Store, agentId: string): RegisteredAgent {
  const found = store.getRegisteredAgent(agentId);
  if (!found) throw new Error(`Agent not found: ${agentId}`);
  return found;
}

function mustFindSubtask(store: Store, taskId: string, subtaskId: string) {
  const found = store.listSubtasks({ parentTaskId: taskId, limit: 500 }).find((candidate) => candidate.id === subtaskId);
  if (!found) throw new Error(`Subtask not found: ${subtaskId}`);
  return found;
}

export async function respawnRun(
  store: Store,
  runId: string,
  overrides: { agentId?: string; model?: string; reasoningEffort?: string },
): Promise<{ oldRun: AgentRun; newRun: AgentRun }> {
  const oldRun = store.getAgentRun(runId);
  if (!oldRun) throw new Error(`Run not found: ${runId}`);
  if (!oldRun.assignmentId) throw new Error(`Run ${runId} has no assignment to resume.`);
  const assignment = store
    .listAssignments({ taskId: oldRun.taskId, limit: 500 })
    .find((candidate) => candidate.id === oldRun.assignmentId);
  if (!assignment) throw new Error(`Assignment not found for run ${runId}: ${oldRun.assignmentId}`);
  const subtask = oldRun.subtaskId
    ? store.listSubtasks({ parentTaskId: oldRun.taskId, limit: 500 }).find((candidate) => candidate.id === oldRun.subtaskId)
    : undefined;

  const stopped = (await stopAgentRun(store, runId)) ?? oldRun;

  const currentAgent = store.getRegisteredAgent(assignment.agentId);
  if (!currentAgent) throw new Error(`Registered agent not found: ${assignment.agentId}`);
  const targetAgent = overrides.agentId
    ? store.getRegisteredAgent(overrides.agentId)
    : resolveAgentVariant(store, currentAgent, overrides.model, overrides.reasoningEffort);
  if (!targetAgent) throw new Error(`Registered agent not found: ${overrides.agentId}`);

  const runsDir = join(paths().artifacts, "runs");
  mkdirSync(runsDir, { recursive: true });
  const logTail = stopped.logPath && existsSync(stopped.logPath) ? readFileSync(stopped.logPath, "utf8") : "";
  const resumePath = join(runsDir, `${runId}-resume.md`);
  writeFileSync(
    resumePath,
    renderResumeArtifact({
      assignment,
      subtask,
      priorSummary: compressLog(logTail, { maxLines: 60 }),
    }),
    "utf8",
  );

  const preview = buildSpawnPreview(targetAgent, resumePath, paths().cwd);
  const newRun = spawnAgentRun(store, {
    orchestrationId: oldRun.orchestrationId,
    taskId: oldRun.taskId,
    subtaskId: oldRun.subtaskId,
    assignmentId: oldRun.assignmentId,
    agentId: targetAgent.id,
    roleId: oldRun.roleId,
    origin: "spawned",
    model: targetAgent.model,
    reasoningEffort: targetAgent.reasoningEffort,
    phase: oldRun.phase,
    restartedFromRunId: oldRun.id,
    runsDir,
    preview,
  }, {
    // The command returns (and closes its store) long before the restarted
    // agent finishes; without a reopen its exit code is lost.
    reopenStore: () => openStore(paths().cwd),
  });

  store.updateAssignment(assignment.id, { status: "running" });
  return { oldRun: stopped, newRun };
}

function resolveAgentVariant(
  store: Store,
  currentAgent: RegisteredAgent,
  model: string | undefined,
  reasoningEffort: string | undefined,
): RegisteredAgent {
  if (!model && !reasoningEffort) return currentAgent;
  const nextModel = model ?? currentAgent.model;
  const nextReasoning = reasoningEffort ?? currentAgent.reasoningEffort;
  const stillInUse = store
    .listAgentRuns({ limit: 500 })
    .some((candidate) => candidate.agentId === currentAgent.id && ["starting", "running", "waiting"].includes(candidate.status));
  if (!stillInUse) {
    return (
      store.updateRegisteredAgent(currentAgent.id, { model: nextModel, reasoningEffort: nextReasoning }) ?? currentAgent
    );
  }
  return store.createRegisteredAgent({
    name: `${currentAgent.name}-${nextModel ?? "variant"}`,
    provider: currentAgent.provider,
    mode: currentAgent.mode,
    command: currentAgent.command,
    baseUrl: currentAgent.baseUrl,
    model: nextModel,
    reasoningEffort: nextReasoning,
    credentialRef: currentAgent.credentialRef,
    capabilities: currentAgent.capabilities,
  });
}

function renderResumeArtifact(input: { assignment: Assignment; subtask?: Subtask; priorSummary: string }): string {
  const lines = ["# Resume Assignment", "", `Assignment: ${input.assignment.id}`];
  if (input.subtask) lines.push(`Subtask: ${input.subtask.title}`);
  lines.push("", "## Original Prompt", "", input.assignment.prompt);
  if (input.subtask?.acceptanceCriteria.length) {
    lines.push("", "## Acceptance Criteria");
    for (const criterion of input.subtask.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  lines.push(
    "",
    "## Progress So Far (from the previous run's log)",
    "",
    input.priorSummary || "No prior output captured.",
    "",
    "## Instructions",
    "",
    "Continue this assignment. Do not repeat completed work; pick up from where the prior run left off.",
  );
  return `${lines.join("\n")}\n`;
}

function resolveAgent(agents: RegisteredAgent[], value: string): RegisteredAgent | undefined {
  return agents.find((agent) => agent.id === value || agent.name === value);
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function tailLines(content: string, count: number): string {
  return content.split(/\r?\n/).slice(-count).join("\n");
}

function parseStatus(value: string): AgentRunStatus {
  const allowed: AgentRunStatus[] = [
    "starting",
    "running",
    "waiting",
    "stopping",
    "stopped",
    "done",
    "failed",
    "detached",
  ];
  if (allowed.includes(value as AgentRunStatus)) return value as AgentRunStatus;
  throw new Error(`Invalid run status "${value}". Use one of: ${allowed.join(", ")}.`);
}
