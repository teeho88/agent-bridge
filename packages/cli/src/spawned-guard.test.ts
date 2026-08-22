import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { blockedForSpawnedRun, installSpawnedRunGuard } from "./spawned-guard.js";

describe("blockedForSpawnedRun", () => {
  const spawned = { spawnedRun: "run-1", orchestration: "orch-7" };

  it("lets everything through for a human terminal", () => {
    expect(blockedForSpawnedRun(["handoff", "create"], {})).toBeUndefined();
    expect(blockedForSpawnedRun(["task", "start"], { orchestration: "orch-7" })).toBeUndefined();
  });

  it("blocks the workboard writes an orchestrated agent should never make", () => {
    for (const path of [
      ["handoff", "create"],
      ["context", "compile"],
      ["session", "start"],
      ["task", "start"],
      ["memory", "add"],
    ]) {
      expect(blockedForSpawnedRun(path, spawned), path.join(" ")).toContain("not available");
    }
  });

  it("points the agent at its own context folder instead of just refusing", () => {
    const message = blockedForSpawnedRun(["handoff", "create"], spawned)!;
    expect(message).toContain(".agent-memory/context/orch-7/");
    // Without the orchestration id the message still has to say where to write.
    expect(blockedForSpawnedRun(["handoff", "create"], { spawnedRun: "run-1" })).toContain(
      "named in your prompt",
    );
  });

  it("leaves reads and the orchestration's own commands alone", () => {
    for (const path of [
      ["task", "current"],
      ["memory", "search"],
      ["context", "show"],
      ["graph", "brief-auto"],
      ["file", "lease"],
      ["orchestration"],
    ]) {
      expect(blockedForSpawnedRun(path, spawned), path.join(" ")).toBeUndefined();
    }
  });
});

describe("installSpawnedRunGuard", () => {
  function program(): Command {
    const root = new Command();
    root.exitOverride();
    const ran: string[] = [];
    root.command("handoff").command("create").action(() => void ran.push("create"));
    root.command("task").command("current").action(() => void ran.push("current"));
    installSpawnedRunGuard(root);
    return Object.assign(root, { ran });
  }

  it("refuses a blocked subcommand and allows the rest", async () => {
    const previous = process.env.AGENT_BRIDGE_SPAWNED_RUN;
    process.env.AGENT_BRIDGE_SPAWNED_RUN = "run-1";
    try {
      await expect(
        program().parseAsync(["node", "agent-bridge", "handoff", "create"]),
      ).rejects.toThrow(/not available/);
      await expect(
        program().parseAsync(["node", "agent-bridge", "task", "current"]),
      ).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_SPAWNED_RUN;
      else process.env.AGENT_BRIDGE_SPAWNED_RUN = previous;
    }
  });
});
