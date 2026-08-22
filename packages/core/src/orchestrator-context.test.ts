import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "@agent-bridge/memory";
import type { AgentRun } from "@agent-bridge/memory";
import { createContextStore, type ContextStoreIO } from "./context-store.js";
import { stepOrchestration, type OrchestratorDeps, type SpawnAgentTurnInput } from "./orchestrator.js";

function fenced(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

function memoryIO(): ContextStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: (path) => files.has(path),
    read: (path) => files.get(path),
    write: (path, content) => void files.set(path, content),
    append: (path, content) => void files.set(path, `${files.get(path) ?? ""}${content}`),
  };
}

function summaryDoc(title: string): string {
  return `# ${title}\n\n## Summary\nDone.\n\n## Detail\nAll of it.\n`;
}

describe("orchestrator context store", () => {
  function harness(fn: (h: {
    store: SQLiteMemoryStore;
    deps: OrchestratorDeps;
    logs: Map<string, string>;
    prompts: Map<string, string>;
    files: Map<string, string>;
    finish: (runId: string, log: string) => void;
  }) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-context-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    const logs = new Map<string, string>();
    const prompts = new Map<string, string>();
    const io = memoryIO();
    const deps: OrchestratorDeps = {
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
          logPath: ".agent-memory/artifacts/runs/source.log",
        });
        prompts.set(run.id, input.prompt);
        return run;
      },
      readLog: (run: AgentRun) => logs.get(run.id) ?? "",
      writePlanFile: () => "/tmp/plan.md",
      contextStoreFor: (orchestrationId) => createContextStore(io, orchestrationId),
    };
    try {
      fn({
        store,
        deps,
        logs,
        prompts,
        files: io.files,
        finish: (runId, log) => {
          logs.set(runId, log);
          store.updateAgentRun(runId, { status: "done", exitCode: 0 });
        },
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function planLog(): string {
    return fenced({
      version: 1,
      phase: "plan",
      complexity: "small",
      planMarkdown: "# Plan\n\n## Summary\nBuild the thing.\n",
      subtasks: [
        { key: "s1", title: "Build the thing", acceptanceCriteria: ["it works"], dependsOn: [], files: ["src/thing.ts"] },
      ],
      reviewers: [{ key: "r1", scope: ["s1"] }],
      questions: [],
    });
  }

  function seed(store: SQLiteMemoryStore) {
    const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
    store.createRegisteredAgent({
      name: "worker",
      provider: "codex",
      mode: "cli",
      command: "codex",
      capabilities: ["implement", "review"],
    });
    const task = store.createTask({ title: "Ship it", goal: "ship the thing", ownerAgent: "codex" });
    return { leader, task };
  }

  it("files the plan and briefs the implementer through the store instead of the prompt", () => {
    harness(({ store, deps, prompts, files, finish }) => {
      const { leader, task } = seed(store);
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      const planPrompt = prompts.get(step.spawnedRunIds[0]!)!;
      // The leader is told where its plan lands, and that a question round
      // files nothing — the plan is written once, when it stops asking.
      expect(planPrompt).toContain(".agent-memory/context/");
      expect(planPrompt).toContain("plan.md");

      finish(step.spawnedRunIds[0]!, planLog());
      step = stepOrchestration(store, orchestration.id, deps);
      expect(step.orchestration.status).toBe("executing");
      expect(step.orchestration.planPath).toBe(`.agent-memory/context/${orchestration.id}/plan.md`);
      expect(files.get(step.orchestration.planPath!)).toContain("Build the thing.");
      expect(files.get(`.agent-memory/context/${orchestration.id}/index.md`)).toContain("`c1-s1`");

      step = stepOrchestration(store, orchestration.id, deps);
      const implementRunId = step.spawnedRunIds[0]!;
      const root = `.agent-memory/context/${orchestration.id}`;

      expect(files.get(`${root}/tasks/c1-s1/brief.md`)).toContain("it works");
      expect(files.get(`${root}/assignment-log.md`)).toContain("| c1-s1 | r1 | implementer |");

      const implementPrompt = prompts.get(implementRunId)!;
      expect(implementPrompt).toContain(`${root}/tasks/c1-s1/brief.md`);
      expect(implementPrompt).toContain(`${root}/tasks/c1-s1/report-r1.md`);
      // The workspace's own CLAUDE.md/AGENTS.md tell a human's agent to update
      // the handoff; a sub-agent following that writes into the wrong layer.
      expect(implementPrompt).toContain(".handoff/CURRENT.md");
      expect(implementPrompt).toContain("Leave the terminal workboard alone");
    });
  });

  it("uses a monotonic plan namespace so replans cannot overwrite an earlier s1 folder", () => {
    harness(({ store, deps, prompts, files, finish }) => {
      const { leader, task } = seed(store);
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });
      const root = `.agent-memory/context/${orchestration.id}`;

      let step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, planLog());
      stepOrchestration(store, orchestration.id, deps);

      store.updateOrchestration(orchestration.id, { status: "planning" });
      step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, planLog());
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);

      expect(prompts.get(step.spawnedRunIds[0]!)).toContain(`${root}/tasks/c2-s1/brief.md`);
      const index = files.get(`${root}/index.md`)!;
      expect(index).toContain("`c1-s1`");
      expect(index).toContain("`c2-s1`");
    });
  });

  it("asks once for a missing report before letting the subtask reach review", () => {
    harness(({ store, deps, prompts, files, finish }) => {
      const { leader, task } = seed(store);
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });
      const root = `.agent-memory/context/${orchestration.id}`;

      let step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, planLog());
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      const implementRunId = step.spawnedRunIds[0]!;

      // The implementer signs off without leaving its report behind.
      finish(implementRunId, "I finished the work.");
      step = stepOrchestration(store, orchestration.id, deps);
      const retryRunId = step.spawnedRunIds[0]!;
      expect(retryRunId).toBeTruthy();
      expect(prompts.get(retryRunId)).toContain(`${root}/tasks/c1-s1/report-r1.md`);
      expect(prompts.get(retryRunId)).toContain(".agent-memory/artifacts/runs/source.log");
      // Still not in review: the record the reviewer reads does not exist yet.
      expect(store.listSubtasks({ parentTaskId: task.id })[0]!.status).toBe("assigned");

      // It writes the file on the retry, and the subtask moves on.
      files.set(`${root}/tasks/c1-s1/report-r1.md`, summaryDoc("Build the thing"));
      finish(retryRunId, "Written.");
      stepOrchestration(store, orchestration.id, deps);
      expect(store.listSubtasks({ parentTaskId: task.id })[0]!.status).toBe("review");
      expect(store.listAssignments({ taskId: task.id })[0]!.resultSummary).toBe("I finished the work.");
    });
  });

  it("gives up after one retry rather than stalling the run on a document", () => {
    harness(({ store, deps, finish }) => {
      const { leader, task } = seed(store);
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });

      let step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, planLog());
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, "I finished the work.");

      step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, "Sorry, I did not write it.");

      stepOrchestration(store, orchestration.id, deps);
      expect(store.listSubtasks({ parentTaskId: task.id })[0]!.status).toBe("review");
    });
  });

  it("hands the reviewer the report path rather than the tail of a log", () => {
    harness(({ store, deps, prompts, files, finish }) => {
      const { leader, task } = seed(store);
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, maxParallel: 1 });
      const root = `.agent-memory/context/${orchestration.id}`;

      let step = stepOrchestration(store, orchestration.id, deps);
      finish(step.spawnedRunIds[0]!, planLog());
      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      files.set(`${root}/tasks/c1-s1/report-r1.md`, summaryDoc("Build the thing"));
      finish(step.spawnedRunIds[0]!, "x".repeat(4000));

      stepOrchestration(store, orchestration.id, deps);
      step = stepOrchestration(store, orchestration.id, deps);
      const reviewPrompt = prompts.get(step.spawnedRunIds[0]!)!;
      expect(reviewPrompt).toContain(`${root}/tasks/c1-s1/report-r1.md`);
      expect(reviewPrompt).toContain(`${root}/tasks/c1-s1/review-r1.md`);
      // The 800-character log tail used to be pasted in here on every review.
      expect(reviewPrompt).not.toContain("xxxxxxxxxx");
    });
  });
});
