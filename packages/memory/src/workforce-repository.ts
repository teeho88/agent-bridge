import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { FINISHED_ORCHESTRATION_STATUSES } from "./types.js";

import type {
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
} from "./types.js";
import {
  now,
  toRegisteredAgent,
  toCredentialRef,
  toWorkforceRole,
  toWorkforce,
  toWorkforceMember,
  toSubtask,
  normalizeSubtaskStatusReason,
  toAssignment,
  toDispatchRun,
  toAgentRun,
  toOrchestration,
  escapeLike,
  toOrchestrationEvent,
  toReview,
} from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class WorkforceRepository {
  constructor(
    private db: Database.Database,
    private host: object,
  ) {}

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
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
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

  deleteRegisteredAgent(id: string): boolean {
    const agent = this.getRegisteredAgent(id);
    if (!agent) return false;
    // Archiving the leader of a run that is still going leaves every step
    // throwing "Registered agent not found", and nothing in the UI could undo
    // it. Point the orchestration at another leader first.
    const leading = this.listOrchestrations({
      leaderAgentId: id,
      limit: 50,
    }).filter(
      (orchestration) =>
        !FINISHED_ORCHESTRATION_STATUSES.has(orchestration.status),
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
      this.db
        .prepare("DELETE FROM workforce_members WHERE agent_id = ?")
        .run(id);
      this.db
        .prepare(
          "UPDATE agents SET name = ?, enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?",
        )
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
    const row = this.db
      .prepare("SELECT * FROM roles WHERE name = ?")
      .get(input.name) as Row;
    return toWorkforceRole(row);
  }

  listWorkforceRoles(): WorkforceRole[] {
    return (
      this.db
        .prepare("SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY name")
        .all() as Row[]
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
    const row = this.db
      .prepare("SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
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

  deleteWorkforceRole(id: string): boolean {
    const role = this.getWorkforceRole(id);
    if (!role) return false;
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM workforce_members WHERE role_id = ?")
        .run(id);
      this.db
        .prepare(
          "UPDATE roles SET name = ?, deleted_at = ?, updated_at = ? WHERE id = ?",
        )
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
    const row = this.db
      .prepare("SELECT * FROM workforces WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toWorkforce(row) : undefined;
  }

  updateWorkforce(
    id: string,
    input: UpdateWorkforceInput,
  ): Workforce | undefined {
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

  deleteWorkforce(id: string): boolean {
    if (!this.getWorkforce(id)) return false;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE assignments SET workforce_id = NULL WHERE workforce_id = ?",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE dispatch_runs SET workforce_id = NULL WHERE workforce_id = ?",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM workforce_members WHERE workforce_id = ?")
        .run(id);
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
        enabled: (input.enabled ?? true) ? 1 : 0,
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
    return (
      this.db.prepare("DELETE FROM workforce_members WHERE id = ?").run(id)
        .changes > 0
    );
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
    const reasonInput =
      input.status && input.status !== current.status
        ? input.statusReason
        : (input.statusReason ?? current.statusReason);
    const statusReason = normalizeSubtaskStatusReason(nextStatus, reasonInput);
    const next: Subtask = {
      ...current,
      title: input.title ?? current.title,
      goal: input.goal ?? current.goal,
      status: nextStatus,
      statusReason,
      priority: input.priority ?? current.priority,
      createdByAssignmentId:
        input.createdByAssignmentId ?? current.createdByAssignmentId,
      dependsOn: input.dependsOn ?? current.dependsOn,
      acceptanceCriteria:
        input.acceptanceCriteria ?? current.acceptanceCriteria,
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
    options: {
      parentTaskId?: string;
      status?: SubtaskStatus;
      limit?: number;
    } = {},
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
    const row = this.db
      .prepare("SELECT * FROM subtasks WHERE id = ?")
      .get(id) as Row | undefined;
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
    const row = this.db
      .prepare("SELECT * FROM assignments WHERE id = ?")
      .get(id) as Row | undefined;
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
    options: {
      taskId?: string;
      status?: DispatchRunStatus;
      limit?: number;
    } = {},
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
    const row = this.db
      .prepare("SELECT * FROM dispatch_runs WHERE id = ?")
      .get(id) as Row | undefined;
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
    const row = this.db
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as Row | undefined;
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
      restartedFromRunId:
        input.restartedFromRunId ?? current.restartedFromRunId,
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
        .prepare(
          `SELECT * FROM agent_runs ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
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
    const row = this.db
      .prepare("SELECT * FROM orchestrations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toOrchestration(row) : undefined;
  }

  getOrchestrationByTask(taskId: string): Orchestration | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM orchestrations WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as Row | undefined;
    return row ? toOrchestration(row) : undefined;
  }

  updateOrchestration(
    id: string,
    input: UpdateOrchestrationInput,
  ): Orchestration | undefined {
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
      lastError:
        input.lastError === undefined
          ? current.lastError
          : (input.lastError ?? undefined),
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

  incrementOrchestrationMaxCycles(
    id: string,
    delta: number,
  ): Orchestration | undefined {
    if (!Number.isInteger(delta) || delta < 1 || delta > 100) {
      throw new Error("Cycle increment must be an integer from 1 to 100.");
    }
    const result = this.db
      .prepare(
        `UPDATE orchestrations
         SET max_cycles = max_cycles + @delta, updated_at = @updatedAt
         WHERE id = @id AND max_cycles + @delta <= 1000`,
      )
      .run({ id, delta, updatedAt: now() });
    if (result.changes === 0) {
      const current = this.getOrchestration(id);
      if (!current) return undefined;
      throw new Error("Total cycle limit cannot exceed 1000.");
    }
    return this.getOrchestration(id);
  }

  listOrchestrations(
    options: {
      status?: OrchestrationStatus;
      leaderAgentId?: string;
      limit?: number;
    } = {},
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
        .prepare(
          `SELECT * FROM orchestrations ${where} ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toOrchestration);
  }

  recordOrchestrationEvent(
    input: RecordOrchestrationEventInput,
  ): OrchestrationEvent {
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
      .run({
        ...event,
        summary: event.summary ?? null,
        payload: event.payload ?? null,
      });
    return event;
  }

  listOrchestrationEvents(options: {
    orchestrationId: string;
    limit?: number;
    kind?: OrchestrationEventKind;
    summaryPrefix?: string;
  }): OrchestrationEvent[] {
    // Filtering in SQL rather than after the fact: an orchestration that ran
    // for a few cycles accumulates thousands of events, and a caller looking
    // for the handful of plan-meta rows among them would otherwise have to
    // guess a limit big enough to still contain the oldest one.
    const filters = ["orchestration_id = @orchestrationId"];
    if (options.kind) filters.push("kind = @kind");
    if (options.summaryPrefix)
      filters.push("summary LIKE @summaryPrefix ESCAPE '\\'");
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
          summaryPrefix: options.summaryPrefix
            ? `${escapeLike(options.summaryPrefix)}%`
            : null,
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
    options: {
      taskId?: string;
      subtaskId?: string;
      consumed?: boolean;
      limit?: number;
    } = {},
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
      filters.push(
        options.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL",
      );
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM reviews ${where} ORDER BY created_at DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(toReview);
  }

  markReviewConsumed(id: string): Review | undefined {
    this.db
      .prepare("UPDATE reviews SET consumed_at = @consumedAt WHERE id = @id")
      .run({
        id,
        consumedAt: now(),
      });
    const row = this.db
      .prepare("SELECT * FROM reviews WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toReview(row) : undefined;
  }
}
