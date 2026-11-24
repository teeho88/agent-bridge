import { execFileSync } from "node:child_process";
import type { AgentKind, CreateHandoffInput, Handoff } from "@agent-bridge/memory";
import { openStore, redactIfEnabled } from "./workspace.js";
import { effectiveWorkflowMode } from "./workflow.js";
import { writeHandoffArtifacts } from "./commands/handoff.js";

export function refreshAutoHandoff(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
  agent: AgentKind,
  sessionId: string | undefined,
  response?: string | null,
): Handoff | undefined {
  const summary = response?.trim();
  if (!summary || process.env.AGENT_BRIDGE_SPAWNED_RUN || effectiveWorkflowMode(store, cwd, sessionId) === "single") return undefined;
  const latest = store.getLatestHandoff(taskId);
  if (latest && !latest.auto) return undefined;
  const handoff = store.upsertAutoHandoff(buildAutoHandoffInput(store, cwd, taskId, summary, agent));
  writeHandoffArtifacts(cwd, handoff, { task: store.getTask(taskId) });
  return handoff;
}

// Heuristically assemble a handoff from what the store already knows about the
// current task — no LLM. summary = the latest assistant response; done = recent
// task title/goal; risks = recorded constraints; next = action bullets parsed
// from the response; filesChanged = git working-tree changes (empty if no repo).
function buildAutoHandoffInput(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
  latestResponse: string,
  agent: AgentKind,
): CreateHandoffInput {
  const memories = store.listMemoriesForTask(taskId, 120);
  const byTimeDesc = [...memories].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  const task = store.getTask(taskId);

  const taskLabel = task ? oneLine(task.goal || task.title, 100) : undefined;
  const done = taskLabel ? [`Handled task: ${taskLabel}`] : [];

  const risks = dedupeStrings(
    byTimeDesc
      .filter((m) => m.type === "constraint")
      .map((m) => oneLine(m.content, 120)),
  ).slice(0, 5);

  const next = nextActionsFromText(latestResponse);
  const filesChanged = gitChangedFiles(cwd);
  const summary =
    latestResponse.length > 800
      ? `${latestResponse.slice(0, 800).trim()}\n...[truncated]`
      : latestResponse;

  return {
    taskId,
    fromAgent: agent,
    summary: redactIfEnabled(summary, cwd),
    done: done.map((d) => redactIfEnabled(d, cwd)),
    next: next.map((n) => redactIfEnabled(n, cwd)),
    risks: risks.map((r) => redactIfEnabled(r, cwd)),
    filesChanged,
  };
}

function nextActionsFromText(text: string): string[] {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim())
    .filter((line) =>
      /\b(next|todo|then|fix|add|implement|tiếp|còn|cần|sửa|làm)\b/i.test(line),
    );
  return dedupeStrings(bullets.map((b) => oneLine(b, 120))).slice(0, 5);
}

function gitChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trim()}…` : flat;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

