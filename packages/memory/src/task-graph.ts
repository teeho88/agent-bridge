import type { Memory, Task } from "./types.js";

export type TaskGraph = {
  task: Task;
  memories: Memory[];
};

export function buildTaskGraph(task: Task, memories: Memory[]): TaskGraph {
  return { task, memories };
}
