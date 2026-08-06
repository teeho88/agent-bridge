import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWriteLeases } from "./graph.js";
import { openStore } from "../workspace.js";

describe("graph brief Work-Git guard", () => {
  it("requires a current task write lease before marking a file edited", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-graph-"));
    const store = openStore(root);
    try {
      const task = store.createTask({ title: "Edit session", ownerAgent: "codex" });

      expect(() => assertWriteLeases(store, task.id, ["src/session.ts"])).toThrow("Missing write lease");

      store.acquireFileLease({ taskId: task.id, path: "src/session.ts", mode: "write", agent: "codex" });

      expect(() => assertWriteLeases(store, task.id, ["src/session.ts"])).not.toThrow();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});