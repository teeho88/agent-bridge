import { describe, expect, it } from "vitest";
import {
  contextKeyFor,
  createContextStore,
  roundFor,
  type ContextStoreIO,
} from "./context-store.js";

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

describe("context store keys", () => {
  it("folds every rework attempt into the original's folder", () => {
    expect(contextKeyFor("s1", "id-1")).toBe("s1");
    expect(contextKeyFor("s1-rework-2", "id-2")).toBe("s1");
    expect(contextKeyFor("s1-rework-2-rework-3", "id-3")).toBe("s1");
  });

  it("scopes a folder to the cycle its key was planned in, so a reused key cannot collide", () => {
    // Every plan calls its first subtask "s1"; without the cycle, cycle 2's s1
    // would overwrite cycle 1's brief, report and summary.
    expect(contextKeyFor("s1", "id-1", 1)).toBe("c1-s1");
    expect(contextKeyFor("s1", "id-9", 2)).toBe("c2-s1");
    // A rework belongs to the cycle its original was planned in, not the one
    // that raised it — same folder, later round.
    expect(contextKeyFor("s1-rework-4", "id-4", 1)).toBe("c1-s1");
    // Metas written before folders were cycle-scoped keep their old folder.
    expect(contextKeyFor("s1", "id-1", undefined)).toBe("s1");
  });

  it("numbers each attempt so a rework cannot overwrite the round it replaces", () => {
    expect(roundFor("s1")).toBe(1);
    expect(roundFor("s1-rework-2")).toBe(2);
    expect(roundFor("s1-rework-2-rework-5")).toBe(3);
  });

  it("keeps a leader-authored key inside its own directory", () => {
    expect(contextKeyFor("../../etc/passwd", "id")).toBe("etc-passwd");
    expect(contextKeyFor("   ", "fallback-id")).toBe("fallback-id");
  });

  it("gives different rounds different files", () => {
    const store = createContextStore(memoryIO(), "orch-1");
    expect(store.turnPath("report", "s1", 1)).not.toBe(store.turnPath("report", "s1", 2));
    expect(store.turnPath("report", "s1", 2)).toBe(".agent-memory/context/orch-1/tasks/s1/report-r2.md");
  });
});

describe("context store gate", () => {
  it("rejects a turn that wrote nothing, wrote no summary, or left it empty", () => {
    const io = memoryIO();
    const store = createContextStore(io, "orch-1");
    const path = store.turnPath("report", "s1", 1);

    expect(store.checkTurn("report", "s1", 1).ok).toBe(false);

    io.write(path, "# Report\n\nI did the thing.\n");
    const noSummary = store.checkTurn("report", "s1", 1);
    expect(noSummary.ok).toBe(false);
    expect(noSummary.ok === false && noSummary.reason).toContain("## Summary");

    io.write(path, "# Report\n\n## Summary\n\n## Detail\nlots of words\n");
    expect(store.checkTurn("report", "s1", 1).ok).toBe(false);

    io.write(path, "# Report\n\n## Summary\nAdded the parser.\n\n## Detail\nlots of words\n");
    expect(store.checkTurn("report", "s1", 1).ok).toBe(true);
  });
});

describe("plan document", () => {
  it("carries the revision log forward so the reason for each change survives", () => {
    const io = memoryIO();
    const store = createContextStore(io, "orch-1");

    store.writePlan("# Plan v1\n\nDo the thing.");
    expect(io.files.get(store.planPath)).not.toContain("## Revision");

    store.writePlan("# Plan v2\n\nDo it differently.", {
      trigger: "review found the parser is wrong",
      change: "split the parser subtask in two",
    });
    store.writePlan("# Plan v3\n\nDo it a third way.", {
      trigger: "user change request",
      change: "drop the CLI flag",
    });

    const plan = io.files.get(store.planPath)!;
    // The body is the newest plan only...
    expect(plan).toContain("# Plan v3");
    expect(plan).not.toContain("Do it differently.");
    // ...but every reason a revision happened is still there. Losing these is
    // what lets revision N+1 undo revision N and loop.
    expect(plan).toContain("## Revision 1");
    expect(plan).toContain("review found the parser is wrong");
    expect(plan).toContain("## Revision 2");
    expect(plan).toContain("drop the CLI flag");
  });
});

describe("assignment log", () => {
  it("appends, so two implementers dispatched together both survive", () => {
    const io = memoryIO();
    const store = createContextStore(io, "orch-1");
    store.appendAssignment({ contextKey: "s1", round: 1, role: "implementer", agent: "codex", subtaskTitle: "One" });
    store.appendAssignment({ contextKey: "s2", round: 1, role: "implementer", agent: "claude", subtaskTitle: "Two" });
    store.appendAssignment({ contextKey: "s1", round: 2, role: "implementer", agent: "codex", subtaskTitle: "One again" });

    const log = io.files.get(store.assignmentLogPath)!;
    expect(log).toContain("| s1 | r1 | implementer | codex | One");
    expect(log).toContain("| s2 | r1 | implementer | claude | Two");
    expect(log).toContain("| s1 | r2 | implementer | codex | One again");
  });
});

describe("assignment brief", () => {
  it("points at each dependency's summary and nothing else of theirs", () => {
    const io = memoryIO();
    const store = createContextStore(io, "orch-1");
    store.writeBrief({
      contextKey: "s2",
      title: "Wire the CLI",
      goal: "expose the parser",
      acceptanceCriteria: ["cli --parse works"],
      files: ["src/cli.ts"],
      dependencies: [{ title: "Build the parser", summaryPath: store.summaryPath("s1") }],
    });

    const brief = io.files.get(store.briefPath("s2"))!;
    expect(brief).toContain("## Summary");
    expect(brief).toContain("cli --parse works");
    expect(brief).toContain(".agent-memory/context/orch-1/tasks/s1/summary.md");
    expect(brief).not.toContain("report-r1.md");
  });
});
