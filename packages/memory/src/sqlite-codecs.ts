import { randomUUID } from "node:crypto";
import { searchTerms } from "./text-normalize.js";
import { normalizeOrchestrationStatus } from "./types.js";

import type { GraphNode } from "./graph.js";

import type {
  AgentRun,
  Orchestration,
  OrchestrationEvent,
  Review,
  WorkforceRole,
  WorkforceMember,
  Workforce,
  SubtaskStatus,
  Subtask,
  RegisteredAgent,
  DispatchRun,
  CredentialRef,
  Assignment,
  AgentRequest,
  Decision,
  FileLease,
  FileSummary,
  Handoff,
  MemoryCandidate,
  RunRecord,
  SessionEvent,
  Task,
  TaskChange,
  TaskLane,
} from "./types.js";
type Row = Record<string, unknown>;
export function now(): string {
  return new Date().toISOString();
}

export function slug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "task"}-${randomUUID().slice(0, 8)}`;
}

export function parseList(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

// Build a safe FTS5 MATCH expression from free-text user input. Tokens are
// diacritic-folded to match the folded FTS index (v3), so accent-insensitive
// queries work. Each token is wrapped in double quotes (a string literal) so
// punctuation and FTS operators in the query cannot break the MATCH syntax.
// OR retrieves partial matches; bm25 ranks coverage. Bound query complexity.
export function toFtsMatchExpression(query: string): string | undefined {
  const tokens = searchTerms(query);
  if (!tokens.length) return undefined;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export function toTask(row: Row): Task {
  return {
    repositoryId: row.repository_id ? String(row.repository_id) : undefined,
    branch: row.branch ? String(row.branch) : undefined,
    baseCommit: row.base_commit ? String(row.base_commit) : undefined,
    revision: Number(row.revision ?? 0),
    id: String(row.id),
    title: String(row.title),
    goal: row.goal ? String(row.goal) : undefined,
    status: String(row.status) as Task["status"],
    statusReason: row.status_reason ? String(row.status_reason) : undefined,
    ownerAgent: row.owner_agent
      ? (String(row.owner_agent) as Task["ownerAgent"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toDecision(row: Row): Decision {
  return {
    stale: Boolean(row.stale),
    scope: row.scope ? String(row.scope) : undefined,
    evidence: row.evidence ? JSON.parse(String(row.evidence)) : undefined,
    supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    decision: String(row.decision),
    reason: row.reason ? String(row.reason) : undefined,
    relatedFiles: parseList(row.related_files),
    sourceAgent: row.source_agent
      ? (String(row.source_agent) as Decision["sourceAgent"])
      : undefined,
    createdAt: String(row.created_at),
  };
}

export function toFileSummary(row: Row): FileSummary {
  return {
    path: String(row.path),
    summary: row.summary ? String(row.summary) : undefined,
    lastSeenHash: row.last_seen_hash ? String(row.last_seen_hash) : undefined,
    importantRanges: parseList(row.important_ranges),
    manualPriority:
      row.manual_priority == null ? undefined : Number(row.manual_priority),
    lastTaskId: row.last_task_id ? String(row.last_task_id) : undefined,
    lastTaskEditedAt: row.last_task_edited_at
      ? String(row.last_task_edited_at)
      : undefined,
    updatedAt: String(row.updated_at),
  };
}

export function toRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    agent: row.agent ? (String(row.agent) as RunRecord["agent"]) : undefined,
    command: row.command ? String(row.command) : undefined,
    resultSummary: row.result_summary ? String(row.result_summary) : undefined,
    tokenEstimate:
      row.token_estimate != null ? Number(row.token_estimate) : undefined,
    createdAt: String(row.created_at),
  };
}

export function toSessionEvent(row: Row): SessionEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    agent: row.agent ? (String(row.agent) as SessionEvent["agent"]) : undefined,
    kind: String(row.kind) as SessionEvent["kind"],
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: String(row.created_at),
  };
}

export function toMemoryCandidate(row: Row): MemoryCandidate {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    sessionEventId: row.session_event_id
      ? String(row.session_event_id)
      : undefined,
    type: String(row.type) as MemoryCandidate["type"],
    content: String(row.content),
    importance: Number(row.importance ?? 3),
    tags: parseList(row.tags),
    sourceAgent: row.source_agent
      ? (String(row.source_agent) as MemoryCandidate["sourceAgent"])
      : undefined,
    status: String(row.status) as MemoryCandidate["status"],
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
  };
}

export function toTaskLane(row: Row): TaskLane {
  return {
    taskId: String(row.task_id),
    mode: String(row.mode) as TaskLane["mode"],
    baseRef: row.base_ref ? String(row.base_ref) : undefined,
    baseCommit: row.base_commit ? String(row.base_commit) : undefined,
    worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
    status: String(row.status) as TaskLane["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toFileLease(row: Row): FileLease {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    agent: row.agent ? (String(row.agent) as FileLease["agent"]) : undefined,
    path: String(row.path),
    mode: String(row.mode) as FileLease["mode"],
    baseHash: row.base_hash ? String(row.base_hash) : undefined,
    currentHash: row.current_hash ? String(row.current_hash) : undefined,
    expiresAt: String(row.expires_at),
    releasedAt: row.released_at ? String(row.released_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toTaskChange(row: Row): TaskChange {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    path: String(row.path),
    changeType: String(row.change_type) as TaskChange["changeType"],
    baseHash: row.base_hash ? String(row.base_hash) : undefined,
    currentHash: row.current_hash ? String(row.current_hash) : undefined,
    diffSummary: row.diff_summary ? String(row.diff_summary) : undefined,
    status: String(row.status) as TaskChange["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toAgentRequest(row: Row): AgentRequest {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    agent: row.agent ? (String(row.agent) as AgentRequest["agent"]) : undefined,
    type: String(row.type) as AgentRequest["type"],
    title: String(row.title),
    payload: row.payload ? String(row.payload) : undefined,
    status: String(row.status) as AgentRequest["status"],
    response: row.response ? String(row.response) : undefined,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
  };
}

export function toRegisteredAgent(row: Row): RegisteredAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    provider: String(row.provider) as RegisteredAgent["provider"],
    mode: String(row.mode) as RegisteredAgent["mode"],
    command: row.command ? String(row.command) : undefined,
    baseUrl: row.base_url ? String(row.base_url) : undefined,
    model: row.model ? String(row.model) : undefined,
    reasoningEffort: row.reasoning_effort
      ? String(row.reasoning_effort)
      : undefined,
    credentialRef: row.credential_ref ? String(row.credential_ref) : undefined,
    capabilities: parseList(row.capabilities),
    presetKey: row.preset_key ? String(row.preset_key) : undefined,
    presetSelected: Number(row.preset_selected ?? 1) === 1,
    presetHidden: Number(row.preset_hidden ?? 0) === 1,
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toCredentialRef(row: Row): CredentialRef {
  return {
    id: String(row.id),
    provider: String(row.provider),
    kind: String(row.kind) as CredentialRef["kind"],
    ref: String(row.ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toWorkforceRole(row: Row): WorkforceRole {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    permissions: parseList(row.permissions),
    defaultPrompt: row.default_prompt ? String(row.default_prompt) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toWorkforce(row: Row): Workforce {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    defaultLeaderAssignmentId: row.default_leader_assignment_id
      ? String(row.default_leader_assignment_id)
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toWorkforceMember(row: Row): WorkforceMember {
  return {
    id: String(row.id),
    workforceId: String(row.workforce_id),
    agentId: String(row.agent_id),
    roleId: String(row.role_id),
    priority: Number(row.priority ?? 3),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toSubtask(row: Row): Subtask {
  return {
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    title: String(row.title),
    goal: row.goal ? String(row.goal) : undefined,
    status: String(row.status) as Subtask["status"],
    statusReason: row.status_reason ? String(row.status_reason) : undefined,
    priority: Number(row.priority ?? 3),
    dependsOn: parseList(row.depends_on),
    acceptanceCriteria: parseList(row.acceptance_criteria),
    createdByAssignmentId: row.created_by_assignment_id
      ? String(row.created_by_assignment_id)
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function normalizeSubtaskStatusReason(
  status: SubtaskStatus,
  reason?: string,
): string | undefined {
  if (status !== "blocked" && status !== "cancelled") return undefined;
  const fallback =
    status === "blocked"
      ? "Blocked without a recorded reason."
      : "Cancelled without a recorded reason.";
  const flat = (reason?.trim() || fallback).replace(/\s+/g, " ");
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

export function toAssignment(row: Row): Assignment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    subtaskId: row.subtask_id ? String(row.subtask_id) : undefined,
    workforceId: row.workforce_id ? String(row.workforce_id) : undefined,
    agentId: String(row.agent_id),
    roleId: String(row.role_id),
    status: String(row.status) as Assignment["status"],
    prompt: String(row.prompt),
    resultSummary: row.result_summary ? String(row.result_summary) : undefined,
    testSummary: row.test_summary ? String(row.test_summary) : undefined,
    riskSummary: row.risk_summary ? String(row.risk_summary) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toDispatchRun(row: Row): DispatchRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    workforceId: row.workforce_id ? String(row.workforce_id) : undefined,
    status: String(row.status) as DispatchRun["status"],
    mode: String(row.mode) as DispatchRun["mode"],
    planSummary: row.plan_summary ? String(row.plan_summary) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toAgentRun(row: Row): AgentRun {
  return {
    id: String(row.id),
    orchestrationId: row.orchestration_id
      ? String(row.orchestration_id)
      : undefined,
    taskId: String(row.task_id),
    subtaskId: row.subtask_id ? String(row.subtask_id) : undefined,
    assignmentId: row.assignment_id ? String(row.assignment_id) : undefined,
    workforceId: row.workforce_id ? String(row.workforce_id) : undefined,
    agentId: String(row.agent_id),
    roleId: row.role_id ? String(row.role_id) : undefined,
    cycle: row.cycle == null ? undefined : Number(row.cycle),
    origin: String(row.origin) as AgentRun["origin"],
    pid: row.pid == null ? undefined : Number(row.pid),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    provider: row.provider ? String(row.provider) : undefined,
    model: row.model ? String(row.model) : undefined,
    reasoningEffort: row.reasoning_effort
      ? String(row.reasoning_effort)
      : undefined,
    command: row.command ? String(row.command) : undefined,
    cwd: row.cwd ? String(row.cwd) : undefined,
    logPath: row.log_path ? String(row.log_path) : undefined,
    status: String(row.status) as AgentRun["status"],
    phase: row.phase ? (String(row.phase) as AgentRun["phase"]) : undefined,
    progressPercent:
      row.progress_percent == null ? undefined : Number(row.progress_percent),
    progressNote: row.progress_note ? String(row.progress_note) : undefined,
    restartedFromRunId: row.restarted_from_run_id
      ? String(row.restarted_from_run_id)
      : undefined,
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined,
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toOrchestration(row: Row): Orchestration {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    workforceId: row.workforce_id ? String(row.workforce_id) : undefined,
    leaderAgentId: String(row.leader_agent_id),
    status: normalizeOrchestrationStatus(row.status),
    autonomy: String(row.autonomy) as Orchestration["autonomy"],
    cycle: Number(row.cycle ?? 0),
    maxCycles: Number(row.max_cycles ?? 8),
    maxParallel: Number(row.max_parallel ?? 3),
    // 0 is a real setting ("never stop to ask"), so only NULL falls back.
    maxQuestionRounds:
      row.max_question_rounds === null || row.max_question_rounds === undefined
        ? undefined
        : Number(row.max_question_rounds),
    complexity: row.complexity ? String(row.complexity) : undefined,
    planPath: row.plan_path ? String(row.plan_path) : undefined,
    reportPath: row.report_path ? String(row.report_path) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// Stored as a JSON array. A hand-edited or truncated value must not take the
// whole orchestration row down with it — an unreadable restriction is treated
// as no restriction.
export function parseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return items.length ? items : undefined;
  } catch {
    return undefined;
  }
}

// `_` and `%` in a caller-supplied prefix are literal, not wildcards.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

export function toOrchestrationEvent(row: Row): OrchestrationEvent {
  return {
    id: String(row.id),
    orchestrationId: String(row.orchestration_id),
    cycle: Number(row.cycle ?? 0),
    phase: String(row.phase),
    kind: String(row.kind) as OrchestrationEvent["kind"],
    summary: row.summary ? String(row.summary) : undefined,
    payload: row.payload ? String(row.payload) : undefined,
    createdAt: String(row.created_at),
  };
}

export function toReview(row: Row): Review {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    subtaskId: row.subtask_id ? String(row.subtask_id) : undefined,
    reviewerAssignmentId: row.reviewer_assignment_id
      ? String(row.reviewer_assignment_id)
      : undefined,
    targetAssignmentId: row.target_assignment_id
      ? String(row.target_assignment_id)
      : undefined,
    verdict: String(row.verdict) as Review["verdict"],
    score: row.score == null ? undefined : Number(row.score),
    summary: String(row.summary),
    findings: row.findings ? String(row.findings) : undefined,
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
  };
}
export function toHandoff(row: Row): Handoff {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    fromAgent: row.from_agent
      ? (String(row.from_agent) as Handoff["fromAgent"])
      : undefined,
    summary: String(row.summary),
    done: parseList(row.done),
    next: parseList(row.next),
    risks: parseList(row.risks),
    filesChanged: parseList(row.files_changed),
    createdAt: String(row.created_at),
    auto: Number(row.auto) === 1,
  };
}

export function toGraphNode(row: Row): GraphNode {
  return {
    id: String(row.id),
    kind: String(row.kind) as GraphNode["kind"],
    path: String(row.path),
    name: row.name ? String(row.name) : undefined,
    language: row.language ? String(row.language) : undefined,
    symbolKind: row.symbol_kind ? String(row.symbol_kind) : undefined,
    line: row.line != null ? Number(row.line) : undefined,
    signature: row.signature ? String(row.signature) : undefined,
    contentHash: row.content_hash ? String(row.content_hash) : undefined,
  };
}

export type GraphStats = {
  files: number;
  symbols: number;
  edges: number;
  internalEdges: number;
  externalEdges: number;
};
