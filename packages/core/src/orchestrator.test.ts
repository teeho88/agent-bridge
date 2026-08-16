import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "@agent-bridge/memory";
import type { AgentRun } from "@agent-bridge/memory";
import { stepOrchestration, type OrchestratorDeps, type SpawnAgentTurnInput } from "./orchestrator.js";

function fenced(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

function makeDeps(store: SQLiteMemoryStore, logs: Map<string, string>, prompts?: Map<string, string>): OrchestratorDeps {
  return {
    spawn: (input: SpawnAgentTurnInput): AgentRun => {
      const run = store.createAgentRun({
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        assignmentId: input.assignmentId,
        workforceId: input.workforceId,
        agentId: input.agent.id,
        roleId: input.roleId,
        cycle: input.cycle,
        phase: input.phase,
        status: "running",
      });
      prompts?.set(run.id, input.prompt);
      return run;
    },
    readLog: (run: AgentRun) => logs.get(run.id) ?? "",
    writePlanFile: () => "/tmp/plan.md",
  };
}

function finishRun(store: SQLiteMemoryStore, logs: Map<string, string>, runId: string, log: string, status: "done" | "failed" | "detached" = "done"): void {
  logs.set(runId, log);
  store.updateAgentRun(runId, { status, exitCode: status === "done" ? 0 : 1 });
}

function createWorkerLeader(store: SQLiteMemoryStore, name = "leader") {
  return store.createRegisteredAgent({
    name,
    provider: "codex",
    mode: "cli",
    command: "codex",
    capabilities: ["implement", "review"],
  });
}

describe("orchestrator", () => {
  function withStore(fn: (store: SQLiteMemoryStore) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-orchestrator-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("drives plan -> execute -> review -> accept through to reporting", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      // The leader may only staff agents that are registered and enabled, so
      // the roster it plans against has to exist up front.
      store.createRegisteredAgent({
        name: "codex-gpt56",
        provider: "codex",
        mode: "cli",
        command: "codex",
        model: "gpt-5.6",
        capabilities: ["implement"],
      });
      store.createRegisteredAgent({
        name: "claude-opus",
        provider: "claude",
        mode: "cli",
        command: "claude",
        model: "opus",
        capabilities: ["review"],
      });
      const task = store.createTask({ title: "Ship the report module", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 2 });

      // planning: spawn the leader's plan turn
      let step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const planRunId = step.spawnedRunIds[0]!;
      expect(store.getOrchestration(orchestration.id)?.status).toBe("planning");

      finishRun(store, logs, planRunId, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan\n\n1. Implement the thing.",
        subtasks: [
          {
            key: "s1",
            title: "Implement the thing",
            acceptanceCriteria: ["tests pass"],
            dependsOn: [],
            files: [],
            agentPreference: { provider: "codex", mode: "cli", model: "gpt-5.6" },
          },
        ],
        reviewers: [
          { key: "r1", scope: ["s1"], agentPreference: { provider: "claude", mode: "cli", model: "opus" } },
        ],
        questions: [],
      }));

      // planning -> executing
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("executing");
      expect(step.orchestration.complexity).toBe("small");
      const subtask = store.listSubtasks({ parentTaskId: task.id })[0]!;
      expect(subtask.title).toBe("Implement the thing");

      // executing: spawn the implementer
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const implementRunId = step.spawnedRunIds[0]!;
      const implementerRun = store.getAgentRun(implementRunId)!;
      expect(implementerRun.phase).toBe("implement");
      const implementerAgent = store.getRegisteredAgent(implementerRun.agentId)!;
      expect(implementerAgent.provider).toBe("codex");
      expect(implementerAgent.model).toBe("gpt-5.6");
      expect(implementerAgent.capabilities).toContain("implement");

      finishRun(store, logs, implementRunId, "implemented the thing successfully");

      // executing: reconcile the finished implementer -> subtask "review"
      step = stepOrchestration(store, orchestration.id, deps);
      expect(store.listSubtasks({ parentTaskId: task.id })[0]?.status).toBe("review");

      // executing: spawn the reviewer
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const reviewRunId = step.spawnedRunIds[0]!;
      const reviewRun = store.getAgentRun(reviewRunId)!;
      expect(reviewRun.phase).toBe("review");
      const reviewerAgent = store.getRegisteredAgent(reviewRun.agentId)!;
      expect(reviewerAgent.provider).toBe("claude");
      expect(reviewerAgent.capabilities).toContain("review");

      finishRun(store, logs, reviewRunId, fenced({
        version: 1,
        phase: "review",
        reviews: [{ subtaskKey: "s1", verdict: "pass", score: 92, summary: "Looks good." }],
      }));

      // executing: parse the reviewer's output into a Review row
      step = stepOrchestration(store, orchestration.id, deps);
      expect(store.listReviews({ taskId: task.id })).toHaveLength(1);

      // executing -> adjudicating (a pending review exists)
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("adjudicating");

      // adjudicating: spawn the leader's adjudicate turn
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const adjudicateRunId = step.spawnedRunIds[0]!;

      finishRun(store, logs, adjudicateRunId, fenced({
        version: 1,
        phase: "adjudicate",
        decisions: [{ subtaskKey: "s1", verdict: "accept" }],
        projectComplete: true,
        questions: [],
      }));

      // adjudicating: apply the accept decision -> reporting
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("reporting");
      expect(store.listSubtasks({ parentTaskId: task.id })[0]?.status).toBe("done");
      expect(store.listReviews({ taskId: task.id, consumed: true })).toHaveLength(1);

      // reporting is a no-op from the orchestrator's side (report generate owns it)
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("reporting");
      expect(step.spawnedRunIds).toHaveLength(0);
    });
  });

  it("creates a fresh subtask and re-reviews it when the leader requests rework", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [{ key: "r1", scope: ["s1"] }],
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps); // -> executing

      step = stepOrchestration(store, orchestration.id, deps); // spawn implementer
      const firstImplementRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, firstImplementRunId, "first attempt");
      step = stepOrchestration(store, orchestration.id, deps); // subtask -> review

      step = stepOrchestration(store, orchestration.id, deps); // spawn reviewer
      const firstReviewRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, firstReviewRunId, fenced({
        version: 1,
        phase: "review",
        reviews: [{ subtaskKey: "s1", verdict: "rework", summary: "Missing an edge case." }],
      }));
      step = stepOrchestration(store, orchestration.id, deps); // record review
      step = stepOrchestration(store, orchestration.id, deps); // -> adjudicating

      step = stepOrchestration(store, orchestration.id, deps); // spawn adjudicate
      const adjudicateRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, adjudicateRunId, fenced({
        version: 1,
        phase: "adjudicate",
        decisions: [
          {
            subtaskKey: "s1",
            verdict: "rework",
            rework: { title: "Fix the edge case", acceptanceCriteria: ["edge case handled"] },
          },
        ],
        projectComplete: false,
        questions: [],
      }));

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("executing");
      expect(step.orchestration.cycle).toBe(2);

      const subtasks = store.listSubtasks({ parentTaskId: task.id });
      expect(subtasks).toHaveLength(2);
      const original = subtasks.find((s) => s.title === "Implement X")!;
      const rework = subtasks.find((s) => s.title === "Fix the edge case")!;
      // Superseded by the rework subtask, not stuck: left as "blocked" it
      // reads as outstanding work forever and the leader will not call the
      // project complete.
      expect(original.status).toBe("cancelled");
      expect(rework.status).toBe("todo");

      // executing: spawns an implementer for the rework subtask specifically
      step = stepOrchestration(store, orchestration.id, deps);
      const reworkImplementRun = store.getAgentRun(step.spawnedRunIds[0]!)!;
      expect(reworkImplementRun.subtaskId).toBe(rework.id);
      finishRun(store, logs, reworkImplementRun.id, "fixed the edge case");
      step = stepOrchestration(store, orchestration.id, deps); // rework subtask -> review

      // The reviewer group should cover the rework subtask now (folded into its scope).
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const secondReviewRun = store.getAgentRun(step.spawnedRunIds[0]!)!;
      expect(secondReviewRun.phase).toBe("review");
    });
  });

  it("retries once on a leader parse failure, then pauses and raises a question on a second failure", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Broken plan", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      let step = stepOrchestration(store, orchestration.id, deps);
      const firstRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, firstRunId, "not json at all, just prose");

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("planning");
      expect(step.spawnedRunIds).toHaveLength(1);
      const retryRunId = step.spawnedRunIds[0]!;
      expect(retryRunId).not.toBe(firstRunId);

      finishRun(store, logs, retryRunId, "still not json");

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("paused");
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);
    });
  });

  it("surfaces a detached leader run's own log instead of stalling silently forever", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Untrusted dir", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      // Simulate a CLI process that exits immediately (e.g. a trust-check
      // refusal) and only gets reaped as "detached", never "failed" or "done".
      let step = stepOrchestration(store, orchestration.id, deps);
      const firstRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, firstRunId, "Not inside a trusted directory and --skip-git-repo-check was not specified.", "detached");

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("planning");
      expect(step.spawnedRunIds).toHaveLength(1);
      const retryRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, retryRunId, "Not inside a trusted directory and --skip-git-repo-check was not specified.", "detached");

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("paused");
      expect(step.orchestration.lastError).toContain("Not inside a trusted directory");
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);
    });
  });

  it("still consumes a detached leader run that actually completed successfully", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Missed exit event", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      // A piped CLI process can finish and write a perfectly valid reply, yet
      // still get reaped as "detached" if its exit event never reaches this
      // process (e.g. the store handle that spawned it already closed). That
      // must not be treated as a failure — the valid content should still win.
      let step = stepOrchestration(store, orchestration.id, deps);
      const runId = step.spawnedRunIds[0]!;
      finishRun(store, logs, runId, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan\n\n1. Implement the thing.",
        subtasks: [{ key: "s1", title: "Implement the thing", acceptanceCriteria: ["tests pass"], dependsOn: [], files: [] }],
        reviewers: [{ key: "r1", scope: ["s1"] }],
        questions: [],
      }), "detached");

      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("executing");
      expect(store.listSubtasks({ parentTaskId: task.id })[0]?.title).toBe("Implement the thing");
    });
  });

  it("marks the orchestration failed and raises a question once max_cycles is exceeded", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Runaway task", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxCycles: 1 });
      store.updateOrchestration(orchestration.id, { status: "executing", cycle: 2 });

      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("failed");
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);
    });
  });

  it("re-plans against the change request instead of re-applying the old plan", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts = new Map<string, string>();
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput): AgentRun => {
          const run = store.createAgentRun({
            orchestrationId: input.orchestrationId,
            taskId: input.taskId,
            subtaskId: input.subtaskId,
            assignmentId: input.assignmentId,
            agentId: input.agent.id,
            roleId: input.roleId,
            phase: input.phase,
            status: "running",
          });
          prompts.set(run.id, input.prompt);
          return run;
        },
      };
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Ship the game", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const firstPlanRunId = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, firstPlanRunId, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan\n\n1. Build the game.",
        subtasks: [{ key: "s1", title: "Build the game", acceptanceCriteria: ["it runs"], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(1);

      // The user asks for a change once the project is delivered.
      store.updateOrchestration(orchestration.id, { status: "planning" });
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: 1,
        phase: "plan",
        kind: "user_action",
        summary: "change-request: add sound",
        payload: JSON.stringify({
          type: "change-request",
          request: "Add sound effects for flap and collision.",
          previousPlan: "# Plan\n\n1. Build the game.",
          previousReport: "# Report\n\nShipped.",
        }),
      });

      // A fresh plan turn is spawned: the already-applied plan run must not be
      // re-parsed, or its subtask would be created a second time.
      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(1);

      const prompt = prompts.get(step.spawnedRunIds[0]!)!;
      expect(prompt).toContain("Leader Re-planning Turn");
      expect(prompt).toContain("Add sound effects for flap and collision.");
      expect(prompt).toContain("[todo] Build the game");
      expect(prompt).toContain("Shipped.");
      expect(prompt).toContain("Plan ONLY the work the change request needs.");
    });
  });

  it("reviews the ready part of a scope when the rest of it is waiting on that very review", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 2 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          { key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
          { key: "s2", title: "Verify X", acceptanceCriteria: ["done"], dependsOn: ["s1"], files: [] },
        ],
        reviewers: [{ key: "r1", scope: ["s1", "s2"] }],
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps); // -> executing

      step = stepOrchestration(store, orchestration.id, deps); // spawn implementer for s1 only (s2 depends on it)
      expect(step.spawnedRunIds).toHaveLength(1);
      finishRun(store, logs, step.spawnedRunIds[0]!, "implemented X");
      step = stepOrchestration(store, orchestration.id, deps); // s1 -> review

      // s2 cannot start until s1 is "done", and s1 only becomes done after this
      // review is adjudicated: the reviewer has to run on s1 alone.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      const reviewRun = store.getAgentRun(step.spawnedRunIds[0]!)!;
      expect(reviewRun.phase).toBe("review");
      expect(store.getOrchestration(orchestration.id)?.status).toBe("executing");
    });
  });

  it("cancels unstarted subtasks the re-plan dropped instead of stranding them", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          { key: "s1", title: "Old A", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
          { key: "s2", title: "Old B", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
        ],
        reviewers: [{ key: "r1", scope: ["s1", "s2"] }],
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps); // -> executing

      store.updateOrchestration(orchestration.id, { status: "planning" });
      step = stepOrchestration(store, orchestration.id, deps); // fresh plan turn
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan v2",
        subtasks: [{ key: "s1", title: "New A", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [{ key: "r1", scope: ["s1"] }],
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps);

      const byTitle = new Map(store.listSubtasks({ parentTaskId: task.id }).map((item) => [item.title, item.status]));
      expect(byTitle.get("New A")).toBe("todo");
      expect(byTitle.get("Old A")).toBe("cancelled");
      expect(byTitle.get("Old B")).toBe("cancelled");
    });
  });

  it("pauses instead of burning cycles when the leader has nothing to decide and will not finish", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "adjudicating", cycle: 2 });

      const adjudicateRunId = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, adjudicateRunId, fenced({
        version: 1,
        phase: "adjudicate",
        decisions: [],
        projectComplete: false,
        questions: [],
      }));

      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("paused");
      expect(step.orchestration.cycle).toBe(2);
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);
    });
  });

  it("sends a detached implementer to review, but blocks a failed one", () => {
    withStore((store) => {
      for (const [runStatus, expected] of [["detached", "review"], ["failed", "blocked"], ["stopped", "blocked"]] as const) {
        const logs = new Map<string, string>();
        const deps = makeDeps(store, logs);
        const leader = createWorkerLeader(store, `leader-${runStatus}`);
        const task = store.createTask({ title: `Ship ${runStatus}`, ownerAgent: "codex" });
        const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

        let step = stepOrchestration(store, orchestration.id, deps);
        finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
          version: 1,
          phase: "plan",
          complexity: "small",
          planMarkdown: "# Plan",
          subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
          reviewers: [{ key: "r1", scope: ["s1"] }],
          questions: [],
        }));
        stepOrchestration(store, orchestration.id, deps); // -> executing
        step = stepOrchestration(store, orchestration.id, deps); // spawn implementer
        const implementRunId = step.spawnedRunIds[0]!;

        logs.set(implementRunId, "wrote the code");
        store.updateAgentRun(implementRunId, { status: runStatus });

        stepOrchestration(store, orchestration.id, deps);
        const subtask = store.listSubtasks({ parentTaskId: task.id })[0]!;
        expect(subtask.status, `run status "${runStatus}"`).toBe(expected);
      }
    });
  });

  // Closing the tool mid-review leaves the reviewer's log truncated, so the
  // next start finds a terminal run whose output cannot be parsed. That has to
  // recover, not spin: the whole orchestration was unresumable because it did.
  it("retries an unparseable reviewer turn with the original prompt, then pauses instead of looping", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts = new Map<string, string>();
      const deps = makeDeps(store, logs, prompts);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship the review fix", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [{ key: "r1", scope: ["s1"] }],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing
      step = stepOrchestration(store, orchestration.id, deps); // spawn implementer
      finishRun(store, logs, step.spawnedRunIds[0]!, "wrote the code");
      stepOrchestration(store, orchestration.id, deps); // implementer -> review
      step = stepOrchestration(store, orchestration.id, deps); // spawn reviewer
      const reviewRunId = step.spawnedRunIds[0]!;
      const originalPrompt = prompts.get(reviewRunId)!;
      expect(originalPrompt).toContain("Implement X");

      // The tool was killed here: the reviewer's log stops mid-sentence.
      finishRun(store, logs, reviewRunId, "Reading the diff now, checking accept", "detached");

      step = stepOrchestration(store, orchestration.id, deps);
      const retryRunId = step.spawnedRunIds[0]!;
      expect(retryRunId).toBeDefined();
      // A spawned turn is a brand new CLI process with no memory of the last
      // one; a bare "that did not parse" retry is unanswerable.
      expect(prompts.get(retryRunId)).toContain(originalPrompt);
      expect(prompts.get(retryRunId)).toContain("could not be parsed");

      // The failed run must be consumed. Re-stepping while the retry is still
      // running must not spawn a second retry for the same run.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
      // Nor may it re-parse that run and burn the one remaining attempt while
      // the retry is still working.
      expect(step.orchestration.status).toBe("executing");

      // Second failure: stop, do not keep spending agents.
      finishRun(store, logs, retryRunId, "still not JSON", "detached");
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
      expect(step.orchestration.status).toBe("paused");
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);

      // And a paused orchestration stays put rather than spawning on the next tick.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
    });
  });

  it("does not re-parse a reviewer run once another turn on the same assignment delivered its verdicts", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts = new Map<string, string>();
      const deps = makeDeps(store, logs, prompts);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship the supersede fix", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [{ key: "r1", scope: ["s1"] }],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, "wrote the code");
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      const reviewRunId = step.spawnedRunIds[0]!;

      finishRun(store, logs, reviewRunId, "truncated", "detached");
      step = stepOrchestration(store, orchestration.id, deps);
      const retryRunId = step.spawnedRunIds[0]!;
      finishRun(store, logs, retryRunId, fenced({
        version: 1,
        phase: "review",
        reviews: [{ subtaskKey: "s1", verdict: "pass", score: 90, summary: "Fine." }],
      }));

      step = stepOrchestration(store, orchestration.id, deps);
      expect(store.listReviews({ taskId: task.id })).toHaveLength(1);
      // The orchestration moves on to adjudication instead of tripping over the
      // stale sibling run and pausing.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).not.toBe("paused");
    });
  });

  it("pauses for the leader's planning questions, then re-plans with the answers", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts = new Map<string, string>();
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput): AgentRun => {
          const run = store.createAgentRun({
            orchestrationId: input.orchestrationId,
            taskId: input.taskId,
            agentId: input.agent.id,
            phase: input.phase,
            status: "running",
          });
          prompts.set(run.id, input.prompt);
          return run;
        },
      };
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const planWithQuestions = {
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Guessed subtask", acceptanceCriteria: [], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [{ question: "Should destroyed pipes score a point?", options: ["Yes, one point", "No points"] }],
      };

      const firstPlanRunId = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, firstPlanRunId, fenced(planWithQuestions));

      // The plan is NOT applied: its subtasks encode the guess the leader
      // explicitly refused to make.
      const paused = stepOrchestration(store, orchestration.id, deps);
      expect(paused.orchestration.status).toBe("paused");
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(0);
      const question = store.listAgentRequests({ taskId: task.id, status: "pending" })[0]!;
      expect(question.title).toBe("Should destroyed pipes score a point?");
      // Options ride in the payload so the dashboard can offer them as picks.
      expect(JSON.parse(question.payload!)).toEqual({ options: ["Yes, one point", "No points"] });

      // The user answers, exactly as the UI endpoint does.
      store.resolveAgentRequest(question.id, "resolved", "Yes, exactly one point.");
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: orchestration.cycle,
        phase: "plan",
        kind: "user_action",
        summary: "Answered 1 leader question(s).",
        payload: JSON.stringify({
          type: "question-answers",
          answers: [{ question: question.title, answer: "Yes, exactly one point." }],
        }),
      });
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: orchestration.cycle,
        phase: "plan",
        kind: "run_ended",
        summary: `Consumed plan run ${firstPlanRunId} (superseded by answered questions).`,
      });
      store.updateOrchestration(orchestration.id, { status: "planning", lastError: null });

      const replan = stepOrchestration(store, orchestration.id, deps);
      expect(replan.spawnedRunIds).toHaveLength(1);
      const prompt = prompts.get(replan.spawnedRunIds[0]!)!;
      expect(prompt).toContain("## Answers To Your Questions");
      expect(prompt).toContain("Yes, exactly one point.");

      // Re-asking the same question must not park it again — it is settled.
      finishRun(store, logs, replan.spawnedRunIds[0]!, fenced(planWithQuestions));
      const applied = stepOrchestration(store, orchestration.id, deps);
      expect(applied.orchestration.status).toBe("executing");
      expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(1);
    });
  });

  it("approve-each asks before every agent, and a rejection pauses instead of spawning", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
        maxParallel: 1,
      });

      // Nothing is launched: the plan turn itself needs a yes first.
      let step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
      expect(step.summary).toContain("Approval requested");
      const planApproval = store.listAgentRequests({ taskId: task.id, status: "pending" }).find((r) => r.type === "approval")!;
      expect(planApproval.title).toContain("planning turn");

      // Re-stepping must reuse the same request, not pile up duplicates.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.summary).toContain("Waiting for your approval");
      expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).filter((r) => r.type === "approval")).toHaveLength(1);

      store.resolveAgentRequest(planApproval.id, "accepted");
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);

      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing

      // The implementer needs its own approval, named after the subtask.
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
      const implementApproval = store
        .listAgentRequests({ taskId: task.id, status: "pending" })
        .find((r) => r.type === "approval" && r.title.includes("Implement X"))!;
      expect(implementApproval).toBeDefined();
      expect(store.listSubtasks({ parentTaskId: task.id })[0]?.status).toBe("todo");

      // Rejecting drops just this subtask: it is blocked, no agent ran, and the
      // orchestration keeps going rather than ending over one "no".
      store.resolveAgentRequest(implementApproval.id, "rejected");
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).not.toBe("paused");
      expect(store.listSubtasks({ parentTaskId: task.id })[0]?.status).toBe("blocked");
      expect(store.listAgentRuns({ taskId: task.id, limit: 50 }).filter((r) => r.phase === "implement")).toHaveLength(0);
    });
  });

  it("pauses when a turn nothing can continue past is rejected", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
      });

      stepOrchestration(store, orchestration.id, deps);
      const planApproval = store.listAgentRequests({ taskId: task.id, status: "pending" }).find((r) => r.type === "approval")!;
      // There is no plan without a planning turn, so "no" here really does end
      // the run until the user intervenes.
      store.resolveAgentRequest(planApproval.id, "rejected");
      const step = stepOrchestration(store, orchestration.id, deps);

      expect(step.orchestration.status).toBe("paused");
      expect(step.orchestration.lastError).toContain("planning turn");
    });
  });

  it("keeps dispatching the subtasks you did approve after you reject one", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
        maxParallel: 2,
      });

      stepOrchestration(store, orchestration.id, deps);
      const planApproval = store.listAgentRequests({ taskId: task.id, status: "pending" }).find((r) => r.type === "approval")!;
      store.resolveAgentRequest(planApproval.id, "accepted");
      const planRun = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, planRun, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          { key: "s1", title: "Keep this", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
          { key: "s2", title: "Drop this", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
        ],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing
      stepOrchestration(store, orchestration.id, deps); // asks about both

      const approvals = store
        .listAgentRequests({ taskId: task.id, status: "pending", limit: 50 })
        .filter((request) => request.type === "approval");
      store.resolveAgentRequest(approvals.find((r) => r.title.includes("Keep this"))!.id, "accepted");
      store.resolveAgentRequest(approvals.find((r) => r.title.includes("Drop this"))!.id, "rejected");

      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).not.toBe("paused");
      expect(step.spawnedRunIds).toHaveLength(1);
      expect(step.summary).toContain("Blocked 1 you rejected");
      const subtasks = store.listSubtasks({ parentTaskId: task.id, limit: 10 });
      expect(subtasks.find((s) => s.title === "Keep this")?.status).toBe("assigned");
      expect(subtasks.find((s) => s.title === "Drop this")?.status).toBe("blocked");
    });
  });

  it("asks about every dispatchable subtask at once instead of stalling behind the first", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
        maxParallel: 3,
      });

      const planStep = stepOrchestration(store, orchestration.id, deps);
      const planApproval = store.listAgentRequests({ taskId: task.id, status: "pending" }).find((r) => r.type === "approval")!;
      store.resolveAgentRequest(planApproval.id, "accepted");
      void planStep;
      const planRun = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, planRun, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          { key: "s1", title: "Implement one", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
          { key: "s2", title: "Implement two", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
          { key: "s3", title: "Implement three", acceptanceCriteria: ["done"], dependsOn: [], files: [] },
        ],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing

      // One pass, three questions: an unanswered approval must not hold up
      // independent work queued behind it.
      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(0);
      expect(step.awaitingApprovalSince).toBeTruthy();
      const approvals = store
        .listAgentRequests({ taskId: task.id, status: "pending", limit: 50 })
        .filter((request) => request.type === "approval");
      expect(approvals).toHaveLength(3);

      // Approving just one starts exactly that one; the other two keep waiting.
      const second = approvals.find((request) => request.title.includes("Implement two"))!;
      store.resolveAgentRequest(second.id, "accepted");
      const spawnStep = stepOrchestration(store, orchestration.id, deps);
      expect(spawnStep.spawnedRunIds).toHaveLength(1);
      expect(spawnStep.summary).toContain("2 more await your approval");
      const run = store.getAgentRun(spawnStep.spawnedRunIds[0]!)!;
      expect(store.listSubtasks({ parentTaskId: task.id }).find((s) => s.id === run.subtaskId)?.title).toBe("Implement two");
    });
  });

  it("spawns the agent the user picked when they approve with a different one", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const stand_in = store.createRegisteredAgent({
        name: "claude-standin",
        provider: "claude",
        mode: "cli",
        command: "claude",
        capabilities: ["implement", "review"],
      });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        autonomy: "approve-each",
        maxParallel: 1,
      });

      const planApprovalStep = stepOrchestration(store, orchestration.id, deps);
      expect(planApprovalStep.spawnedRunIds).toHaveLength(0);
      const planApproval = store.listAgentRequests({ taskId: task.id, status: "pending" }).find((r) => r.type === "approval")!;
      store.resolveAgentRequest(planApproval.id, "accepted");
      const planRun = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
      finishRun(store, logs, planRun, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing
      stepOrchestration(store, orchestration.id, deps); // asks for approval

      const approval = store
        .listAgentRequests({ taskId: task.id, status: "pending" })
        .find((request) => request.type === "approval" && request.title.includes("Implement X"))!;
      // The request carries who the orchestrator intended to use, so the user
      // can see what they are overriding.
      const intended = JSON.parse(approval.payload!).agentId as string;
      expect([leader.id, stand_in.id]).toContain(intended);
      const picked = intended === stand_in.id ? leader.id : stand_in.id;
      store.resolveAgentRequest(
        approval.id,
        "accepted",
        JSON.stringify({ type: "spawn-approval-response", agentId: picked }),
      );

      const step = stepOrchestration(store, orchestration.id, deps);
      expect(step.spawnedRunIds).toHaveLength(1);
      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.agentId).toBe(picked);
      expect(store.listAssignments({ taskId: task.id, limit: 10 })[0]?.agentId).toBe(picked);
    });
  });

  it("leaves auto and manual orchestrations ungated", () => {
    withStore((store) => {
      for (const autonomy of ["auto", "manual"] as const) {
        const logs = new Map<string, string>();
        const deps = makeDeps(store, logs);
        const leader = store.createRegisteredAgent({ name: `leader-${autonomy}`, provider: "codex", mode: "cli", command: "codex" });
        const task = store.createTask({ title: `Ship ${autonomy}`, ownerAgent: "codex" });
        const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, autonomy });

        const step = stepOrchestration(store, orchestration.id, deps);
        expect(step.spawnedRunIds, `autonomy "${autonomy}"`).toHaveLength(1);
        expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).filter((r) => r.type === "approval")).toHaveLength(0);
      }
    });
  });

  it("treats an empty plan as 'nothing left to build' on a re-plan, but a failure on a first plan", () => {
    withStore((store) => {
      const emptyPlan = {
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan\n\nNothing more to implement; the change request is already satisfied.",
        subtasks: [],
        reviewers: [],
        questions: [],
      };

      // Re-plan: work already exists, so an empty plan means "we're done".
      {
        const logs = new Map<string, string>();
        const deps = makeDeps(store, logs);
        const leader = store.createRegisteredAgent({ name: "leader-replan", provider: "codex", mode: "cli", command: "codex" });
        const task = store.createTask({ title: "Already shipped", ownerAgent: "codex" });
        const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
        const existing = store.createSubtask({ parentTaskId: task.id, title: "Built earlier" });
        store.updateSubtask(existing.id, { status: "done" });

        const planRunId = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
        finishRun(store, logs, planRunId, fenced(emptyPlan));
        const step = stepOrchestration(store, orchestration.id, deps);

        expect(step.orchestration.status).toBe("reporting");
        expect(store.listSubtasks({ parentTaskId: task.id })).toHaveLength(1);
      }

      // First plan: nothing exists, so an empty plan is the leader failing.
      {
        const logs = new Map<string, string>();
        const deps = makeDeps(store, logs);
        const leader = store.createRegisteredAgent({ name: "leader-fresh", provider: "codex", mode: "cli", command: "codex" });
        const task = store.createTask({ title: "Brand new", ownerAgent: "codex" });
        const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

        const planRunId = stepOrchestration(store, orchestration.id, deps).spawnedRunIds[0]!;
        finishRun(store, logs, planRunId, fenced(emptyPlan));
        const step = stepOrchestration(store, orchestration.id, deps);

        expect(step.orchestration.status).toBe("paused");
        expect(store.listAgentRequests({ taskId: task.id, status: "pending" }).length).toBeGreaterThan(0);
      }
    });
  });

  it("keeps an assignment's result summary short, since every prompt replays it", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // -> executing
      step = stepOrchestration(store, orchestration.id, deps); // spawn implementer

      // A real implementer log is far longer than what belongs in a prompt.
      const tail = "FINAL SUMMARY: shipped it.";
      finishRun(store, logs, step.spawnedRunIds[0]!, "x".repeat(20_000) + tail);
      stepOrchestration(store, orchestration.id, deps);

      const assignment = store.listAssignments({ taskId: task.id, limit: 10 })[0]!;
      expect(assignment.resultSummary!.length).toBeLessThanOrEqual(800);
      // The tail is what carries the agent's own conclusion, so keep that end.
      expect(assignment.resultSummary).toContain(tail);
    });
  });

  it("stamps every spawned run with the cycle it belongs to", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      // cycle 0 while planning
      let step = stepOrchestration(store, orchestration.id, deps);
      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.cycle).toBe(0);

      finishRun(store, logs, step.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{ key: "s1", title: "Implement X", acceptanceCriteria: ["done"], dependsOn: [], files: [] }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps); // applyPlanTurn sets cycle 1

      step = stepOrchestration(store, orchestration.id, deps);
      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.cycle).toBe(1);
    });
  });
  it("offers the leader only registered enabled agents, not every installed CLI", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts: string[] = [];
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput) => {
          prompts.push(input.prompt);
          return makeDeps(store, logs).spawn(input);
        },
        // Installed on this machine, but nobody registered an agent for it —
        // so the leader must never hear about it.
        listProviders: () => [
          { provider: "codex", models: ["gpt-5.6-sol"] },
          { provider: "gemini", models: ["gemini-2.5-pro"] },
        ],
      };
      const leader = createWorkerLeader(store);
      store.createRegisteredAgent({
        name: "claude-opus",
        provider: "claude",
        mode: "cli",
        command: "claude",
        model: "claude-opus-5",
        capabilities: ["implement", "review"],
      });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      stepOrchestration(store, orchestration.id, deps);

      expect(prompts[0]).toContain("claude — models: claude-opus-5");
      expect(prompts[0]).not.toContain("gemini");
      expect(prompts[0]).toContain("Staff from the roster above.");
      expect(prompts[0]).toContain("You are NOT limited to your own provider.");
    });
  });

  it("hides agents the user disabled in the Agents tab", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts: string[] = [];
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput) => {
          prompts.push(input.prompt);
          return makeDeps(store, logs).spawn(input);
        },
      };
      const leader = createWorkerLeader(store);
      const claude = store.createRegisteredAgent({ name: "claude-opus", provider: "claude", mode: "cli", command: "claude", capabilities: ["implement", "review"] });
      store.updateRegisteredAgent(claude.id, { enabled: false });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      stepOrchestration(store, orchestration.id, deps);

      // Not `not.toContain("claude")`: the prompt's worked JSON example names
      // claude regardless. The roster line is what has to shrink.
      expect(prompts[0]).toContain("Available agent providers for this team: codex.");
      expect(prompts[0]).not.toContain("- claude");
    });
  });

  it("honours the orchestration's team-provider allowlist", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts: string[] = [];
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput) => {
          prompts.push(input.prompt);
          return makeDeps(store, logs).spawn(input);
        },
      };
      const leader = createWorkerLeader(store);
      store.createRegisteredAgent({ name: "claude-opus", provider: "claude", mode: "cli", command: "claude", capabilities: ["implement", "review"] });
      store.createRegisteredAgent({ name: "gemini-pro", provider: "gemini", mode: "cli", command: "gemini", capabilities: ["implement", "review"] });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        teamProviders: ["codex", "claude"],
      });

      stepOrchestration(store, orchestration.id, deps);

      // Roster order follows listRegisteredAgents (enabled, then name).
      expect(prompts[0]).toContain("Available agent providers for this team: claude, codex.");
      expect(prompts[0]).not.toContain("gemini");
    });
  });

  it("uses a capability-matched adjudicator first but requires the Leader to confirm completion", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts = new Map<string, string>();
      const deps = makeDeps(store, logs, prompts);
      const leader = createWorkerLeader(store);
      const adjudicator = store.createRegisteredAgent({
        name: "cheap-adjudicator",
        provider: "codex",
        mode: "cli",
        command: "codex",
        capabilities: ["adjudicate"],
      });
      const task = store.createTask({ title: "Confirm completion", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "adjudicating", cycle: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      const firstPassRunId = step.spawnedRunIds[0]!;
      expect(store.getAgentRun(firstPassRunId)?.agentId).toBe(adjudicator.id);
      expect(prompts.get(firstPassRunId)).toContain("# Adjudicator Turn");

      finishRun(store, logs, firstPassRunId, fenced({
        version: 1,
        phase: "adjudicate",
        decisions: [],
        projectComplete: true,
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps);
      const leaderRunId = step.spawnedRunIds[0]!;
      expect(store.getAgentRun(leaderRunId)?.agentId).toBe(leader.id);
      expect(prompts.get(leaderRunId)).toContain("# First-pass Adjudicator Proposal");
      expect(step.orchestration.status).toBe("adjudicating");

      finishRun(store, logs, leaderRunId, fenced({
        version: 1,
        phase: "adjudicate",
        decisions: [],
        projectComplete: true,
        questions: [],
      }));
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("reporting");
    });
  });

  it("does not select an adjudicator outside Team providers", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      store.createRegisteredAgent({
        name: "claude-adjudicator",
        provider: "claude",
        mode: "cli",
        command: "claude",
        capabilities: ["adjudicate"],
      });
      const task = store.createTask({ title: "Codex-only adjudication", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        teamProviders: ["codex"],
      });
      store.updateOrchestration(orchestration.id, { status: "adjudicating", cycle: 1 });

      const step = stepOrchestration(store, orchestration.id, deps);
      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.agentId).toBe(leader.id);
    });
  });

  it("does not widen an allowlist when none of its providers are staffable", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts: string[] = [];
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput) => {
          prompts.push(input.prompt);
          return makeDeps(store, logs).spawn(input);
        },
      };
      const leader = store.createRegisteredAgent({
        name: "claude-leader",
        provider: "claude",
        mode: "cli",
        command: "claude",
      });
      store.createRegisteredAgent({
        name: "claude-worker",
        provider: "claude",
        mode: "cli",
        command: "claude",
        capabilities: ["implement", "review"],
      });
      const task = store.createTask({ title: "Codex-only team", ownerAgent: "claude" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        teamProviders: ["codex"],
      });

      stepOrchestration(store, orchestration.id, deps);

      expect(prompts[0]).toContain("none registered yet");
      expect(prompts[0]).not.toContain("claude-worker");
    });
  });

  it("offers installed CLIs to the leader when the roster is empty", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const prompts: string[] = [];
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        spawn: (input: SpawnAgentTurnInput) => {
          prompts.push(input.prompt);
          return makeDeps(store, logs).spawn(input);
        },
        listProviders: () => [
          { provider: "codex", models: ["gpt-5.6-sol"] },
          { provider: "gemini", models: ["gemini-2.5-pro"] },
        ],
      };
      // The leader itself is registered, but it has neither implement nor
      // review capability, so there is nothing in the roster to staff from.
      const leader = store.createRegisteredAgent({
        name: "leader-only",
        provider: "codex",
        mode: "cli",
        command: "codex",
        capabilities: ["plan"],
      });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      stepOrchestration(store, orchestration.id, deps);

      expect(prompts[0]).toContain("codex — models: gpt-5.6-sol");
      expect(prompts[0]).toContain("gemini — models: gemini-2.5-pro");
      expect(prompts[0]).toContain("registers one automatically the first time you staff them");
    });
  });

  it("auto-registers an agent when the leader staffs a provider the roster has none for", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        listProviders: () => [{ provider: "kimi", models: [] }],
        defaultCommandFor: (provider) => (provider === "kimi" ? "kimi" : undefined),
      };
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const planStep = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, planStep.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          {
            key: "s1",
            title: "Implement X",
            acceptanceCriteria: ["done"],
            dependsOn: [],
            files: [],
            // Not in the roster: the leader asked for a provider the user
            // never registered.
            agentPreference: { provider: "kimi", mode: "cli" },
          },
        ],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);
      const step = stepOrchestration(store, orchestration.id, deps);

      expect(step.spawnedRunIds).toHaveLength(1);
      const staffed = store.listRegisteredAgents({ provider: "kimi", limit: 10 });
      expect(staffed).toHaveLength(1);
      expect(staffed[0]!.command).toBe("kimi");
      expect(staffed[0]!.capabilities).toContain("implement");
      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.agentId).toBe(staffed[0]!.id);
    });
  });

  it("refuses to staff a provider outside the team allowlist instead of registering it", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps: OrchestratorDeps = {
        ...makeDeps(store, logs),
        listProviders: () => [{ provider: "kimi", models: [] }],
        defaultCommandFor: (provider) => provider,
      };
      const leader = createWorkerLeader(store);
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        teamProviders: ["codex"],
      });

      const planStep = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, planStep.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          {
            key: "s1",
            title: "Implement X",
            acceptanceCriteria: ["done"],
            dependsOn: [],
            files: [],
            agentPreference: { provider: "kimi", mode: "cli" },
          },
        ],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);

      expect(() => stepOrchestration(store, orchestration.id, deps)).toThrow(/not allowed for implementer staffing/);
      expect(store.listRegisteredAgents({ provider: "kimi", limit: 10 })).toHaveLength(0);
    });
  });

  it("never spawns a registered provider outside the orchestration team allowlist", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      store.createRegisteredAgent({
        name: "claude-implementer",
        provider: "claude",
        mode: "cli",
        command: "claude",
        capabilities: ["implement"],
      });
      const task = store.createTask({ title: "Codex-only re-plan", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: leader.id,
        teamProviders: ["codex"],
      });

      const planStep = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, planStep.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [{
          key: "s1",
          title: "Implement X",
          acceptanceCriteria: ["done"],
          dependsOn: [],
          files: [],
          agentPreference: { provider: "claude", mode: "cli" },
        }],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);

      expect(() => stepOrchestration(store, orchestration.id, deps)).toThrow(
        /Provider "claude" is not allowed.*codex/,
      );
      expect(
        store.listAgentRuns({ orchestrationId: orchestration.id, limit: 50 }).filter((run) => run.phase === "implement"),
      ).toHaveLength(0);
    });
  });

  it("falls back within the roster when the leader asks for a model that is not registered", () => {
    withStore((store) => {
      const logs = new Map<string, string>();
      const deps = makeDeps(store, logs);
      const leader = createWorkerLeader(store);
      const claude = store.createRegisteredAgent({
        name: "claude-opus",
        provider: "claude",
        mode: "cli",
        command: "claude",
        model: "claude-opus-5",
        capabilities: ["implement"],
      });
      const task = store.createTask({ title: "Ship it", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const planStep = stepOrchestration(store, orchestration.id, deps);
      finishRun(store, logs, planStep.spawnedRunIds[0]!, fenced({
        version: 1,
        phase: "plan",
        complexity: "small",
        planMarkdown: "# Plan",
        subtasks: [
          {
            key: "s1",
            title: "Implement X",
            acceptanceCriteria: ["done"],
            dependsOn: [],
            files: [],
            agentPreference: { provider: "claude", mode: "cli", model: "claude-sonnet-5" },
          },
        ],
        reviewers: [],
        questions: [],
      }));
      stepOrchestration(store, orchestration.id, deps);
      const step = stepOrchestration(store, orchestration.id, deps);

      expect(store.getAgentRun(step.spawnedRunIds[0]!)?.agentId).toBe(claude.id);
      // No new agent record was invented for the unregistered model.
      expect(store.listRegisteredAgents({ limit: 100 }).map((agent) => agent.name).sort()).toEqual([
        "claude-opus",
        "leader",
      ]);
    });
  });
});
