import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stopAgentRun } from "@agent-bridge/adapters";
import { stepOrchestration } from "@agent-bridge/core";
import { openStore } from "../workspace.js";
import { makeOrchestratorDeps } from "./workforce.js";

describe("makeOrchestratorDeps (real spawn wiring)", () => {
  it("writes a real prompt file and spawns a real process for the leader's plan turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-workforce-cli-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({
        name: "leader",
        provider: "codex",
        mode: "cli",
        command: process.execPath,
      });
      const task = store.createTask({ title: "Build the thing", goal: "Build the thing end to end", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const step = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store));

      expect(step.orchestration.status).toBe("planning");
      expect(step.spawnedRunIds).toHaveLength(1);
      const run = store.getAgentRun(step.spawnedRunIds[0]!)!;
      expect(run.phase).toBe("plan");
      expect(run.pid).toBeGreaterThan(0);
      expect(run.logPath).toBeTruthy();

      await stopAgentRun(store, run.id);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws a clear error when the leader agent is not CLI-mode-spawnable", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-workforce-cli-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({
        name: "leader-manual",
        provider: "manual",
        mode: "manual",
      });
      const task = store.createTask({ title: "Manual leader task", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      expect(() => stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store))).toThrow(
        "CLI-mode agents only",
      );
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
