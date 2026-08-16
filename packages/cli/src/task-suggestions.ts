import type { AgentKind, Memory, Task } from "@agent-bridge/memory";

type SuggestionStore = {
  addMemory(input: {
    taskId?: string;
    type: "note";
    content: string;
    importance?: number;
    tags?: string[];
    sourceAgent?: AgentKind;
    dedupe?: boolean;
  }): Memory;
  getTask(id: string): Task | undefined;
  listMemoriesForTask(taskId: string, limit?: number): Memory[];
  updateTask(
    id: string,
    input: { title?: string; goal?: string; status?: Task["status"]; ownerAgent?: AgentKind },
  ): Task | undefined;
};

const promptSuggestionTag = "task-label-source";
const provisionalTitles = new Set([
  "Untitled task",
  "Codex session",
  "Claude session",
  "Antigravity session",
  "Generic session",
  "Codex terminal",
  "Claude terminal",
  "Antigravity terminal",
]);
const provisionalGoals = new Set([
  "Interactive Codex CLI opened from Work Board.",
  "Interactive Claude CLI opened from Work Board.",
  "Interactive Antigravity CLI opened from Work Board.",
]);

export function placeholderTaskTitle(agent?: AgentKind): string {
  if (agent === "codex") return "Codex session";
  if (agent === "claude") return "Claude session";
  if (agent === "antigravity") return "Antigravity session";
  if (agent === "generic") return "Generic session";
  return "Untitled task";
}

export function titleFromSuggestion(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
    .replace(/[.?!,:;]+$/g, "") || "Untitled task";
}

export function rememberTaskLabelSource(
  store: SuggestionStore,
  taskId: string,
  text: string,
  agent: AgentKind,
): void {
  const source = text.trim();
  if (!source) return;
  const exists = store
    .listMemoriesForTask(taskId, 100)
    .some((memory) => memory.tags.includes(promptSuggestionTag));
  if (exists) return;
  store.addMemory({
    taskId,
    type: "note",
    content: source,
    importance: 2,
    sourceAgent: agent,
    tags: [agent, promptSuggestionTag],
    dedupe: false,
  });
}

export function firstTaskLabelSource(store: SuggestionStore, taskId: string): string | undefined {
  return store
    .listMemoriesForTask(taskId, 100)
    .filter((memory) => memory.tags.includes(promptSuggestionTag))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]
    ?.content.trim();
}

export function applyTaskLabelSuggestion(
  store: SuggestionStore,
  taskId: string,
  input: { titleText?: string; goalText?: string; status?: Task["status"]; replaceAutoTitle?: boolean },
): Task | undefined {
  const task = store.getTask(taskId);
  if (!task) return undefined;
  const titleText = input.titleText?.trim();
  const goalText = input.goalText?.trim();
  const title = shouldSeedTitle(task, input.replaceAutoTitle === true)
    ? titleFromSuggestion(titleText || goalText || "")
    : undefined;
  const goal = (!task.goal || provisionalGoals.has(task.goal.trim())) && goalText
    ? goalText
    : undefined;
  if (!title && !goal && !input.status) return task;
  return store.updateTask(taskId, {
    title,
    goal,
    status: input.status,
  });
}

export function shouldSeedTitle(task: Task, replaceAutoTitle = false): boolean {
  const title = task.title.trim();
  if (!title) return true;
  if (provisionalTitles.has(title)) return true;
  return replaceAutoTitle && Boolean(task.goal && title === titleFromSuggestion(task.goal));
}

