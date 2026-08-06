import { describe, expect, it } from "vitest";
import { compileContext } from "./context-compiler.js";
import type { MemoryStore } from "@agent-bridge/memory";

describe("compileContext", () => {
  it("renders a compact prompt pack from task memory", () => {
    const store = baseStore([
      {
        id: "mem-1",
        taskId: "task-1",
        type: "bug" as const,
        content: "Cookie exists but session is not restored.",
        importance: 5,
        tags: ["auth"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-2",
        taskId: "task-1",
        type: "constraint" as const,
        content: "Do not touch payment auth flow.",
        importance: 5,
        tags: ["payment"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mem-3",
        taskId: "task-1",
        type: "note" as const,
        content: "Claude prompt: can you also inspect unrelated files?",
        importance: 5,
        tags: ["claude-code", "prompt"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });
    expect(pack.renderedMarkdown).toContain("Session survives refresh");
    expect(pack.renderedMarkdown).toContain("Cookie exists");
    expect(pack.renderedMarkdown).toContain("Do not touch payment auth flow");
    expect(pack.renderedMarkdown).not.toContain("Claude prompt:");
  });

  it("orders current state by bm25 relevance, not just importance", () => {
    const relevant = {
      id: "mem-relevant",
      taskId: "task-1",
      type: "bug" as const,
      content:
        "Session is dropped on refresh because the cookie is not restored.",
      importance: 1,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const importantButOffTopic = {
      id: "mem-offtopic",
      taskId: "task-1",
      type: "bug" as const,
      content: "Unrelated note about logging configuration.",
      importance: 5,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const store = baseStore([importantButOffTopic, relevant]);
    // FTS/bm25 ranks the on-topic memory first despite its lower importance.
    store.searchMemories = () => [relevant];

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });
    const relevantIdx = pack.currentState.findIndex((line) =>
      line.includes("Session is dropped"),
    );
    const offtopicIdx = pack.currentState.findIndex((line) =>
      line.includes("Unrelated note"),
    );
    expect(relevantIdx).toBeGreaterThanOrEqual(0);
    expect(offtopicIdx).toBeGreaterThanOrEqual(0);
    expect(relevantIdx).toBeLessThan(offtopicIdx);
  });

  it("includes repository memories in every task context", () => {
    const store = baseStore([]);
    store.listRepoMemories = () => [
      {
        id: "repo-memory",
        type: "constraint",
        content: "Repository uses signed session cookies.",
        importance: 5,
        tags: ["repo"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    expect(
      compileContext(store, {
        taskId: "task-1",
        agent: "codex",
        tokenBudget: 4000,
      }).renderedMarkdown,
    ).toContain("Repository uses signed session cookies.");
  });

  it("honours an explicit memoryTokenBudget when trimming current state", () => {
    const manyMemories = Array.from({ length: 20 }, (_, index) => ({
      id: `mem-${index}`,
      taskId: "task-1",
      type: "bug" as const,
      content: `Observation number ${index} about the failing session refresh behaviour.`,
      importance: 3,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const store = baseStore(manyMemories);

    const small = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
      memoryTokenBudget: 40,
    });
    const large = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
      memoryTokenBudget: 4000,
    });

    expect(small.currentState.length).toBeGreaterThan(0);
    expect(large.currentState.length).toBeGreaterThan(
      small.currentState.length,
    );
  });
  it("distills shared memory from handoff and task state", () => {
    const store = baseStore([
      {
        id: "mem-state",
        taskId: "task-1",
        type: "note" as const,
        content:
          "Compiler should give the next agent a compact operating brief.",
        importance: 4,
        tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    store.listDecisions = () => [
      {
        id: "decision-1",
        taskId: "task-1",
        decision: "Keep shared memory in the compiled prompt pack",
        reason: "Avoid rereading raw history on agent handoff",
        relatedFiles: ["packages/core/src/context-compiler.ts"],
        sourceAgent: "codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.getLatestHandoff = () => ({
      id: "handoff-1",
      taskId: "task-1",
      fromAgent: "claude",
      toAgent: "codex",
      summary: "Compiler work is underway.",
      done: ["Added repo-map injection"],
      next: ["Wire compact handoff context into prompt pack"],
      risks: ["Do not expand raw memory too much"],
      filesChanged: ["packages/core/src/context-compiler.ts"],
      createdAt: "2026-01-01T00:00:00.000Z",
      auto: false,
    });

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });

    expect(pack.sharedMemory).toContain("Objective: Session survives refresh");
    expect(pack.sharedMemory).toContain("Done: Added repo-map injection");
    expect(pack.sharedMemory).toContain(
      "Touched file: packages/core/src/context-compiler.ts",
    );
    expect(pack.renderedMarkdown).toContain("## Shared Memory");
    expect(pack.renderedMarkdown).toContain("### Files Changed");
  });
  it("ignores handoff packets targeted at another agent", () => {
    const store = baseStore([]);
    store.getLatestHandoff = () => ({
      id: "handoff-other-agent",
      taskId: "task-1",
      fromAgent: "codex",
      toAgent: "claude",
      summary: "This packet is for Claude, not Codex.",
      done: [],
      next: ["Claude-only next step"],
      risks: [],
      filesChanged: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      auto: false,
    });

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });

    expect(pack.handoff).toBeUndefined();
    expect(pack.renderedMarkdown).not.toContain("This packet is for Claude");
    expect(pack.nextActions).not.toContain("Claude-only next step");
  });

  it("does not repeat latest handoff risks in the final risks section", () => {
    const store = baseStore([]);
    store.getLatestHandoff = () => ({
      id: "handoff-for-codex",
      taskId: "task-1",
      fromAgent: "claude",
      toAgent: "codex",
      summary: "Continue compiler work.",
      done: [],
      next: [],
      risks: ["Do not expand raw memory too much"],
      filesChanged: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      auto: false,
    });

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });

    const finalRisks =
      pack.renderedMarkdown.split("## Risks / Do Not Touch")[1] ?? "";
    expect(pack.renderedMarkdown).toContain(
      "### Risks\n- Do not expand raw memory too much",
    );
    expect(pack.sharedMemory).not.toContain(
      "Risk: Do not expand raw memory too much",
    );
    expect(finalRisks).not.toContain("Do not expand raw memory too much");
  });


  it("injects the current assignment for the target agent", () => {
    const store = baseStore([]);
    store.listRegisteredAgents = () => [
      {
        id: "agent-codex",
        name: "codex-cli",
        provider: "codex",
        mode: "cli",
        command: "codex",
        capabilities: ["edit"],
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.getRegisteredAgent = () => store.listRegisteredAgents()[0];
    store.listWorkforceRoles = () => [
      {
        id: "role-implementer",
        name: "implementer",
        permissions: ["read", "edit", "test"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.listSubtasks = () => [
      {
        id: "subtask-registry",
        parentTaskId: "task-1",
        title: "Implement registry CLI",
        status: "assigned",
        priority: 3,
        dependsOn: [],
        acceptanceCriteria: ["agent list works"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.listWorkforces = () => [
      {
        id: "workforce-default",
        name: "Default Engineering Team",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    store.listAssignments = () => [
      {
        id: "assignment-1",
        taskId: "task-1",
        subtaskId: "subtask-registry",
        workforceId: "workforce-default",
        agentId: "agent-codex",
        roleId: "role-implementer",
        status: "queued",
        prompt: "Build the registry commands.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 4000,
    });

    expect(pack.currentAssignment?.assignment.id).toBe("assignment-1");
    expect(pack.renderedMarkdown).toContain("## Current Assignment");
    expect(pack.renderedMarkdown).toContain("Role: implementer");
    expect(pack.renderedMarkdown).toContain("Subtask: Implement registry CLI");
    expect(pack.renderedMarkdown).toContain("Acceptance: agent list works");
  });
  it("does not duplicate a shortened title as the goal when no goal is recorded", () => {
    const store = baseStore([]);
    const originalGetTask = store.getTask;
    store.getTask = (id: string) => {
      const task = originalGetTask(id);
      return task ? { ...task, title: "Short title", goal: undefined } : undefined;
    };

    const pack = compileContext(store, {
      taskId: "task-1",
      agent: "codex",
      tokenBudget: 2000,
    });

    expect(pack.renderedMarkdown).toContain("## Goal\nNo explicit goal recorded.");
    expect(pack.renderedMarkdown).not.toContain("## Goal\nShort title");
  });

});

function baseStore(
  memories: ReturnType<MemoryStore["listMemoriesForTask"]>,
): MemoryStore {
  return {
    close() {},
    createTask() {
      throw new Error("unused");
    },
    getTask() {
      return {
        id: "task-1",
        title: "Fix auth",
        goal: "Session survives refresh",
        status: "in_progress",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    },
    updateTaskStatus() {
      throw new Error("unused");
    },
    listTasks() {
      return [];
    },
    addMemory() {
      throw new Error("unused");
    },
    searchMemories() {
      return [];
    },
    listMemoriesForTask() {
      return memories;
    },
    listRepoMemories() {
      return [];
    },
    listDecisions() {
      return [];
    },
    listFileSummaries() {
      return [];
    },
    createRegisteredAgent() {
      throw new Error("unused");
    },
    getRegisteredAgent() {
      return undefined;
    },
    listRegisteredAgents() {
      return [];
    },
    updateRegisteredAgent() {
      return undefined;
    },
    deleteRegisteredAgent() {
      return false;
    },
    createCredentialRef() {
      throw new Error("unused");
    },
    listCredentialRefs() {
      return [];
    },
    createWorkforceRole() {
      throw new Error("unused");
    },
    getWorkforceRole() {
      return undefined;
    },
    updateWorkforceRole() {
      return undefined;
    },
    deleteWorkforceRole() {
      return false;
    },
    listWorkforceRoles() {
      return [];
    },
    ensureDefaultWorkforceRoles() {
      return [];
    },
    createWorkforce() {
      throw new Error("unused");
    },
    getWorkforce() {
      return undefined;
    },
    updateWorkforce() {
      return undefined;
    },
    deleteWorkforce() {
      return false;
    },
    listWorkforces() {
      return [];
    },
    addWorkforceMember() {
      throw new Error("unused");
    },
    deleteWorkforceMember() {
      return false;
    },
    listWorkforceMembers() {
      return [];
    },
    createSubtask() {
      throw new Error("unused");
    },
    updateSubtask() {
      return undefined;
    },
    listSubtasks() {
      return [];
    },
    createAssignment() {
      throw new Error("unused");
    },
    updateAssignment() {
      return undefined;
    },
    listAssignments() {
      return [];
    },
    createDispatchRun() {
      throw new Error("unused");
    },
    updateDispatchRun() {
      return undefined;
    },
    listDispatchRuns() {
      return [];
    },
    upsertTaskLane() {
      throw new Error("unused");
    },
    getTaskLane() {
      return undefined;
    },
    listTaskLanes() {
      return [];
    },
    acquireFileLease() {
      return { acquired: false };
    },
    releaseFileLease() {
      return undefined;
    },
    listFileLeases() {
      return [];
    },
    upsertTaskChange() {
      throw new Error("unused");
    },
    listTaskChanges() {
      return [];
    },
    createAgentRequest() {
      throw new Error("unused");
    },
    resolveAgentRequest() {
      return undefined;
    },
    listAgentRequests() {
      return [];
    },
    deleteAgentRequest() {
      return false;
    },
    deleteAgentRequests() {
      return 0;
    },
    createHandoff() {
      throw new Error("unused");
    },
    updateHandoff() {
      throw new Error("unused");
    },
    upsertAutoHandoff() {
      throw new Error("unused");
    },
    getLatestHandoff() {
      return undefined;
    },
    addRun() {
      throw new Error("unused");
    },
    createAgentRun() {
      throw new Error("unused");
    },
    getAgentRun() {
      return undefined;
    },
    updateAgentRun() {
      return undefined;
    },
    listAgentRuns() {
      return [];
    },
    createOrchestration() {
      throw new Error("unused");
    },
    getOrchestration() {
      return undefined;
    },
    getOrchestrationByTask() {
      return undefined;
    },
    updateOrchestration() {
      return undefined;
    },
    listOrchestrations() {
      return [];
    },
    recordOrchestrationEvent() {
      throw new Error("unused");
    },
    listOrchestrationEvents() {
      return [];
    },
    createReview() {
      throw new Error("unused");
    },
    listReviews() {
      return [];
    },
    markReviewConsumed() {
      return undefined;
    },
  };
}


