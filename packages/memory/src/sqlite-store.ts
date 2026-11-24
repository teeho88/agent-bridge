import { leaseSnapshotHash } from "./lease-snapshot.js";
import { ManagedDispatchRepository, type ManagedDispatchPolicy, type ManagedDispatchInput, type ManagedDispatch } from "./managed-dispatch.js";
import type { TaskDecomposition, LeaseRecoveryInput } from "./task-planning.js";
import type { LifecycleConfig, ConsolidationResult } from "./memory-policy.js";
export type {
  LifecycleConfig,
  ConsolidationCluster,
  ConsolidationResult,
} from "./memory-policy.js";
import { MemoryRepository } from "./memory-repository.js";
import { TaskRepository } from "./task-repository.js";
import { SessionRepository } from "./session-repository.js";
import { WorkforceRepository } from "./workforce-repository.js";
import { LeaseRepository } from "./lease-repository.js";
import { GraphRepository } from "./graph-repository.js";

import type { GraphStats } from "./sqlite-codecs.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  ManagedReview,
  ManagedReviewInput,
  TaskAttempt,
  TaskRetryKind,
  TaskRetryPolicy,
  EndTaskAttemptInput,
  Checkpoint,
  CheckpointInput,
  MemoryEvidence,
} from "./types.js";
import { dirname } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { EmbeddingRepository } from "./embedding-repository.js";

import type { MaintenancePolicy } from "./pool-maintenance.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

import { type EmbeddingProvider } from "./embeddings.js";
import type { ExtractedGraph, GraphNode, RepoMapFile } from "./graph.js";
import type { MemoryStore, MemorySearchOptions } from "./memory-store.js";
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
  TaskContract,
  TaskContractInput,
  TaskOwnerClaim,
  TaskAcceptanceProof,
  TaskCheckProof,
  TaskChange,
  TaskLane,
  UpdateTaskInput,
  UpsertFileSummaryInput,
  UpsertTaskChangeInput,
  UpsertTaskLaneInput,
} from "./types.js";

type Row = Record<string, unknown>;

export type { GraphStats } from "./sqlite-codecs.js";
// Tunable memory-pool behaviour. Any field left undefined falls back to the
// DEFAULT_* constants in lifecycle.ts. Typically sourced from project config.
export type SQLiteMemoryStoreOptions = {
  // Optional semantic-search provider. When set, reindexEmbeddings()/
  // semanticSearch() are usable; when absent, the store is purely lexical.
  embeddingProvider?: EmbeddingProvider;
  lifecycle?: LifecycleConfig;
};

export class SQLiteMemoryStore implements MemoryStore {
  private db: Database.Database;
  private managedDispatch: ManagedDispatchRepository;
  private memories: MemoryRepository;
  private tasks: TaskRepository;
  private sessions: SessionRepository;

  private workforce: WorkforceRepository;
  private leases: LeaseRepository;
  private graph: GraphRepository;

  private embeddings: EmbeddingRepository;
  private lifecycle: LifecycleConfig;

  constructor(databasePath: string, options: SQLiteMemoryStoreOptions = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const existingDatabase =
      databasePath !== ":memory:" &&
      existsSync(databasePath) &&
      statSync(databasePath).size > 0;
    this.db = new Database(databasePath);
    try {
      const version = Number(
        this.db.pragma("user_version", { simple: true }) ?? 0,
      );
      if (existingDatabase && version < LATEST_SCHEMA_VERSION) {
        this.db
          .prepare("VACUUM INTO ?")
          .run(`${databasePath}.v${version}-${randomUUID()}.backup`);
      }
      runMigrations(this.db);
      this.lifecycle = options.lifecycle ?? {};
      this.memories = new MemoryRepository(this.db, this, this.lifecycle);
      this.tasks = new TaskRepository(this.db, this);
      this.sessions = new SessionRepository(this.db, this);

      this.workforce = new WorkforceRepository(this.db, this);
      this.leases = new LeaseRepository(this.db, this);
      this.managedDispatch = new ManagedDispatchRepository(this.db, this);
      this.graph = new GraphRepository(this.db, this);

      this.embeddings = new EmbeddingRepository(
        this.db,
        options.embeddingProvider,
        (query, search) => this.searchMemories(query, search),
        (search, alias) => this.memorySearchFilter(search, alias),
        this.lifecycle,
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  forEachRetentionReference(visit: (value: unknown) => void): void {
    for (const row of this.db
      .prepare("SELECT log_path, command FROM agent_runs")
      .iterate() as Iterable<Row>) {
      visit(row.log_path);
      visit(row.command);
    }
    for (const row of this.db
      .prepare("SELECT payload FROM checkpoints")
      .iterate() as Iterable<Row>) {
      try {
        visit(JSON.parse(String(row.payload)));
      } catch {
        throw new Error("Invalid checkpoint payload; retention aborted");
      }
    }
  }

  withRetentionLock<T>(collect: () => T): T {
    return this.db.transaction(collect).immediate();
  }

  contextSnapshot<T>(read: () => T): { value: T; stamp: string } {
    return this.db.transaction(() => {
      const stamp = this.contextStamp();
      const value = read();
      if (this.contextStamp() !== stamp)
        throw new Error(
          "context_publication_conflict: snapshot mutated while compiling",
        );
      return { value, stamp };
    })();
  }

  private contextStamp(): string {
    return `${this.db.pragma("data_version", { simple: true })}:${(this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n}`;
  }

  commitContextSnapshot<T>(stamp: string, commit: () => T): T {
    return this.db
      .transaction(() => {
        if (stamp !== this.contextStamp())
          throw new Error(
            "context_publication_conflict: memory changed; refresh and retry",
          );
        return commit();
      })
      .immediate();
  }

  bindTaskIdentity(
    taskId: string,
    identity: { repositoryId: string; branch: string; baseCommit?: string },
  ): void {
    return this.tasks.bindTaskIdentity(taskId, identity);
  }

  setMemoryEvidence(id: string, evidence: MemoryEvidence): void {
    return this.memories.setMemoryEvidence(id, evidence);
  }

  markMemoryStale(id: string): void {
    return this.memories.markMemoryStale(id);
  }

  setDecisionEvidence(
    id: string,
    scope: string,
    evidence: MemoryEvidence,
  ): void {
    return this.tasks.setDecisionEvidence(id, scope, evidence);
  }

  recordDecision(input: {
    taskId: string;
    decision: string;
    reason?: string;
    scope: string;
    evidence?: MemoryEvidence;
    relatedFiles?: string[];
    sourceAgent?: AgentKind;
    supersedes?: string;
  }): Decision {
    return this.tasks.recordDecision(input);
  }

  supersedeDecision(id: string, replacementId: string): void {
    return this.tasks.supersedeDecision(id, replacementId);
  }

  listCheckpoints(taskId: string, limit = 20): Checkpoint[] {
    return this.tasks.listCheckpoints(taskId, limit);
  }

  saveCheckpoint(input: CheckpointInput): {
    checkpoint: Checkpoint;
    changed: boolean;
  } {
    return this.tasks.saveCheckpoint(input);
  }

  createTask(input: CreateTaskInput): Task {
    return this.tasks.createTask(input);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.getTask(id);
  }

  updateTaskStatus(id: string, status: Task["status"]): Task | undefined {
    return this.tasks.updateTaskStatus(id, status);
  }

  claimManagedDispatchLaunch(runId: string, taskId: string, agentId: string, sessionId: string, provider: string): AgentRun {
    return this.managedDispatch.claimLaunch(runId, taskId, agentId, sessionId, provider);
  }

  settleManagedDispatch(requestId: string, input: EndTaskAttemptInput & { repositoryRoot: string }, agent: AgentKind, sessionId: string): ManagedDispatch {
    return this.managedDispatch.settle(requestId, input, agent, sessionId);
  }

  recordManagedDispatchOverhead(parentTaskId: string, usage: NonNullable<ManagedDispatchPolicy["actualOverheadTokens"]>, agent: AgentKind, sessionId: string): void {
    this.managedDispatch.recordOverhead(parentTaskId, usage, agent, sessionId);
  }

  managedDispatchReport(parentTaskId: string) { return this.managedDispatch.report(parentTaskId); }

  assertManagedTaskDependencies(taskId: string): void { this.tasks.assertTaskDependencies(taskId); }

  configureManagedDispatch(parentTaskId: string, policy: ManagedDispatchPolicy, agent: AgentKind, sessionId: string): ManagedDispatchPolicy {
    return this.managedDispatch.configure(parentTaskId, policy, agent, sessionId);
  }

  listManagedDispatches(parentTaskId: string): ManagedDispatch[] { return this.managedDispatch.list(parentTaskId); }

  reserveManagedDispatch(input: ManagedDispatchInput, leaderAgent: AgentKind, leaderSession: string): ManagedDispatch {
    return this.managedDispatch.reserve(input, leaderAgent, leaderSession);
  }

  getTaskDecomposition(taskId: string): TaskDecomposition | undefined {
    return this.tasks.getTaskDecomposition(taskId);
  }

  setTaskDecomposition(plan: TaskDecomposition, agent: AgentKind, sessionId: string): TaskDecomposition {
    return this.tasks.setTaskDecomposition(plan, agent, sessionId);
  }

  getTaskContract(taskId: string): TaskContract | undefined {
    return this.tasks.getTaskContract(taskId);
  }

  setTaskContract(taskId: string, input: TaskContractInput, agent?: AgentKind, sessionId?: string): TaskContract {
    return this.tasks.setTaskContract(taskId, input, agent, sessionId);
  }

  getTaskOwnerClaim(taskId: string): TaskOwnerClaim | undefined {
    return this.tasks.getTaskOwnerClaim(taskId);
  }

  claimTask(taskId: string, agent: AgentKind, sessionId: string): TaskOwnerClaim {
    return this.tasks.claimTask(taskId, agent, sessionId);
  }

  releaseTaskClaim(taskId: string, agent: AgentKind, sessionId: string): void {
    this.tasks.releaseTaskClaim(taskId, agent, sessionId);
  }

  listTaskAcceptance(taskId: string): TaskAcceptanceProof[] {
    return this.tasks.listTaskAcceptance(taskId);
  }

  verifyTaskAcceptance(taskId: string, criterion: string, checkpointId: string, agent: AgentKind, sessionId: string): TaskAcceptanceProof {
    return this.tasks.verifyTaskAcceptance(taskId, criterion, checkpointId, agent, sessionId);
  }

  listTaskChecks(taskId: string): TaskCheckProof[] {
    return this.tasks.listTaskChecks(taskId);
  }

  verifyTaskCheck(taskId: string, checkpointId: string, agent: AgentKind, sessionId: string): TaskCheckProof {
    return this.tasks.verifyTaskCheck(taskId, checkpointId, agent, sessionId);
  }

  transitionManagedTask(taskId: string, target: Task["status"], agent: AgentKind, sessionId: string, reason?: string): Task {
    return this.tasks.transitionManagedTask(taskId, target, agent, sessionId, reason);
  }

  listManagedReviews(taskId: string): ManagedReview[] { return this.tasks.listManagedReviews(taskId); }
  getTaskRetryPolicy(taskId: string): TaskRetryPolicy | undefined { return this.tasks.getTaskRetryPolicy(taskId); }
  listTaskAttempts(taskId: string): TaskAttempt[] { return this.tasks.listTaskAttempts(taskId); }
  setTaskRetryPolicy(taskId: string, kind: TaskRetryKind, agent: AgentKind, sessionId: string): TaskRetryPolicy {
    return this.tasks.setTaskRetryPolicy(taskId, kind, agent, sessionId);
  }
  beginTaskAttempt(taskId: string, operation: string, hypothesis: string, agent: AgentKind, sessionId: string): TaskAttempt {
    return this.tasks.beginTaskAttempt(taskId, operation, hypothesis, agent, sessionId);
  }
  endTaskAttempt(taskId: string, attemptId: string, input: EndTaskAttemptInput, agent: AgentKind, sessionId: string): TaskAttempt {
    return this.tasks.endTaskAttempt(taskId, attemptId, input, agent, sessionId);
  }
  recordManagedReview(taskId: string, input: ManagedReviewInput, agent: AgentKind, sessionId: string): ManagedReview {
    return this.tasks.recordManagedReview(taskId, input, agent, sessionId);
  }

  updateTask(id: string, input: UpdateTaskInput): Task | undefined {
    return this.tasks.updateTask(id, input);
  }

  deleteTask(id: string): boolean {
    return this.tasks.deleteTask(id);
  }

  listTasks(limit = 20): Task[] {
    return this.tasks.listTasks(limit);
  }

  addMemory(input: AddMemoryInput): Memory {
    return this.memories.addMemory(input);
  }

  updateRepoMemory(id: string, input: UpdateMemoryInput): Memory | undefined {
    return this.memories.updateRepoMemory(id, input);
  }

  deleteRepoMemory(id: string): boolean {
    return this.memories.deleteRepoMemory(id);
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
    return this.memories.upsertLatestMemory(input, options);
  }

  // Evict low-value memories so the pool fits within maxPoolSize. Protected
  // types (constraint/decision/handoff) are never evicted. Returns the evicted
  // memories; with dryRun, computes the selection without deleting.
  runMaintenance(options: MaintenancePolicy = {}): number {
    return this.memories.runMaintenance(options);
  }

  listArchivedMemories(taskId?: string, limit = 50): Memory[] {
    return this.memories.listArchivedMemories(taskId, limit);
  }

  restoreMemory(id: string): boolean {
    return this.memories.restoreMemory(id);
  }
  getMemoryHistory(id: string, taskId: string): Memory | undefined {
    return this.memories.getMemoryHistory(id, taskId);
  }

  pruneMemories(options: MaintenancePolicy = {}): Memory[] {
    return this.memories.pruneMemories(options);
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
    batchSize?: number;
  }): ConsolidationResult {
    return this.memories.consolidateMemories(options);
  }

  hasEmbeddingProvider(): boolean {
    return this.embeddings.hasEmbeddingProvider();
  }
  getEmbeddingDiagnostic() {
    return this.embeddings.getEmbeddingDiagnostic();
  }
  reindexEmbeddings(
    options: Parameters<EmbeddingRepository["reindexEmbeddings"]>[0] = {},
  ) {
    return this.embeddings.reindexEmbeddings(options);
  }
  semanticSearch(
    query: string,
    options: Parameters<EmbeddingRepository["semanticSearch"]>[1] = {},
  ) {
    return this.embeddings.semanticSearch(query, options);
  }

  searchMemories(query: string, options: MemorySearchOptions = {}): Memory[] {
    return this.memories.searchMemories(query, options);
  }

  memorySearchFilter(options: MemorySearchOptions, alias: string) {
    return this.memories.memorySearchFilter(options, alias);
  }

  getMemory(id: string, taskId: string): Memory | undefined {
    return this.memories.getMemory(id, taskId);
  }

  getLatestResponse(taskId: string): Memory | undefined {
    return this.memories.getLatestResponse(taskId);
  }

  listLatestTaskHandoffs(
    limit = 50,
    offset = 0,
  ): Array<{ task: Task; handoff: Handoff }> {
    return this.tasks.listLatestTaskHandoffs(limit, offset);
  }

  getDecision(id: string, taskId: string): Decision | undefined {
    return this.tasks.getDecision(id, taskId);
  }

  getContextMemories(
    taskId: string,
    query: string,
    excludeTags: string[] = [],
  ): Memory[] {
    return this.memories.getContextMemories(taskId, query, excludeTags);
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
    return this.memories.listMemories(options);
  }

  listMemoriesForTask(taskId: string, limit = 50): Memory[] {
    return this.memories.listMemoriesForTask(taskId, limit);
  }

  listRepoMemories(limit = 50): Memory[] {
    return this.memories.listRepoMemories(limit);
  }

  recordSessionEvent(input: RecordSessionEventInput): SessionEvent {
    return this.sessions.recordSessionEvent(input);
  }

  listSessionEvents(
    options: { taskId?: string; sessionId?: string; limit?: number } = {},
  ): SessionEvent[] {
    return this.sessions.listSessionEvents(options);
  }

  listActiveSessionEvents(limit = 100): SessionEvent[] {
    return this.sessions.listActiveSessionEvents(limit);
  }

  listSessionHistory(): SessionEvent[] {
    return this.sessions.listSessionHistory();
  }

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    return this.sessions.createMemoryCandidate(input);
  }

  listMemoryCandidates(
    status: MemoryCandidate["status"] = "pending",
    limit = 100,
  ): MemoryCandidate[] {
    return this.sessions.listMemoryCandidates(status, limit);
  }

  reviewMemoryCandidate(
    id: string,
    action: "promote" | "reject",
  ): MemoryCandidate | undefined {
    return this.sessions.reviewMemoryCandidate(id, action);
  }

  listDecisions(taskId: string): Decision[] {
    return this.tasks.listDecisions(taskId);
  }

  getFileSummary(path: string): FileSummary | undefined {
    return this.memories.getFileSummary(path);
  }

  listFileSummaries(): FileSummary[] {
    return this.memories.listFileSummaries();
  }

  createRegisteredAgent(input: CreateRegisteredAgentInput): RegisteredAgent {
    return this.workforce.createRegisteredAgent(input);
  }

  getRegisteredAgent(id: string): RegisteredAgent | undefined {
    return this.workforce.getRegisteredAgent(id);
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
    return this.workforce.listRegisteredAgents(options);
  }

  updateRegisteredAgent(
    id: string,
    input: UpdateRegisteredAgentInput,
  ): RegisteredAgent | undefined {
    return this.workforce.updateRegisteredAgent(id, input);
  }

  // Archive instead of physically deleting so historical assignments/agent_runs/
  // orchestrations retain a valid foreign-key target (same pattern as
  // deleteWorkforceRole). The archived name is freed for later reuse.
  deleteRegisteredAgent(id: string): boolean {
    return this.workforce.deleteRegisteredAgent(id);
  }

  createCredentialRef(input: CreateCredentialRefInput): CredentialRef {
    return this.workforce.createCredentialRef(input);
  }

  listCredentialRefs(provider?: string): CredentialRef[] {
    return this.workforce.listCredentialRefs(provider);
  }

  createWorkforceRole(input: CreateWorkforceRoleInput): WorkforceRole {
    return this.workforce.createWorkforceRole(input);
  }

  listWorkforceRoles(): WorkforceRole[] {
    return this.workforce.listWorkforceRoles();
  }

  ensureDefaultWorkforceRoles(): WorkforceRole[] {
    return this.workforce.ensureDefaultWorkforceRoles();
  }

  getWorkforceRole(id: string): WorkforceRole | undefined {
    return this.workforce.getWorkforceRole(id);
  }

  updateWorkforceRole(
    id: string,
    input: UpdateWorkforceRoleInput,
  ): WorkforceRole | undefined {
    return this.workforce.updateWorkforceRole(id, input);
  }

  // Archive instead of physically deleting so historical assignments retain a
  // valid foreign-key target. The archived name is freed for later reuse.
  deleteWorkforceRole(id: string): boolean {
    return this.workforce.deleteWorkforceRole(id);
  }

  createWorkforce(input: CreateWorkforceInput): Workforce {
    return this.workforce.createWorkforce(input);
  }

  listWorkforces(limit = 100): Workforce[] {
    return this.workforce.listWorkforces(limit);
  }

  getWorkforce(id: string): Workforce | undefined {
    return this.workforce.getWorkforce(id);
  }

  updateWorkforce(
    id: string,
    input: UpdateWorkforceInput,
  ): Workforce | undefined {
    return this.workforce.updateWorkforce(id, input);
  }

  // Removes the workforce and its memberships. Existing assignments/dispatch
  // runs keep their history but are unlinked from the deleted workforce
  // (workforce_id set to NULL) rather than deleted — callers already tolerate
  // a workforce id that no longer resolves (see workforce UI rendering).
  // Foreign keys are enforced (see migrations.ts), so these must be cleared
  // before the parent workforces row is removed or the DELETE fails.
  deleteWorkforce(id: string): boolean {
    return this.workforce.deleteWorkforce(id);
  }

  addWorkforceMember(input: AddWorkforceMemberInput): WorkforceMember {
    return this.workforce.addWorkforceMember(input);
  }

  listWorkforceMembers(workforceId: string): WorkforceMember[] {
    return this.workforce.listWorkforceMembers(workforceId);
  }

  deleteWorkforceMember(id: string): boolean {
    return this.workforce.deleteWorkforceMember(id);
  }

  createSubtask(input: CreateSubtaskInput): Subtask {
    return this.workforce.createSubtask(input);
  }

  updateSubtask(id: string, input: UpdateSubtaskInput): Subtask | undefined {
    return this.workforce.updateSubtask(id, input);
  }

  listSubtasks(
    options: {
      parentTaskId?: string;
      status?: SubtaskStatus;
      limit?: number;
    } = {},
  ): Subtask[] {
    return this.workforce.listSubtasks(options);
  }

  createAssignment(input: CreateAssignmentInput): Assignment {
    return this.workforce.createAssignment(input);
  }

  updateAssignment(
    id: string,
    input: UpdateAssignmentInput,
  ): Assignment | undefined {
    return this.workforce.updateAssignment(id, input);
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
    return this.workforce.listAssignments(options);
  }

  createDispatchRun(input: CreateDispatchRunInput): DispatchRun {
    return this.workforce.createDispatchRun(input);
  }

  updateDispatchRun(
    id: string,
    input: UpdateDispatchRunInput,
  ): DispatchRun | undefined {
    return this.workforce.updateDispatchRun(id, input);
  }

  listDispatchRuns(
    options: {
      taskId?: string;
      status?: DispatchRunStatus;
      limit?: number;
    } = {},
  ): DispatchRun[] {
    return this.workforce.listDispatchRuns(options);
  }

  createAgentRun(input: CreateAgentRunInput): AgentRun {
    return this.workforce.createAgentRun(input);
  }

  getAgentRun(id: string): AgentRun | undefined {
    return this.workforce.getAgentRun(id);
  }

  updateAgentRun(id: string, input: UpdateAgentRunInput): AgentRun | undefined {
    return this.workforce.updateAgentRun(id, input);
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
    return this.workforce.listAgentRuns(options);
  }

  createOrchestration(input: CreateOrchestrationInput): Orchestration {
    return this.workforce.createOrchestration(input);
  }

  getOrchestration(id: string): Orchestration | undefined {
    return this.workforce.getOrchestration(id);
  }

  getOrchestrationByTask(taskId: string): Orchestration | undefined {
    return this.workforce.getOrchestrationByTask(taskId);
  }

  updateOrchestration(
    id: string,
    input: UpdateOrchestrationInput,
  ): Orchestration | undefined {
    return this.workforce.updateOrchestration(id, input);
  }

  incrementOrchestrationMaxCycles(
    id: string,
    delta: number,
  ): Orchestration | undefined {
    return this.workforce.incrementOrchestrationMaxCycles(id, delta);
  }

  listOrchestrations(
    options: {
      status?: OrchestrationStatus;
      leaderAgentId?: string;
      limit?: number;
    } = {},
  ): Orchestration[] {
    return this.workforce.listOrchestrations(options);
  }

  recordOrchestrationEvent(
    input: RecordOrchestrationEventInput,
  ): OrchestrationEvent {
    return this.workforce.recordOrchestrationEvent(input);
  }

  listOrchestrationEvents(options: {
    orchestrationId: string;
    limit?: number;
    kind?: OrchestrationEventKind;
    summaryPrefix?: string;
  }): OrchestrationEvent[] {
    return this.workforce.listOrchestrationEvents(options);
  }

  createReview(input: CreateReviewInput): Review {
    return this.workforce.createReview(input);
  }

  listReviews(
    options: {
      taskId?: string;
      subtaskId?: string;
      consumed?: boolean;
      limit?: number;
    } = {},
  ): Review[] {
    return this.workforce.listReviews(options);
  }

  markReviewConsumed(id: string): Review | undefined {
    return this.workforce.markReviewConsumed(id);
  }

  upsertTaskLane(input: UpsertTaskLaneInput): TaskLane {
    return this.leases.upsertTaskLane(input);
  }

  getTaskLane(taskId: string): TaskLane | undefined {
    return this.leases.getTaskLane(taskId);
  }

  listTaskLanes(status?: TaskLane["status"], limit = 50): TaskLane[] {
    return this.leases.listTaskLanes(status, limit);
  }

  acquireFileLease(input: AcquireFileLeaseInput): AcquireFileLeaseResult {
    return this.leases.acquireFileLease(input);
  }

  acquireFileLeases(inputs: AcquireFileLeaseInput[]): {
    acquired: boolean;
    leases?: FileLease[];
    blockingLease?: FileLease;
  } {
    return this.leases.acquireFileLeases(inputs);
  }

  releaseFileLeases(
    ids: string[],
    owner: { taskId: string; agent?: string; sessionId?: string },
  ): FileLease[] {
    return this.leases.releaseFileLeases(ids, owner);
  }

  recoverSessionFileLeases(input: LeaseRecoveryInput): FileLease[] {
    return this.db.transaction(() => {
      if (!input.reason?.trim()) throw new Error("Recovery reason required");
      const runs = this.db.prepare("SELECT task_id, status, pid FROM agent_runs WHERE session_id = ?").all(input.sessionId) as { task_id: string; status: string; pid?: number }[];
      if (!runs.length || runs.some(run => run.task_id !== input.taskId || !["done", "failed", "stopped"].includes(run.status)))
        throw new Error("Recovery requires terminal runs for this task/session");
      for (const run of runs) if (run.pid) {
        try { process.kill(run.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
          throw new Error("Cannot establish that provider process stopped");
        }
        throw new Error("Provider process is still alive");
      }
      const checkpoint = this.listCheckpoints(input.taskId, -1).find(cp => cp.id === input.checkpointId);
      if (!checkpoint || checkpoint.author !== input.agent || checkpoint.sessionId !== input.sessionId)
        throw new Error("Recovery requires owner checkpoint");

      const leases = this.db.prepare("SELECT path FROM file_leases WHERE session_id = ? AND released_at IS NULL AND mode = 'write'")
        .all(input.sessionId) as { path: string }[];
      for (const lease of leases) {
        const file = checkpoint.files.find(file => file.path.replace(/\\/g, "/").toLowerCase() === lease.path.toLowerCase());
        const hash = leaseSnapshotHash(input.repositoryRoot, lease.path);
        if (!file || file.hash !== hash) throw new Error(`Checkpoint does not preserve current file: ${lease.path}`);
      }
      return this.leases.releaseSessionFileLeases(input, `recovery checkpoint=${input.checkpointId}: ${input.reason}`);
    }).immediate();
  }

  releaseSessionFileLeases(
    owner: { taskId: string; agent: string; sessionId: string },
    reason: string,
  ): FileLease[] {
    return this.leases.releaseSessionFileLeases(owner, reason);
  }

  releaseFileLease(id: string, owner?: { taskId: string; agent?: string; sessionId?: string }): FileLease | undefined {
    return this.leases.releaseFileLease(id, owner);
  }

  listFileLeases(
    options: {
      taskId?: string;
      path?: string;
      activeOnly?: boolean;
      limit?: number;
    } = {},
  ): FileLease[] {
    return this.leases.listFileLeases(options);
  }

  upsertTaskChange(input: UpsertTaskChangeInput): TaskChange {
    return this.leases.upsertTaskChange(input);
  }

  listTaskChanges(taskId: string, limit = 100): TaskChange[] {
    return this.leases.listTaskChanges(taskId, limit);
  }

  createAgentRequest(input: CreateAgentRequestInput): AgentRequest {
    return this.leases.createAgentRequest(input);
  }

  resolveAgentRequest(
    id: string,
    status: AgentRequestStatus,
    response?: string,
  ): AgentRequest | undefined {
    return this.leases.resolveAgentRequest(id, status, response);
  }

  listAgentRequests(
    options: {
      taskId?: string;
      status?: AgentRequestStatus;
      limit?: number;
    } = {},
  ): AgentRequest[] {
    return this.leases.listAgentRequests(options);
  }

  // Agent requests are an inbox, not an audit log — unlike workforce/agent
  // deletes there is no history to preserve, so this is a real hard delete.
  deleteAgentRequest(id: string): boolean {
    return this.leases.deleteAgentRequest(id);
  }

  deleteAgentRequests(ids: string[]): number {
    return this.leases.deleteAgentRequests(ids);
  }

  upsertFileSummary(input: UpsertFileSummaryInput): FileSummary {
    return this.memories.upsertFileSummary(input);
  }

  createHandoff(input: CreateHandoffInput): Handoff {
    return this.tasks.createHandoff(input);
  }

  updateHandoff(input: UpdateHandoffInput): Handoff {
    return this.tasks.updateHandoff(input);
  }

  // Maintain a single auto-generated handoff per task: drop the previous auto
  // row before inserting the refreshed one, so the Stop hook never bloats the
  // table. Manual handoffs (auto = 0) are untouched.
  upsertAutoHandoff(input: CreateHandoffInput): Handoff {
    return this.tasks.upsertAutoHandoff(input);
  }

  // A task has exactly one current handoff: the agent taking the task over
  // rewrites it in place. Keeping a stack of rows made "the handoff of this
  // task" ambiguous for the next agent, which is the only reader that matters.
  upsertTaskHandoff(input: CreateHandoffInput): Handoff {
    return this.tasks.upsertTaskHandoff(input);
  }

  getLatestHandoff(taskId: string): Handoff | undefined {
    return this.tasks.getLatestHandoff(taskId);
  }

  listRuns(options: { taskId?: string; limit?: number } = {}): RunRecord[] {
    return this.tasks.listRuns(options);
  }

  addRun(record: Omit<RunRecord, "id" | "createdAt">): RunRecord {
    return this.tasks.addRun(record);
  }

  // --- Knowledge graph (SQLite-only; not part of the MemoryStore interface) ---

  replaceGraph(graph: ExtractedGraph, paths?: string[]): { nodes: number; edges: number } {
    return this.graph.replaceGraph(graph, paths);
  }

  getGraphStats(): GraphStats {
    return this.graph.getGraphStats();
  }

  listGraphFiles(limit = 1000): GraphNode[] {
    return this.graph.listGraphFiles(limit);
  }

  getFileSymbols(path: string): GraphNode[] {
    return this.graph.getFileSymbols(path);
  }

  // Outgoing imports for a file: resolved internal file paths and external modules.
  getImports(path: string): { internal: string[]; external: string[] } {
    return this.graph.getImports(path);
  }

  // Files that import the given file (fan-in / who-depends-on-this).
  getDependents(path: string): string[] {
    return this.graph.getDependents(path);
  }

  // Substring search over node names and paths (diacritic-folded), symbols first.
  searchGraphNodes(
    query: string,
    options: { kind?: GraphNode["kind"]; limit?: number } = {},
  ): GraphNode[] {
    return this.graph.searchGraphNodes(query, options);
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
    return this.graph.buildRepoMap(options);
  }
}
