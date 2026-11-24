import { buildSpawnPreview, spawnAgentRun, stopAgentRun, reapAgentRuns } from "@agent-bridge/adapters";
import type { TaskDecomposition, ManagedDispatchPolicy, ManagedDispatchInput } from "@agent-bridge/memory";
import { assertWriteLeases } from "./graph.js";
import { normalizeLeasePath } from "./file.js";
import { writeHandoffArtifacts } from "./handoff.js";
import type { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, TaskChangeStatus, TaskStatus, TaskContractInput, ManagedReviewInput, TaskRetryKind, EndTaskAttemptInput } from "@agent-bridge/memory";
import {
  readCliInvocationSettings,
  getActiveTaskId,
  openStore,
  redactIfEnabled,
  paths,
  renderCurrentTask,
  resolveCurrentTaskId,
  rememberSessionWindowHandle,
  setCurrentTask,
  startAgentSession,
  syncAfterTaskDeleted,
  syncCurrentTaskArtifact,
  writeCurrentTaskArtifact
} from "../workspace.js";
import { markTaskGoalOmitted, placeholderTaskTitle } from "../task-suggestions.js";
import { readConfig } from "../workspace.js";
import { repositoryIdentity } from "../runtime-identity.js";
import { collectTestResult } from "../runtime-checkpoint.js";
import { readResumePacket } from "../task-resume.js";
import { selectTaskChecks, type CheckRule } from "../task-check-plan.js";

export function registerTask(program: Command): void {
  const task = program.command("task").description("Manage task state");
  const dispatch = task.command("dispatch").description("Reserve and account for managed multi-agent runs");
  for (const action of ["launch", "stop"]) {
    dispatch.command(action).requiredOption("--task <parentTaskId>").requiredOption("--request <requestId>")
      .requiredOption("--session <sessionId>").option("--agent <agent>", "worker agent", "codex")
      .option("--prompt-file <path>")
      .action((options: { task: string; request: string; session: string; agent: AgentKind; promptFile?: string }) => {
        const store = openStore();
        try {
          const record = store.listManagedDispatches(options.task).find(run => run.requestId === options.request);
          if (!record || record.agent !== options.agent || record.sessionId !== options.session) throw new Error("Dispatch owner/session mismatch");
          if (action === "stop") console.log(JSON.stringify(stopAgentRun(store, record.runId), null, 2));
          else {
            if (!options.promptFile) throw new Error("--prompt-file is required for launch");
            const agent = store.getRegisteredAgent(record.agentId)!;
            const cwd = process.cwd();
            const preview = buildSpawnPreview(agent, options.promptFile, cwd, readCliInvocationSettings(cwd, agent.provider));
            console.log(JSON.stringify(spawnAgentRun(store, { taskId: record.taskId, agentId: record.agentId,
              sessionId: record.sessionId, phase: "implement", reservedRunId: record.runId,
              runsDir: join(paths(cwd).artifacts, "runs"), preview }, { showTerminal: false, reopenStore: () => openStore(cwd) }), null, 2));
          }
        } finally { store.close(); }
      });
  }
  dispatch.command("reap").requiredOption("--task <parentTaskId>")
    .action((options: { task: string }) => {
      const store = openStore();
      try { reapAgentRuns(store, { taskId: options.task });
        for (const run of store.listManagedDispatches(options.task)) reapAgentRuns(store, { taskId: run.taskId });
        console.log(JSON.stringify(store.managedDispatchReport(options.task), null, 2)); }
      finally { store.close(); }
    });
  for (const action of ["policy", "reserve", "settle", "overhead"]) {
    dispatch.command(action).requiredOption("--file <jsonFile>").requiredOption("--session <sessionId>")
      .option("--agent <agent>", "caller agent", "codex").option("--task <parentTaskId>")
      .option("--request <requestId>")
      .action((options: { file: string; session: string; agent: AgentKind; task?: string; request?: string }) => {
        const store = openStore();
        try {
          const value = JSON.parse(readFileSync(options.file, "utf8"));
          let result: unknown;
          if (action === "reserve") result = store.reserveManagedDispatch(value as ManagedDispatchInput, options.agent, options.session);
          else if (action === "settle") {
            if (!options.request) throw new Error("--request is required for settlement");
            result = store.settleManagedDispatch(options.request, { ...value, repositoryRoot: process.cwd() }, options.agent, options.session);
          } else {
            if (!options.task) throw new Error("--task is required");
            if (action === "policy") result = store.configureManagedDispatch(options.task, value as ManagedDispatchPolicy, options.agent, options.session);
            else { store.recordManagedDispatchOverhead(options.task, value, options.agent, options.session); result = store.managedDispatchReport(options.task); }
          }
          console.log(JSON.stringify(result, null, 2));
        } finally { store.close(); }
      });
  }
  dispatch.command("report").requiredOption("--task <parentTaskId>")
    .action((options: { task: string }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.managedDispatchReport(options.task), null, 2)); } finally { store.close(); }
    });
  const decomposition = task.command("decomposition").description("Map child outputs to parent acceptance");
  decomposition.command("set").requiredOption("--file <jsonFile>").requiredOption("--session <sessionId>")
    .option("--agent <agent>", "parent owner", "codex")
    .action((options: { file: string; session: string; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.setTaskDecomposition(JSON.parse(readFileSync(options.file, "utf8")) as TaskDecomposition,
        options.agent, options.session), null, 2)); } finally { store.close(); }
    });
  decomposition.command("show").requiredOption("--task <taskId>")
    .action((options: { task: string }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.getTaskDecomposition(options.task) ?? null, null, 2)); } finally { store.close(); }
    });
  task.command("check-plan").requiredOption("--task <taskId>").requiredOption("--files <paths...>")
    .requiredOption("--rules <jsonFile>").option("--expand-reason <reason>")
    .action((options: { task: string; files: string[]; rules: string; expandReason?: string }) => {
      const store = openStore();
      try {
        const contract = store.getTaskContract(options.task);
        if (!contract) throw new Error("Managed task contract required");
        console.log(JSON.stringify(selectTaskChecks(process.cwd(), contract, options.files,
          JSON.parse(readFileSync(options.rules, "utf8")) as CheckRule[], options.expandReason), null, 2));
      } finally { store.close(); }
    });
  task.command("resume").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .option("--agent <agent>", "receiving agent", "codex")
    .option("--revision <revision>", "expected checkpoint revision")
    .action((options: { task: string; session: string; agent: AgentKind; revision?: string }) => {
      const store = openStore();
      try { console.log(JSON.stringify(readResumePacket(store, process.cwd(), options), null, 2)); }
      finally { store.close(); }
    });

  const contract = task.command("contract").description("Configure a managed task contract");
  const attempt = task.command("attempt");
  attempt.command("policy").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--kind <kind>").option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; kind: TaskRetryKind; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.setTaskRetryPolicy(options.task, options.kind, options.agent, options.session), null, 2)); }
      finally { store.close(); }
    });
  attempt.command("begin").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--operation <operation>").requiredOption("--hypothesis <hypothesis>")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; operation: string; hypothesis: string; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.beginTaskAttempt(options.task, options.operation, options.hypothesis, options.agent, options.session), null, 2)); }
      finally { store.close(); }
    });
  attempt.command("end").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--attempt <attemptId>").requiredOption("--file <jsonFile>")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; attempt: string; file: string; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.endTaskAttempt(options.task, options.attempt,
        JSON.parse(readFileSync(options.file, "utf8")) as EndTaskAttemptInput, options.agent, options.session), null, 2)); }
      finally { store.close(); }
    });
  task.command("review").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--file <jsonFile>").option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; file: string; agent: AgentKind }) => {
      const store = openStore();
      try {
        console.log(JSON.stringify(store.recordManagedReview(options.task,
          JSON.parse(readFileSync(options.file, "utf8")) as ManagedReviewInput, options.agent, options.session), null, 2));
      } finally { store.close(); }
    });
  contract.command("set").requiredOption("--task <taskId>").requiredOption("--file <jsonFile>")
    .option("--session <sessionId>").option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; file: string; session?: string; agent: AgentKind }) => {
      const store = openStore();
      try {
        const input = JSON.parse(readFileSync(options.file, "utf8")) as TaskContractInput;
        console.log(JSON.stringify(store.setTaskContract(options.task, input, options.agent, options.session), null, 2));
      } finally { store.close(); }
    });
  contract.command("show").requiredOption("--task <taskId>")
    .action((options: { task: string }) => {
      const store = openStore();
      try { console.log(JSON.stringify({ task: store.getTask(options.task), contract: store.getTaskContract(options.task),
        claim: store.getTaskOwnerClaim(options.task), acceptance: store.listTaskAcceptance(options.task),
        checks: store.listTaskChecks(options.task), reviews: store.listManagedReviews(options.task),
        retryPolicy: store.getTaskRetryPolicy(options.task), attempts: store.listTaskAttempts(options.task) }, null, 2)); }
      finally { store.close(); }
    });

  const owner = task.command("owner").description("Claim or release a managed task");
  owner.command("claim").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.claimTask(options.task, options.agent, options.session), null, 2)); }
      finally { store.close(); }
    });
  owner.command("release").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; session: string; agent: AgentKind }) => {
      const store = openStore();
      try { store.releaseTaskClaim(options.task, options.agent, options.session); console.log("Claim released"); }
      finally { store.close(); }
    });

  task.command("verify").requiredOption("--task <taskId>")
    .requiredOption("--checkpoint <checkpointId>").requiredOption("--session <sessionId>")
    .option("--criterion <criterion>", "acceptance criterion to verify")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; checkpoint: string; session: string; agent: AgentKind; criterion?: string }) => {
      const store = openStore();
      try {
        const check = store.verifyTaskCheck(options.task, options.checkpoint, options.agent, options.session);
        const acceptance = options.criterion
          ? store.verifyTaskAcceptance(options.task, options.criterion, options.checkpoint, options.agent, options.session)
          : undefined;
        console.log(JSON.stringify({ check, acceptance }, null, 2));
      } finally { store.close(); }
    });

  task.command("transition").requiredOption("--task <taskId>").requiredOption("--status <status>")
    .requiredOption("--session <sessionId>").option("--reason <reason>")
    .option("--agent <agent>", "owner agent", "codex")
    .action((options: { task: string; status: string; session: string; agent: AgentKind; reason?: string }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.transitionManagedTask(options.task, parseTaskStatus(options.status),
        options.agent, options.session, options.reason), null, 2)); }
      finally { store.close(); }
    });

  task.command("checkpoint").requiredOption("--summary <summary>")
    .requiredOption("--tests <tests>").option("--run-test <command>", "execute a check and retain its actual exit status/evidence").option("--next <items...>")
    .option("--files <paths...>").option("--task <taskId>").option("--session <sessionId>")
    .option("--done <items...>", "completed work, distinct from planned next actions")
    .option("--blockers <items...>").option("--agent <agent>", "source agent", "codex")
    .action((options: { summary: string; tests: string; runTest?: string; next?: string[]; done?: string[]; blockers?: string[]; files?: string[]; task?: string; session?: string; agent: AgentKind }) => {
      const store = openStore();
      try {
        const config = readConfig();
        if (options.runTest && config.contextEfficiency?.runtimeBookkeeping !== true) throw new Error("Enable contextEfficiency.runtimeBookkeeping to collect command evidence");
        const sessionId = options.session ?? process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID ?? config.currentSessions?.[options.agent];
        const sessionTask = sessionId ? config.sessionTasks?.[sessionId] : undefined;
        const claim = options.task ? store.getTaskOwnerClaim(options.task) : undefined;
        const managedSession = Boolean(claim && claim.sessionId === sessionId && claim.agent === options.agent);
        if (options.session && !sessionTask && !managedSession || options.task && sessionTask && options.task !== sessionTask) throw new Error("Session/task mismatch");
        const taskId = sessionTask ?? options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
        store.bindTaskIdentity(taskId, repositoryIdentity(process.cwd()));
        const files = (options.files ?? []).map(normalizeLeasePath);
        if (files.length) {
          assertWriteLeases(store, taskId, files);
          for (const path of files) {
            if (!store.listFileLeases({ path, activeOnly: true, limit: 100 }).some((lease) => lease.taskId === taskId && lease.agent === options.agent && lease.sessionId === (sessionTask ? sessionId : undefined) && lease.mode === "write"))
              throw new Error(`Write lease owner/session mismatch: ${path}`);
          }
        }
        const summary = redactIfEnabled(options.summary);
        const tests = redactIfEnabled(options.tests);
        const result = store.saveCheckpoint({ taskId, author: options.agent, sessionId: sessionTask || managedSession ? sessionId : undefined, summary,
          tests: options.runTest ? collectTestResult(process.cwd(), options.runTest) : { summary: tests, status: /^(not[ _-]?run|chưa chạy)$/i.test(tests.trim()) ? "not_run" : "unknown" },
          files: files.map((path) => ({ path, hash: existsSync(join(process.cwd(), path)) ? createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex") : undefined })),
          completed: (options.done ?? []).map((item) => redactIfEnabled(item)),
          next: (options.next ?? []).map((item) => redactIfEnabled(item)), blockers: (options.blockers ?? []).map((item) => redactIfEnabled(item)) });
        const handoff = store.getLatestHandoff(taskId)!;
        writeHandoffArtifacts(process.cwd(), handoff, { archive: false, task: store.getTask(taskId) });
        console.log(JSON.stringify({ taskId, checkpointId: result.checkpoint.id, handoffId: handoff.id, revision: result.checkpoint.revision, changed: result.changed, files: files.length }));
      } finally { store.close(); }
    });

  task
    .command("start")
    .argument("[title]", "task title")
    .option("--goal <goal>", "task goal")
    .option("--agent <agent>", "source agent", "codex")
    .action((title: string | undefined, options: { goal?: string; agent: AgentKind }) => {
      const store = openStore();
      try {
        const taskTitle = title?.trim() || placeholderTaskTitle(options.agent);
        const created = store.createTask({ title: taskTitle, goal: options.goal, ownerAgent: options.agent });
        setCurrentTask(created.id, undefined, options.agent);
        const sessionId = `${options.agent}-${randomUUID()}`;
        startAgentSession(sessionId, created.id, undefined, options.agent);
        rememberSessionWindowHandle(sessionId, created.id, options.agent);
        store.recordSessionEvent({
          sessionId,
          taskId: created.id,
          agent: options.agent,
          kind: "session_started",
          summary: `${agentLabel(options.agent)} session started for new task.`,
        });
        store.addMemory({
          taskId: created.id,
          type: "task",
          content: created.goal ? `${created.title}: ${created.goal}` : created.title,
          importance: 5,
          sourceAgent: options.agent
        });
        writeCurrentTaskArtifact(created);
        console.log(`Bound ${options.agent} session ${sessionId} to ${created.id}`);
        console.log(`Started task ${created.id}`);
        console.log(renderCurrentTask(created));
      } finally {
        store.close();
      }
    });

  task
    .command("update")
    .description("Edit task title, goal, status, or owner")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--title <title>", "new task title")
    .option("--goal <goal>", "new task goal")
    .option("--clear-goal", "keep the task goal empty and prevent prompt-based goal seeding")
    .option("--status <status>", "todo | in_progress | review | blocked | done | cancelled")
    .option("--agent <agent>", "owner/current agent")
    .option("--session <sessionId>", "claimed session for managed task edits")
    .action(
      (options: { task?: string; title?: string; goal?: string; clearGoal?: boolean; status?: TaskStatus; agent?: AgentKind; session?: string }) => {
        const store = openStore();
        try {
          const explicitTask = Boolean(options.task);
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
          const current = store.getTask(taskId);
          if (!current) throw new Error(`Task not found: ${taskId}`);
          if (options.clearGoal && options.goal !== undefined) {
            throw new Error("Use either --goal or --clear-goal, not both.");
          }
          const nextTitle = (options.title ?? current.title).trim();
          const nextGoal = options.clearGoal ? "" : (options.goal ?? current.goal)?.trim();
          if ((options.title !== undefined || options.goal !== undefined) && nextGoal && nextTitle === nextGoal) {
            throw new Error("Task title must be a shorter descriptive name distinct from its goal.");
          }
          const status = options.status ? parseTaskStatus(options.status) : undefined;
          if (status && store.getTaskContract(taskId) && status !== current.status)
            throw new Error("Use task transition with --session for managed task statuses");
          let updated = store.updateTask(taskId, {
            title: options.title,
            goal: options.clearGoal ? "" : options.goal,
            status,
            ownerAgent: options.agent ?? (store.getTaskContract(taskId) ? store.getTaskOwnerClaim(taskId)?.agent : undefined),
            sessionId: options.session,
          });
          if (options.clearGoal) {
            updated = markTaskGoalOmitted(store, taskId, options.agent ?? updated?.ownerAgent ?? "codex");
          }
          if (!updated) throw new Error(`Task not found: ${taskId}`);
          const isCurrent = resolveCurrentTaskId(undefined, undefined, options.agent) === updated.id;
          if (!explicitTask || isCurrent) {
            setCurrentTask(updated.id, undefined, options.agent ?? updated.ownerAgent);
            writeCurrentTaskArtifact(updated);
          }
          store.addMemory({
            taskId: updated.id,
            type: "task",
            content: `Task updated: ${updated.title} (${updated.status})`,
            importance: 4,
            sourceAgent: options.agent ?? updated.ownerAgent
          });
          console.log(renderCurrentTask(updated));
        } finally {
          store.close();
        }
      }
    );

  task
    .command("delete")
    .description("Delete a task and its task-scoped memory, handoff, decision, and run records")
    .requiredOption("--task <taskId>", "task id to delete")
    .action((options: { task: string }) => {
      const store = openStore();
      try {
        const deleted = store.deleteTask(options.task);
        if (!deleted) throw new Error(`Task not found: ${options.task}`);
        syncAfterTaskDeleted(store, options.task);
        console.log(`Deleted task ${options.task}`);
      } finally {
        store.close();
      }
    });

  task.command("current").description("Show current task").action(() => {
    const store = openStore();
    try {
      const taskId = getActiveTaskId(store);
      const current = syncCurrentTaskArtifact(store, taskId);
      const markdown = renderCurrentTask(current);
      console.log(markdown);
    } finally {
      store.close();
    }
  });

  task
    .command("lane")
    .description("Create or update the isolated working lane for a task")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--mode <mode>", "patch | worktree", "patch")
    .option("--base-ref <ref>", "git base ref", "HEAD")
    .option("--base-commit <sha>", "git base commit")
    .option("--worktree-path <path>", "worktree path for worktree mode")
    .option("--status <status>", "active | merged | discarded | conflict", "active")
    .action((options: { task?: string; mode: string; baseRef?: string; baseCommit?: string; worktreePath?: string; status: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store);
        const lane = store.upsertTaskLane({
          taskId,
          mode: parseLaneMode(options.mode),
          baseRef: options.baseRef,
          baseCommit: options.baseCommit ?? gitHead(),
          worktreePath: options.worktreePath,
          status: parseLaneStatus(options.status)
        });
        console.log(JSON.stringify(lane, null, 2));
      } finally {
        store.close();
      }
    });

  task
    .command("scan")
    .description("Scan git working tree changes into the task change set")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .action((options: { task?: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store);
        const changes = scanGitChanges().map((change) =>
          store.upsertTaskChange({
            taskId,
            path: change.path,
            changeType: change.changeType,
            currentHash: contentHash(change.path),
            diffSummary: change.summary
          })
        );
        console.log(changes.length ? JSON.stringify(changes, null, 2) : "No git working tree changes detected.");
      } finally {
        store.close();
      }
    });

  task
    .command("changes")
    .description("List recorded changes for a task")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .action((options: { task?: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store);
        console.log(JSON.stringify(store.listTaskChanges(taskId, 200), null, 2));
      } finally {
        store.close();
      }
    });

  for (const statusCommand of [
    { name: "accept", status: "accepted" as TaskChangeStatus, lane: "merged" as const },
    { name: "discard", status: "discarded" as TaskChangeStatus, lane: "discarded" as const },
    { name: "merge", status: "accepted" as TaskChangeStatus, lane: "merged" as const }
  ]) {
    task
      .command(statusCommand.name)
      .description(`Mark a task change set as ${statusCommand.status}`)
      .option("--task <taskId>", "task id (defaults to the active task)")
      .action((options: { task?: string }) => {
        const store = openStore();
        try {
          const taskId = options.task ?? getActiveTaskId(store);
          const changes = store.listTaskChanges(taskId, 500);
          for (const change of changes) {
            store.upsertTaskChange({
              taskId,
              path: change.path,
              changeType: change.changeType,
              baseHash: change.baseHash,
              currentHash: change.currentHash,
              diffSummary: change.diffSummary,
              status: statusCommand.status
            });
          }
          const lane = store.getTaskLane(taskId);
          if (lane) store.upsertTaskLane({ ...lane, status: statusCommand.lane });
          store.addMemory({
            taskId,
            type: "note",
            content: `Task ${statusCommand.name} requested: ${changes.length} recorded changes marked ${statusCommand.status}.`,
            importance: 3,
            sourceAgent: "codex",
            tags: ["orchestration", statusCommand.name]
          });
          console.log(`Marked ${changes.length} changes ${statusCommand.status}.`);
        } finally {
          store.close();
        }
      });
  }
}

function parseTaskStatus(status: string): TaskStatus {
  const allowed: TaskStatus[] = ["todo", "in_progress", "review", "blocked", "done", "cancelled"];
  if (!allowed.includes(status as TaskStatus)) {
    throw new Error(`Invalid status "${status}". Use one of: ${allowed.join(", ")}.`);
  }
  return status as TaskStatus;
}

function agentLabel(agent: AgentKind): string {
  return agent === "antigravity"
    ? "Antigravity"
    : agent[0].toUpperCase() + agent.slice(1);
}

function parseLaneMode(value: string): "patch" | "worktree" {
  if (value === "patch" || value === "worktree") return value;
  throw new Error('Invalid lane mode. Use "patch" or "worktree".');
}

function parseLaneStatus(value: string): "active" | "merged" | "discarded" | "conflict" {
  const allowed = ["active", "merged", "discarded", "conflict"];
  if (allowed.includes(value)) return value as "active" | "merged" | "discarded" | "conflict";
  throw new Error(`Invalid lane status "${value}". Use one of: ${allowed.join(", ")}.`);
}

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function scanGitChanges(): Array<{ path: string; changeType: "added" | "modified" | "deleted" | "renamed"; summary: string }> {
  const raw = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rest = line.slice(3).trim();
      const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
      const changeType = status.includes("D")
        ? "deleted"
        : status.includes("R")
          ? "renamed"
          : status.includes("A") || status.includes("?")
            ? "added"
            : "modified";
      return { path: path.replace(/\\/g, "/"), changeType, summary: `${status.trim() || "changed"} ${path}` };
    });
}

function contentHash(path: string): string | undefined {
  const full = join(paths().cwd, path);
  if (!existsSync(full)) return undefined;
  return createHash("sha256").update(readFileSync(full)).digest("hex");
}

