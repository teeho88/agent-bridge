import { validateDecomposition, type TaskDecomposition } from "./task-planning.js";
import type Database from "better-sqlite3";
import { taskRetryPolicy, taskRetryLimit } from "./task-retry-policy.js";
import type { MemoryRepository } from "./memory-repository.js";
import { randomUUID, createHash } from "node:crypto";

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

import type {
  CreateHandoffInput,
  UpdateHandoffInput,
  CreateTaskInput,
  TaskContract,
  TaskContractInput,
  TaskOwnerClaim,
  TaskAcceptanceProof,
  TaskCheckProof,
  TaskStatus,
  Decision,
  Handoff,
  RunRecord,
  Task,
  UpdateTaskInput,
} from "./types.js";
import {
  now,
  slug,
  toTask,
  toDecision,
  toRun,
  toHandoff,
} from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class TaskRepository {
  constructor(
    private db: Database.Database,
    private host: Pick<
      MemoryRepository,
      "upsertLatestMemory" | "setMemoryEvidence"
    >,
  ) {}

  bindTaskIdentity(
    taskId: string,
    identity: { repositoryId: string; branch: string; baseCommit?: string },
  ): void {
    this.db
      .transaction(() => {
        const task = this.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (
          task.repositoryId &&
          (task.repositoryId !== identity.repositoryId ||
            task.branch !== identity.branch)
        ) {
          throw new Error(
            "Task repository/branch mismatch; select a task for this branch.",
          );
        }
        if (!task.repositoryId)
          this.db
            .prepare(
              "UPDATE tasks SET repository_id = ?, branch = ?, base_commit = ? WHERE id = ?",
            )
            .run(
              identity.repositoryId,
              identity.branch,
              identity.baseCommit ?? null,
              taskId,
            );
      })
      .immediate();
  }

  setDecisionEvidence(
    id: string,
    scope: string,
    evidence: MemoryEvidence,
  ): void {
    const result = this.db
      .prepare(
        "UPDATE decisions SET scope = ?, evidence = ?, stale = 0 WHERE id = ?",
      )
      .run(scope, JSON.stringify(evidence), id);
    if (!result.changes) throw new Error(`Decision not found: ${id}`);
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
    return this.db
      .transaction(() => {
        if (!this.getTask(input.taskId))
          throw new Error(`Task not found: ${input.taskId}`);
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO decisions (id, task_id, decision, reason, scope, evidence, related_files, source_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            input.taskId,
            input.decision,
            input.reason ?? null,
            input.scope,
            input.evidence ? JSON.stringify(input.evidence) : null,
            JSON.stringify(input.relatedFiles ?? []),
            input.sourceAgent ?? null,
            now(),
          );
        if (input.supersedes) this.supersedeDecision(input.supersedes, id);
        return this.listDecisions(input.taskId).find(
          (decision) => decision.id === id,
        )!;
      })
      .immediate();
  }

  supersedeDecision(id: string, replacementId: string): void {
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT id, task_id, scope FROM decisions WHERE id IN (?, ?)",
          )
          .all(id, replacementId) as Row[];
        if (
          id === replacementId ||
          rows.length !== 2 ||
          rows[0].task_id !== rows[1].task_id ||
          rows[0].scope !== rows[1].scope
        )
          throw new Error("Decision scope mismatch");
        if (
          this.db
            .prepare(
              "SELECT id FROM decisions WHERE id = ? AND superseded_by IS NOT NULL",
            )
            .get(replacementId)
        )
          throw new Error("Replacement decision is superseded");
        this.db
          .prepare("UPDATE decisions SET superseded_by = ? WHERE id = ?")
          .run(replacementId, id);
      })
      .immediate();
  }

  listCheckpoints(taskId: string, limit = 20): Checkpoint[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY revision DESC LIMIT ?",
      )
      .all(taskId, limit) as Row[];
    return rows.map((row) => ({
      ...JSON.parse(String(row.payload)),
      id: String(row.id),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
    }));
  }

  saveCheckpoint(input: CheckpointInput): {
    checkpoint: Checkpoint;
    changed: boolean;
  } {
    return this.db
      .transaction(() => {
        if (
          input.tests.status === "passed" &&
          (input.tests.exitCode !== 0 ||
            !input.tests.command ||
            !input.tests.evidencePath)
        )
          throw new Error(
            "Passed tests require command, exit zero and evidence",
          );
        if (
          input.tests.status === "failed" &&
          (input.tests.exitCode === undefined ||
            input.tests.exitCode === 0 ||
            !input.tests.command ||
            !input.tests.evidencePath)
        )
          throw new Error(
            "Failed tests require command, nonzero exit and evidence",
          );
        const task = this.getTask(input.taskId);
        if (!task) throw new Error(`Task not found: ${input.taskId}`);
        const contract = this.getTaskContract(input.taskId);
        if (contract && task.status === "done") throw new Error("Reopen completed managed task before checkpointing");
        const effectiveInput: CheckpointInput = {
          ...input,
          goal: task.goal,
          decisions: this.listDecisions(input.taskId).map(({ id, decision, reason }) => ({ id, decision, reason })),
          ...(contract ? { contractVersion: contract.version } : {}),
        };
        const { author, sessionId, ...state } = effectiveInput;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(contract ? { ...effectiveInput } : state))
          .digest("hex");
        const previous = this.db
          .prepare(
            "SELECT fingerprint FROM checkpoints WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
          )
          .get(input.taskId) as Row | undefined;
        if (previous?.fingerprint === fingerprint)
          return {
            checkpoint: this.listCheckpoints(input.taskId, 1)[0],
            changed: false,
          };
        const checkpoint: Checkpoint = {
          ...effectiveInput,
          id: randomUUID(),
          revision: (task.revision ?? 0) + 1,
          createdAt: now(),
        };
        if (contract) {
          const history = this.listCheckpoints(input.taskId, -1);
          const oldHashes = new Map<string, string | undefined>();
          for (const entry of history) for (const file of entry.files)
            if (!oldHashes.has(file.path)) oldHashes.set(file.path, file.hash);
          const sourceChanged = input.files.some(file => oldHashes.has(file.path) && oldHashes.get(file.path) !== file.hash);
          if (sourceChanged || input.tests.status === "failed") {
            this.invalidateTaskDependents(input.taskId);
            this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(input.taskId);
            this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(input.taskId);
            this.db.prepare("UPDATE task_quality_reviews SET valid = 0 WHERE task_id = ?").run(input.taskId);
          }
        }
        this.db
          .prepare(
            "INSERT INTO checkpoints (id, task_id, revision, session_id, author, summary, payload, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            checkpoint.id,
            input.taskId,
            checkpoint.revision,
            sessionId ?? null,
            author ?? null,
            input.summary,
            JSON.stringify(effectiveInput),
            fingerprint,
            checkpoint.createdAt,
          );
        this.db
          .prepare("UPDATE tasks SET revision = ?, updated_at = ? WHERE id = ?")
          .run(checkpoint.revision, checkpoint.createdAt, input.taskId);
        this.upsertTaskHandoff({
          taskId: input.taskId,
          fromAgent: author,
          summary: input.summary,
          done: [
            ...(input.completed ?? []),
            input.tests.status === "not_run"
              ? input.tests.summary
              : `Tests (${input.tests.status}): ${input.tests.summary}${input.tests.evidencePath ? `; evidence: ${input.tests.evidencePath}` : ""}`,
          ],
          next: input.next,
          risks: input.blockers,
          filesChanged: input.files.map((file) => file.path),
        });
        const memory = this.host.upsertLatestMemory(
          {
            taskId: input.taskId,
            type: "test",
            content: `${input.summary}\nTests (${input.tests.status}): ${input.tests.summary}${input.tests.evidencePath ? `\nEvidence: ${input.tests.evidencePath}` : ""}`,
            summary: `Tests (${input.tests.status}): ${input.tests.summary}`,
            sourceAgent: author,
            tags: ["checkpoint"],
            importance: 4,
          },
          { latestTag: "checkpoint" },
        );
        this.db
          .prepare(
            "UPDATE memories SET evidence = NULL, stale = 0 WHERE id = ?",
          )
          .run(memory.id);
        if (input.tests.evidencePath)
          this.host.setMemoryEvidence(memory.id, {
            source: input.tests.evidencePath,
            observedAt: checkpoint.createdAt,
            commit: input.tests.commit,
          });
        return { checkpoint, changed: true };
      })
      .immediate();
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

  assertTaskDependencies(taskId: string, includeChildren = false): void {
    const contract = this.getTaskContract(taskId);
    if (!contract) throw new Error("Managed task contract required");
    const plan = this.getTaskDecomposition(taskId);
    if (plan && plan.parentVersion !== contract.version) throw new Error("Decomposition requires revision review");
    const ids = [...contract.dependsOn, ...(includeChildren ? plan?.children.map(child => child.taskId) ?? [] : [])];
    for (const id of ids) {
      if (this.getTask(id)?.status !== "done") throw new Error(`Unfinished task dependency: ${id}`);
      const dependency = this.getTaskContract(id);
      if (dependency) {
        const review = this.listManagedReviews(id)[0];
        if (!review || review.verdict !== "pass" || review.contractVersion !== dependency.version ||
            review.revision !== (this.getTask(id)?.revision ?? 0) ||
            !this.db.prepare("SELECT id FROM task_quality_reviews WHERE id = ? AND valid = 1").get(review.id))
          throw new Error(`Unaccepted task dependency: ${id}`);
      }
    }
  }

  private invalidateTaskDependents(taskId: string, seen = new Set<string>()): void {
    if (seen.has(taskId)) return;
    seen.add(taskId);
    const rows = this.db.prepare("SELECT task_id FROM task_contracts").all() as { task_id: string }[];
    for (const row of rows) {
      const id = row.task_id;
      if (seen.has(id)) continue;
      if (!this.getTaskContract(id)!.dependsOn.includes(taskId) &&
          !this.getTaskDecomposition(id)?.children.some(child => child.taskId === taskId)) continue;
      this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(id);
      this.db.prepare("UPDATE task_contracts SET version = version + 1, updated_at = ? WHERE task_id = ?").run(now(), id);
      this.db.prepare("UPDATE task_quality_reviews SET valid = 0 WHERE task_id = ?").run(id);
      this.db.prepare("UPDATE tasks SET status = 'blocked', status_reason = ?, updated_at = ? WHERE id = ? AND status IN ('in_progress','review','done')")
        .run(`Dependency changed: ${taskId}; reassess and collect fresh integration evidence`, now(), id);
      this.invalidateTaskDependents(id, seen);
    }
  }

  getTaskDecomposition(taskId: string): TaskDecomposition | undefined {
    const row = this.db.prepare("SELECT payload FROM task_decompositions WHERE task_id = ?").get(taskId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as TaskDecomposition : undefined;
  }

  setTaskDecomposition(plan: TaskDecomposition, agent: AgentKind, sessionId: string): TaskDecomposition {
    return this.db.transaction(() => {
      this.assertQualityOwner(plan.parentTaskId, agent, sessionId);
      if (!["todo", "in_progress"].includes(this.getTask(plan.parentTaskId)!.status))
        throw new Error("Decomposition requires an open parent");
      validateDecomposition(plan, this.getTaskContract(plan.parentTaskId)!, plan.children.map(child => ({
        taskId: child.taskId, ownerAgent: this.getTask(child.taskId)?.ownerAgent,
        contract: this.getTaskContract(child.taskId),
      })));
      for (const child of plan.children) {
        const seen = new Set<string>();
        const visit = (id: string): void => {
          if (id === plan.parentTaskId) throw new Error("Decomposition child cannot depend on its parent");
          if (seen.has(id)) return;
          seen.add(id);
          for (const next of this.getTaskContract(id)?.dependsOn ?? []) visit(next);
          for (const next of this.getTaskDecomposition(id)?.children ?? []) visit(next.taskId);
        };
        visit(child.taskId);
      }
      const old = this.getTaskDecomposition(plan.parentTaskId);
      const changed = old ? JSON.stringify(old) !== JSON.stringify(plan) : this.listCheckpoints(plan.parentTaskId, 1).length > 0;
      if (changed) {
        this.db.prepare("UPDATE task_contracts SET version = version + 1, updated_at = ? WHERE task_id = ?").run(now(), plan.parentTaskId);
        this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(plan.parentTaskId);
        this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(plan.parentTaskId);
        this.db.prepare("UPDATE task_quality_reviews SET valid = 0 WHERE task_id = ?").run(plan.parentTaskId);
        this.invalidateTaskDependents(plan.parentTaskId);
      }
      const current = { ...plan, parentVersion: this.getTaskContract(plan.parentTaskId)!.version };
      this.db.prepare("INSERT INTO task_decompositions (task_id,payload) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload")
        .run(plan.parentTaskId, JSON.stringify(current));
      return this.getTaskDecomposition(plan.parentTaskId)!;
    }).immediate();
  }

  getTaskContract(taskId: string): TaskContract | undefined {
    const row = this.db.prepare("SELECT * FROM task_contracts WHERE task_id = ?").get(taskId) as Row | undefined;
    if (!row) return undefined;
    return {
      taskId, scope: JSON.parse(String(row.scope)), constraints: JSON.parse(String(row.constraints)),
      acceptance: JSON.parse(String(row.acceptance)), checks: JSON.parse(String(row.checks)),
      dependsOn: JSON.parse(String(row.depends_on)), contextRefs: JSON.parse(String(row.context_refs)),
      version: Number(row.version), updatedAt: String(row.updated_at),
    };
  }

  setTaskContract(taskId: string, input: TaskContractInput, agent?: AgentKind, sessionId?: string): TaskContract {
    const array = (values: string[], name: string, required = false): string[] => {
      if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim()))
        throw new Error(`Invalid contract ${name}`);
      const unique = [...new Set(values.map(value => value.trim()))];
      if (required && !unique.length) throw new Error(`Contract ${name} is required`);
      return unique;
    };
    const spec = {
      scope: array(input.scope, "scope", true), constraints: array(input.constraints, "constraints"),
      acceptance: array(input.acceptance, "acceptance", true), checks: array(input.checks, "checks", true),
      dependsOn: array(input.dependsOn, "dependsOn"), contextRefs: array(input.contextRefs, "contextRefs"),
    };
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task?.goal?.trim()) throw new Error("Task goal is required for managed tasks");
      const claim = this.getTaskOwnerClaim(taskId);
      if (claim && (claim.agent !== agent || claim.sessionId !== sessionId))
        throw new Error("Claim owner/session mismatch for contract update");
      if (task.status === "done" || task.status === "review" || task.status === "cancelled")
        throw new Error("Contract cannot change during review or after completion");
      for (const dependency of spec.dependsOn) {
        if (dependency === taskId || !this.getTask(dependency)) throw new Error(`Invalid dependency: ${dependency}`);
        const seen = new Set<string>();
        const visit = (id: string): void => {
          if (id === taskId) throw new Error("Circular task dependency");
          if (seen.has(id)) return;
          seen.add(id);
          for (const next of this.getTaskContract(id)?.dependsOn ?? []) visit(next);
          for (const child of this.getTaskDecomposition(id)?.children ?? []) visit(child.taskId);
        };
        visit(dependency);
      }
      const version = (this.getTaskContract(taskId)?.version ?? 0) + 1;
      this.db.prepare(`INSERT INTO task_contracts
          (task_id,scope,constraints,acceptance,checks,depends_on,context_refs,version,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
          scope=excluded.scope,constraints=excluded.constraints,acceptance=excluded.acceptance,
          checks=excluded.checks,depends_on=excluded.depends_on,context_refs=excluded.context_refs,
          version=excluded.version,updated_at=excluded.updated_at`).run(
        taskId, JSON.stringify(spec.scope), JSON.stringify(spec.constraints), JSON.stringify(spec.acceptance),
        JSON.stringify(spec.checks), JSON.stringify(spec.dependsOn), JSON.stringify(spec.contextRefs), version, now(),
      );
      this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(taskId);
      this.invalidateTaskDependents(taskId);
      return this.getTaskContract(taskId)!;
    }).immediate();
  }

  getTaskOwnerClaim(taskId: string): TaskOwnerClaim | undefined {
    const row = this.db.prepare("SELECT * FROM task_owner_claims WHERE task_id = ?").get(taskId) as Row | undefined;
    return row ? { taskId, agent: String(row.agent) as TaskOwnerClaim["agent"],
      sessionId: String(row.session_id), claimedAt: String(row.claimed_at) } : undefined;
  }

  claimTask(taskId: string, agent: TaskOwnerClaim["agent"], sessionId: string): TaskOwnerClaim {
    if (!sessionId.trim()) throw new Error("Session ID is required");
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task || !this.getTaskContract(taskId)) throw new Error("Managed task contract required");
      if (task.status === "cancelled") throw new Error("Task is closed");
      if (task.ownerAgent && task.ownerAgent !== agent) throw new Error("Task owner differs from claimant");
      const old = this.getTaskOwnerClaim(taskId);
      if (old && (old.agent !== agent || old.sessionId !== sessionId)) throw new Error("Task already claimed by another session");
      if (!old) {
        this.db.prepare("INSERT INTO task_owner_claims (task_id, agent, session_id, claimed_at) VALUES (?,?,?,?)")
          .run(taskId, agent, sessionId, now());
        this.db.prepare("UPDATE tasks SET owner_agent = ?, updated_at = ? WHERE id = ?").run(agent, now(), taskId);
      }
      return this.getTaskOwnerClaim(taskId)!;
    }).immediate();
  }

  releaseTaskClaim(taskId: string, agent: TaskOwnerClaim["agent"], sessionId: string): void {
    this.db.transaction(() => {
      const claim = this.getTaskOwnerClaim(taskId);
      if (!claim || claim.agent !== agent || claim.sessionId !== sessionId) throw new Error("Claim owner/session mismatch");
      if (this.listTaskAttempts(taskId).some(attempt => !attempt.endedAt) ||
          this.db.prepare("SELECT id FROM agent_runs WHERE task_id = ? AND status NOT IN ('done','failed','stopped')").get(taskId) ||
          this.db.prepare("SELECT id FROM file_leases WHERE task_id = ? AND session_id = ? AND released_at IS NULL").get(taskId, sessionId))
        throw new Error("Stop run, checkpoint, end attempt and release leases before handing off claim");
      this.db.prepare("DELETE FROM task_owner_claims WHERE task_id = ?").run(taskId);
      this.db.prepare("UPDATE tasks SET owner_agent = NULL, updated_at = ? WHERE id = ?")
        .run(now(), taskId);
    }).immediate();
  }

  listTaskAcceptance(taskId: string): TaskAcceptanceProof[] {
    return (this.db.prepare("SELECT * FROM task_acceptance_proofs WHERE task_id = ? ORDER BY criterion")
      .all(taskId) as Row[]).map(row => ({ taskId, criterion: String(row.criterion),
      checkpointId: String(row.checkpoint_id), contractVersion: Number(row.contract_version),
      verifiedAt: String(row.verified_at) }));
  }

  private validatedTaskCheck(taskId: string, checkpointId: string, agent: AgentKind, sessionId: string):
    { contract: TaskContract; command: string } {
    const task = this.getTask(taskId);
    const contract = this.getTaskContract(taskId);
    if (!contract || task?.status !== "in_progress") throw new Error("Task must be in progress with a contract");
    const claim = this.getTaskOwnerClaim(taskId);
    if (!claim || claim.agent !== agent || claim.sessionId !== sessionId)
      throw new Error("Claim owner/session mismatch");
    const row = this.db.prepare("SELECT payload FROM checkpoints WHERE id = ? AND task_id = ?")
      .get(checkpointId, taskId) as { payload: string } | undefined;
    if (!row) throw new Error("Checkpoint does not belong to task");
    this.assertTaskDependencies(taskId, true);
    const proof = JSON.parse(row.payload) as CheckpointInput;
    const history = this.listCheckpoints(taskId, -1);
    const proofIndex = history.findIndex(checkpoint => checkpoint.id === checkpointId);
    const newer = history.slice(0, proofIndex);
    if (newer.some(checkpoint => checkpoint.tests.status === "failed"))
      throw new Error("Checkpoint predates a failed check; collect fresh evidence");
    const hashes = new Map<string, string | undefined>();
    for (const checkpoint of history.slice(proofIndex).reverse()) for (const file of checkpoint.files)
      hashes.set(file.path, file.hash);
    for (const checkpoint of [...newer].reverse()) for (const file of checkpoint.files) {
      if (hashes.has(file.path) && hashes.get(file.path) !== file.hash)
        throw new Error("Checkpoint predates a source revision change; collect fresh evidence");
      hashes.set(file.path, file.hash);
    }
    if (proof.contractVersion !== contract.version || proof.author !== agent ||
        proof.sessionId !== sessionId || proof.tests.status !== "passed" ||
        proof.tests.exitCode !== 0 || !proof.tests.evidencePath?.trim() ||
        !proof.tests.command || !contract.checks.includes(proof.tests.command))
      throw new Error("Verified check requires claimed session, passing command and evidence");
    return { contract, command: proof.tests.command };
  }

  verifyTaskAcceptance(taskId: string, criterion: string, checkpointId: string,
    agent: AgentKind, sessionId: string): TaskAcceptanceProof {
    return this.db.transaction(() => {
      const { contract } = this.validatedTaskCheck(taskId, checkpointId, agent, sessionId);
      if (!contract.acceptance.includes(criterion)) throw new Error("Criterion is not in task contract");
      this.db.prepare(`INSERT INTO task_acceptance_proofs
        (task_id,criterion,checkpoint_id,contract_version,verified_at) VALUES (?,?,?,?,?)
        ON CONFLICT(task_id,criterion) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,
        contract_version=excluded.contract_version,verified_at=excluded.verified_at`)
        .run(taskId, criterion, checkpointId, contract.version, now());
      return this.listTaskAcceptance(taskId).find(item => item.criterion === criterion)!;
    }).immediate();
  }

  listTaskChecks(taskId: string): TaskCheckProof[] {
    return (this.db.prepare("SELECT * FROM task_check_proofs WHERE task_id = ? ORDER BY command")
      .all(taskId) as Row[]).map(row => ({ taskId, command: String(row.command),
        checkpointId: String(row.checkpoint_id), contractVersion: Number(row.contract_version),
        verifiedAt: String(row.verified_at) }));
  }

  verifyTaskCheck(taskId: string, checkpointId: string, agent: AgentKind, sessionId: string): TaskCheckProof {
    return this.db.transaction(() => {
      const { contract, command } = this.validatedTaskCheck(taskId, checkpointId, agent, sessionId);
      this.db.prepare(`INSERT INTO task_check_proofs
        (task_id,command,checkpoint_id,contract_version,verified_at) VALUES (?,?,?,?,?)
        ON CONFLICT(task_id,command) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,
        contract_version=excluded.contract_version,verified_at=excluded.verified_at`)
        .run(taskId, command, checkpointId, contract.version, now());
      return this.listTaskChecks(taskId).find(item => item.command === command)!;
    }).immediate();
  }

  listManagedReviews(taskId: string): ManagedReview[] {
    return (this.db.prepare("SELECT payload FROM task_quality_reviews WHERE task_id = ? ORDER BY rowid DESC")
      .all(taskId) as { payload: string }[]).map(row => JSON.parse(row.payload) as ManagedReview);
  }

  getTaskRetryPolicy(taskId: string): TaskRetryPolicy | undefined {
    const row = this.db.prepare("SELECT payload FROM task_retry_policies WHERE task_id = ?").get(taskId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as TaskRetryPolicy : undefined;
  }

  listTaskAttempts(taskId: string): TaskAttempt[] {
    return (this.db.prepare("SELECT payload FROM task_attempts WHERE task_id = ? ORDER BY rowid")
      .all(taskId) as { payload: string }[]).map(row => JSON.parse(row.payload) as TaskAttempt);
  }

  private assertQualityOwner(taskId: string, agent: AgentKind, sessionId: string): void {
    const claim = this.getTaskOwnerClaim(taskId);
    if (!claim || claim.agent !== agent || claim.sessionId !== sessionId) throw new Error("Claim owner/session mismatch");
    if (!this.getTaskContract(taskId)) throw new Error("Managed task contract required");
  }

  setTaskRetryPolicy(taskId: string, kind: TaskRetryKind, agent: AgentKind, sessionId: string): TaskRetryPolicy {
    return this.db.transaction(() => {
      this.assertQualityOwner(taskId, agent, sessionId);
      if (this.listTaskAttempts(taskId).length || !["todo", "in_progress"].includes(this.getTask(taskId)!.status))
        throw new Error("Retry policy must be fixed before the first attempt");
      const policy = taskRetryPolicy(kind);
      this.db.prepare("INSERT INTO task_retry_policies (task_id, payload) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload")
        .run(taskId, JSON.stringify(policy));
      return policy;
    }).immediate();
  }

  beginTaskAttempt(taskId: string, operation: string, hypothesis: string, agent: AgentKind, sessionId: string): TaskAttempt {
    return this.db.transaction(() => {
      this.assertQualityOwner(taskId, agent, sessionId);
      if (this.getTask(taskId)?.status !== "in_progress") throw new Error("Task must be in progress");
      this.assertTaskDependencies(taskId);
      const policy = this.getTaskRetryPolicy(taskId);
      if (!policy) throw new Error("Set retry policy before starting attempts");
      const attempts = this.listTaskAttempts(taskId);
      if (attempts.some(attempt => !attempt.endedAt)) throw new Error("An attempt is already running; checkpoint and end it before recovery");
      const limit = taskRetryLimit(policy, attempts);
      const previous = attempts.at(-1);
      const changedDirection = limit === "Repeated failure limit reached" && previous?.operation !== operation.trim() &&
        (previous?.decision === "change_direction" || previous?.decision === "escalate");
      if (limit && !changedDirection) throw new Error(limit);
      if (!operation.trim() || !hypothesis.trim()) throw new Error("Attempt requires operation and hypothesis");
      const attempt: TaskAttempt = { id: randomUUID(), taskId, operation: operation.trim(), hypothesis: hypothesis.trim(), sessionId, startedAt: now(), tokens: null };
      this.db.prepare("INSERT INTO task_attempts (id, task_id, payload) VALUES (?, ?, ?)").run(attempt.id, taskId, JSON.stringify(attempt));
      return attempt;
    }).immediate();
  }

  endTaskAttempt(taskId: string, attemptId: string, input: EndTaskAttemptInput, agent: AgentKind, sessionId: string): TaskAttempt {
    return this.db.transaction(() => {
      this.assertQualityOwner(taskId, agent, sessionId);
      const attempts = this.listTaskAttempts(taskId);
      const attempt = attempts.find(item => item.id === attemptId);
      if (!attempt || attempt.endedAt) throw new Error("Running task attempt required");
      if (!input.reason?.trim() || !["progressed", "failed", "blocked"].includes(input.outcome) ||
          !["continue", "change_direction", "escalate", "blocked"].includes(input.decision) ||
          input.tokens !== null && (!Number.isSafeInteger(input.tokens) || input.tokens < 0)) throw new Error("Invalid attempt outcome, reason, decision or token usage");
      const checkpoint = this.listCheckpoints(taskId, 1)[0];
      if (!checkpoint || checkpoint.id !== input.checkpointId || checkpoint.author !== agent || checkpoint.sessionId !== sessionId ||
          checkpoint.contractVersion !== this.getTaskContract(taskId)!.version || Date.parse(checkpoint.createdAt) < Date.parse(attempt.startedAt))
        throw new Error("Attempt requires a current owner checkpoint with hypothesis, evidence and next step");
      if (!checkpoint.next.length || !checkpoint.summary.trim()) throw new Error("Attempt checkpoint requires summary and next step");
      Object.assign(attempt, input, { endedAt: now() });
      const limit = taskRetryLimit(this.getTaskRetryPolicy(taskId)!, attempts);
      if (limit && input.decision === "continue") throw new Error(`${limit}; choose change_direction, escalate or blocked`);
      this.db.prepare("UPDATE task_attempts SET payload = ? WHERE id = ?").run(JSON.stringify(attempt), attemptId);
      if (limit || input.decision === "blocked") this.transitionManagedTask(taskId, "blocked", agent, sessionId, limit ?? input.reason);
      return attempt;
    }).immediate();
  }

  recordManagedReview(taskId: string, input: ManagedReviewInput, agent: AgentKind, sessionId: string): ManagedReview {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      const contract = this.getTaskContract(taskId);
      const claim = this.getTaskOwnerClaim(taskId);
      if (!claim || claim.agent !== agent || claim.sessionId !== sessionId) throw new Error("Claim owner/session mismatch");
      if (!contract || task?.status !== "review") throw new Error("Task must be in review");
      if (!["pass", "rework", "blocked"].includes(input.verdict) || !input.reason?.trim() ||
          !input.diffRef?.trim() || !input.reviewerSession?.trim() || !Array.isArray(input.limitations) ||
          input.limitations.some(item => typeof item !== "string")) throw new Error("Review requires verdict, reason, diff, reviewer and limitations");
      if (contract.scope.length > 1 && input.reviewerSession === sessionId) throw new Error("Multi-scope task requires an independent reviewer session");
      const checkpoint = this.listCheckpoints(taskId, 1)[0];
      if (!checkpoint || checkpoint.id !== input.checkpointId || checkpoint.contractVersion !== contract.version)
        throw new Error("Review requires the current checkpoint and contract revision");
      const review: ManagedReview = { ...input, id: randomUUID(), taskId, contractVersion: contract.version,
        revision: task.revision ?? 0, createdAt: now() };
      this.db.prepare("INSERT INTO task_quality_reviews (id, task_id, payload) VALUES (?, ?, ?)")
        .run(review.id, taskId, JSON.stringify(review));
      if (input.verdict !== "pass") this.transitionManagedTask(taskId, input.verdict === "rework" ? "in_progress" : "blocked", agent, sessionId, input.reason);
      return review;
    }).immediate();
  }

  transitionManagedTask(taskId: string, target: TaskStatus, agent: TaskOwnerClaim["agent"],
    sessionId: string, reason?: string): Task {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      const contract = this.getTaskContract(taskId);
      if (!task || !contract) throw new Error("Managed task contract required");
      const claim = this.getTaskOwnerClaim(taskId);
      if (!claim || claim.agent !== agent || claim.sessionId !== sessionId) throw new Error("Claim owner/session mismatch");
      const allowed: Record<TaskStatus, TaskStatus[]> = {
        todo: ["in_progress", "blocked", "cancelled"],
        in_progress: ["review", "blocked", "cancelled"],
        review: ["done", "in_progress", "blocked"],
        blocked: ["in_progress", "cancelled"], done: ["in_progress"], cancelled: [],
      };
      if (!allowed[task.status]?.includes(target)) throw new Error(`Invalid task transition: ${task.status} -> ${target}`);
      if ((target === "review" || target === "done") && this.listTaskAttempts(taskId).some(attempt => !attempt.endedAt))
        throw new Error("End the running attempt before review or completion");
      if (task.status === "done" && !reason?.trim()) throw new Error("Reopen reason is required");
      if (["in_progress", "review", "done"].includes(target)) this.assertTaskDependencies(taskId, target !== "in_progress");
      if ((target === "blocked" || target === "in_progress" && task.status === "review") && !reason?.trim())
        throw new Error("Reason is required for blocked or rejected review");
      if (target === "in_progress" && (task.status === "todo" || task.status === "blocked")) {
        if (!task.goal?.trim() || !contract.scope.length || !contract.acceptance.length || !contract.checks.length)
          throw new Error("Task requirements missing");
        const deps = contract.dependsOn.map(id => this.getTask(id));
        if (deps.some(dep => dep?.status !== "done")) throw new Error("Unfinished task dependency");
      }
      if (target === "done") {
        const proofs = this.listTaskAcceptance(taskId);
        if (!contract.acceptance.every(criterion => proofs.some(p => p.criterion === criterion && p.contractVersion === contract.version)))
          throw new Error("Acceptance criteria lack verified checks");
        const checks = this.listTaskChecks(taskId);
        if (!contract.checks.every(command => checks.some(p => p.command === command && p.contractVersion === contract.version)))
          throw new Error("Required task checks lack verified evidence");
        const review = this.listManagedReviews(taskId)[0];
        if (!review || review.verdict !== "pass" || review.contractVersion !== contract.version || review.revision !== (task.revision ?? 0))
          throw new Error("Current revision requires a passing review");
        if (!this.db.prepare("SELECT id FROM task_quality_reviews WHERE id = ? AND valid = 1").get(review.id))
          throw new Error("Current revision requires a passing review");
      }
      if ((task.status === "review" || task.status === "done") && target === "in_progress") {
        this.invalidateTaskDependents(taskId);
        this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(taskId);
      }
      if ((task.status === "review" || task.status === "done") && target !== "done")
        this.db.prepare("UPDATE task_quality_reviews SET valid = 0 WHERE task_id = ?").run(taskId);
      this.db.prepare("UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?")
        .run(target, target === "blocked" || task.status === "review" && target === "in_progress" ? reason?.trim() ?? null : null, now(), taskId);
      return this.getTask(taskId)!;
    }).immediate();
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toTask(row) : undefined;
  }

  updateTaskStatus(id: string, status: Task["status"]): Task | undefined {
    return this.db.transaction(() => {
      if (this.getTaskContract(id) && this.getTask(id)?.status !== status)
        throw new Error("Managed task status requires an owner-verified transition");
      if (status !== "done" && this.getTask(id)?.status === "done") this.invalidateTaskDependents(id);
      this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now(), id);
      return this.getTask(id);
    }).immediate();
  }

  updateTask(id: string, input: UpdateTaskInput): Task | undefined {
    return this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) return undefined;
      const contract = this.getTaskContract(id);
      const goalChanged = input.goal !== undefined && input.goal !== current.goal;
      if (contract) {
        const claim = this.getTaskOwnerClaim(id);
        if (claim && (input.title !== undefined || input.goal !== undefined || input.ownerAgent !== undefined) &&
            (input.ownerAgent !== claim.agent || input.sessionId !== claim.sessionId))
          throw new Error("Claim owner/session mismatch for managed task update");
        if (input.status !== undefined && input.status !== current.status)
          throw new Error("Managed task status requires an owner-verified transition");
        if (input.ownerAgent !== undefined && input.ownerAgent !== current.ownerAgent)
          throw new Error("Managed task owner must be changed through a claim");
        if (goalChanged && ["review", "done", "cancelled"].includes(current.status))
          throw new Error("Managed task goal cannot change during review or after completion");
        if (goalChanged && !input.goal?.trim())
          throw new Error("Managed task goal is required");
      }
      if (!contract && current.status === "done" && input.status !== undefined && input.status !== "done") this.invalidateTaskDependents(id);
      const next = {
        id,
        title: input.title ?? current.title,
        goal: input.goal ?? current.goal,
        status: input.status ?? current.status,
        ownerAgent: input.ownerAgent ?? current.ownerAgent,
        updatedAt: now(),
      };
      this.db.prepare(`UPDATE tasks
         SET title = @title, goal = @goal, status = @status, owner_agent = @ownerAgent, updated_at = @updatedAt
         WHERE id = @id`).run(next);
      if (contract && goalChanged) {
        this.invalidateTaskDependents(id);
        this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(id);
        this.db.prepare("UPDATE task_contracts SET version = version + 1, updated_at = ? WHERE task_id = ?")
          .run(now(), id);
      }
      return this.getTask(id);
    }).immediate();
  }

  deleteTask(id: string): boolean {
    const exists = Boolean(this.getTask(id));
    if (!exists) return false;
    const tx = this.db.transaction(() => {
      const refs = this.db.prepare("SELECT task_id FROM task_contracts WHERE task_id != ?").all(id) as { task_id: string }[];
      if (refs.some(row => this.getTaskContract(row.task_id)!.dependsOn.includes(id) ||
          this.getTaskDecomposition(row.task_id)?.children.some(child => child.taskId === id)))
        throw new Error("Task is referenced by dependency or decomposition");
      this.db.prepare("DELETE FROM task_acceptance_proofs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM task_check_proofs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM memories WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(id);
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

  listLatestTaskHandoffs(
    limit = 50,
    offset = 0,
  ): Array<{ task: Task; handoff: Handoff }> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid handoff pagination");
    const rows = this.db
      .prepare(
        `SELECT h.*, t.title AS task_title, t.goal AS task_goal,
      t.status AS task_status, t.owner_agent AS task_owner_agent, t.created_at AS task_created_at,
      t.updated_at AS task_updated_at, t.revision AS task_revision
      FROM handoffs h JOIN tasks t ON t.id = h.task_id
      WHERE h.id = (SELECT latest.id FROM handoffs latest WHERE latest.task_id = h.task_id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
      ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Row[];
    return rows.map((row) => ({
      handoff: toHandoff(row),
      task: toTask({
        id: row.task_id,
        title: row.task_title,
        goal: row.task_goal,
        status: row.task_status,
        owner_agent: row.task_owner_agent,
        created_at: row.task_created_at,
        updated_at: row.task_updated_at,
        revision: row.task_revision,
      }),
    }));
  }

  getDecision(id: string, taskId: string): Decision | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM decisions WHERE id = ? AND task_id = ? AND superseded_by IS NULL",
      )
      .get(id, taskId) as Row | undefined;
    return row ? toDecision(row) : undefined;
  }

  listDecisions(taskId: string): Decision[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM decisions WHERE task_id = ? AND superseded_by IS NULL ORDER BY created_at DESC",
        )
        .all(taskId) as Row[]
    ).map(toDecision);
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

  upsertAutoHandoff(input: CreateHandoffInput): Handoff {
    this.db
      .prepare("DELETE FROM handoffs WHERE task_id = ? AND auto = 1")
      .run(input.taskId);
    return this.createHandoff({ ...input, auto: true });
  }

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
}
