import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Handoff, Task } from "@agent-bridge/memory";
import { writeHandoffArtifacts } from "./handoff.js";

describe("writeHandoffArtifacts", () => {
  it("writes portable current and indexed history for a manual handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-handoff-"));
    const handoff: Handoff = {
      id: "handoff-12345678",
      taskId: "task-1",
      fromAgent: "codex",
      summary: "Core flow works; verification is still pending.",
      done: ["Implemented the core flow"],
      next: ["Run the focused tests"],
      risks: ["Do not overwrite unrelated changes"],
      filesChanged: ["packages/cli/src/commands/handoff.ts"],
      createdAt: "2026-08-20T14:30:00.000Z",
      auto: false
    };
    const task: Task = {
      id: "task-1",
      title: "Improve handoff",
      goal: "Make handoffs portable across agents.",
      status: "in_progress",
      createdAt: handoff.createdAt,
      updatedAt: handoff.createdAt
    };

    try {
      writeHandoffArtifacts(root, handoff, { archive: true, task });

      const current = readFileSync(join(root, ".handoff", "CURRENT.md"), "utf8");
      expect(current).toContain("# Handoff — Improve handoff");
      expect(current).toContain("From: codex");
      expect(current).not.toContain("To:");
      expect(current).toContain("1. **P0** Run the focused tests");
      expect(current).toContain("`packages/cli/src/commands/handoff.ts`");
      const history = readdirSync(join(root, ".handoff", "history"));
      expect(history).toHaveLength(1);
      const index = readFileSync(join(root, ".handoff", "INDEX.md"), "utf8");
      expect(index).toContain("Improve handoff | in_progress");
      expect(index).toContain(`.handoff/history/${history[0]}`);

      writeHandoffArtifacts(root, { ...handoff, summary: "Auto refresh", auto: true }, { task });
      expect(readdirSync(join(root, ".handoff", "history"))).toHaveLength(1);
      expect(readFileSync(join(root, ".handoff", "CURRENT.md"), "utf8"))
        .toContain("Auto refresh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
