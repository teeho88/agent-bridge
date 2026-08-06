export type AgentKind = "claude" | "codex" | "gemini" | "antigravity" | "generic";

export type AgentProvider =
  | "codex"
  | "claude"
  | "gemini"
  | "antigravity"
  | "openai-compatible"
  | "deepseek"
  | "kimi"
  | "glm"
  | "manual"
  | "generic";

export type AgentRunMode = "cli" | "api" | "manual";

export type RegisteredAgent = {
  id: string;
  name: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  command?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  credentialRef?: string;
  capabilities: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateRegisteredAgentInput = {
  name: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  command?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  credentialRef?: string;
  capabilities?: string[];
  enabled?: boolean;
};

export type UpdateRegisteredAgentInput = Partial<CreateRegisteredAgentInput> & {
  enabled?: boolean;
};

export type CredentialRefKind = "env" | "command" | "os-store" | "manual";

export type CredentialRef = {
  id: string;
  provider: string;
  kind: CredentialRefKind;
  ref: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateCredentialRefInput = {
  provider: string;
  kind: CredentialRefKind;
  ref: string;
};

export type RolePermission =
  | "plan"
  | "split"
  | "assign"
  | "spawn"
  | "read"
  | "edit"
  | "test"
  | "review"
  | "approve"
  | "merge"
  | "handoff"
  | "report"
  | string;

export type WorkforceRole = {
  id: string;
  name: string;
  description?: string;
  permissions: RolePermission[];
  defaultPrompt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkforceRoleInput = {
  name: string;
  description?: string;
  permissions?: RolePermission[];
  defaultPrompt?: string;
};

export type UpdateWorkforceRoleInput = Partial<CreateWorkforceRoleInput>;

export type Workforce = {
  id: string;
  name: string;
  description?: string;
  defaultLeaderAssignmentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkforceInput = {
  name: string;
  description?: string;
  defaultLeaderAssignmentId?: string;
};

export type UpdateWorkforceInput = Partial<CreateWorkforceInput>;

export type WorkforceMember = {
  id: string;
  workforceId: string;
  agentId: string;
  roleId: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AddWorkforceMemberInput = {
  workforceId: string;
  agentId: string;
  roleId: string;
  priority?: number;
  enabled?: boolean;
};

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

export type SubtaskStatus =
  | "todo"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export type Subtask = {
  id: string;
  parentTaskId: string;
  title: string;
  goal?: string;
  status: SubtaskStatus;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  createdByAssignmentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSubtaskInput = {
  parentTaskId: string;
  title: string;
  goal?: string;
  status?: SubtaskStatus;
  priority?: number;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  createdByAssignmentId?: string;
};

export type UpdateSubtaskInput = Partial<
  Omit<CreateSubtaskInput, "parentTaskId">
>;

export type MemoryType =
  | "task"
  | "decision"
  | "file"
  | "bug"
  | "test"
  | "constraint"
  | "handoff"
  | "artifact"
  | "note";

export type Task = {
  id: string;
  title: string;
  goal?: string;
  status: TaskStatus;
  ownerAgent?: AgentKind;
  createdAt: string;
  updatedAt: string;
};

export type Memory = {
  id: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number;
  tags: string[];
  sourceAgent?: AgentKind;
  createdAt: string;
  updatedAt: string;
  // Set to a representative memory's id when this memory has been consolidated
  // away. Superseded memories are hidden from compile/search but kept for history.
  supersededBy?: string;
};

export type Decision = {
  id: string;
  taskId?: string;
  decision: string;
  reason?: string;
  relatedFiles: string[];
  sourceAgent?: AgentKind;
  createdAt: string;
};

export type FileSummary = {
  path: string;
  summary?: string;
  lastSeenHash?: string;
  importantRanges: string[];
  // An explicit human/agent override. Automatic brief refreshes must not alter it.
  manualPriority?: number;
  lastTaskId?: string;
  lastTaskEditedAt?: string;
  updatedAt: string;
};

export type UpsertFileSummaryInput = {
  path: string;
  summary?: string;
  lastSeenHash?: string;
  importantRanges?: string[];
  manualPriority?: number;
  lastTaskId?: string;
  markTaskEdited?: boolean;
};

export type Handoff = {
  id: string;
  taskId: string;
  fromAgent?: AgentKind;
  toAgent?: AgentKind;
  summary: string;
  done: string[];
  next: string[];
  risks: string[];
  filesChanged: string[];
  createdAt: string;
  // True when assembled automatically by the Stop hook; false for handoffs an
  // agent authored via `handoff create`. Manual handoffs are not auto-clobbered.
  auto: boolean;
};

export type RunRecord = {
  id: string;
  taskId?: string;
  agent?: AgentKind;
  command?: string;
  resultSummary?: string;
  tokenEstimate?: number;
  createdAt: string;
};

// Immutable lifecycle facts emitted by an agent session. Task state is derived
// from these facts rather than inferred from whichever task was updated last.
export type SessionEventKind =
  | "session_started"
  | "prompt_submitted"
  | "assistant_summary"
  | "session_ended"
  | "session_paused"
  | "session_resumed"
  | "stop_requested"
  | "task_cancelled"
  | "user_prompt"
  | "request_created"
  | "request_resolved";

export type SessionEvent = {
  id: string;
  sessionId: string;
  taskId?: string;
  agent?: AgentKind;
  kind: SessionEventKind;
  summary?: string;
  createdAt: string;
};

export type RecordSessionEventInput = Omit<SessionEvent, "id" | "createdAt"> & {
  createdAt?: string;
};

export type MemoryCandidateStatus = "pending" | "promoted" | "rejected";

// A proposed repository memory. Candidates preserve useful discoveries without
// letting a transient response silently pollute the shared knowledge base.
export type MemoryCandidate = {
  id: string;
  taskId?: string;
  sessionEventId?: string;
  type: MemoryType;
  content: string;
  importance: number;
  tags: string[];
  sourceAgent?: AgentKind;
  status: MemoryCandidateStatus;
  createdAt: string;
  reviewedAt?: string;
};

export type CreateMemoryCandidateInput = Omit<
  MemoryCandidate,
  "id" | "status" | "createdAt" | "reviewedAt"
>;

export type CreateTaskInput = {
  title: string;
  goal?: string;
  ownerAgent?: AgentKind;
};

export type UpdateTaskInput = {
  title?: string;
  goal?: string;
  status?: TaskStatus;
  ownerAgent?: AgentKind;
};

export type AddMemoryInput = {
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  importance?: number;
  tags?: string[];
  sourceAgent?: AgentKind;
  // When false, skip near-duplicate detection and always insert a new row.
  // Defaults to deduping on (merges into a near-identical existing memory of the
  // same task + type).
  dedupe?: boolean;
};

export type CreateHandoffInput = {
  taskId: string;
  fromAgent?: AgentKind;
  toAgent?: AgentKind;
  summary: string;
  done?: string[];
  next?: string[];
  risks?: string[];
  filesChanged?: string[];
  auto?: boolean;
};

export type UpdateHandoffInput = {
  id: string;
  taskId: string;
  fromAgent?: AgentKind;
  toAgent?: AgentKind;
  summary: string;
  done?: string[];
  next?: string[];
  risks?: string[];
  filesChanged?: string[];
};

export type TaskLaneMode = "worktree" | "patch";
export type TaskLaneStatus = "active" | "merged" | "discarded" | "conflict";

export type TaskLane = {
  taskId: string;
  mode: TaskLaneMode;
  baseRef?: string;
  baseCommit?: string;
  worktreePath?: string;
  status: TaskLaneStatus;
  createdAt: string;
  updatedAt: string;
};

export type UpsertTaskLaneInput = {
  taskId: string;
  mode: TaskLaneMode;
  baseRef?: string;
  baseCommit?: string;
  worktreePath?: string;
  status?: TaskLaneStatus;
};

export type FileLeaseMode = "read" | "write";

export type FileLease = {
  id: string;
  taskId: string;
  sessionId?: string;
  agent?: AgentKind;
  path: string;
  mode: FileLeaseMode;
  baseHash?: string;
  currentHash?: string;
  expiresAt: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AcquireFileLeaseInput = {
  taskId: string;
  path: string;
  mode: FileLeaseMode;
  sessionId?: string;
  agent?: AgentKind;
  baseHash?: string;
  currentHash?: string;
  ttlSeconds?: number;
};

export type AcquireFileLeaseResult = {
  acquired: boolean;
  lease?: FileLease;
  blockingLease?: FileLease;
};

export type TaskChangeType = "added" | "modified" | "deleted" | "renamed";
export type TaskChangeStatus =
  | "pending"
  | "accepted"
  | "discarded"
  | "conflict";

export type TaskChange = {
  id: string;
  taskId: string;
  path: string;
  changeType: TaskChangeType;
  baseHash?: string;
  currentHash?: string;
  diffSummary?: string;
  status: TaskChangeStatus;
  createdAt: string;
  updatedAt: string;
};

export type UpsertTaskChangeInput = {
  taskId: string;
  path: string;
  changeType: TaskChangeType;
  baseHash?: string;
  currentHash?: string;
  diffSummary?: string;
  status?: TaskChangeStatus;
};

export type AgentRequestType = "approval" | "command" | "merge" | "question";
export type AgentRequestStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "resolved";

export type AgentRequest = {
  id: string;
  taskId?: string;
  sessionId?: string;
  agent?: AgentKind;
  type: AgentRequestType;
  title: string;
  payload?: string;
  status: AgentRequestStatus;
  response?: string;
  createdAt: string;
  resolvedAt?: string;
};

export type CreateAgentRequestInput = {
  taskId?: string;
  sessionId?: string;
  agent?: AgentKind;
  type: AgentRequestType;
  title: string;
  payload?: string;
};


export type AssignmentStatus =
  | "queued"
  | "approved"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type Assignment = {
  id: string;
  taskId: string;
  subtaskId?: string;
  workforceId?: string;
  agentId: string;
  roleId: string;
  status: AssignmentStatus;
  prompt: string;
  resultSummary?: string;
  testSummary?: string;
  riskSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAssignmentInput = {
  taskId: string;
  subtaskId?: string;
  workforceId?: string;
  agentId: string;
  roleId: string;
  status?: AssignmentStatus;
  prompt: string;
  resultSummary?: string;
  testSummary?: string;
  riskSummary?: string;
};

export type UpdateAssignmentInput = Partial<
  Omit<CreateAssignmentInput, "taskId" | "agentId" | "roleId">
> & {
  agentId?: string;
  roleId?: string;
};

export type DispatchRunStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DispatchRunMode = "dry-run" | "spawn";

export type DispatchRun = {
  id: string;
  taskId: string;
  workforceId?: string;
  status: DispatchRunStatus;
  mode: DispatchRunMode;
  planSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateDispatchRunInput = {
  taskId: string;
  workforceId?: string;
  status?: DispatchRunStatus;
  mode?: DispatchRunMode;
  planSummary?: string;
};

export type UpdateDispatchRunInput = Partial<
  Omit<CreateDispatchRunInput, "taskId">
>;

export type AgentRunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "stopping"
  | "stopped"
  | "done"
  | "failed"
  | "detached";

export type AgentRunOrigin = "spawned" | "adopted" | "manual";

export type AgentRunPhase = "plan" | "implement" | "review" | "adjudicate" | "report";

export type AgentRun = {
  id: string;
  orchestrationId?: string;
  taskId: string;
  subtaskId?: string;
  assignmentId?: string;
  workforceId?: string;
  agentId: string;
  roleId?: string;
  // Orchestration cycle this run was spawned in; absent for adopted/manual
  // runs and for rows created before the column existed.
  cycle?: number;
  origin: AgentRunOrigin;
  pid?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  command?: string;
  cwd?: string;
  logPath?: string;
  status: AgentRunStatus;
  phase?: AgentRunPhase;
  progressPercent?: number;
  progressNote?: string;
  restartedFromRunId?: string;
  exitCode?: number;
  startedAt?: string;
  heartbeatAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentRunInput = {
  orchestrationId?: string;
  taskId: string;
  subtaskId?: string;
  assignmentId?: string;
  workforceId?: string;
  agentId: string;
  roleId?: string;
  cycle?: number;
  origin?: AgentRunOrigin;
  pid?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  command?: string;
  cwd?: string;
  logPath?: string;
  status?: AgentRunStatus;
  phase?: AgentRunPhase;
  restartedFromRunId?: string;
  startedAt?: string;
};

export type UpdateAgentRunInput = Partial<
  Omit<CreateAgentRunInput, "taskId" | "agentId">
> & {
  status?: AgentRunStatus;
  progressPercent?: number;
  progressNote?: string;
  exitCode?: number;
  heartbeatAt?: string;
  endedAt?: string;
};

export type OrchestrationStatus =
  | "planning"
  | "executing"
  | "reviewing"
  | "adjudicating"
  | "reworking"
  | "reporting"
  | "done"
  | "failed"
  | "paused";

export type OrchestrationAutonomy = "manual" | "approve-each" | "auto";

export type Orchestration = {
  id: string;
  taskId: string;
  workforceId?: string;
  leaderAgentId: string;
  status: OrchestrationStatus;
  autonomy: OrchestrationAutonomy;
  cycle: number;
  maxCycles: number;
  maxParallel: number;
  complexity?: string;
  planPath?: string;
  reportPath?: string;
  lastError?: string;
  // Providers the leader is allowed to staff implementers/reviewers from.
  // Empty/absent means "no restriction" — the caller decides what is installed.
  teamProviders?: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateOrchestrationInput = {
  taskId: string;
  workforceId?: string;
  leaderAgentId: string;
  status?: OrchestrationStatus;
  autonomy?: OrchestrationAutonomy;
  maxCycles?: number;
  maxParallel?: number;
  teamProviders?: string[];
};

export type UpdateOrchestrationInput = Partial<
  Omit<CreateOrchestrationInput, "taskId" | "leaderAgentId">
> & {
  status?: OrchestrationStatus;
  cycle?: number;
  complexity?: string;
  planPath?: string;
  reportPath?: string;
  // `null` clears the stored error; `undefined` leaves it untouched. A
  // reopened orchestration has to be able to drop the failure that ended the
  // previous round, or the board keeps showing it forever.
  lastError?: string | null;
};

export type OrchestrationEventKind =
  | "leader_turn"
  | "spawn"
  | "run_ended"
  | "verdict"
  | "rework"
  | "error"
  | "user_action";

export type OrchestrationEvent = {
  id: string;
  orchestrationId: string;
  cycle: number;
  phase: string;
  kind: OrchestrationEventKind;
  summary?: string;
  payload?: string;
  createdAt: string;
};

export type RecordOrchestrationEventInput = {
  orchestrationId: string;
  cycle?: number;
  phase: string;
  kind: OrchestrationEventKind;
  summary?: string;
  payload?: string;
};

export type ReviewVerdict = "pass" | "rework" | "block";

export type Review = {
  id: string;
  taskId: string;
  subtaskId?: string;
  reviewerAssignmentId?: string;
  targetAssignmentId?: string;
  verdict: ReviewVerdict;
  score?: number;
  summary: string;
  findings?: string;
  consumedAt?: string;
  createdAt: string;
};

export type CreateReviewInput = {
  taskId: string;
  subtaskId?: string;
  reviewerAssignmentId?: string;
  targetAssignmentId?: string;
  verdict: ReviewVerdict;
  score?: number;
  summary: string;
  findings?: string;
};
