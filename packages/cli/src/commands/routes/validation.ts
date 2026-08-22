import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentKind,
  AgentProvider,
  AgentRequestStatus,
  AgentRequestType,
  AgentRunMode,
  AssignmentStatus,
  FileLeaseMode,
  RegisteredAgent,
  SubtaskStatus,
  TaskChangeStatus,
  TaskStatus,
} from "@agent-bridge/memory";
import type { SkillScope } from "../../skill-library.js";

// Request-body coercion shared by every route group: turn untrusted JSON into
// the narrow types the store expects, or throw so serveRequest answers 500.

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requiredSkillScope(value: unknown): SkillScope {
  if (value !== "global" && value !== "repo") {
    throw new Error("scope must be global or repo");
  }
  return value;
}

// A non-negative whole number, or undefined for "not set". Zero is kept: it is
// a real answer for limits like the leader's question rounds.
export function optionalCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(optionalString(value) ?? Number.NaN);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

export function parseItems(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// The team-provider allowlist arrives as an array of checkbox values. Each one
// is validated as a real provider so a typo becomes an error at start time,
// not an unstaffable plan several minutes in.
export function parseAgentProvider(value: string): AgentProvider {
  const allowed: AgentProvider[] = [
    "codex",
    "claude",
    "gemini",
    "antigravity",
    "openai-compatible",
    "deepseek",
    "kimi",
    "glm",
    "manual",
    "generic",
  ];
  if (allowed.includes(value as AgentProvider)) return value as AgentProvider;
  throw new Error(`Invalid provider "${value}". Use one of: ${allowed.join(", ")}.`);
}

export function parseAgentRunMode(value: string): AgentRunMode {
  const allowed: AgentRunMode[] = ["cli", "api", "manual"];
  if (allowed.includes(value as AgentRunMode)) return value as AgentRunMode;
  throw new Error(`Invalid mode "${value}". Use one of: ${allowed.join(", ")}.`);
}

export function parseSubtaskStatus(value: string): SubtaskStatus {
  const allowed: SubtaskStatus[] = [
    "todo",
    "assigned",
    "in_progress",
    "testing",
    "review",
    "blocked",
    "done",
    "cancelled",
  ];
  if (allowed.includes(value as SubtaskStatus)) return value as SubtaskStatus;
  throw new Error(`Invalid subtask status "${value}". Use one of: ${allowed.join(", ")}.`);
}

export function parseAssignmentStatus(value: string): AssignmentStatus {
  const allowed: AssignmentStatus[] = [
    "queued",
    "approved",
    "running",
    "waiting",
    "done",
    "failed",
    "cancelled",
  ];
  if (allowed.includes(value as AssignmentStatus)) return value as AssignmentStatus;
  throw new Error(`Invalid assignment status "${value}". Use one of: ${allowed.join(", ")}.`);
}

export function assignmentStatusToSubtaskStatus(
  status: AssignmentStatus,
): SubtaskStatus | undefined {
  if (status === "running") return "in_progress";
  if (status === "done") return "done";
  if (status === "failed") return "blocked";
  if (status === "cancelled") return "cancelled";
  if (status === "queued" || status === "approved") return "assigned";
  return undefined;
}

export function parseTaskStatus(value?: string): TaskStatus | undefined {
  if (!value) return undefined;
  const allowed: TaskStatus[] = [
    "todo",
    "in_progress",
    "blocked",
    "done",
    "cancelled",
  ];
  if (!allowed.includes(value as TaskStatus)) {
    throw new Error(
      `Invalid status "${value}". Use one of: ${allowed.join(", ")}.`,
    );
  }
  return value as TaskStatus;
}

export function parseLaneMode(value: string): "patch" | "worktree" {
  if (value === "patch" || value === "worktree") return value;
  throw new Error('Invalid lane mode. Use "patch" or "worktree".');
}

export function parseLaneStatus(
  value: string,
): "active" | "merged" | "discarded" | "conflict" {
  const allowed = ["active", "merged", "discarded", "conflict"];
  if (allowed.includes(value))
return value as "active" | "merged" | "discarded" | "conflict";
  throw new Error(
`Invalid lane status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

export function parseLeaseMode(value: string): FileLeaseMode {
  if (value === "read" || value === "write") return value;
  throw new Error('Invalid lease mode. Use "read" or "write".');
}

export function parseChangeType(
  value: string,
): "added" | "modified" | "deleted" | "renamed" {
  const allowed = ["added", "modified", "deleted", "renamed"];
  if (allowed.includes(value))
return value as "added" | "modified" | "deleted" | "renamed";
  throw new Error(
`Invalid change type "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

export function parseChangeStatus(value: string): TaskChangeStatus {
  const allowed: TaskChangeStatus[] = [
    "pending",
    "accepted",
    "discarded",
    "conflict",
  ];
  if (allowed.includes(value as TaskChangeStatus))
    return value as TaskChangeStatus;
  throw new Error(
    `Invalid change status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

export function parseRequestType(value: string): AgentRequestType {
  const allowed: AgentRequestType[] = [
    "approval",
    "command",
    "merge",
    "question",
  ];
  if (allowed.includes(value as AgentRequestType))
    return value as AgentRequestType;
  throw new Error(
    `Invalid request type "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

export function parseRequestStatus(value: string): AgentRequestStatus {
  const allowed: AgentRequestStatus[] = [
    "pending",
    "accepted",
    "rejected",
    "resolved",
  ];
  if (allowed.includes(value as AgentRequestStatus))
    return value as AgentRequestStatus;
  throw new Error(
    `Invalid request status "${value}". Use one of: ${allowed.join(", ")}.`,
  );
}

export function parseAgentKind(value: string): AgentKind {
  const allowed: AgentKind[] = ["claude", "codex", "gemini", "antigravity", "generic"];
  if (!allowed.includes(value as AgentKind)) {
    throw new Error(
      `Invalid agent "${value}". Use one of: ${allowed.join(", ")}.`,
    );
  }
  return value as AgentKind;
}

export function agentLabel(agent: AgentKind): string {
  return agent === "antigravity"
    ? "Antigravity"
    : agent[0].toUpperCase() + agent.slice(1);
}

export function ownerAgentKind(agent: RegisteredAgent): AgentKind {
  if (["claude", "codex", "antigravity", "generic"].includes(agent.provider)) {
    return agent.provider as AgentKind;
  }
  return "generic";
}

export function contentHash(root: string, path: string): string | undefined {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  return createHash("sha256").update(readFileSync(full, "utf8")).digest("hex");
}
