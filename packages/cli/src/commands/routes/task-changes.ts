import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FileLease, TaskChange } from "@agent-bridge/memory";
import { paths } from "../../workspace.js";
import { contentHash } from "./validation.js";
import {
  addedFileDiff,
  gitDiff,
  gitDiffStat,
  gitPathStatus,
  truncateDiff,
} from "./git.js";

// Work Board task changes: pairing a change with the write lease that covers
// it, and the per-task context file the dashboard edits.

export type UiTaskChange = TaskChange & {
  insertions: number;
  deletions: number;
  diff?: string;
  diffStat?: string;
};

export function taskChangesWithWriteLeases(
  root: string,
  changes: TaskChange[],
  leases: FileLease[],
): TaskChange[] {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  for (const lease of leases) {
    if (lease.mode !== "write" || byPath.has(lease.path)) continue;
    const gitStatus = gitPathStatus(root, lease.path);
    const changeType = gitStatus
      ? gitStatus.changeType
      : existsSync(resolve(root, lease.path))
        ? "modified"
        : "deleted";
    byPath.set(lease.path, {
      id: `lease-change-${lease.id}`,
      taskId: lease.taskId,
      path: lease.path,
      changeType,
      baseHash: lease.baseHash,
      currentHash: contentHash(root, lease.path) ?? lease.currentHash,
      diffSummary: gitStatus?.summary ?? `write lease ${lease.path}`,
      status: "pending",
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    });
  }
  return Array.from(byPath.values());
}

export function enrichTaskChanges(root: string, changes: TaskChange[]): UiTaskChange[] {
  return changes.map((change) => {
    const stat = gitDiffStat(root, change.path);
    const fallback =
      stat.insertions === 0 &&
      stat.deletions === 0 &&
      change.changeType === "added"
        ? addedFileDiff(root, change.path)
        : undefined;
    const diff = gitDiff(root, change.path) || fallback?.diff;
    return {
      ...change,
      insertions: stat.insertions || fallback?.insertions || 0,
      deletions: stat.deletions,
      diff: truncateDiff(diff),
      diffStat: stat.raw || fallback?.raw,
    };
  });
}

// `cwd` is required: this used to default to the command's module state,
// which is what kept it from moving out of ui.ts.
export function taskContextPath(taskId: string, cwd: string): string {
  return join(paths(cwd).tasks, taskId, "compiled-context.md");
}

export function writeTaskContext(
  taskId: string,
  content: string,
  cwd: string,
): void {
  const filePath = taskContextPath(taskId, cwd);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
}
