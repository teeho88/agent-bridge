import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "./workspace.js";
import {
  applyTaskLabelSuggestion,
  placeholderTaskTitle,
  rememberTaskLabelSource,
  firstTaskLabelSource,
} from "./task-suggestions.js";

describe("task label suggestions", () => {
  it("seeds placeholder task labels once and keeps later prompts from overwriting them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-task-suggestion-"));
    try {
      const store = openStore(cwd);
      try {
        const task = store.createTask({
          title: placeholderTaskTitle("generic"),
          ownerAgent: "generic",
        });

        const seeded = applyTaskLabelSuggestion(store, task.id, {
          titleText: "First completed response",
          goalText: "First completed response",
        });
        expect(seeded?.title).toBe("First completed response");
        expect(seeded?.goal).toBe("First completed response");

        const second = applyTaskLabelSuggestion(store, task.id, {
          titleText: "Second prompt should not rename",
          goalText: "Second prompt should not rename",
        });
        expect(second?.title).toBe("First completed response");
        expect(second?.goal).toBe("First completed response");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps only the first prompt source for delayed Codex seeding", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-task-suggestion-"));
    try {
      const store = openStore(cwd);
      try {
        const task = store.createTask({
          title: placeholderTaskTitle("codex"),
          ownerAgent: "codex",
        });
        rememberTaskLabelSource(store, task.id, "First prompt", "codex");
        rememberTaskLabelSource(store, task.id, "Second prompt", "codex");

        expect(firstTaskLabelSource(store, task.id)).toBe("First prompt");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
