import type { Command } from "commander";
import type { SubtaskStatus } from "@agent-bridge/memory";
import { getActiveTaskId, openStore, parseList } from "../workspace.js";

export function registerSubtask(program: Command): void {
  const subtask = program.command("subtask").description("Manage workforce subtasks");

  subtask
    .command("create")
    .argument("<title>", "subtask title")
    .option("--task <taskId>", "parent task id (defaults to active task)")
    .option("--goal <goal>", "subtask goal")
    .option("--status <status>", "todo | assigned | in_progress | testing | review | blocked | done | cancelled")
    .option("--reason <text>", "short reason for blocked or cancelled status")
    .option("--priority <priority>", "priority 1-5", "3")
    .option("--depends-on <ids>", "comma-separated dependency subtask ids")
    .option("--criteria <items>", "comma-separated acceptance criteria")
    .action((title: string, options: { task?: string; goal?: string; status?: string; priority: string; dependsOn?: string; criteria?: string }) => {
      const store = openStore();
      try {
        const parentTaskId = options.task ?? getActiveTaskId(store);
        const created = store.createSubtask({
          parentTaskId,
          title,
          goal: options.goal,
          status: options.status ? parseSubtaskStatus(options.status) : undefined,
          priority: Number(options.priority),
          dependsOn: parseList(options.dependsOn),
          acceptanceCriteria: parseList(options.criteria),
        });
        console.log(JSON.stringify(created, null, 2));
      } finally {
        store.close();
      }
    });

  subtask.command("list").option("--task <taskId>", "parent task id").option("--status <status>", "filter by status").action((options: { task?: string; status?: string }) => {
    const store = openStore();
    try {
      const parentTaskId = options.task ?? getActiveTaskId(store);
      console.log(JSON.stringify(store.listSubtasks({ parentTaskId, status: options.status ? parseSubtaskStatus(options.status) : undefined }), null, 2));
    } finally {
      store.close();
    }
  });

  subtask
    .command("update")
    .argument("<subtaskId>", "subtask id")
    .option("--title <title>", "new title")
    .option("--goal <goal>", "new goal")
    .option("--status <status>", "todo | assigned | in_progress | testing | review | blocked | done | cancelled")
    .option("--priority <priority>", "priority 1-5")
    .option("--depends-on <ids>", "comma-separated dependency subtask ids")
    .option("--criteria <items>", "comma-separated acceptance criteria")
    .action((subtaskId: string, options: { title?: string; goal?: string; status?: string; reason?: string; priority?: string; dependsOn?: string; criteria?: string }) => {
      const store = openStore();
      try {
        const updated = store.updateSubtask(subtaskId, {
          title: options.title,
          goal: options.goal,
          status: options.status ? parseSubtaskStatus(options.status) : undefined,
          statusReason: options.reason,
          priority: options.priority ? Number(options.priority) : undefined,
          dependsOn: options.dependsOn ? parseList(options.dependsOn) : undefined,
          acceptanceCriteria: options.criteria ? parseList(options.criteria) : undefined,
        });
        if (!updated) throw new Error(`Subtask not found: ${subtaskId}`);
        console.log(JSON.stringify(updated, null, 2));
      } finally {
        store.close();
      }
    });
}

function parseSubtaskStatus(value: string): SubtaskStatus {
  const allowed: SubtaskStatus[] = ["todo", "assigned", "in_progress", "testing", "review", "blocked", "done", "cancelled"];
  if (allowed.includes(value as SubtaskStatus)) return value as SubtaskStatus;
  throw new Error(`Invalid subtask status "${value}". Use one of: ${allowed.join(", ")}.`);
}
