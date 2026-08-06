import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "./sqlite-store.js";
import { schemaStatements } from "./schema.js";

describe("SQLiteMemoryStore", () => {
  it("removes the legacy graph file importance column during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(path);
    try {
      store.close();
      const db = new Database(path, { readonly: true });
      try {
        const columns = (
          db.prepare("PRAGMA table_info(files)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name);
        expect(columns).toContain("manual_priority");
        expect(columns).not.toContain("importance");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repoints antigravity agents from the IDE launcher to the headless agy binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    try {
      const store = new SQLiteMemoryStore(path);
      let staleId: string;
      let customId: string;
      try {
        // Rows written before the provider's command was corrected. `antigravity`
        // is the IDE launcher and is not on PATH: spawning one died with
        // "spawn antigravity ENOENT" before the agent ever started.
        staleId = store.createRegisteredAgent({ name: "agy-old", provider: "antigravity", mode: "cli", command: "antigravity" }).id;
        customId = store.createRegisteredAgent({ name: "agy-custom", provider: "antigravity", mode: "cli", command: "C:/tools/agy.exe" }).id;
        // Force the migration to re-run against these rows.
        const db = new Database(path);
        try {
          db.pragma("user_version = 21");
          db.prepare("UPDATE agents SET command = 'antigravity' WHERE id = ?").run(staleId);
        } finally {
          db.close();
        }
      } finally {
        store.close();
      }

      const reopened = new SQLiteMemoryStore(path);
      try {
        expect(reopened.getRegisteredAgent(staleId)?.command).toBe("agy");
        // A hand-set path is a deliberate override, not stale data.
        expect(reopened.getRegisteredAgent(customId)?.command).toBe("C:/tools/agy.exe");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates tasks and searches memories", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Fix login session persistence",
        goal: "User remains logged in after refresh",
        ownerAgent: "claude",
      });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Cookie exists but session is not restored after refresh",
        tags: ["auth", "cookie"],
        importance: 5,
      });

      const results = store.searchMemories("session cookie", {
        taskId: task.id,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe("bug");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps repository memory separate from task memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Task", ownerAgent: "codex" });
      store.addMemory({
        type: "constraint",
        content: "Repo-wide rule",
        importance: 5,
      });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "Task-only state",
        importance: 3,
      });

      expect(store.listRepoMemories()).toHaveLength(1);
      expect(store.listRepoMemories()[0]?.content).toBe("Repo-wide rule");
      expect(store.listMemoriesForTask(task.id)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records independent session events and promotes reviewed repository knowledge", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const first = store.createTask({
        title: "First concurrent task",
        ownerAgent: "claude",
      });
      const second = store.createTask({
        title: "Second concurrent task",
        ownerAgent: "claude",
      });
      store.recordSessionEvent({
        sessionId: "session-a",
        taskId: first.id,
        agent: "claude",
        kind: "session_started",
      });
      store.recordSessionEvent({
        sessionId: "session-b",
        taskId: second.id,
        agent: "claude",
        kind: "session_started",
      });
      store.recordSessionEvent({
        sessionId: "session-a",
        taskId: first.id,
        agent: "claude",
        kind: "session_ended",
      });

      expect(
        store.listActiveSessionEvents().map((event) => event.taskId),
      ).toEqual([second.id]);

      const candidate = store.createMemoryCandidate({
        taskId: second.id,
        type: "decision",
        content: "Use event-derived state for concurrent sessions.",
        importance: 5,
        tags: ["architecture"],
        sourceAgent: "claude",
      });
      expect(store.listMemoryCandidates()).toHaveLength(1);
      expect(store.reviewMemoryCandidate(candidate.id, "promote")?.status).toBe(
        "promoted",
      );
      expect(store.listRepoMemories()[0]?.content).toContain(
        "event-derived state",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat stop requests as active sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Stopped task",
        ownerAgent: "codex",
      });
      store.recordSessionEvent({
        sessionId: "session-a",
        taskId: task.id,
        agent: "codex",
        kind: "session_started",
      });
      store.recordSessionEvent({
        sessionId: "session-a",
        taskId: task.id,
        agent: "codex",
        kind: "stop_requested",
      });

      expect(store.listActiveSessionEvents()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("records workforce agents, roles, subtasks, assignments, and dispatch runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const credential = store.createCredentialRef({
        provider: "deepseek",
        kind: "env",
        ref: "DEEPSEEK_API_KEY",
      });
      const agent = store.createRegisteredAgent({
        name: "deepseek-researcher",
        provider: "deepseek",
        mode: "api",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        credentialRef: credential.id,
        capabilities: ["research", "implement"],
      });
      expect(agent.enabled).toBe(true);
      expect(store.listRegisteredAgents({ provider: "deepseek" })).toHaveLength(1);
      expect(store.updateRegisteredAgent(agent.id, { enabled: false })?.enabled).toBe(false);

      const roles = store.ensureDefaultWorkforceRoles();
      const implementer = roles.find((role) => role.name === "implementer")!;
      expect(implementer.permissions).toContain("edit");

      const workforce = store.createWorkforce({ name: "Default Engineering Team" });
      const member = store.addWorkforceMember({
        workforceId: workforce.id,
        agentId: agent.id,
        roleId: implementer.id,
        priority: 5,
      });
      expect(member.enabled).toBe(true);
      expect(store.listWorkforceMembers(workforce.id)[0]?.priority).toBe(5);
      expect(store.deleteWorkforceMember(member.id)).toBe(true);
      expect(store.listWorkforceMembers(workforce.id)).toHaveLength(0);
      store.addWorkforceMember({ workforceId: workforce.id, agentId: agent.id, roleId: implementer.id, priority: 5 });

      const task = store.createTask({ title: "Build workforce layer", ownerAgent: "codex" });
      const subtask = store.createSubtask({
        parentTaskId: task.id,
        title: "Implement agent registry",
        acceptanceCriteria: ["agent add/list/test can be built on store methods"],
      });
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(1);
      expect(store.updateSubtask(subtask.id, { status: "assigned" })?.status).toBe("assigned");

      const assignment = store.createAssignment({
        taskId: task.id,
        subtaskId: subtask.id,
        workforceId: workforce.id,
        agentId: agent.id,
        roleId: implementer.id,
        prompt: "Implement the registry store methods.",
      });
      expect(store.listAssignments({ taskId: task.id, status: "queued" })).toHaveLength(1);
      expect(store.deleteWorkforceRole(implementer.id)).toBe(true);
      expect(store.listWorkforceRoles().some((role) => role.id === implementer.id)).toBe(false);
      expect(store.listAssignments({ taskId: task.id })[0]?.roleId).toBe(implementer.id);
      expect(
        store.updateAssignment(assignment.id, {
          status: "done",
          resultSummary: "Registry foundations are in place.",
        })?.resultSummary,
      ).toContain("foundations");

      const dispatch = store.createDispatchRun({
        taskId: task.id,
        workforceId: workforce.id,
        mode: "dry-run",
        status: "awaiting_approval",
        planSummary: "One implementer assignment proposed.",
      });
      expect(store.listDispatchRuns({ taskId: task.id })).toHaveLength(1);
      expect(store.updateDispatchRun(dispatch.id, { status: "completed" })?.status).toBe("completed");

      expect(store.deleteTask(task.id)).toBe(true);
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(0);
      expect(store.listAssignments({ taskId: task.id })).toHaveLength(0);
      expect(store.listDispatchRuns({ taskId: task.id })).toHaveLength(0);
      expect(store.listWorkforces()).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a workforce that still has assignments and dispatch runs, unlinking them instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "codex-agent", provider: "codex", mode: "cli", command: "codex" });
      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const workforce = store.createWorkforce({ name: "Team To Delete" });
      store.addWorkforceMember({ workforceId: workforce.id, agentId: agent.id, roleId: implementerRole.id });
      const task = store.createTask({ title: "Task with a linked team", ownerAgent: "codex" });
      const assignment = store.createAssignment({
        taskId: task.id,
        workforceId: workforce.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Do the thing.",
      });
      const dispatchRun = store.createDispatchRun({ taskId: task.id, workforceId: workforce.id });

      expect(store.deleteWorkforce(workforce.id)).toBe(true);

      expect(store.listWorkforces().some((candidate) => candidate.id === workforce.id)).toBe(false);
      expect(store.listWorkforceMembers(workforce.id)).toHaveLength(0);
      const survivingAssignment = store.listAssignments({ taskId: task.id }).find((candidate) => candidate.id === assignment.id);
      expect(survivingAssignment).toBeDefined();
      expect(survivingAssignment?.workforceId).toBeUndefined();
      const survivingDispatchRun = store.listDispatchRuns({ taskId: task.id }).find((candidate) => candidate.id === dispatchRun.id);
      expect(survivingDispatchRun).toBeDefined();
      expect(survivingDispatchRun?.workforceId).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a registered agent that already has assignments/agent_runs, archiving instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "codex-agent", provider: "codex", mode: "cli", command: "codex" });
      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const workforce = store.createWorkforce({ name: "Team With Deleted Agent" });
      store.addWorkforceMember({ workforceId: workforce.id, agentId: agent.id, roleId: implementerRole.id });
      const task = store.createTask({ title: "Task with a deleted agent", ownerAgent: "codex" });
      const assignment = store.createAssignment({
        taskId: task.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Do the thing.",
      });
      store.createAgentRun({ taskId: task.id, assignmentId: assignment.id, agentId: agent.id });

      expect(store.deleteRegisteredAgent(agent.id)).toBe(true);

      expect(store.getRegisteredAgent(agent.id)).toBeUndefined();
      expect(store.listRegisteredAgents({ limit: 500 }).some((candidate) => candidate.id === agent.id)).toBe(false);
      expect(store.listWorkforceMembers(workforce.id)).toHaveLength(0);
      // Historical rows survive untouched; agent_id/leader_agent_id-style FKs
      // are NOT NULL so they cannot be unlinked the way workforce_id can.
      expect(store.listAssignments({ taskId: task.id })[0]?.agentId).toBe(agent.id);

      // Archiving frees the original name for reuse.
      const recreated = store.createRegisteredAgent({ name: "codex-agent", provider: "codex", mode: "cli", command: "codex" });
      expect(recreated.id).not.toBe(agent.id);

      expect(store.deleteRegisteredAgent("agent-does-not-exist")).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes agent requests individually and in bulk", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Task with stale requests", ownerAgent: "codex" });
      const first = store.createAgentRequest({ taskId: task.id, type: "question", title: "Stale question 1" });
      const second = store.createAgentRequest({ taskId: task.id, type: "question", title: "Stale question 2" });
      const third = store.createAgentRequest({ taskId: task.id, type: "approval", title: "Stale approval" });

      expect(store.deleteAgentRequest(first.id)).toBe(true);
      expect(store.listAgentRequests({ taskId: task.id })).toHaveLength(2);
      expect(store.deleteAgentRequest(first.id)).toBe(false);

      expect(store.deleteAgentRequests([second.id, third.id])).toBe(2);
      expect(store.listAgentRequests({ taskId: task.id })).toHaveLength(0);
      expect(store.deleteAgentRequests([])).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not null out unspecified fields when update input carries an explicit undefined key", () => {
    // Regression test: partial-update helpers must fall back to the current
    // value field-by-field rather than spreading `input` over `current` — a
    // caller-side object literal like { name: undefined, model: 'x' } (e.g.
    // an unset CLI option) previously nulled out NOT NULL columns and threw
    // "NOT NULL constraint failed".
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "codex-agent", provider: "codex", mode: "cli", command: "codex" });
      const updatedAgent = store.updateRegisteredAgent(agent.id, { name: undefined, model: "gpt-5.6" });
      expect(updatedAgent?.name).toBe("codex-agent");
      expect(updatedAgent?.model).toBe("gpt-5.6");

      const task = store.createTask({ title: "Task", ownerAgent: "codex" });
      const subtask = store.createSubtask({ parentTaskId: task.id, title: "Original title", acceptanceCriteria: ["a"] });
      const updatedSubtask = store.updateSubtask(subtask.id, { title: undefined, status: "in_progress" });
      expect(updatedSubtask?.title).toBe("Original title");
      expect(updatedSubtask?.status).toBe("in_progress");
      expect(updatedSubtask?.acceptanceCriteria).toEqual(["a"]);

      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const assignment = store.createAssignment({ taskId: task.id, agentId: agent.id, roleId: implementerRole.id, prompt: "Original prompt" });
      const updatedAssignment = store.updateAssignment(assignment.id, { prompt: undefined, status: "running" });
      expect(updatedAssignment?.prompt).toBe("Original prompt");
      expect(updatedAssignment?.status).toBe("running");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks agent runs, orchestrations, and reviews for the leader-driven workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const columns = (
        store as unknown as { db: Database.Database }
      ).db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("pid");
      expect(columns.map((column) => column.name)).not.toContain("api_key");

      const leader = store.createRegisteredAgent({
        name: "codex-leader",
        provider: "codex",
        mode: "cli",
        command: "codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
      });
      const implementer = store.createRegisteredAgent({
        name: "codex-implementer",
        provider: "codex",
        mode: "cli",
        command: "codex",
      });
      const roles = store.ensureDefaultWorkforceRoles();
      expect(roles.some((role) => role.name === "reporter")).toBe(true);
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const task = store.createTask({ title: "Ship report module", ownerAgent: "codex" });

      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
        maxParallel: 2,
        teamProviders: ["codex", "claude"],
      });
      expect(orchestration.status).toBe("planning");
      expect(orchestration.cycle).toBe(0);
      expect(store.getOrchestrationByTask(task.id)?.id).toBe(orchestration.id);
      // The allowlist has to survive the round trip: it is read on every
      // planning turn to decide which providers the leader may staff from.
      expect(store.getOrchestration(orchestration.id)?.teamProviders).toEqual(["codex", "claude"]);
      expect(
        store.getOrchestration(
          store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id }).id,
        )?.teamProviders,
      ).toBeUndefined();

      const updatedOrchestration = store.updateOrchestration(orchestration.id, {
        status: "executing",
        cycle: 1,
        planPath: ".agent-memory/plans/task-1.md",
      });
      expect(updatedOrchestration?.status).toBe("executing");
      expect(updatedOrchestration?.planPath).toContain("plans");

      const event = store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: 1,
        phase: "plan",
        kind: "leader_turn",
        summary: "Leader produced 3 subtasks",
      });
      expect(event.id).toBeTruthy();
      expect(store.listOrchestrationEvents({ orchestrationId: orchestration.id })).toHaveLength(1);

      const subtask = store.createSubtask({
        parentTaskId: task.id,
        title: "Implement report renderer",
        acceptanceCriteria: ["report file is generated"],
      });
      const assignment = store.createAssignment({
        taskId: task.id,
        subtaskId: subtask.id,
        agentId: implementer.id,
        roleId: implementerRole.id,
        prompt: "Implement the report renderer.",
      });

      const run = store.createAgentRun({
        orchestrationId: orchestration.id,
        taskId: task.id,
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        agentId: implementer.id,
        roleId: implementerRole.id,
        provider: "codex",
        model: "gpt-5.6",
        phase: "implement",
      });
      expect(run.status).toBe("starting");
      expect(run.origin).toBe("spawned");

      const runningRun = store.updateAgentRun(run.id, {
        status: "running",
        pid: 4242,
        logPath: ".agent-memory/artifacts/runs/run-1/output.log",
        progressPercent: 40,
      });
      expect(runningRun?.status).toBe("running");
      expect(runningRun?.pid).toBe(4242);
      expect(store.listAgentRuns({ taskId: task.id, status: "running" })).toHaveLength(1);

      const doneRun = store.updateAgentRun(run.id, {
        status: "done",
        exitCode: 0,
        endedAt: new Date().toISOString(),
      });
      expect(doneRun?.status).toBe("done");
      expect(doneRun?.exitCode).toBe(0);

      const review = store.createReview({
        taskId: task.id,
        subtaskId: subtask.id,
        targetAssignmentId: assignment.id,
        verdict: "rework",
        score: 55,
        summary: "Missing test coverage for the empty-report case.",
        findings: JSON.stringify([{ severity: "medium", issue: "no empty-state test" }]),
      });
      expect(store.listReviews({ taskId: task.id, consumed: false })).toHaveLength(1);
      const consumed = store.markReviewConsumed(review.id);
      expect(consumed?.consumedAt).toBeTruthy();
      expect(store.listReviews({ taskId: task.id, consumed: false })).toHaveLength(0);
      expect(store.listReviews({ taskId: task.id, consumed: true })).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records task lanes, change sets, and agent requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Isolated task lane",
        ownerAgent: "codex",
      });
      const lane = store.upsertTaskLane({
        taskId: task.id,
        mode: "worktree",
        baseRef: "main",
        baseCommit: "abc123",
        worktreePath: ".agent-memory/tasks/lane",
      });
      expect(lane).toMatchObject({
        taskId: task.id,
        mode: "worktree",
        status: "active",
      });
      expect(store.getTaskLane(task.id)?.baseCommit).toBe("abc123");
      expect(store.listTaskLanes("active")).toHaveLength(1);

      const change = store.upsertTaskChange({
        taskId: task.id,
        path: "src/session.ts",
        changeType: "modified",
        baseHash: "old",
        currentHash: "new",
        diffSummary: "Updates session restoration",
      });
      expect(change).toMatchObject({
        path: "src/session.ts",
        status: "pending",
      });

      const updatedChange = store.upsertTaskChange({
        taskId: task.id,
        path: "src/session.ts",
        changeType: "modified",
        baseHash: "old",
        currentHash: "newer",
        diffSummary: "Marks conflict",
        status: "conflict",
      });
      expect(updatedChange.id).toBe(change.id);
      expect(store.listTaskChanges(task.id)[0]?.status).toBe("conflict");

      const request = store.createAgentRequest({
        taskId: task.id,
        sessionId: "codex-session",
        agent: "codex",
        type: "approval",
        title: "Allow overwrite",
        payload: JSON.stringify({ path: "src/session.ts" }),
      });
      expect(store.listAgentRequests({ status: "pending" })).toHaveLength(1);
      const resolved = store.resolveAgentRequest(
        request.id,
        "accepted",
        "Approved by user",
      );
      expect(resolved?.status).toBe("accepted");
      expect(resolved?.response).toBe("Approved by user");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses file leases to prevent cross-task write conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const first = store.createTask({
        title: "First task",
        ownerAgent: "codex",
      });
      const second = store.createTask({
        title: "Second task",
        ownerAgent: "claude",
      });

      const firstWrite = store.acquireFileLease({
        taskId: first.id,
        sessionId: "session-a",
        agent: "codex",
        path: "src/session.ts",
        mode: "write",
        baseHash: "base-a",
        ttlSeconds: 60,
      });
      expect(firstWrite.acquired).toBe(true);

      const blockedWrite = store.acquireFileLease({
        taskId: second.id,
        sessionId: "session-b",
        agent: "claude",
        path: "src/session.ts",
        mode: "write",
      });
      expect(blockedWrite.acquired).toBe(false);
      expect(blockedWrite.blockingLease?.taskId).toBe(first.id);

      const blockedRead = store.acquireFileLease({
        taskId: second.id,
        path: "src/session.ts",
        mode: "read",
      });
      expect(blockedRead.acquired).toBe(false);

      const renewed = store.acquireFileLease({
        taskId: first.id,
        sessionId: "session-a",
        agent: "codex",
        path: "src/session.ts",
        mode: "write",
        currentHash: "hash-a",
        ttlSeconds: 120,
      });
      expect(renewed.acquired).toBe(true);
      expect(renewed.lease?.id).toBe(firstWrite.lease?.id);
      expect(renewed.lease?.currentHash).toBe("hash-a");

      store.releaseFileLease(firstWrite.lease!.id);
      const secondWrite = store.acquireFileLease({
        taskId: second.id,
        path: "src/session.ts",
        mode: "write",
      });
      expect(secondWrite.acquired).toBe(true);
      expect(
        store.listFileLeases({ path: "src/session.ts", activeOnly: true }),
      ).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates task metadata without changing the task id", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Old title",
        goal: "Old goal",
        ownerAgent: "codex",
      });
      const updated = store.updateTask(task.id, {
        title: "New title",
        goal: "New goal",
        status: "blocked",
        ownerAgent: "claude",
      });

      expect(updated?.id).toBe(task.id);
      expect(updated?.title).toBe("New title");
      expect(updated?.goal).toBe("New goal");
      expect(updated?.status).toBe("blocked");
      expect(updated?.ownerAgent).toBe("claude");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a task and its task-scoped records", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Delete me",
        ownerAgent: "codex",
      });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "task memory",
        importance: 3,
      });
      store.createHandoff({ taskId: task.id, summary: "handoff" });
      store.addRun({ taskId: task.id, command: "test", resultSummary: "ok" });

      expect(store.deleteTask(task.id)).toBe(true);
      expect(store.getTask(task.id)).toBeUndefined();
      expect(store.listMemories({ taskId: task.id })).toHaveLength(0);
      expect(store.getLatestHandoff(task.id)).toBeUndefined();
      expect(store.listRuns({ taskId: task.id })).toHaveLength(0);
      expect(
        store.searchMemories("task memory", { taskId: task.id }),
      ).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a task that owns an orchestration, its runs and reviews", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Orchestrated", ownerAgent: "codex" });
      const agent = store.createRegisteredAgent({
        name: "leader",
        provider: "codex",
        mode: "cli",
        command: "codex",
      });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: agent.id });
      const subtask = store.createSubtask({ parentTaskId: task.id, title: "Do it" });
      store.createAgentRun({
        taskId: task.id,
        orchestrationId: orchestration.id,
        agentId: agent.id,
        phase: "plan",
        status: "done",
      });
      store.createReview({
        taskId: task.id,
        subtaskId: subtask.id,
        verdict: "pass",
        summary: "looks fine",
      });
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: 0,
        phase: "plan",
        kind: "spawn",
        summary: "spawned the plan turn",
      });

      // Every task the Orchestrator tab creates looks like this; before the
      // fix this threw a raw "FOREIGN KEY constraint failed".
      expect(store.deleteTask(task.id)).toBe(true);
      expect(store.getTask(task.id)).toBeUndefined();
      expect(store.getOrchestration(orchestration.id)).toBeUndefined();
      expect(store.listOrchestrationEvents({ orchestrationId: orchestration.id })).toHaveLength(0);
      expect(store.listAgentRuns({ taskId: task.id })).toHaveLength(0);
      expect(store.listReviews({ taskId: task.id })).toHaveLength(0);
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates an existing handoff in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(path);
    try {
      const task = store.createTask({
        title: "Edit handoff",
        ownerAgent: "codex",
      });
      const original = store.createHandoff({
        taskId: task.id,
        fromAgent: "claude",
        toAgent: "codex",
        summary: "before",
        next: ["old next"],
      });

      const updated = store.updateHandoff({
        id: original.id,
        taskId: task.id,
        fromAgent: "codex",
        toAgent: "claude",
        summary: "after",
        done: ["edited"],
        next: ["new next"],
        risks: ["watch target"],
        filesChanged: ["packages/cli/src/ui-page.ts"],
      });

      const db = new Database(path, { readonly: true });
      const handoffCount = (
        db
          .prepare("SELECT COUNT(*) c FROM handoffs WHERE task_id = ?")
          .get(task.id) as { c: number }
      ).c;
      db.close();

      expect(handoffCount).toBe(1);
      expect(updated.id).toBe(original.id);
      expect(updated.createdAt).toBe(original.createdAt);
      expect(updated.summary).toBe("after");
      expect(updated.fromAgent).toBe("codex");
      expect(updated.toAgent).toBe("claude");
      expect(store.getLatestHandoff(task.id)?.summary).toBe("after");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps a single auto handoff per task and never clobbers a manual one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(path);
    try {
      const task = store.createTask({
        title: "Handoff lifecycle",
        ownerAgent: "claude",
      });

      store.upsertAutoHandoff({ taskId: task.id, summary: "auto v1" });
      store.upsertAutoHandoff({ taskId: task.id, summary: "auto v2" });

      // Only one auto row survives — no table bloat across repeated Stops.
      const db = new Database(path, { readonly: true });
      const autoCount = (
        db.prepare("SELECT COUNT(*) c FROM handoffs WHERE auto = 1").get() as {
          c: number;
        }
      ).c;
      db.close();
      expect(autoCount).toBe(1);

      const latestAuto = store.getLatestHandoff(task.id);
      expect(latestAuto?.summary).toBe("auto v2");
      expect(latestAuto?.auto).toBe(true);

      // A manual handoff takes precedence and is preserved.
      store.createHandoff({ taskId: task.id, summary: "MANUAL" });
      const latest = store.getLatestHandoff(task.id);
      expect(latest?.summary).toBe("MANUAL");
      expect(latest?.auto).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one visible latest-state memory and supersedes stale state rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Latest response",
        ownerAgent: "claude",
      });

      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "Claude latest response: old response",
        importance: 3,
        sourceAgent: "claude",
        tags: ["claude-code", "stop"],
        dedupe: false,
      });
      store.upsertLatestMemory(
        {
          taskId: task.id,
          type: "note",
          content: "Claude latest response: current response",
          importance: 3,
          sourceAgent: "claude",
          tags: ["claude-code", "stop", "latest-response"],
        },
        {
          latestTag: "latest-response",
          legacyContentPrefix: "Claude latest response:",
        },
      );
      store.upsertLatestMemory(
        {
          taskId: task.id,
          type: "note",
          content: "Claude latest response: newer response",
          importance: 3,
          sourceAgent: "claude",
          tags: ["claude-code", "stop", "latest-response"],
        },
        {
          latestTag: "latest-response",
          legacyContentPrefix: "Claude latest response:",
        },
      );

      const visibleLatest = store
        .listMemoriesForTask(task.id, 20)
        .filter((memory) => memory.tags.includes("latest-response"));
      expect(visibleLatest).toHaveLength(1);
      expect(visibleLatest[0]?.content).toBe(
        "Claude latest response: newer response",
      );
      expect(visibleLatest[0]?.importance).toBe(3);
      expect(
        store.searchMemories("old response", { taskId: task.id }),
      ).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches Vietnamese (Unicode) content via FTS", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Kiểm tra encoding",
        ownerAgent: "codex",
      });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Sửa lỗi đăng nhập: phần được nạp chưa đúng, kết nối nội bộ",
        importance: 4,
      });

      const results = store.searchMemories("đăng nhập", { taskId: task.id });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain("đăng nhập");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches accent-insensitively (folded FTS index)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Auth", ownerAgent: "codex" });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Sửa lỗi đăng nhập sau khi làm mới trang",
        importance: 4,
      });

      // Query without diacritics finds the accented Vietnamese content.
      const plain = store.searchMemories("dang nhap", { taskId: task.id });
      expect(plain).toHaveLength(1);
      expect(plain[0]?.content).toContain("đăng nhập");

      // And the reverse: accented query finds it too (sanity check).
      const accented = store.searchMemories("đăng nhập", { taskId: task.id });
      expect(accented).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ranks more relevant memories first (bm25)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Auth work",
        ownerAgent: "claude",
      });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "Unrelated note about logging",
        importance: 5,
      });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content:
          "session token expires and session is dropped on session refresh",
        importance: 1,
      });

      const results = store.searchMemories("session token");
      // The denser match wins on bm25 even though its importance is lower.
      expect(results[0]?.content).toContain("session token");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a pre-versioning (v0) database and backfills FTS", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    try {
      // Build a legacy database: base schema only, no FTS, user_version left at 0.
      const legacy = new Database(path);
      for (const statement of schemaStatements) legacy.prepare(statement).run();
      const ts = "2026-01-01T00:00:00.000Z";
      legacy
        .prepare(
          "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'done', ?, ?)",
        )
        .run("t1", "Legacy task", ts, ts);
      legacy
        .prepare(
          "INSERT INTO memories (id, task_id, type, content, importance, tags, created_at, updated_at) VALUES (?, ?, 'note', ?, 3, '[]', ?, ?)",
        )
        .run("m1", "t1", "legacy session widget needs migration", ts, ts);
      expect(Number(legacy.pragma("user_version", { simple: true }))).toBe(0);
      legacy.close();

      // Opening via the store runs the versioned migrations (v1 -> v2),
      // creating the FTS table and backfilling the pre-existing row.
      const store = new SQLiteMemoryStore(path);
      const results = store.searchMemories("legacy");
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("m1");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges near-duplicate memories on add (same task + type)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Auth" });
      const first = store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Session cookie is not restored after refresh",
        tags: ["auth"],
        importance: 3,
      });
      const second = store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Session cookie is not restored after refresh",
        tags: ["cookie"],
        importance: 5,
      });

      expect(second.id).toBe(first.id); // merged into the existing memory
      const all = store.listMemoriesForTask(task.id, 50);
      expect(all).toHaveLength(1);
      expect(all[0]?.importance).toBe(5); // max importance
      expect(all[0]?.tags.sort()).toEqual(["auth", "cookie"]); // union of tags
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inserts a separate row when dedupe is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Auth" });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "same text",
        importance: 3,
      });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "same text",
        importance: 3,
        dedupe: false,
      });
      expect(store.listMemoriesForTask(task.id, 50)).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes to a size cap, protecting constraints, and honours dry-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Pool" });
      store.addMemory({
        taskId: task.id,
        type: "constraint",
        content: "do not touch billing",
        importance: 1,
      });
      // Distinct content so dedupe does not merge them away.
      for (let i = 0; i < 5; i += 1) {
        store.addMemory({
          taskId: task.id,
          type: "note",
          content: `observation number ${i}`,
          importance: 2,
        });
      }

      const preview = store.pruneMemories({ maxPoolSize: 3, dryRun: true });
      expect(preview.length).toBe(3); // 6 total - cap 3
      expect(store.listMemoriesForTask(task.id, 50)).toHaveLength(6); // dry-run changed nothing

      const evicted = store.pruneMemories({ maxPoolSize: 3 });
      expect(evicted.every((memory) => memory.type === "note")).toBe(true);
      const remaining = store.listMemoriesForTask(task.id, 50);
      expect(remaining).toHaveLength(3);
      expect(remaining.some((memory) => memory.type === "constraint")).toBe(
        true,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consolidates related memories, hiding originals from compile but keeping history", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({ title: "Auth" });
      // dedupe: false keeps them as separate rows (they are similar enough that
      // dedupe-on-add would otherwise merge them).
      const contents = [
        "session cookie not restored after refresh",
        "session cookie not restored after refresh reload",
        "session cookie not restored after refresh again",
      ];
      for (const content of contents) {
        store.addMemory({
          taskId: task.id,
          type: "bug",
          content,
          importance: 3,
          dedupe: false,
        });
      }

      const preview = store.consolidateMemories({
        taskId: task.id,
        threshold: 0.5,
        dryRun: true,
      });
      expect(preview.clusters).toHaveLength(1);
      expect(preview.supersededCount).toBe(3);
      expect(store.listMemoriesForTask(task.id, 50)).toHaveLength(3); // dry-run changed nothing

      const result = store.consolidateMemories({
        taskId: task.id,
        threshold: 0.5,
      });
      expect(result.clusters).toHaveLength(1);
      expect(result.supersededCount).toBe(3);

      // Compile/search see only the representative; originals are hidden.
      const visible = store.listMemoriesForTask(task.id, 50);
      expect(visible).toHaveLength(1);
      expect(visible[0]?.id).toBe(result.clusters[0]?.representativeId);
      expect(
        store.searchMemories("session cookie", { taskId: task.id }),
      ).toHaveLength(1);

      // History is preserved: list still shows the 3 originals + representative.
      expect(store.listMemories({ taskId: task.id })).toHaveLength(4);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ranks a keyword-disjoint but semantically-close memory first (hybrid)", async () => {
    // Fake provider: maps text to a 2D concept vector (session vs logging).
    const provider = {
      async embed(text: string): Promise<number[]> {
        const t = text.toLowerCase();
        return [
          /session|cookie|sign|login|logged|auth/.test(t) ? 1 : 0,
          /log|config|verbose/.test(t) ? 1 : 0,
        ];
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"), {
      embeddingProvider: provider,
    });
    try {
      const task = store.createTask({ title: "Auth" });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "Cookie is not restored",
        importance: 3,
      });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "Verbose logging configuration tips",
        importance: 3,
      });
      expect(await store.reindexEmbeddings({ taskId: task.id })).toBe(2);

      // The query shares no keywords with either memory, but is the "session" concept.
      const results = await store.semanticSearch("user cannot stay signed in", {
        taskId: task.id,
        weights: { alpha: 0.2, beta: 0.8 },
      });
      expect(results[0]?.content).toContain("Cookie");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("semanticSearch falls back to lexical when no provider is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      expect(store.hasEmbeddingProvider()).toBe(false);
      const task = store.createTask({ title: "Auth" });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "session cookie not restored",
        importance: 3,
      });
      const results = await store.semanticSearch("session cookie", {
        taskId: task.id,
      });
      expect(results).toHaveLength(1);
      await expect(store.reindexEmbeddings()).rejects.toThrow(/provider/i);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles two concurrent connections (claude + codex) without losing writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    const claude = new SQLiteMemoryStore(path);
    const codex = new SQLiteMemoryStore(path);
    try {
      const task = claude.createTask({ title: "Shared repo" });
      // Interleave writes from both connections against the same DB file (WAL +
      // busy_timeout). dedupe:false so distinct rows are not merged.
      for (let i = 0; i < 10; i += 1) {
        claude.addMemory({
          taskId: task.id,
          type: "note",
          content: `claude note ${i}`,
          importance: 3,
          dedupe: false,
        });
        codex.addMemory({
          taskId: task.id,
          type: "note",
          content: `codex note ${i}`,
          importance: 3,
          dedupe: false,
        });
      }
      // Both connections see all 20 memories; FTS (written via triggers on both
      // connections) finds rows authored by the other connection.
      expect(codex.listMemories({ taskId: task.id, limit: 100 })).toHaveLength(
        20,
      );
      expect(
        claude.searchMemories("codex note", { taskId: task.id, limit: 100 })
          .length,
      ).toBeGreaterThan(0);
      expect(
        codex.searchMemories("claude note", { taskId: task.id, limit: 100 })
          .length,
      ).toBeGreaterThan(0);
    } finally {
      claude.close();
      codex.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects an injected lifecycle dedupe threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    // A very high threshold (0.99) means only (near-)identical content merges.
    const store = new SQLiteMemoryStore(join(dir, "memories.db"), {
      lifecycle: { dedupeThreshold: 0.99 },
    });
    try {
      const task = store.createTask({ title: "Auth" });
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "session cookie not restored after refresh",
        importance: 3,
      });
      // ~0.85 similar: would merge at the default 0.85, but not at 0.99.
      store.addMemory({
        taskId: task.id,
        type: "bug",
        content: "session cookie not restored after refresh reload",
        importance: 3,
      });
      expect(store.listMemoriesForTask(task.id, 50)).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays in sync when memories are added after backfill", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "memories.db");
    let store = new SQLiteMemoryStore(path);
    try {
      const task = store.createTask({ title: "Sync check" });
      store.close();
      // Reopen (re-runs migrations; backfill must not duplicate rows).
      store = new SQLiteMemoryStore(path);
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "alpha beta gamma",
        importance: 3,
      });
      const results = store.searchMemories("beta");
      expect(results).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores a knowledge graph and answers neighbor/dependent/repo-map queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      store.replaceGraph({
        nodes: [
          {
            id: "src/util.ts",
            kind: "file",
            path: "src/util.ts",
            language: "ts",
          },
          {
            id: "src/util.ts#add@1",
            kind: "symbol",
            path: "src/util.ts",
            name: "add",
            symbolKind: "function",
            line: 1,
          },
          {
            id: "src/index.ts",
            kind: "file",
            path: "src/index.ts",
            language: "ts",
          },
        ],
        edges: [
          {
            src: "src/index.ts",
            dst: "src/util.ts",
            kind: "imports",
            raw: "./util",
          },
          {
            src: "src/index.ts",
            dst: "ext:express",
            kind: "imports",
            raw: "express",
          },
        ],
      });

      const stats = store.getGraphStats();
      expect(stats).toMatchObject({
        files: 2,
        symbols: 1,
        internalEdges: 1,
        externalEdges: 1,
      });

      const imports = store.getImports("src/index.ts");
      expect(imports.internal).toEqual(["src/util.ts"]);
      expect(imports.external).toEqual(["express"]);

      expect(store.getDependents("src/util.ts")).toEqual(["src/index.ts"]);
      expect(
        store.getFileSymbols("src/util.ts").map((node) => node.name),
      ).toEqual(["add"]);

      // Most depended-on file (util) ranks first in the repo map.
      const map = store.buildRepoMap();
      expect(map[0]?.path).toBe("src/util.ts");
      expect(map[0]?.usedByCount).toBe(1);

      // Rebuild replaces wholesale (no stale rows).
      store.replaceGraph({
        nodes: [{ id: "a.ts", kind: "file", path: "a.ts" }],
        edges: [],
      });
      expect(store.getGraphStats().files).toBe(1);
      expect(store.getDependents("src/util.ts")).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selects task matches, graph neighbours, then structural fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const task = store.createTask({
        title: "Brief graph files",
        ownerAgent: "codex",
      });
      store.replaceGraph({
        nodes: [
          {
            id: "src/session.ts",
            kind: "file",
            path: "src/session.ts",
            language: "ts",
            contentHash: "hash-new",
          },
          {
            id: "src/cookie.ts",
            kind: "file",
            path: "src/cookie.ts",
            language: "ts",
            contentHash: "hash-cookie",
          },
          {
            id: "src/b.ts",
            kind: "file",
            path: "src/b.ts",
            language: "ts",
            contentHash: "hash-b",
          },
        ],
        edges: [
          { src: "src/session.ts", dst: "src/cookie.ts", kind: "imports" },
        ],
      });
      store.upsertFileSummary({
        path: "src/session.ts",
        summary: "Restores authentication session tokens.",
        manualPriority: 5,
        lastSeenHash: "hash-old",
        lastTaskId: task.id,
        markTaskEdited: true,
      });
      const map = store.buildRepoMap({
        limit: 3,
        task: { title: "Fix authentication token restore" },
        recentTaskFiles: ["src/session.ts"],
      });
      expect(map[0]).toMatchObject({
        path: "src/session.ts",
        brief: "Restores authentication session tokens.",
        manualPriority: 5,
        briefStale: true,
        selectionReason: "task",
      });
      expect(map[1]).toMatchObject({
        path: "src/cookie.ts",
        selectionReason: "neighbor",
      });
      expect(map[2]).toMatchObject({
        path: "src/b.ts",
        selectionReason: "structural",
      });
      store.upsertFileSummary({
        path: "src/session.ts",
        summary: "Updated automatic brief.",
        lastSeenHash: "hash-new",
      });
      expect(
        store.listFileSummaries().find((file) => file.path === "src/session.ts")
          ?.manualPriority,
      ).toBe(5);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent run cycle", () => {
  it("stores the orchestration cycle a run belongs to", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-run-cycle-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "a", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "t", ownerAgent: "codex" });

      const stamped = store.createAgentRun({ taskId: task.id, agentId: agent.id, cycle: 3 });
      const legacy = store.createAgentRun({ taskId: task.id, agentId: agent.id });

      expect(store.getAgentRun(stamped.id)?.cycle).toBe(3);
      // Adopted/manual runs and pre-migration rows have no cycle at all; the
      // board treats those as "unknown" rather than guessing.
      expect(store.getAgentRun(legacy.id)?.cycle).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
