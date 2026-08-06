import type { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, TaskChangeStatus, TaskStatus } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
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
import { placeholderTaskTitle } from "../task-suggestions.js";

export function registerTask(program: Command): void {
  const task = program.command("task").description("Manage task state");

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
    .option("--status <status>", "todo | in_progress | blocked | done | cancelled")
    .option("--agent <agent>", "owner/current agent")
    .action(
      (options: { task?: string; title?: string; goal?: string; status?: TaskStatus; agent?: AgentKind }) => {
        const store = openStore();
        try {
          const explicitTask = Boolean(options.task);
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
          const status = options.status ? parseTaskStatus(options.status) : undefined;
          const updated = store.updateTask(taskId, {
            title: options.title,
            goal: options.goal,
            status,
            ownerAgent: options.agent
          });
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
  const allowed: TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
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

