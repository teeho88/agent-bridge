import type { Command } from "commander";
import type { AssignmentStatus } from "@agent-bridge/memory";
import { getActiveTaskId, openStore } from "../workspace.js";

export function registerAssignment(program: Command): void {
  const assignment = program.command("assignment").description("Inspect and correct workforce assignments");

  assignment
    .command("list")
    .option("--task <taskId>", "task id (defaults to active task)")
    .option("--subtask <subtaskId>", "filter by subtask id")
    .option("--status <status>", "queued | approved | running | waiting | done | failed | cancelled")
    .action((options: { task?: string; subtask?: string; status?: string }) => {
      const store = openStore();
      try {
        const taskId = options.subtask ? undefined : options.task ?? getActiveTaskId(store);
        console.log(JSON.stringify(store.listAssignments({
          taskId,
          subtaskId: options.subtask,
          status: options.status ? parseAssignmentStatus(options.status) : undefined,
        }), null, 2));
      } finally {
        store.close();
      }
    });

  assignment
    .command("update")
    .argument("<assignmentId>", "assignment id")
    .option("--status <status>", "queued | approved | running | waiting | done | failed | cancelled")
    .option("--result <summary>", "result summary")
    .action((assignmentId: string, options: { status?: string; result?: string }) => {
      const store = openStore();
      try {
        const updated = store.updateAssignment(assignmentId, {
          status: options.status ? parseAssignmentStatus(options.status) : undefined,
          resultSummary: options.result,
        });
        if (!updated) throw new Error(`Assignment not found: ${assignmentId}`);
        console.log(JSON.stringify(updated, null, 2));
      } finally {
        store.close();
      }
    });
}

function parseAssignmentStatus(value: string): AssignmentStatus {
  const allowed: AssignmentStatus[] = ["queued", "approved", "running", "waiting", "done", "failed", "cancelled"];
  if (allowed.includes(value as AssignmentStatus)) return value as AssignmentStatus;
  throw new Error(`Invalid assignment status "${value}". Use one of: ${allowed.join(", ")}.`);
}
