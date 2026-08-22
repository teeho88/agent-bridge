import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./migrations.js";
import { foldDiacritics } from "./text-normalize.js";
import {
  clusterBySimilarity,
  DEFAULT_DEDUPE_THRESHOLD,
  PROTECTED_TYPES,
  selectEvictions,
  similarity,
} from "./lifecycle.js";
import {
  decodeVector,
  encodeVector,
  hybridRank,
  type EmbeddingProvider,
  type HybridCandidate,
  type HybridWeights,
} from "./embeddings.js";
import type { ExtractedGraph, GraphNode, RepoMapFile } from "./graph.js";
import type { MemoryStore } from "./memory-store.js";
import type {
  AddMemoryInput,
  UpdateMemoryInput,
  AgentRun,
  AgentRunStatus,
  CreateAgentRunInput,
  UpdateAgentRunInput,
  Orchestration,
  OrchestrationStatus,
  CreateOrchestrationInput,
  UpdateOrchestrationInput,
  OrchestrationEvent,
  OrchestrationEventKind,
  RecordOrchestrationEventInput,
  Review,
  CreateReviewInput,
  WorkforceRole,
  WorkforceMember,
  Workforce,
  UpdateSubtaskInput,
  UpdateRegisteredAgentInput,
  UpdateDispatchRunInput,
  UpdateAssignmentInput,
  SubtaskStatus,
  Subtask,
  RegisteredAgent,
  DispatchRunStatus,
  DispatchRun,
  CreateWorkforceRoleInput,
  UpdateWorkforceRoleInput,
  CreateWorkforceInput,
  UpdateWorkforceInput,
  CreateSubtaskInput,
  CreateRegisteredAgentInput,
  CreateDispatchRunInput,
  CreateCredentialRefInput,
  CredentialRef,
  CreateAssignmentInput,
  Assignment,
  AddWorkforceMemberInput,
  AcquireFileLeaseInput,
  AcquireFileLeaseResult,
  AgentRequest,
  AgentRequestStatus,
  CreateMemoryCandidateInput,
  CreateAgentRequestInput,
  CreateHandoffInput,
  UpdateHandoffInput,
  CreateTaskInput,
  Decision,
  FileLease,
  FileSummary,
  Handoff,
  Memory,
  MemoryCandidate,
  RecordSessionEventInput,
  RunRecord,
  SessionEvent,
  Task,
  TaskChange,
  TaskLane,
  UpdateTaskInput,
  UpsertFileSummaryInput,
  UpsertTaskChangeInput,
  UpsertTaskLaneInput,
} from "./types.js";
import { FINISHED_ORCHESTRATION_STATUSES } from "./types.js";

type Row = Record<string, unknown>;

export type ConsolidationCluster = {
  representativeId: string;
  representativeContent: string;
  supersededIds: string[];
};

export type ConsolidationResult = {
  clusters: ConsolidationCluster[];
  supersededCount: number;
};

function now(): string {
  return new Date().toISOString();
}

function slug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "task"}-${randomUUID().slice(0, 8)}`;
}

function parseList(value: unknown): string[] {
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
// Tokens are space-joined, which FTS5 treats as an implicit AND. Returns
// undefined when there is nothing to match.
function toFtsMatchExpression(query: string): string | undefined {
  const tokens = foldDiacritics(query)
    .split(/\s+/)
    .map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean);
  if (!tokens.length) return undefined;
  return tokens.map((token) => `"${token}"`).join(" ");
}

function toTask(row: Row): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    goal: row.goal ? String(row.goal) : undefined,
    status: String(row.status) as Task["status"],
    ownerAgent: row.owner_agent
      ? (String(row.owner_agent) as Task["ownerAgent"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    type: String(row.type) as Memory["type"],
    content: String(row.content),
    summary: row.summary ? String(row.summary) : undefined,
    importance: Number(row.importance ?? 3),
    tags: parseList(row.tags),
    sourceAgent: row.source_agent
      ? (String(row.source_agent) as Memory["sourceAgent"])
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
  };
}

function toDecision(row: Row): Decision {
  return {
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

function toFileSummary(row: Row): FileSummary {
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

function toRun(row: Row): RunRecord {
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

function toSessionEvent(row: Row): SessionEvent {
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

function toMemoryCandidate(row: Row): MemoryCandidate {
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

function toTaskLane(row: Row): TaskLane {
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

function toFileLease(row: Row): FileLease {
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

function toTaskChange(row: Row): TaskChange {
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

function toAgentRequest(row: Row): AgentRequest {
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

function toRegisteredAgent(row: Row): RegisteredAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    provider: String(row.provider) as RegisteredAgent["provider"],
    mode: String(row.mode) as RegisteredAgent["mode"],
    command: row.command ? String(row.command) : undefined,
    baseUrl: row.base_url ? String(row.base_url) : undefined,
    model: row.model ? String(row.model) : undefined,
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : undefined,
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

function toCredentialRef(row: Row): CredentialRef {
  return {
    id: String(row.id),
    provider: String(row.provider),
    kind: String(row.kind) as CredentialRef["kind"],
    ref: String(row.ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toWorkforceRole(row: Row): WorkforceRole {
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

function toWorkforce(row: Row): Workforce {
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

function toWorkforceMember(row: Row): WorkforceMember {
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

function toSubtask(row: Row): Subtask {
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

function normalizeSubtaskStatusReason(status: SubtaskStatus, reason?: string): string | undefined {
  if (status !== "blocked" && status !== "cancelled") return undefined;
  const fallback = status === "blocked" ? "Blocked without a recorded reason." : "Cancelled without a recorded reason.";
  const flat = (reason?.trim() || fallback).replace(/\s+/g, " ");
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

function toAssignment(row: Row): Assignment {
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

function toDispatchRun(row: Row): DispatchRun {
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

function toAgentRun(row: Row): AgentRun {
  return {
    id: String(row.id),
    orchestrationId: row.orchestration_id ? String(row.orchestration_id) : undefined,
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
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : undefined,
    command: row.command ? String(row.command) : undefined,
    cwd: row.cwd ? String(row.cwd) : undefined,
    logPath: row.log_path ? String(row.log_path) : undefined,
    status: String(row.status) as AgentRun["status"],
    phase: row.phase ? (String(row.phase) as AgentRun["phase"]) : undefined,
    progressPercent: row.progress_percent == null ? undefined : Number(row.progress_percent),
    progressNote: row.progress_note ? String(row.progress_note) : undefined,
    restartedFromRunId: row.restarted_from_run_id ? String(row.restarted_from_run_id) : undefined,
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined,
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toOrchestration(row: Row): Orchestration {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    workforceId: row.workforce_id ? String(row.workforce_id) : undefined,
    leaderAgentId: String(row.leader_agent_id),
    status: String(row.status) as Orchestration["status"],
    autonomy: String(row.autonomy) as Orchestration["autonomy"],
    cycle: Number(row.cycle ?? 0),
    maxCycles: Number(row.max_cycles ?? 8),
    maxParallel: Number(row.max_parallel ?? 3),
    // 0 is a real setting ("never stop to ask"), so only NULL falls back.
    maxQuestionRounds: row.max_question_rounds === null || row.max_question_rounds === undefined
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
function parseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return items.length ? items : undefined;
  } catch {
    return undefined;
  }
}

// `_` and `%` in a caller-supplied prefix are literal, not wildcards.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => "\\" + match);
}

function toOrchestrationEvent(row: Row): OrchestrationEvent {
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

function toReview(row: Row): Review {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    subtaskId: row.subtask_id ? String(row.subtask_id) : undefined,
    reviewerAssignmentId: row.reviewer_assignment_id ? String(row.reviewer_assignment_id) : undefined,
    targetAssignmentId: row.target_assignment_id ? String(row.target_assignment_id) : undefined,
    verdict: String(row.verdict) as Review["verdict"],
    score: row.score == null ? undefined : Number(row.score),
    summary: String(row.summary),
    findings: row.findings ? String(row.findings) : undefined,
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
  };
}
function toHandoff(row: Row): Handoff {
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

function toGraphNode(row: Row): GraphNode {
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

// Tunable memory-pool behaviour. Any field left undefined falls back to the
// DEFAULT_* constants in lifecycle.ts. Typically sourced from project config.
export type LifecycleConfig = {
  dedupeThreshold?: number;
  consolidateThreshold?: number;
  minClusterSize?: number;
  decayHalfLifeDays?: number;
  maxPoolSize?: number;
  hybrid?: HybridWeights;
};

export type SQLiteMemoryStoreOptions = {
  // Optional semantic-search provider. When set, reindexEmbeddings()/
  // semanticSearch() are usable; when absent, the store is purely lexical.
  embeddingProvider?: EmbeddingProvider;
  lifecycle?: LifecycleConfig;
};

export class SQLiteMemoryStore implements MemoryStore {
  private db: Database.Database;
  private embeddingProvider?: EmbeddingProvider;
  private lifecycle: LifecycleConfig;

  constructor(databasePath: string, options: SQLiteMemoryStoreOptions = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    runMigrations(this.db);
    this.embeddingProvider = options.embeddingProvider;
    this.lifecycle = options.lifecycle ?? {};
  }

  close(): void {
    this.db.close();
  }

  createTask(input: CreateTaskInput): Task {
    const timestamp = now();
    const task: Task = {
      id: slug(input.title),
      title: input.title,
      goal: input.goal,
      status: "todo",
      ownerAgent: input.ownerAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, goal, status, owner_agent, created_at, updated_at)
         VALUES (@id, @title, @goal, @status, @ownerAgent, @createdAt, @updatedAt)`,
      )
      .run(task);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toTask(row) : undefined;
  }

  updateTaskStatus(id: string, status: Task["status"]): Task | undefined {
    const updatedAt = now();
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    return this.getTask(id);
  }

  updateTask(id: string, input: UpdateTaskInput): Task | undefined {
    const current = this.getTask(id);
    if (!current) return undefined;
    const next = {
      id,
      title: input.title ?? current.title,
      goal: input.goal ?? current.goal,
      status: input.status ?? current.status,
      ownerAgent: input.ownerAgent ?? current.ownerAgent,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE tasks
         SET title = @title, goal = @goal, status = @status, owner_agent = @ownerAgent, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run(next);
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const exists = Boolean(this.getTask(id));
    if (!exists) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memories WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM decisions WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM handoffs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
      this.db
        .prepare("DELETE FROM memory_candidates WHERE task_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM session_events WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM assignments WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM dispatch_runs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM subtasks WHERE parent_task_id = ?").run(id);
      this.db.prepare("DELETE FROM task_lanes WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM file_leases WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM task_changes WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM agent_requests WHERE task_id = ?").run(id);
      // These also carry a task_id FK, so leaving them behind makes deleting
      // any orchestrated task fail outright with a raw "FOREIGN KEY
      // constraint failed" — which is every task the Orchestrator tab
      // creates. orchestration_events hangs off orchestrations rather than
      // off the task, so it has to go before its parent row.
      this.db.prepare("DELETE FROM reviews WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM agent_runs WHERE task_id = ?").run(id);
      this.db
        .prepare(
          "DELETE FROM orchestration_events WHERE orchestration_id IN (SELECT id FROM orchestrations WHERE task_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM orchestrations WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  listTasks(limit = 20): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as Row[]
    ).map(toTask);
  }

  addMemory(input: AddMemoryInput): Memory {
    if (input.dedupe !== false) {
      const merged = this.tryMergeDuplicate(input);
      if (merged) return merged;
    }

    const timestamp = now();
    const memory: Memory = {
      id: `mem-${randomUUID()}`,
      taskId: input.taskId,
      type: input.type,
      content: input.content,
      summary: input.summary,
      importance: input.importance ?? 3,
      tags: input.tags ?? [],
      sourceAgent: input.sourceAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO memories
         (id, task_id, type, content, summary, importance, tags, source_agent, created_at, updated_at)
         VALUES (@id, @taskId, @type, @content, @summary, @importance, @tags, @sourceAgent, @createdAt, @updatedAt)`,
      )
      .run({ ...memory, tags: JSON.stringify(memory.tags) });
    return memory;
  }

  updateRepoMemory(id: string, input: UpdateMemoryInput): Memory | undefined {
    const current = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND task_id IS NULL")
      .get(id) as Row | undefined;
    if (!current) return undefined;

    const memory = toMemory(current);
    const updated: Memory = {
      ...memory,
      type: input.type ?? memory.type,
      content: input.content ?? memory.content,
      summary: input.summary ?? memory.summary,
      importance: input.importance ?? memory.importance,
      tags: input.tags ?? memory.tags,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE memories
         SET type = @type, content = @content, summary = @summary,
             importance = @importance, tags = @tags, updated_at = @updatedAt
         WHERE id = @id AND task_id IS NULL`,
      )
      .run({
        ...updated,
        summary: updated.summary ?? null,
        tags: JSON.stringify(updated.tags),
      });
    return updated;
  }

  deleteRepoMemory(id: string): boolean {
    return this.db
      .prepare("DELETE FROM memories WHERE id = ? AND task_id IS NULL")
      .run(id).changes > 0;
  }

  // Maintain one visible "latest state" memory per task/source/type. Existing
  // rows with the marker tag are updated in place; older duplicate state rows
  // are superseded so compile/search only sees the current value.
  upsertLatestMemory(
    input: AddMemoryInput,
    options: {
      latestTag: string;
      legacyContentPrefix?: string;
      staleImportance?: number;
    },
  ): Memory {
    const timestamp = now();
    const tags = Array.from(
      new Set([...(input.tags ?? []), options.latestTag]),
    );
    const taskFilter = input.taskId ? "task_id = @taskId" : "task_id IS NULL";
    const sourceFilter = input.sourceAgent
      ? "source_agent = @sourceAgent"
      : "source_agent IS NULL";
    const legacyFilter = options.legacyContentPrefix
      ? "OR content LIKE @legacyPattern"
      : "";
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE type = @type AND ${taskFilter} AND ${sourceFilter} AND superseded_by IS NULL
           AND (tags LIKE @tagPattern ${legacyFilter})
           ORDER BY updated_at DESC, created_at DESC`,
        )
        .all({
          type: input.type,
          taskId: input.taskId ?? null,
          sourceAgent: input.sourceAgent ?? null,
          tagPattern: `%"${options.latestTag}"%`,
          legacyPattern: `${options.legacyContentPrefix ?? ""}%`,
        }) as Row[]
    ).map(toMemory);

    if (!rows.length) {
      return this.addMemory({ ...input, tags, dedupe: false });
    }

    const current = rows[0];
    const updated: Memory = {
      ...current,
      content: input.content,
      summary: input.summary,
      importance: input.importance ?? 3,
      tags,
      sourceAgent: input.sourceAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE memories
           SET content = @content, summary = @summary, importance = @importance, tags = @tags,
               source_agent = @sourceAgent, created_at = @createdAt, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id: updated.id,
          content: updated.content,
          summary: updated.summary ?? null,
          importance: updated.importance,
          tags: JSON.stringify(updated.tags),
          sourceAgent: updated.sourceAgent ?? null,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        });

      const stale = rows.slice(1);
      if (stale.length) {
        const mark = this.db.prepare(
          "UPDATE memories SET superseded_by = ?, importance = ?, updated_at = ? WHERE id = ?",
        );
        for (const memory of stale) {
          mark.run(
            updated.id,
            options.staleImportance ?? 1,
            timestamp,
            memory.id,
          );
        }
      }
    });
    tx();
    return updated;
  }

  // Find a near-identical existing memory (same task + type) and merge into it
  // instead of inserting a duplicate. Keeps the longer content, the higher
  // importance, the union of tags, and bumps updated_at. Returns the merged
  // memory, or undefined when nothing is similar enough.
  private tryMergeDuplicate(input: AddMemoryInput): Memory | undefined {
    const candidates = (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE type = @type AND superseded_by IS NULL
           AND (task_id = @taskId OR (@taskId IS NULL AND task_id IS NULL))`,
        )
        .all({ type: input.type, taskId: input.taskId ?? null }) as Row[]
    ).map(toMemory);

    let best: Memory | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = similarity(input.content, candidate.content);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    const threshold =
      this.lifecycle.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
    if (!best || bestScore < threshold) return undefined;

    const merged: Memory = {
      ...best,
      content:
        input.content.length > best.content.length
          ? input.content
          : best.content,
      summary: best.summary ?? input.summary,
      importance: Math.max(best.importance, input.importance ?? 3),
      tags: Array.from(new Set([...best.tags, ...(input.tags ?? [])])),
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE memories
         SET content = @content, summary = @summary, importance = @importance, tags = @tags, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: merged.id,
        content: merged.content,
        summary: merged.summary ?? null,
        importance: merged.importance,
        tags: JSON.stringify(merged.tags),
        updatedAt: merged.updatedAt,
      });
    return merged;
  }

  // Evict low-value memories so the pool fits within maxPoolSize. Protected
  // types (constraint/decision/handoff) are never evicted. Returns the evicted
  // memories; with dryRun, computes the selection without deleting.
  pruneMemories(
    options: {
      maxPoolSize?: number;
      nowMs?: number;
      halfLifeDays?: number;
      dryRun?: boolean;
    } = {},
  ): Memory[] {
    const all = (this.db.prepare("SELECT * FROM memories").all() as Row[]).map(
      toMemory,
    );
    const victimIds = selectEvictions(all, {
      maxPoolSize: options.maxPoolSize ?? this.lifecycle.maxPoolSize,
      nowMs: options.nowMs ?? Date.parse(now()),
      halfLifeDays: options.halfLifeDays ?? this.lifecycle.decayHalfLifeDays,
    });
    const byId = new Map(all.map((memory) => [memory.id, memory]));
    const victims = victimIds
      .map((id) => byId.get(id))
      .filter((memory): memory is Memory => Boolean(memory));
    if (!options.dryRun && victims.length) {
      const remove = this.db.prepare("DELETE FROM memories WHERE id = ?");
      const tx = this.db.transaction(() => {
        for (const id of victimIds) remove.run(id);
      });
      tx();
    }
    return victims;
  }

  // Group a task's related memories into clusters and replace each cluster with
  // a single representative memory, marking the originals as superseded (kept in
  // the DB for history, hidden from compile/search). Protected types are left
  // untouched. With dryRun, returns the plan without writing.
  consolidateMemories(options: {
    taskId: string;
    threshold?: number;
    minClusterSize?: number;
    dryRun?: boolean;
  }): ConsolidationResult {
    const memories = this.listMemoriesForTask(options.taskId, 1000).filter(
      (memory) => !PROTECTED_TYPES.has(memory.type),
    );

    const byType = new Map<Memory["type"], Memory[]>();
    for (const memory of memories) {
      const group = byType.get(memory.type) ?? [];
      group.push(memory);
      byType.set(memory.type, group);
    }

    const plans: Array<{
      type: Memory["type"];
      content: string;
      importance: number;
      tags: string[];
      members: Memory[];
    }> = [];
    for (const [type, group] of byType) {
      // Stable seed order (oldest first) for deterministic clustering.
      const ordered = [...group].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const threshold =
        options.threshold ?? this.lifecycle.consolidateThreshold;
      const minClusterSize =
        options.minClusterSize ?? this.lifecycle.minClusterSize;
      for (const cluster of clusterBySimilarity(
        ordered,
        threshold,
        minClusterSize,
      )) {
        const seen = new Set<string>();
        const parts: string[] = [];
        for (const member of cluster) {
          const key = foldDiacritics(member.content)
            .replace(/\s+/g, " ")
            .trim();
          if (seen.has(key)) continue;
          seen.add(key);
          parts.push(member.content.trim());
        }
        plans.push({
          type,
          content: parts.join("; "),
          importance: Math.max(...cluster.map((member) => member.importance)),
          tags: Array.from(new Set(cluster.flatMap((member) => member.tags))),
          members: cluster,
        });
      }
    }

    if (options.dryRun) {
      return {
        clusters: plans.map((plan) => ({
          representativeId: "(dry-run)",
          representativeContent: plan.content,
          supersededIds: plan.members.map((member) => member.id),
        })),
        supersededCount: plans.reduce(
          (total, plan) => total + plan.members.length,
          0,
        ),
      };
    }

    const clusters: ConsolidationCluster[] = [];
    let supersededCount = 0;
    const tx = this.db.transaction(() => {
      const mark = this.db.prepare(
        "UPDATE memories SET superseded_by = ? WHERE id = ?",
      );
      for (const plan of plans) {
        const representative = this.addMemory({
          taskId: options.taskId,
          type: plan.type,
          content: plan.content,
          importance: plan.importance,
          tags: plan.tags,
          dedupe: false,
        });
        for (const member of plan.members) {
          mark.run(representative.id, member.id);
          supersededCount += 1;
        }
        clusters.push({
          representativeId: representative.id,
          representativeContent: representative.content,
          supersededIds: plan.members.map((member) => member.id),
        });
      }
    });
    tx();
    return { clusters, supersededCount };
  }

  hasEmbeddingProvider(): boolean {
    return Boolean(this.embeddingProvider);
  }

  // Backfill embeddings for memories that lack them (skips superseded). Requires
  // a provider; returns the number of memories embedded.
  async reindexEmbeddings(options: { taskId?: string } = {}): Promise<number> {
    if (!this.embeddingProvider) {
      throw new Error(
        "No embedding provider configured. Set AGENT_BRIDGE_EMBEDDING_MODULE.",
      );
    }
    const taskFilter = options.taskId ? "AND task_id = @taskId" : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE embedding IS NULL AND superseded_by IS NULL ${taskFilter}`,
      )
      .all({ taskId: options.taskId }) as Row[];

    const update = this.db.prepare(
      "UPDATE memories SET embedding = @embedding WHERE id = @id",
    );
    let count = 0;
    for (const row of rows) {
      const memory = toMemory(row);
      const vector = await this.embeddingProvider.embed(
        memory.summary || memory.content,
      );
      update.run({ id: memory.id, embedding: encodeVector(vector) });
      count += 1;
    }
    return count;
  }

  // Hybrid retrieval: blends bm25 with vector cosine. Candidate pool is the
  // union of bm25 hits and every embedded memory (so semantically-related
  // memories surface even with no shared keywords). Falls back to plain
  // searchMemories when no provider is configured.
  async semanticSearch(
    query: string,
    options: { taskId?: string; limit?: number; weights?: HybridWeights } = {},
  ): Promise<Memory[]> {
    const limit = options.limit ?? 20;
    if (!this.embeddingProvider)
      return this.searchMemories(query, { taskId: options.taskId, limit });

    const lexical = this.searchMemories(query, {
      taskId: options.taskId,
      limit: Math.max(limit * 4, 50),
    });
    const rankById = new Map(
      lexical.map((memory, index) => [memory.id, index]),
    );

    const taskFilter = options.taskId ? "AND task_id = @taskId" : "";
    const embeddedRows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE embedding IS NOT NULL AND superseded_by IS NULL ${taskFilter}`,
      )
      .all({ taskId: options.taskId }) as Row[];

    const byId = new Map<string, { memory: Memory; vector?: number[] }>();
    for (const memory of lexical) byId.set(memory.id, { memory });
    for (const row of embeddedRows) {
      const memory = toMemory(row);
      byId.set(memory.id, {
        memory,
        vector: decodeVector(row.embedding as Buffer),
      });
    }

    const queryVector = await this.embeddingProvider.embed(query);
    const candidates: Array<HybridCandidate<Memory>> = Array.from(
      byId.values(),
    ).map((entry) => ({
      item: entry.memory,
      bm25Rank: rankById.get(entry.memory.id) ?? Number.POSITIVE_INFINITY,
      vector: entry.vector,
    }));

    return hybridRank(
      candidates,
      queryVector,
      options.weights ?? this.lifecycle.hybrid,
    ).slice(0, limit);
  }

  searchMemories(
    query: string,
    options: { taskId?: string; limit?: number } = {},
  ): Memory[] {
    const limit = options.limit ?? 20;
    const matchExpr = toFtsMatchExpression(query);

    // No usable search terms: fall back to importance/recency ordering.
    if (!matchExpr) {
      const taskFilter = options.taskId ? "AND task_id = @taskId" : "";
      const rows = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE superseded_by IS NULL
           ${taskFilter}
           ORDER BY importance DESC, created_at DESC
           LIMIT @limit`,
        )
        .all({ taskId: options.taskId, limit }) as Row[];
      return rows.map(toMemory);
    }

    const taskFilter = options.taskId ? "AND m.task_id = @taskId" : "";
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.mem_id
         WHERE memories_fts MATCH @matchExpr
         AND m.superseded_by IS NULL
         ${taskFilter}
         ORDER BY bm25(memories_fts) ASC, m.importance DESC, m.created_at DESC
         LIMIT @limit`,
      )
      .all({ matchExpr, taskId: options.taskId, limit }) as Row[];

    return rows.map(toMemory);
  }

  // Single query path for both the history view (`memory list`/`export`, which
  // includes superseded memories) and the compile view (listMemoriesForTask,
  // which hides them). Task-scoped queries order by importance then recency;
  // cross-task queries order by recency.
  listMemories(
    options: {
      taskId?: string;
      limit?: number;
      includeSuperseded?: boolean;
    } = {},
  ): Memory[] {
    const limit = options.limit ?? 100;
    const includeSuperseded = options.includeSuperseded ?? true;
    const filters: string[] = [];
    if (options.taskId) filters.push("task_id = @taskId");
    if (!includeSuperseded) filters.push("superseded_by IS NULL");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const orderBy = options.taskId
      ? "importance DESC, created_at DESC"
      : "created_at DESC";
    return (
      this.db
        .prepare(
          `SELECT * FROM memories ${where} ORDER BY ${orderBy} LIMIT @limit`,
        )
        .all({ taskId: options.taskId, limit }) as Row[]
    ).map(toMemory);
  }

  listMemoriesForTask(taskId: string, limit = 50): Memory[] {
    return this.listMemories({ taskId, limit, includeSuperseded: false });
  }

  listRepoMemories(limit = 50): Memory[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE task_id IS NULL AND superseded_by IS NULL
           ORDER BY importance DESC, created_at DESC
           LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(toMemory);
  }

  recordSessionEvent(input: RecordSessionEventInput): SessionEvent {
    const event: SessionEvent = {
      id: `event-${randomUUID()}`,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agent: input.agent,
      kind: input.kind,
      summary: input.summary,
      createdAt: input.createdAt ?? now(),
    };
    this.db
      .prepare(
        `INSERT INTO session_events (id, session_id, task_id, agent, kind, summary, created_at)
         VALUES (@id, @sessionId, @taskId, @agent, @kind, @summary, @createdAt)`,
      )
      .run({
        ...event,
        taskId: event.taskId ?? null,
        agent: event.agent ?? null,
        summary: event.summary ?? null,
      });
    return event;
  }

  listSessionEvents(
    options: { taskId?: string; sessionId?: string; limit?: number } = {},
  ): SessionEvent[] {
    const filters: string[] = [];
    if (options.taskId) filters.push("task_id = @taskId");
    if (options.sessionId) filters.push("session_id = @sessionId");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM session_events ${where} ORDER BY created_at DESC LIMIT @limit`,
        )
        .all({
          taskId: options.taskId,
          sessionId: options.sessionId,
          limit: options.limit ?? 100,
        }) as Row[]
    ).map(toSessionEvent);
  }

  listActiveSessionEvents(limit = 100): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM session_events e
         WHERE e.id = (
           SELECT latest.id FROM session_events latest
           WHERE latest.session_id = e.session_id
           ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
         )
         AND e.kind NOT IN ('session_ended', 'session_paused', 'stop_requested', 'task_cancelled')
         ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(toSessionEvent);
  }

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    const candidate: MemoryCandidate = {
      id: `candidate-${randomUUID()}`,
      taskId: input.taskId,
      sessionEventId: input.sessionEventId,
      type: input.type,
      content: input.content,
      importance: input.importance,
      tags: input.tags,
      sourceAgent: input.sourceAgent,
      status: "pending",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO memory_candidates
         (id, task_id, session_event_id, type, content, importance, tags, source_agent, status, created_at)
         VALUES (@id, @taskId, @sessionEventId, @type, @content, @importance, @tags, @sourceAgent, @status, @createdAt)`,
      )
      .run({
        ...candidate,
        taskId: candidate.taskId ?? null,
        sessionEventId: candidate.sessionEventId ?? null,
        sourceAgent: candidate.sourceAgent ?? null,
        tags: JSON.stringify(candidate.tags),
      });
    return candidate;
  }

  listMemoryCandidates(
    status: MemoryCandidate["status"] = "pending",
    limit = 100,
  ): MemoryCandidate[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(status, limit) as Row[]
    ).map(toMemoryCandidate);
  }

  reviewMemoryCandidate(
    id: string,
    action: "promote" | "reject",
  ): MemoryCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const candidate = toMemoryCandidate(row);
    if (candidate.status !== "pending") return candidate;
    const reviewedAt = now();
    const status = action === "promote" ? "promoted" : "rejected";
    const tx = this.db.transaction(() => {
      if (action === "promote") {
        this.addMemory({
          type: candidate.type,
          content: candidate.content,
          importance: candidate.importance,
          tags: Array.from(
            new Set([...candidate.tags, "repo-memory", "promoted"]),
          ),
          sourceAgent: candidate.sourceAgent,
        });
      }
      this.db
        .prepare(
          "UPDATE memory_candidates SET status = ?, reviewed_at = ? WHERE id = ?",
        )
        .run(status, reviewedAt, id);
    });
    tx();
    return toMemoryCandidate(
      this.db
        .prepare("SELECT * FROM memory_candidates WHERE id = ?")
        .get(id) as Row,
    );
  }

  listDecisions(taskId: string): Decision[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at DESC",
        )
        .all(taskId) as Row[]
    ).map(toDecision);
  }

  getFileSummary(path: string): FileSummary | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | Row
      | undefined;
    return row ? toFileSummary(row) : undefined;
  }

  listFileSummaries(): FileSummary[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM files ORDER BY manual_priority DESC, updated_at DESC",
        )
        .all() as Row[]
    ).map(toFileSummary);
  }

  createRegisteredAgent(input: CreateRegisteredAgentInput): RegisteredAgent {
    const timestamp = now();
    const agent: RegisteredAgent = {
      id: `agent-${randomUUID()}`,
      name: input.name,
      description: input.description,
      provider: input.provider,
      mode: input.mode,
      command: input.command,
      baseUrl: input.baseUrl,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      credentialRef: input.credentialRef,
      capabilities: input.capabilities ?? [],
      presetKey: input.presetKey,
      presetSelected: input.presetSelected ?? true,
      presetHidden: input.presetHidden ?? false,
      enabled: input.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO agents
         (id, name, description, provider, mode, command, base_url, model, reasoning_effort, credential_ref, capabilities, preset_key, preset_selected, preset_hidden, enabled, created_at, updated_at)
         VALUES (@id, @name, @description, @provider, @mode, @command, @baseUrl, @model, @reasoningEffort, @credentialRef, @capabilities, @presetKey, @presetSelected, @presetHidden, @enabled, @createdAt, @updatedAt)`,
      )
      .run({
        ...agent,
        description: agent.description ?? null,
        command: agent.command ?? null,
        baseUrl: agent.baseUrl ?? null,
        model: agent.model ?? null,
        reasoningEffort: agent.reasoningEffort ?? null,
        credentialRef: agent.credentialRef ?? null,
        capabilities: JSON.stringify(agent.capabilities),
        presetKey: agent.presetKey ?? null,
        presetSelected: agent.presetSelected ? 1 : 0,
        presetHidden: agent.presetHidden ? 1 : 0,
        enabled: agent.enabled ? 1 : 0,
      });
    return agent;
  }

  getRegisteredAgent(id: string): RegisteredAgent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(id) as
      | Row
      | undefined;
    return row ? toRegisteredAgent(row) : undefined;
  }

  listRegisteredAgents(
    options: {
      enabled?: boolean;
      provider?: string;
      includeUnselectedPresets?: boolean;
      includeHiddenPresets?: boolean;
      limit?: number;
    } = {},
  ): RegisteredAgent[] {
    const filters: string[] = ["deleted_at IS NULL"];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.enabled != null) {
      filters.push("enabled = @enabled");
      params.enabled = options.enabled ? 1 : 0;
    }
    if (options.provider) {
      filters.push("provider = @provider");
      params.provider = options.provider;
    }
    if (!options.includeUnselectedPresets) filters.push("preset_selected = 1");
    // A hidden preset was deleted from the default-agent table; its row only
    // survives so the built-in seeding does not resurrect it.
    if (!options.includeHiddenPresets) filters.push("preset_hidden = 0");
    return (
      this.db
        .prepare(
          `SELECT * FROM agents WHERE ${filters.join(" AND ")} ORDER BY enabled DESC, name LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toRegisteredAgent);
  }

  updateRegisteredAgent(
    id: string,
    input: UpdateRegisteredAgentInput,
  ): RegisteredAgent | undefined {
    const current = this.getRegisteredAgent(id);
    if (!current) return undefined;
    // Every field falls back to its current value rather than spreading
    // `input` directly — a caller that includes a key with an explicit
    // `undefined` value (e.g. an unset --name option) must not null it out.
    const next: RegisteredAgent = {
      ...current,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      provider: input.provider ?? current.provider,
      mode: input.mode ?? current.mode,
      command: input.command ?? current.command,
      baseUrl: input.baseUrl ?? current.baseUrl,
      model: input.model ?? current.model,
      reasoningEffort: input.reasoningEffort ?? current.reasoningEffort,
      credentialRef: input.credentialRef ?? current.credentialRef,
      capabilities: input.capabilities ?? current.capabilities,
      presetKey: input.presetKey ?? current.presetKey,
      presetSelected: input.presetSelected ?? current.presetSelected,
      presetHidden: input.presetHidden ?? current.presetHidden,
      enabled: input.enabled ?? current.enabled,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE agents
         SET name = @name, description = @description, provider = @provider, mode = @mode, command = @command,
             base_url = @baseUrl, model = @model, reasoning_effort = @reasoningEffort, credential_ref = @credentialRef,
             capabilities = @capabilities, preset_key = @presetKey, preset_selected = @presetSelected,
             preset_hidden = @presetHidden, enabled = @enabled, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        description: next.description ?? null,
        command: next.command ?? null,
        baseUrl: next.baseUrl ?? null,
        model: next.model ?? null,
        reasoningEffort: next.reasoningEffort ?? null,
        credentialRef: next.credentialRef ?? null,
        capabilities: JSON.stringify(next.capabilities),
        presetKey: next.presetKey ?? null,
        presetSelected: next.presetSelected ? 1 : 0,
        presetHidden: next.presetHidden ? 1 : 0,
        enabled: next.enabled ? 1 : 0,
      });
    return this.getRegisteredAgent(id);
  }

  // Archive instead of physically deleting so historical assignments/agent_runs/
  // orchestrations retain a valid foreign-key target (same pattern as
  // deleteWorkforceRole). The archived name is freed for later reuse.
  deleteRegisteredAgent(id: string): boolean {
    const agent = this.getRegisteredAgent(id);
    if (!agent) return false;
    // Archiving the leader of a run that is still going leaves every step
    // throwing "Registered agent not found", and nothing in the UI could undo
    // it. Point the orchestration at another leader first.
    const leading = this.listOrchestrations({ leaderAgentId: id, limit: 50 }).filter(
      (orchestration) => !FINISHED_ORCHESTRATION_STATUSES.has(orchestration.status),
    );
    if (leading.length) {
      throw new Error(
        `Agent "${agent.name}" is leading ${leading.length} unfinished orchestration(s): ` +
          `${leading.map((orchestration) => orchestration.id).join(", ")}. ` +
          `Change the leader on those orchestrations (or stop them) before deleting this agent.`,
      );
    }
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM workforce_members WHERE agent_id = ?").run(id);
      this.db
        .prepare("UPDATE agents SET name = ?, enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(`${agent.name}__deleted__${id}`, timestamp, timestamp, id);
    });
    tx();
    return true;
  }

  createCredentialRef(input: CreateCredentialRefInput): CredentialRef {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO credential_refs (id, provider, kind, ref, created_at, updated_at)
         VALUES (@id, @provider, @kind, @ref, @createdAt, @updatedAt)
         ON CONFLICT(provider, kind, ref) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run({
        id: `credential-${randomUUID()}`,
        provider: input.provider,
        kind: input.kind,
        ref: input.ref,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare(
        "SELECT * FROM credential_refs WHERE provider = ? AND kind = ? AND ref = ?",
      )
      .get(input.provider, input.kind, input.ref) as Row;
    return toCredentialRef(row);
  }

  listCredentialRefs(provider?: string): CredentialRef[] {
    const where = provider ? "WHERE provider = @provider" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM credential_refs ${where} ORDER BY provider, kind, ref`,
        )
        .all({ provider }) as Row[]
    ).map(toCredentialRef);
  }

  createWorkforceRole(input: CreateWorkforceRoleInput): WorkforceRole {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO roles (id, name, description, permissions, default_prompt, created_at, updated_at)
         VALUES (@id, @name, @description, @permissions, @defaultPrompt, @createdAt, @updatedAt)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           permissions = excluded.permissions,
           default_prompt = excluded.default_prompt,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: `role-${randomUUID()}`,
        name: input.name,
        description: input.description ?? null,
        permissions: JSON.stringify(input.permissions ?? []),
        defaultPrompt: input.defaultPrompt ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db.prepare("SELECT * FROM roles WHERE name = ?").get(input.name) as Row;
    return toWorkforceRole(row);
  }

  listWorkforceRoles(): WorkforceRole[] {
    return (
      this.db.prepare("SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY name").all() as Row[]
    ).map(toWorkforceRole);
  }

  ensureDefaultWorkforceRoles(): WorkforceRole[] {
    const defaults: CreateWorkforceRoleInput[] = [
      { name: "leader", permissions: ["plan", "approve", "merge", "handoff"] },
      { name: "distributor", permissions: ["split", "assign"] },
      { name: "implementer", permissions: ["read", "edit", "test"] },
      { name: "tester", permissions: ["read", "test", "review"] },
      { name: "reviewer", permissions: ["read", "review", "approve"] },
      { name: "researcher", permissions: ["read", "plan"] },
      { name: "integrator", permissions: ["merge", "handoff"] },
      { name: "reporter", permissions: ["report", "read", "handoff"] },
    ];
    for (const role of defaults) this.createWorkforceRole(role);
    return this.listWorkforceRoles();
  }

  getWorkforceRole(id: string): WorkforceRole | undefined {
    const row = this.db.prepare("SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL").get(id) as
      | Row
      | undefined;
    return row ? toWorkforceRole(row) : undefined;
  }

  updateWorkforceRole(
    id: string,
    input: UpdateWorkforceRoleInput,
  ): WorkforceRole | undefined {
    const current = this.getWorkforceRole(id);
    if (!current) return undefined;
    const next: WorkforceRole = {
      ...current,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      permissions: input.permissions ?? current.permissions,
      defaultPrompt: input.defaultPrompt ?? current.defaultPrompt,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE roles
         SET name = @name, description = @description, permissions = @permissions,
             default_prompt = @defaultPrompt, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        name: next.name,
        description: next.description ?? null,
        permissions: JSON.stringify(next.permissions),
        defaultPrompt: next.defaultPrompt ?? null,
        updatedAt: next.updatedAt,
      });
    return this.getWorkforceRole(id);
  }

  // Archive instead of physically deleting so historical assignments retain a
  // valid foreign-key target. The archived name is freed for later reuse.
  deleteWorkforceRole(id: string): boolean {
    const role = this.getWorkforceRole(id);
    if (!role) return false;
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM workforce_members WHERE role_id = ?").run(id);
      this.db.prepare("UPDATE roles SET name = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(`${role.name}__deleted__${id}`, timestamp, timestamp, id);
    });
    tx();
    return true;
  }

  createWorkforce(input: CreateWorkforceInput): Workforce {
    const timestamp = now();
    const workforce: Workforce = {
      id: `workforce-${randomUUID()}`,
      name: input.name,
      description: input.description,
      defaultLeaderAssignmentId: input.defaultLeaderAssignmentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO workforces
         (id, name, description, default_leader_assignment_id, created_at, updated_at)
         VALUES (@id, @name, @description, @defaultLeaderAssignmentId, @createdAt, @updatedAt)`,
      )
      .run({
        ...workforce,
        description: workforce.description ?? null,
        defaultLeaderAssignmentId: workforce.defaultLeaderAssignmentId ?? null,
      });
    return workforce;
  }

  listWorkforces(limit = 100): Workforce[] {
    return (
      this.db
        .prepare("SELECT * FROM workforces ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as Row[]
    ).map(toWorkforce);
  }

  getWorkforce(id: string): Workforce | undefined {
    const row = this.db.prepare("SELECT * FROM workforces WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toWorkforce(row) : undefined;
  }

  updateWorkforce(id: string, input: UpdateWorkforceInput): Workforce | undefined {
    const current = this.getWorkforce(id);
    if (!current) return undefined;
    const next: Workforce = {
      ...current,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      defaultLeaderAssignmentId:
        input.defaultLeaderAssignmentId ?? current.defaultLeaderAssignmentId,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE workforces
         SET name = @name, description = @description,
             default_leader_assignment_id = @defaultLeaderAssignmentId, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        name: next.name,
        description: next.description ?? null,
        defaultLeaderAssignmentId: next.defaultLeaderAssignmentId ?? null,
        updatedAt: next.updatedAt,
      });
    return this.getWorkforce(id);
  }

  // Removes the workforce and its memberships. Existing assignments/dispatch
  // runs keep their history but are unlinked from the deleted workforce
  // (workforce_id set to NULL) rather than deleted — callers already tolerate
  // a workforce id that no longer resolves (see workforce UI rendering).
  // Foreign keys are enforced (see migrations.ts), so these must be cleared
  // before the parent workforces row is removed or the DELETE fails.
  deleteWorkforce(id: string): boolean {
    if (!this.getWorkforce(id)) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE assignments SET workforce_id = NULL WHERE workforce_id = ?").run(id);
      this.db.prepare("UPDATE dispatch_runs SET workforce_id = NULL WHERE workforce_id = ?").run(id);
      this.db.prepare("DELETE FROM workforce_members WHERE workforce_id = ?").run(id);
      this.db.prepare("DELETE FROM workforces WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  addWorkforceMember(input: AddWorkforceMemberInput): WorkforceMember {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO workforce_members
         (id, workforce_id, agent_id, role_id, priority, enabled, created_at, updated_at)
         VALUES (@id, @workforceId, @agentId, @roleId, @priority, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(workforce_id, agent_id, role_id) DO UPDATE SET
           priority = excluded.priority,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: `member-${randomUUID()}`,
        workforceId: input.workforceId,
        agentId: input.agentId,
        roleId: input.roleId,
        priority: input.priority ?? 3,
        enabled: input.enabled ?? true ? 1 : 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare(
        "SELECT * FROM workforce_members WHERE workforce_id = ? AND agent_id = ? AND role_id = ?",
      )
      .get(input.workforceId, input.agentId, input.roleId) as Row;
    return toWorkforceMember(row);
  }

  listWorkforceMembers(workforceId: string): WorkforceMember[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workforce_members WHERE workforce_id = ? ORDER BY enabled DESC, priority DESC, created_at",
        )
        .all(workforceId) as Row[]
    ).map(toWorkforceMember);
  }

  deleteWorkforceMember(id: string): boolean {
    return this.db.prepare("DELETE FROM workforce_members WHERE id = ?").run(id).changes > 0;
  }

  createSubtask(input: CreateSubtaskInput): Subtask {
    const timestamp = now();
    const status = input.status ?? "todo";
    const subtask: Subtask = {
      id: `subtask-${randomUUID()}`,
      parentTaskId: input.parentTaskId,
      title: input.title,
      goal: input.goal,
      status,
      statusReason: normalizeSubtaskStatusReason(status, input.statusReason),
      priority: input.priority ?? 3,
      dependsOn: input.dependsOn ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      createdByAssignmentId: input.createdByAssignmentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO subtasks
         (id, parent_task_id, title, goal, status, status_reason, priority, depends_on, acceptance_criteria, created_by_assignment_id, created_at, updated_at)
         VALUES (@id, @parentTaskId, @title, @goal, @status, @statusReason, @priority, @dependsOn, @acceptanceCriteria, @createdByAssignmentId, @createdAt, @updatedAt)`,
      )
      .run({
        ...subtask,
        goal: subtask.goal ?? null,
        statusReason: subtask.statusReason ?? null,
        dependsOn: JSON.stringify(subtask.dependsOn),
        acceptanceCriteria: JSON.stringify(subtask.acceptanceCriteria),
        createdByAssignmentId: subtask.createdByAssignmentId ?? null,
      });
    return subtask;
  }

  updateSubtask(id: string, input: UpdateSubtaskInput): Subtask | undefined {
    const current = this.getSubtask(id);
    if (!current) return undefined;
    // Every field falls back to its current value rather than spreading
    // `input` directly — a caller that includes a key with an explicit
    // `undefined` value (e.g. `subtask update <id> --status done` without
    // --title) must not null out title and violate its NOT NULL constraint.
    const nextStatus = input.status ?? current.status;
    const reasonInput = input.status && input.status !== current.status
      ? input.statusReason
      : input.statusReason ?? current.statusReason;
    const statusReason = normalizeSubtaskStatusReason(nextStatus, reasonInput);
    const next: Subtask = {
      ...current,
      title: input.title ?? current.title,
      goal: input.goal ?? current.goal,
      status: nextStatus,
      statusReason,
      priority: input.priority ?? current.priority,
      createdByAssignmentId: input.createdByAssignmentId ?? current.createdByAssignmentId,
      dependsOn: input.dependsOn ?? current.dependsOn,
      acceptanceCriteria: input.acceptanceCriteria ?? current.acceptanceCriteria,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE subtasks
         SET title = @title, goal = @goal, status = @status, status_reason = @statusReason, priority = @priority,
             depends_on = @dependsOn, acceptance_criteria = @acceptanceCriteria,
             created_by_assignment_id = @createdByAssignmentId, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        goal: next.goal ?? null,
        statusReason: next.statusReason ?? null,
        dependsOn: JSON.stringify(next.dependsOn),
        acceptanceCriteria: JSON.stringify(next.acceptanceCriteria),
        createdByAssignmentId: next.createdByAssignmentId ?? null,
      });
    return this.getSubtask(id);
  }

  listSubtasks(
    options: { parentTaskId?: string; status?: SubtaskStatus; limit?: number } = {},
  ): Subtask[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.parentTaskId) {
      filters.push("parent_task_id = @parentTaskId");
      params.parentTaskId = options.parentTaskId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM subtasks ${where} ORDER BY priority DESC, updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toSubtask);
  }

  private getSubtask(id: string): Subtask | undefined {
    const row = this.db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toSubtask(row) : undefined;
  }

  createAssignment(input: CreateAssignmentInput): Assignment {
    const timestamp = now();
    const assignment: Assignment = {
      id: `assignment-${randomUUID()}`,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      workforceId: input.workforceId,
      agentId: input.agentId,
      roleId: input.roleId,
      status: input.status ?? "queued",
      prompt: input.prompt,
      resultSummary: input.resultSummary,
      testSummary: input.testSummary,
      riskSummary: input.riskSummary,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO assignments
         (id, task_id, subtask_id, workforce_id, agent_id, role_id, status, prompt, result_summary, test_summary, risk_summary, created_at, updated_at)
         VALUES (@id, @taskId, @subtaskId, @workforceId, @agentId, @roleId, @status, @prompt, @resultSummary, @testSummary, @riskSummary, @createdAt, @updatedAt)`,
      )
      .run({
        ...assignment,
        subtaskId: assignment.subtaskId ?? null,
        workforceId: assignment.workforceId ?? null,
        resultSummary: assignment.resultSummary ?? null,
        testSummary: assignment.testSummary ?? null,
        riskSummary: assignment.riskSummary ?? null,
      });
    return assignment;
  }

  updateAssignment(
    id: string,
    input: UpdateAssignmentInput,
  ): Assignment | undefined {
    const current = this.getAssignment(id);
    if (!current) return undefined;
    // Every field falls back to its current value rather than spreading
    // `input` directly — an explicit `undefined` key must not null out a
    // NOT NULL column (agentId/roleId/prompt/status) or silently clear a
    // nullable one (subtaskId/workforceId) that the caller didn't intend to touch.
    const next: Assignment = {
      ...current,
      subtaskId: input.subtaskId ?? current.subtaskId,
      workforceId: input.workforceId ?? current.workforceId,
      agentId: input.agentId ?? current.agentId,
      roleId: input.roleId ?? current.roleId,
      status: input.status ?? current.status,
      prompt: input.prompt ?? current.prompt,
      resultSummary: input.resultSummary ?? current.resultSummary,
      testSummary: input.testSummary ?? current.testSummary,
      riskSummary: input.riskSummary ?? current.riskSummary,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE assignments
         SET subtask_id = @subtaskId, workforce_id = @workforceId,
             agent_id = @agentId, role_id = @roleId, status = @status,
             prompt = @prompt, result_summary = @resultSummary,
             test_summary = @testSummary, risk_summary = @riskSummary,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        subtaskId: next.subtaskId ?? null,
        workforceId: next.workforceId ?? null,
        resultSummary: next.resultSummary ?? null,
        testSummary: next.testSummary ?? null,
        riskSummary: next.riskSummary ?? null,
      });
    return this.getAssignment(id);
  }

  listAssignments(
    options: {
      taskId?: string;
      subtaskId?: string;
      agentId?: string;
      status?: Assignment["status"];
      limit?: number;
    } = {},
  ): Assignment[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.subtaskId) {
      filters.push("subtask_id = @subtaskId");
      params.subtaskId = options.subtaskId;
    }
    if (options.agentId) {
      filters.push("agent_id = @agentId");
      params.agentId = options.agentId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM assignments ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toAssignment);
  }

  private getAssignment(id: string): Assignment | undefined {
    const row = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toAssignment(row) : undefined;
  }

  createDispatchRun(input: CreateDispatchRunInput): DispatchRun {
    const timestamp = now();
    const run: DispatchRun = {
      id: `dispatch-${randomUUID()}`,
      taskId: input.taskId,
      workforceId: input.workforceId,
      status: input.status ?? "planned",
      mode: input.mode ?? "dry-run",
      planSummary: input.planSummary,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO dispatch_runs
         (id, task_id, workforce_id, status, mode, plan_summary, created_at, updated_at)
         VALUES (@id, @taskId, @workforceId, @status, @mode, @planSummary, @createdAt, @updatedAt)`,
      )
      .run({
        ...run,
        workforceId: run.workforceId ?? null,
        planSummary: run.planSummary ?? null,
      });
    return run;
  }

  updateDispatchRun(
    id: string,
    input: UpdateDispatchRunInput,
  ): DispatchRun | undefined {
    const current = this.getDispatchRun(id);
    if (!current) return undefined;
    const next: DispatchRun = {
      ...current,
      workforceId: input.workforceId ?? current.workforceId,
      status: input.status ?? current.status,
      mode: input.mode ?? current.mode,
      planSummary: input.planSummary ?? current.planSummary,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE dispatch_runs
         SET workforce_id = @workforceId, status = @status, mode = @mode,
             plan_summary = @planSummary, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        workforceId: next.workforceId ?? null,
        planSummary: next.planSummary ?? null,
      });
    return this.getDispatchRun(id);
  }

  listDispatchRuns(
    options: { taskId?: string; status?: DispatchRunStatus; limit?: number } = {},
  ): DispatchRun[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM dispatch_runs ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toDispatchRun);
  }

  private getDispatchRun(id: string): DispatchRun | undefined {
    const row = this.db.prepare("SELECT * FROM dispatch_runs WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toDispatchRun(row) : undefined;
  }

  createAgentRun(input: CreateAgentRunInput): AgentRun {
    const timestamp = now();
    const run: AgentRun = {
      id: `run-${randomUUID()}`,
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      assignmentId: input.assignmentId,
      workforceId: input.workforceId,
      agentId: input.agentId,
      roleId: input.roleId,
      cycle: input.cycle,
      origin: input.origin ?? "spawned",
      pid: input.pid,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      command: input.command,
      cwd: input.cwd,
      logPath: input.logPath,
      status: input.status ?? "starting",
      phase: input.phase,
      restartedFromRunId: input.restartedFromRunId,
      startedAt: input.startedAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs
         (id, orchestration_id, task_id, subtask_id, assignment_id, workforce_id, agent_id, role_id,
          cycle, origin, pid, session_id, provider, model, reasoning_effort, command, cwd, log_path,
          status, phase, restarted_from_run_id, started_at, created_at, updated_at)
         VALUES (@id, @orchestrationId, @taskId, @subtaskId, @assignmentId, @workforceId, @agentId, @roleId,
                 @cycle, @origin, @pid, @sessionId, @provider, @model, @reasoningEffort, @command, @cwd, @logPath,
                 @status, @phase, @restartedFromRunId, @startedAt, @createdAt, @updatedAt)`,
      )
      .run({
        ...run,
        orchestrationId: run.orchestrationId ?? null,
        subtaskId: run.subtaskId ?? null,
        assignmentId: run.assignmentId ?? null,
        workforceId: run.workforceId ?? null,
        roleId: run.roleId ?? null,
        cycle: run.cycle ?? null,
        pid: run.pid ?? null,
        sessionId: run.sessionId ?? null,
        provider: run.provider ?? null,
        model: run.model ?? null,
        reasoningEffort: run.reasoningEffort ?? null,
        command: run.command ?? null,
        cwd: run.cwd ?? null,
        logPath: run.logPath ?? null,
        phase: run.phase ?? null,
        restartedFromRunId: run.restartedFromRunId ?? null,
        startedAt: run.startedAt ?? null,
      });
    return run;
  }

  getAgentRun(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toAgentRun(row) : undefined;
  }

  updateAgentRun(id: string, input: UpdateAgentRunInput): AgentRun | undefined {
    const current = this.getAgentRun(id);
    if (!current) return undefined;
    const next: AgentRun = {
      ...current,
      orchestrationId: input.orchestrationId ?? current.orchestrationId,
      subtaskId: input.subtaskId ?? current.subtaskId,
      assignmentId: input.assignmentId ?? current.assignmentId,
      workforceId: input.workforceId ?? current.workforceId,
      agentId: current.agentId,
      roleId: input.roleId ?? current.roleId,
      origin: input.origin ?? current.origin,
      pid: input.pid ?? current.pid,
      sessionId: input.sessionId ?? current.sessionId,
      provider: input.provider ?? current.provider,
      model: input.model ?? current.model,
      reasoningEffort: input.reasoningEffort ?? current.reasoningEffort,
      command: input.command ?? current.command,
      cwd: input.cwd ?? current.cwd,
      logPath: input.logPath ?? current.logPath,
      status: input.status ?? current.status,
      phase: input.phase ?? current.phase,
      progressPercent: input.progressPercent ?? current.progressPercent,
      progressNote: input.progressNote ?? current.progressNote,
      restartedFromRunId: input.restartedFromRunId ?? current.restartedFromRunId,
      exitCode: input.exitCode ?? current.exitCode,
      startedAt: input.startedAt ?? current.startedAt,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      endedAt: input.endedAt ?? current.endedAt,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE agent_runs
         SET orchestration_id = @orchestrationId, subtask_id = @subtaskId, assignment_id = @assignmentId,
             workforce_id = @workforceId, role_id = @roleId, origin = @origin, pid = @pid,
             session_id = @sessionId, provider = @provider, model = @model, reasoning_effort = @reasoningEffort,
             command = @command, cwd = @cwd, log_path = @logPath, status = @status, phase = @phase,
             progress_percent = @progressPercent, progress_note = @progressNote,
             restarted_from_run_id = @restartedFromRunId, exit_code = @exitCode,
             started_at = @startedAt, heartbeat_at = @heartbeatAt, ended_at = @endedAt,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        orchestrationId: next.orchestrationId ?? null,
        subtaskId: next.subtaskId ?? null,
        assignmentId: next.assignmentId ?? null,
        workforceId: next.workforceId ?? null,
        roleId: next.roleId ?? null,
        pid: next.pid ?? null,
        sessionId: next.sessionId ?? null,
        provider: next.provider ?? null,
        model: next.model ?? null,
        reasoningEffort: next.reasoningEffort ?? null,
        command: next.command ?? null,
        cwd: next.cwd ?? null,
        logPath: next.logPath ?? null,
        phase: next.phase ?? null,
        progressPercent: next.progressPercent ?? null,
        progressNote: next.progressNote ?? null,
        restartedFromRunId: next.restartedFromRunId ?? null,
        exitCode: next.exitCode ?? null,
        startedAt: next.startedAt ?? null,
        heartbeatAt: next.heartbeatAt ?? null,
        endedAt: next.endedAt ?? null,
      });
    return this.getAgentRun(id);
  }

  listAgentRuns(
    options: {
      taskId?: string;
      subtaskId?: string;
      orchestrationId?: string;
      status?: AgentRunStatus;
      limit?: number;
    } = {},
  ): AgentRun[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 200 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.subtaskId) {
      filters.push("subtask_id = @subtaskId");
      params.subtaskId = options.subtaskId;
    }
    if (options.orchestrationId) {
      filters.push("orchestration_id = @orchestrationId");
      params.orchestrationId = options.orchestrationId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM agent_runs ${where} ORDER BY updated_at DESC LIMIT @limit`)
        .all(params) as Row[]
    ).map(toAgentRun);
  }

  createOrchestration(input: CreateOrchestrationInput): Orchestration {
    const timestamp = now();
    const orchestration: Orchestration = {
      id: `orch-${randomUUID()}`,
      taskId: input.taskId,
      workforceId: input.workforceId,
      leaderAgentId: input.leaderAgentId,
      status: input.status ?? "planning",
      // "manual" is the safe default now that "approve-each" actually gates
      // every spawn: it used to be inert, so defaulting to it would silently
      // turn on per-agent approval for callers that never asked for it.
      autonomy: input.autonomy ?? "manual",
      cycle: 0,
      maxCycles: input.maxCycles ?? 8,
      maxParallel: input.maxParallel ?? 3,
      maxQuestionRounds: input.maxQuestionRounds,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO orchestrations
         (id, task_id, workforce_id, leader_agent_id, status, autonomy, cycle, max_cycles, max_parallel, max_question_rounds, created_at, updated_at)
         VALUES (@id, @taskId, @workforceId, @leaderAgentId, @status, @autonomy, @cycle, @maxCycles, @maxParallel, @maxQuestionRounds, @createdAt, @updatedAt)`,
      )
      .run({
        ...orchestration,
        workforceId: orchestration.workforceId ?? null,
        maxQuestionRounds: orchestration.maxQuestionRounds ?? null,
      });
    return orchestration;
  }

  getOrchestration(id: string): Orchestration | undefined {
    const row = this.db.prepare("SELECT * FROM orchestrations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toOrchestration(row) : undefined;
  }

  getOrchestrationByTask(taskId: string): Orchestration | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestrations WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row ? toOrchestration(row) : undefined;
  }

  updateOrchestration(id: string, input: UpdateOrchestrationInput): Orchestration | undefined {
    const current = this.getOrchestration(id);
    if (!current) return undefined;
    if (input.leaderAgentId && input.leaderAgentId !== current.leaderAgentId) {
      // A leader the roster cannot resolve is exactly the state this setter
      // exists to repair, so refuse to write another one.
      if (!this.getRegisteredAgent(input.leaderAgentId)) {
        throw new Error(`Registered agent not found: ${input.leaderAgentId}`);
      }
    }
    const next: Orchestration = {
      ...current,
      leaderAgentId: input.leaderAgentId ?? current.leaderAgentId,
      workforceId: input.workforceId ?? current.workforceId,
      status: input.status ?? current.status,
      autonomy: input.autonomy ?? current.autonomy,
      cycle: input.cycle ?? current.cycle,
      maxCycles: input.maxCycles ?? current.maxCycles,
      maxParallel: input.maxParallel ?? current.maxParallel,
      maxQuestionRounds: input.maxQuestionRounds ?? current.maxQuestionRounds,
      complexity: input.complexity ?? current.complexity,
      planPath: input.planPath ?? current.planPath,
      reportPath: input.reportPath ?? current.reportPath,
      lastError: input.lastError === undefined ? current.lastError : (input.lastError ?? undefined),
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE orchestrations
         SET leader_agent_id = @leaderAgentId,
             workforce_id = @workforceId, status = @status, autonomy = @autonomy, cycle = @cycle,
             max_cycles = @maxCycles, max_parallel = @maxParallel,
             max_question_rounds = @maxQuestionRounds, complexity = @complexity,
             plan_path = @planPath, report_path = @reportPath, last_error = @lastError,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        workforceId: next.workforceId ?? null,
        maxQuestionRounds: next.maxQuestionRounds ?? null,
        complexity: next.complexity ?? null,
        planPath: next.planPath ?? null,
        reportPath: next.reportPath ?? null,
        lastError: next.lastError ?? null,
      });
    return this.getOrchestration(id);
  }

  listOrchestrations(
    options: { status?: OrchestrationStatus; leaderAgentId?: string; limit?: number } = {},
  ): Orchestration[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    if (options.leaderAgentId) {
      filters.push("leader_agent_id = @leaderAgentId");
      params.leaderAgentId = options.leaderAgentId;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM orchestrations ${where} ORDER BY updated_at DESC LIMIT @limit`)
        .all(params) as Row[]
    ).map(toOrchestration);
  }

  recordOrchestrationEvent(input: RecordOrchestrationEventInput): OrchestrationEvent {
    const event: OrchestrationEvent = {
      id: `orch-event-${randomUUID()}`,
      orchestrationId: input.orchestrationId,
      cycle: input.cycle ?? 0,
      phase: input.phase,
      kind: input.kind,
      summary: input.summary,
      payload: input.payload,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO orchestration_events
         (id, orchestration_id, cycle, phase, kind, summary, payload, created_at)
         VALUES (@id, @orchestrationId, @cycle, @phase, @kind, @summary, @payload, @createdAt)`,
      )
      .run({ ...event, summary: event.summary ?? null, payload: event.payload ?? null });
    return event;
  }

  listOrchestrationEvents(
    options: { orchestrationId: string; limit?: number; kind?: OrchestrationEventKind; summaryPrefix?: string },
  ): OrchestrationEvent[] {
    // Filtering in SQL rather than after the fact: an orchestration that ran
    // for a few cycles accumulates thousands of events, and a caller looking
    // for the handful of plan-meta rows among them would otherwise have to
    // guess a limit big enough to still contain the oldest one.
    const filters = ["orchestration_id = @orchestrationId"];
    if (options.kind) filters.push("kind = @kind");
    if (options.summaryPrefix) filters.push("summary LIKE @summaryPrefix ESCAPE '\\'");
    return (
      this.db
        .prepare(
          `SELECT * FROM orchestration_events WHERE ${filters.join(" AND ")}
           ORDER BY created_at DESC LIMIT @limit`,
        )
        .all({
          orchestrationId: options.orchestrationId,
          limit: options.limit ?? 200,
          kind: options.kind ?? null,
          summaryPrefix: options.summaryPrefix ? `${escapeLike(options.summaryPrefix)}%` : null,
        }) as Row[]
    ).map(toOrchestrationEvent);
  }

  createReview(input: CreateReviewInput): Review {
    const review: Review = {
      id: `review-${randomUUID()}`,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      reviewerAssignmentId: input.reviewerAssignmentId,
      targetAssignmentId: input.targetAssignmentId,
      verdict: input.verdict,
      score: input.score,
      summary: input.summary,
      findings: input.findings,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO reviews
         (id, task_id, subtask_id, reviewer_assignment_id, target_assignment_id, verdict, score, summary, findings, created_at)
         VALUES (@id, @taskId, @subtaskId, @reviewerAssignmentId, @targetAssignmentId, @verdict, @score, @summary, @findings, @createdAt)`,
      )
      .run({
        ...review,
        subtaskId: review.subtaskId ?? null,
        reviewerAssignmentId: review.reviewerAssignmentId ?? null,
        targetAssignmentId: review.targetAssignmentId ?? null,
        score: review.score ?? null,
        findings: review.findings ?? null,
      });
    return review;
  }

  listReviews(
    options: { taskId?: string; subtaskId?: string; consumed?: boolean; limit?: number } = {},
  ): Review[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 200 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.subtaskId) {
      filters.push("subtask_id = @subtaskId");
      params.subtaskId = options.subtaskId;
    }
    if (options.consumed != null) {
      filters.push(options.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL");
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM reviews ${where} ORDER BY created_at DESC LIMIT @limit`)
        .all(params) as Row[]
    ).map(toReview);
  }

  markReviewConsumed(id: string): Review | undefined {
    this.db.prepare("UPDATE reviews SET consumed_at = @consumedAt WHERE id = @id").run({
      id,
      consumedAt: now(),
    });
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
    return row ? toReview(row) : undefined;
  }

  upsertTaskLane(input: UpsertTaskLaneInput): TaskLane {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO task_lanes
         (task_id, mode, base_ref, base_commit, worktree_path, status, created_at, updated_at)
         VALUES (@taskId, @mode, @baseRef, @baseCommit, @worktreePath, @status, @createdAt, @updatedAt)
         ON CONFLICT(task_id) DO UPDATE SET
           mode = excluded.mode,
           base_ref = excluded.base_ref,
           base_commit = excluded.base_commit,
           worktree_path = excluded.worktree_path,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({
        taskId: input.taskId,
        mode: input.mode,
        baseRef: input.baseRef ?? null,
        baseCommit: input.baseCommit ?? null,
        worktreePath: input.worktreePath ?? null,
        status: input.status ?? "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM task_lanes WHERE task_id = ?")
      .get(input.taskId) as Row;
    return toTaskLane(row);
  }

  getTaskLane(taskId: string): TaskLane | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_lanes WHERE task_id = ?")
      .get(taskId) as Row | undefined;
    return row ? toTaskLane(row) : undefined;
  }

  listTaskLanes(status?: TaskLane["status"], limit = 50): TaskLane[] {
    const statusFilter = status ? "WHERE status = @status" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM task_lanes ${statusFilter} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all({ status, limit }) as Row[]
    ).map(toTaskLane);
  }

  acquireFileLease(input: AcquireFileLeaseInput): AcquireFileLeaseResult {
    const timestamp = now();
    const expiresAt = new Date(
      Date.parse(timestamp) + (input.ttlSeconds ?? 3600) * 1000,
    ).toISOString();
    const blockingRow = this.db
      .prepare(
        `SELECT * FROM file_leases
         WHERE path = @path
           AND task_id != @taskId
           AND released_at IS NULL
           AND expires_at > @timestamp
           AND (mode = 'write' OR @mode = 'write')
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get({
        path: input.path,
        taskId: input.taskId,
        mode: input.mode,
        timestamp,
      }) as Row | undefined;
    if (blockingRow) {
      return { acquired: false, blockingLease: toFileLease(blockingRow) };
    }

    const existing = this.db
      .prepare(
        `SELECT * FROM file_leases
         WHERE path = @path
           AND task_id = @taskId
           AND mode = @mode
           AND released_at IS NULL
           AND expires_at > @timestamp
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get({
        path: input.path,
        taskId: input.taskId,
        mode: input.mode,
        timestamp,
      }) as Row | undefined;

    if (existing) {
      const id = String(existing.id);
      this.db
        .prepare(
          `UPDATE file_leases
           SET session_id = @sessionId, agent = @agent, base_hash = @baseHash,
               current_hash = @currentHash, expires_at = @expiresAt, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id,
          sessionId: input.sessionId ?? null,
          agent: input.agent ?? null,
          baseHash: input.baseHash ?? null,
          currentHash: input.currentHash ?? null,
          expiresAt,
          updatedAt: timestamp,
        });
      return { acquired: true, lease: this.getFileLease(id) };
    }

    const lease: FileLease = {
      id: `lease-${randomUUID()}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      agent: input.agent,
      path: input.path,
      mode: input.mode,
      baseHash: input.baseHash,
      currentHash: input.currentHash,
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO file_leases
         (id, task_id, session_id, agent, path, mode, base_hash, current_hash, expires_at, released_at, created_at, updated_at)
         VALUES (@id, @taskId, @sessionId, @agent, @path, @mode, @baseHash, @currentHash, @expiresAt, @releasedAt, @createdAt, @updatedAt)`,
      )
      .run({
        ...lease,
        sessionId: lease.sessionId ?? null,
        agent: lease.agent ?? null,
        baseHash: lease.baseHash ?? null,
        currentHash: lease.currentHash ?? null,
        releasedAt: null,
      });
    return { acquired: true, lease };
  }

  releaseFileLease(id: string): FileLease | undefined {
    const current = this.getFileLease(id);
    if (!current) return undefined;
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE file_leases SET released_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, timestamp, id);
    return this.getFileLease(id);
  }

  listFileLeases(
    options: {
      taskId?: string;
      path?: string;
      activeOnly?: boolean;
      limit?: number;
    } = {},
  ): FileLease[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = {
      limit: options.limit ?? 100,
      timestamp: now(),
    };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.path) {
      filters.push("path = @path");
      params.path = options.path;
    }
    if (options.activeOnly)
      filters.push("released_at IS NULL AND expires_at > @timestamp");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM file_leases ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toFileLease);
  }

  private getFileLease(id: string): FileLease | undefined {
    const row = this.db
      .prepare("SELECT * FROM file_leases WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toFileLease(row) : undefined;
  }

  upsertTaskChange(input: UpsertTaskChangeInput): TaskChange {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO task_changes
         (id, task_id, path, change_type, base_hash, current_hash, diff_summary, status, created_at, updated_at)
         VALUES (@id, @taskId, @path, @changeType, @baseHash, @currentHash, @diffSummary, @status, @createdAt, @updatedAt)
         ON CONFLICT(task_id, path) DO UPDATE SET
           change_type = excluded.change_type,
           base_hash = excluded.base_hash,
           current_hash = excluded.current_hash,
           diff_summary = excluded.diff_summary,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: `change-${randomUUID()}`,
        taskId: input.taskId,
        path: input.path,
        changeType: input.changeType,
        baseHash: input.baseHash ?? null,
        currentHash: input.currentHash ?? null,
        diffSummary: input.diffSummary ?? null,
        status: input.status ?? "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM task_changes WHERE task_id = ? AND path = ?")
      .get(input.taskId, input.path) as Row;
    return toTaskChange(row);
  }

  listTaskChanges(taskId: string, limit = 100): TaskChange[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_changes WHERE task_id = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(taskId, limit) as Row[]
    ).map(toTaskChange);
  }

  createAgentRequest(input: CreateAgentRequestInput): AgentRequest {
    const request: AgentRequest = {
      id: `request-${randomUUID()}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      agent: input.agent,
      type: input.type,
      title: input.title,
      payload: input.payload,
      status: "pending",
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_requests
         (id, task_id, session_id, agent, type, title, payload, status, response, created_at, resolved_at)
         VALUES (@id, @taskId, @sessionId, @agent, @type, @title, @payload, @status, @response, @createdAt, @resolvedAt)`,
      )
      .run({
        ...request,
        taskId: request.taskId ?? null,
        sessionId: request.sessionId ?? null,
        agent: request.agent ?? null,
        payload: request.payload ?? null,
        response: null,
        resolvedAt: null,
      });
    return request;
  }

  resolveAgentRequest(
    id: string,
    status: AgentRequestStatus,
    response?: string,
  ): AgentRequest | undefined {
    const current = this.getAgentRequest(id);
    if (!current) return undefined;
    const resolvedAt = now();
    this.db
      .prepare(
        "UPDATE agent_requests SET status = ?, response = ?, resolved_at = ? WHERE id = ?",
      )
      .run(status, response ?? null, resolvedAt, id);
    return this.getAgentRequest(id);
  }

  listAgentRequests(
    options: {
      taskId?: string;
      status?: AgentRequestStatus;
      limit?: number;
    } = {},
  ): AgentRequest[] {
    const filters: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit ?? 100 };
    if (options.taskId) {
      filters.push("task_id = @taskId");
      params.taskId = options.taskId;
    }
    if (options.status) {
      filters.push("status = @status");
      params.status = options.status;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toAgentRequest);
  }

  private getAgentRequest(id: string): AgentRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_requests WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toAgentRequest(row) : undefined;
  }

  // Agent requests are an inbox, not an audit log — unlike workforce/agent
  // deletes there is no history to preserve, so this is a real hard delete.
  deleteAgentRequest(id: string): boolean {
    return this.db.prepare("DELETE FROM agent_requests WHERE id = ?").run(id).changes > 0;
  }

  deleteAgentRequests(ids: string[]): number {
    if (!ids.length) return 0;
    const stmt = this.db.prepare("DELETE FROM agent_requests WHERE id = ?");
    const tx = this.db.transaction((values: string[]) => {
      let count = 0;
      for (const value of values) count += stmt.run(value).changes;
      return count;
    });
    return tx(ids);
  }

  upsertFileSummary(input: UpsertFileSummaryInput): FileSummary {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO files
         (path, summary, last_seen_hash, important_ranges, manual_priority, last_task_id, last_task_edited_at, updated_at)
         VALUES (@path, @summary, @lastSeenHash, @importantRanges, @manualPriority, @lastTaskId, @lastTaskEditedAt, @updatedAt)
         ON CONFLICT(path) DO UPDATE SET
           summary = excluded.summary,
           last_seen_hash = excluded.last_seen_hash,
           important_ranges = excluded.important_ranges,
           manual_priority = COALESCE(excluded.manual_priority, files.manual_priority),
           last_task_id = COALESCE(excluded.last_task_id, files.last_task_id),
           last_task_edited_at = COALESCE(excluded.last_task_edited_at, files.last_task_edited_at),
           updated_at = excluded.updated_at`,
      )
      .run({
        path: input.path,
        summary: input.summary ?? null,
        lastSeenHash: input.lastSeenHash ?? null,
        importantRanges: JSON.stringify(input.importantRanges ?? []),
        manualPriority:
          input.manualPriority == null
            ? null
            : Math.max(1, Math.min(5, input.manualPriority)),
        lastTaskId: input.lastTaskId ?? null,
        lastTaskEditedAt: input.markTaskEdited ? timestamp : null,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(input.path) as Row;
    return toFileSummary(row);
  }

  createHandoff(input: CreateHandoffInput): Handoff {
    const handoff: Handoff = {
      id: `handoff-${randomUUID()}`,
      taskId: input.taskId,
      fromAgent: input.fromAgent,
      summary: input.summary,
      done: input.done ?? [],
      next: input.next ?? [],
      risks: input.risks ?? [],
      filesChanged: input.filesChanged ?? [],
      createdAt: now(),
      auto: input.auto ?? false,
    };
    this.db
      .prepare(
        `INSERT INTO handoffs
         (id, task_id, from_agent, summary, done, next, risks, files_changed, created_at, auto)
         VALUES (@id, @taskId, @fromAgent, @summary, @done, @next, @risks, @filesChanged, @createdAt, @auto)`,
      )
      .run({
        ...handoff,
        done: JSON.stringify(handoff.done),
        next: JSON.stringify(handoff.next),
        risks: JSON.stringify(handoff.risks),
        filesChanged: JSON.stringify(handoff.filesChanged),
        auto: handoff.auto ? 1 : 0,
      });
    return handoff;
  }

  updateHandoff(input: UpdateHandoffInput): Handoff {
    const existing = this.db
      .prepare("SELECT * FROM handoffs WHERE id = ?")
      .get(input.id) as Row | undefined;
    if (!existing) {
      throw new Error(`Handoff not found: ${input.id}`);
    }
    const handoff: Handoff = {
      id: String(existing.id),
      taskId: input.taskId,
      fromAgent: input.fromAgent,
      summary: input.summary,
      done: input.done ?? [],
      next: input.next ?? [],
      risks: input.risks ?? [],
      filesChanged: input.filesChanged ?? [],
      createdAt: String(existing.created_at),
      auto: Number(existing.auto) === 1,
    };
    this.db
      .prepare(
        `UPDATE handoffs
         SET task_id = @taskId,
             from_agent = @fromAgent,
             summary = @summary,
             done = @done,
             next = @next,
             risks = @risks,
             files_changed = @filesChanged
         WHERE id = @id`,
      )
      .run({
        ...handoff,
        done: JSON.stringify(handoff.done),
        next: JSON.stringify(handoff.next),
        risks: JSON.stringify(handoff.risks),
        filesChanged: JSON.stringify(handoff.filesChanged),
      });
    return handoff;
  }

  // Maintain a single auto-generated handoff per task: drop the previous auto
  // row before inserting the refreshed one, so the Stop hook never bloats the
  // table. Manual handoffs (auto = 0) are untouched.
  upsertAutoHandoff(input: CreateHandoffInput): Handoff {
    this.db
      .prepare("DELETE FROM handoffs WHERE task_id = ? AND auto = 1")
      .run(input.taskId);
    return this.createHandoff({ ...input, auto: true });
  }

  // A task has exactly one current handoff: the agent taking the task over
  // rewrites it in place. Keeping a stack of rows made "the handoff of this
  // task" ambiguous for the next agent, which is the only reader that matters.
  upsertTaskHandoff(input: CreateHandoffInput): Handoff {
    this.db.prepare("DELETE FROM handoffs WHERE task_id = ?").run(input.taskId);
    return this.createHandoff(input);
  }

  getLatestHandoff(taskId: string): Handoff | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM handoffs WHERE task_id = ? ORDER BY created_at DESC, auto ASC LIMIT 1",
      )
      .get(taskId) as Row | undefined;
    return row ? toHandoff(row) : undefined;
  }

  listRuns(options: { taskId?: string; limit?: number } = {}): RunRecord[] {
    const limit = options.limit ?? 50;
    const taskFilter = options.taskId ? "WHERE task_id = @taskId" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM runs ${taskFilter} ORDER BY created_at DESC LIMIT @limit`,
        )
        .all({ taskId: options.taskId, limit }) as Row[]
    ).map(toRun);
  }

  addRun(record: Omit<RunRecord, "id" | "createdAt">): RunRecord {
    const run: RunRecord = {
      id: `run-${randomUUID()}`,
      createdAt: now(),
      ...record,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, agent, command, result_summary, token_estimate, created_at)
         VALUES (@id, @taskId, @agent, @command, @resultSummary, @tokenEstimate, @createdAt)`,
      )
      .run({
        ...run,
        taskId: run.taskId ?? null,
        agent: run.agent ?? null,
        command: run.command ?? null,
        resultSummary: run.resultSummary ?? null,
        tokenEstimate: run.tokenEstimate ?? null,
      });
    return run;
  }

  // --- Knowledge graph (SQLite-only; not part of the MemoryStore interface) ---

  // Replace the entire graph in one transaction. The graph is a derived index of
  // the repo, so a full rebuild is simpler and safer than incremental upserts.
  replaceGraph(graph: ExtractedGraph): { nodes: number; edges: number } {
    const timestamp = now();
    const insertNode = this.db.prepare(
      `INSERT OR REPLACE INTO graph_nodes (id, kind, path, name, language, symbol_kind, line, signature, content_hash, updated_at)
       VALUES (@id, @kind, @path, @name, @language, @symbolKind, @line, @signature, @contentHash, @updatedAt)`,
    );
    const insertEdge = this.db.prepare(
      `INSERT OR REPLACE INTO graph_edges (src, dst, kind, raw, updated_at)
       VALUES (@src, @dst, @kind, @raw, @updatedAt)`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM graph_nodes").run();
      this.db.prepare("DELETE FROM graph_edges").run();
      for (const node of graph.nodes) {
        insertNode.run({
          id: node.id,
          kind: node.kind,
          path: node.path,
          name: node.name ?? null,
          language: node.language ?? null,
          symbolKind: node.symbolKind ?? null,
          line: node.line ?? null,
          signature: node.signature ?? null,
          contentHash: node.contentHash ?? null,
          updatedAt: timestamp,
        });
      }
      for (const edge of graph.edges) {
        insertEdge.run({
          src: edge.src,
          dst: edge.dst,
          kind: edge.kind,
          raw: edge.raw ?? null,
          updatedAt: timestamp,
        });
      }
    });
    tx();
    return { nodes: graph.nodes.length, edges: graph.edges.length };
  }

  getGraphStats(): GraphStats {
    const count = (sql: string): number =>
      Number((this.db.prepare(sql).get() as Row).n ?? 0);
    return {
      files: count("SELECT COUNT(*) AS n FROM graph_nodes WHERE kind = 'file'"),
      symbols: count(
        "SELECT COUNT(*) AS n FROM graph_nodes WHERE kind = 'symbol'",
      ),
      edges: count("SELECT COUNT(*) AS n FROM graph_edges"),
      internalEdges: count(
        "SELECT COUNT(*) AS n FROM graph_edges WHERE dst NOT LIKE 'ext:%'",
      ),
      externalEdges: count(
        "SELECT COUNT(*) AS n FROM graph_edges WHERE dst LIKE 'ext:%'",
      ),
    };
  }

  listGraphFiles(limit = 1000): GraphNode[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM graph_nodes WHERE kind = 'file' ORDER BY path LIMIT ?",
        )
        .all(limit) as Row[]
    ).map(toGraphNode);
  }

  getFileSymbols(path: string): GraphNode[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM graph_nodes WHERE kind = 'symbol' AND path = ? ORDER BY line",
        )
        .all(path) as Row[]
    ).map(toGraphNode);
  }

  // Outgoing imports for a file: resolved internal file paths and external modules.
  getImports(path: string): { internal: string[]; external: string[] } {
    const rows = this.db
      .prepare("SELECT dst FROM graph_edges WHERE src = ? ORDER BY dst")
      .all(path) as Row[];
    const internal: string[] = [];
    const external: string[] = [];
    for (const row of rows) {
      const dst = String(row.dst);
      if (dst.startsWith("ext:")) external.push(dst.slice(4));
      else internal.push(dst);
    }
    return { internal, external };
  }

  // Files that import the given file (fan-in / who-depends-on-this).
  getDependents(path: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT src FROM graph_edges WHERE dst = ? ORDER BY src",
        )
        .all(path) as Row[]
    ).map((row) => String(row.src));
  }

  // Substring search over node names and paths (diacritic-folded), symbols first.
  searchGraphNodes(
    query: string,
    options: { kind?: GraphNode["kind"]; limit?: number } = {},
  ): GraphNode[] {
    const limit = options.limit ?? 30;
    const needle = `%${foldDiacritics(query)}%`;
    const kindFilter = options.kind ? "AND kind = @kind" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM graph_nodes
           WHERE (fold(name) LIKE @needle OR fold(path) LIKE @needle) ${kindFilter}
           ORDER BY CASE kind WHEN 'symbol' THEN 0 ELSE 1 END, path, line
           LIMIT @limit`,
        )
        .all({ needle, kind: options.kind, limit }) as Row[]
    ).map(toGraphNode);
  }

  // Build a compact task-centred repo map. Task seeds (explicit handoff files
  // and lexical matches against paths/briefs/symbols) come first, then one-hop
  // graph neighbours, then a small structural fallback.
  buildRepoMap(
    options: {
      limit?: number;
      focusPaths?: string[];
      maxSymbolsPerFile?: number;
      recentTaskFiles?: string[];
      task?: { id?: string; title: string; goal?: string };
    } = {},
  ): RepoMapFile[] {
    const limit = options.limit ?? 40;
    const dependentCounts = new Map<string, number>();
    for (const row of this.db
      .prepare(
        "SELECT dst, COUNT(DISTINCT src) AS n FROM graph_edges WHERE dst NOT LIKE 'ext:%' GROUP BY dst",
      )
      .all() as Row[]) {
      dependentCounts.set(String(row.dst), Number(row.n));
    }
    const summaries = new Map(
      this.listFileSummaries().map((summary) => [summary.path, summary]),
    );
    const recentTaskFiles = new Set(options.recentTaskFiles ?? []);

    let files = this.listGraphFiles(5000);
    if (options.focusPaths?.length) {
      const needles = options.focusPaths.map((value) => value.toLowerCase());
      files = files.filter((file) =>
        needles.some((needle) => file.path.toLowerCase().includes(needle)),
      );
    }
    const taskTerms = taskQueryTerms(options.task);
    const relevance = new Map(
      files.map((file) => [
        file.path,
        taskRelevance(file, summaries.get(file.path), taskTerms, this),
      ]),
    );
    const structuralScore = (file: GraphNode): number =>
      Math.log2((dependentCounts.get(file.path) ?? 0) + 1) * 10 +
      (summaries.get(file.path)?.manualPriority ?? 0) * 2;
    const sortBy =
      (score: (file: GraphNode) => number) => (a: GraphNode, b: GraphNode) =>
        score(b) - score(a) || a.path.localeCompare(b.path);

    if (!options.task && !recentTaskFiles.size)
      files.sort(sortBy(structuralScore));

    const selected: Array<{
      file: GraphNode;
      reason?: RepoMapFile["selectionReason"];
    }> = [];
    const selectedPaths = new Set<string>();
    const add = (
      candidates: GraphNode[],
      count: number,
      reason?: RepoMapFile["selectionReason"],
      score = structuralScore,
    ): void => {
      for (const file of candidates.sort(sortBy(score))) {
        if (selected.length >= limit || selectedPaths.has(file.path)) continue;
        selected.push({ file, reason });
        selectedPaths.add(file.path);
        if (selected.filter((entry) => entry.reason === reason).length >= count)
          break;
      }
    };

    if (options.task || recentTaskFiles.size) {
      const taskQuota = Math.min(limit, Math.max(1, Math.ceil(limit * 0.4)));
      const taskSeeds = files.filter((file) => {
        const summary = summaries.get(file.path);
        return (
          recentTaskFiles.has(file.path) ||
          (summary?.lastTaskId === options.task?.id &&
            Boolean(summary?.lastTaskEditedAt)) ||
          (relevance.get(file.path) ?? 0) > 0
        );
      });
      add(
        taskSeeds,
        taskQuota,
        "task",
        (file) =>
          (recentTaskFiles.has(file.path) ? 1_000 : 0) +
          (summaries.get(file.path)?.lastTaskId === options.task?.id &&
          summaries.get(file.path)?.lastTaskEditedAt
            ? 500
            : 0) +
          (relevance.get(file.path) ?? 0) * 60 +
          structuralScore(file),
      );

      const neighbourPaths = new Set<string>();
      for (const { file } of selected) {
        for (const path of this.getImports(file.path).internal)
          neighbourPaths.add(path);
        for (const path of this.getDependents(file.path))
          neighbourPaths.add(path);
      }
      const neighbourQuota = Math.min(
        limit - selected.length,
        Math.ceil(limit / 3),
      );
      add(
        files.filter((file) => neighbourPaths.has(file.path)),
        neighbourQuota,
        "neighbor",
        (file) => (relevance.get(file.path) ?? 0) * 60 + structuralScore(file),
      );
    }
    add(
      files,
      limit - selected.length,
      options.task || recentTaskFiles.size ? "structural" : undefined,
    );

    const maxSymbols = options.maxSymbolsPerFile ?? 12;
    return selected.map(({ file, reason }) => {
      const imports = this.getImports(file.path);
      const summary = summaries.get(file.path);
      return {
        path: file.path,
        language: file.language,
        symbols: this.getFileSymbols(file.path)
          .slice(0, maxSymbols)
          .map((symbol) => ({
            name: symbol.name ?? "",
            kind: symbol.symbolKind ?? "symbol",
          })),
        importsInternal: imports.internal,
        importsExternal: imports.external,
        usedByCount: dependentCounts.get(file.path) ?? 0,
        brief: summary?.summary,
        manualPriority: summary?.manualPriority,
        briefStale: Boolean(
          summary?.summary &&
          summary.lastSeenHash &&
          file.contentHash &&
          summary.lastSeenHash !== file.contentHash,
        ),
        selectionReason: reason,
      };
    });
  }
}

function taskQueryTerms(
  task: { id?: string; title: string; goal?: string } | undefined,
): string[] {
  if (!task) return [];
  return [
    ...new Set(
      foldDiacritics([task.title, task.goal ?? ""].join(" ")).match(
        /[\p{L}\p{N}_-]{3,}/gu,
      ) ?? [],
    ),
  ];
}

function taskRelevance(
  file: GraphNode,
  summary: FileSummary | undefined,
  terms: string[],
  store: SQLiteMemoryStore,
): number {
  if (!terms.length) return 0;
  const text = foldDiacritics(
    [
      file.path,
      summary?.summary ?? "",
      ...store.getFileSymbols(file.path).map((symbol) => symbol.name ?? ""),
    ].join(" "),
  );
  return terms.filter((term) => text.includes(term)).length / terms.length;
}



