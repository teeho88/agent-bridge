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
  ReviewVerdict,
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
  CreateAssignmentInput,
  CredentialRef,
  Assignment,
  AddWorkforceMemberInput,
  AcquireFileLeaseInput,
  AcquireFileLeaseResult,
  AgentRequest,
  AgentRequestStatus,
  CreateAgentRequestInput,
  CreateHandoffInput,
  UpdateHandoffInput,
  CreateTaskInput,
  Decision,
  FileLease,
  FileSummary,
  Handoff,
  Memory,
  RunRecord,
  Task,
  TaskChange,
  TaskLane,
  UpsertTaskChangeInput,
  UpsertTaskLaneInput,
} from "./types.js";

export type MemorySearchOptions = {
  taskId?: string;
  limit?: number;
};

export interface MemoryStore {
  close(): void;
  createTask(input: CreateTaskInput): Task;
  getTask(id: string): Task | undefined;
  updateTaskStatus(id: string, status: Task["status"]): Task | undefined;
  listTasks(limit?: number): Task[];
  addMemory(input: AddMemoryInput): Memory;
  updateRepoMemory(id: string, input: UpdateMemoryInput): Memory | undefined;
  deleteRepoMemory(id: string): boolean;
  searchMemories(query: string, options?: MemorySearchOptions): Memory[];
  listMemoriesForTask(taskId: string, limit?: number): Memory[];
  listRepoMemories(limit?: number): Memory[];
  listDecisions(taskId: string): Decision[];
  listFileSummaries(): FileSummary[];
  createRegisteredAgent(input: CreateRegisteredAgentInput): RegisteredAgent;
  getRegisteredAgent(id: string): RegisteredAgent | undefined;
  listRegisteredAgents(options?: { enabled?: boolean; provider?: string; includeUnselectedPresets?: boolean; includeHiddenPresets?: boolean; limit?: number }): RegisteredAgent[];
  updateRegisteredAgent(id: string, input: UpdateRegisteredAgentInput): RegisteredAgent | undefined;
  // Throws when the agent still leads an unfinished orchestration: archiving it
  // would leave that run unable to resolve its leader.
  deleteRegisteredAgent(id: string): boolean;
  createCredentialRef(input: CreateCredentialRefInput): CredentialRef;
  listCredentialRefs(provider?: string): CredentialRef[];
  createWorkforceRole(input: CreateWorkforceRoleInput): WorkforceRole;
  getWorkforceRole(id: string): WorkforceRole | undefined;
  updateWorkforceRole(id: string, input: UpdateWorkforceRoleInput): WorkforceRole | undefined;
  deleteWorkforceRole(id: string): boolean;
  listWorkforceRoles(): WorkforceRole[];
  ensureDefaultWorkforceRoles(): WorkforceRole[];
  createWorkforce(input: CreateWorkforceInput): Workforce;
  getWorkforce(id: string): Workforce | undefined;
  updateWorkforce(id: string, input: UpdateWorkforceInput): Workforce | undefined;
  deleteWorkforce(id: string): boolean;
  listWorkforces(limit?: number): Workforce[];
  addWorkforceMember(input: AddWorkforceMemberInput): WorkforceMember;
  deleteWorkforceMember(id: string): boolean;
  listWorkforceMembers(workforceId: string): WorkforceMember[];
  createSubtask(input: CreateSubtaskInput): Subtask;
  updateSubtask(id: string, input: UpdateSubtaskInput): Subtask | undefined;
  listSubtasks(options?: { parentTaskId?: string; status?: SubtaskStatus; limit?: number }): Subtask[];
  createAssignment(input: CreateAssignmentInput): Assignment;
  updateAssignment(id: string, input: UpdateAssignmentInput): Assignment | undefined;
  listAssignments(options?: { taskId?: string; subtaskId?: string; agentId?: string; status?: Assignment["status"]; limit?: number }): Assignment[];
  createDispatchRun(input: CreateDispatchRunInput): DispatchRun;
  updateDispatchRun(id: string, input: UpdateDispatchRunInput): DispatchRun | undefined;
  listDispatchRuns(options?: { taskId?: string; status?: DispatchRunStatus; limit?: number }): DispatchRun[];
  upsertTaskLane(input: UpsertTaskLaneInput): TaskLane;
  getTaskLane(taskId: string): TaskLane | undefined;
  listTaskLanes(status?: TaskLane["status"], limit?: number): TaskLane[];
  acquireFileLease(input: AcquireFileLeaseInput): AcquireFileLeaseResult;
  releaseFileLease(id: string): FileLease | undefined;
  listFileLeases(options?: {
    taskId?: string;
    path?: string;
    activeOnly?: boolean;
    limit?: number;
  }): FileLease[];
  upsertTaskChange(input: UpsertTaskChangeInput): TaskChange;
  listTaskChanges(taskId: string, limit?: number): TaskChange[];
  createAgentRequest(input: CreateAgentRequestInput): AgentRequest;
  resolveAgentRequest(
    id: string,
    status: AgentRequestStatus,
    response?: string,
  ): AgentRequest | undefined;
  listAgentRequests(options?: {
    taskId?: string;
    status?: AgentRequestStatus;
    limit?: number;
  }): AgentRequest[];
  deleteAgentRequest(id: string): boolean;
  deleteAgentRequests(ids: string[]): number;
  createHandoff(input: CreateHandoffInput): Handoff;
  updateHandoff(input: UpdateHandoffInput): Handoff;
  upsertAutoHandoff(input: CreateHandoffInput): Handoff;
  upsertTaskHandoff(input: CreateHandoffInput): Handoff;
  getLatestHandoff(taskId: string): Handoff | undefined;
  addRun(record: Omit<RunRecord, "id" | "createdAt">): RunRecord;
  createAgentRun(input: CreateAgentRunInput): AgentRun;
  getAgentRun(id: string): AgentRun | undefined;
  updateAgentRun(id: string, input: UpdateAgentRunInput): AgentRun | undefined;
  listAgentRuns(options?: {
    taskId?: string;
    subtaskId?: string;
    orchestrationId?: string;
    status?: AgentRunStatus;
    limit?: number;
  }): AgentRun[];
  createOrchestration(input: CreateOrchestrationInput): Orchestration;
  getOrchestration(id: string): Orchestration | undefined;
  getOrchestrationByTask(taskId: string): Orchestration | undefined;
  updateOrchestration(id: string, input: UpdateOrchestrationInput): Orchestration | undefined;
  listOrchestrations(options?: { status?: OrchestrationStatus; leaderAgentId?: string; limit?: number }): Orchestration[];
  recordOrchestrationEvent(input: RecordOrchestrationEventInput): OrchestrationEvent;
  listOrchestrationEvents(options?: {
    orchestrationId: string;
    limit?: number;
    kind?: OrchestrationEventKind;
    summaryPrefix?: string;
  }): OrchestrationEvent[];
  createReview(input: CreateReviewInput): Review;
  listReviews(options?: { taskId?: string; subtaskId?: string; consumed?: boolean; limit?: number }): Review[];
  markReviewConsumed(id: string): Review | undefined;
}



