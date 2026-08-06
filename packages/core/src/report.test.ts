import { describe, expect, it } from "vitest";
import { renderFallbackReport, renderReporterPrompt, type ReportContext } from "./report.js";

function baseContext(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    task: {
      id: "task-1",
      title: "Ship the report module",
      goal: "Add a reporter role and a Markdown report",
      status: "in_progress",
      ownerAgent: "codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    orchestration: {
      id: "orch-1",
      taskId: "task-1",
      leaderAgentId: "agent-leader",
      status: "reporting",
      autonomy: "auto",
      cycle: 3,
      maxCycles: 8,
      maxParallel: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    subtasks: [],
    reviews: [],
    assignments: [],
    agents: [],
    taskChanges: [],
    decisions: [],
    ...overrides,
  };
}

describe("renderFallbackReport", () => {
  it("includes all required sections in order", () => {
    const report = renderFallbackReport(baseContext());
    const sections = [
      "Tóm tắt điều hành",
      "Phạm vi & kế hoạch ban đầu",
      "Đội thực hiện",
      "Kết quả theo subtask",
      "Tổng hợp review",
      "Thay đổi file",
      "Rework & lý do",
      "Rủi ro còn lại và việc cần làm tiếp",
      "Phụ lục: timeline",
    ];
    let cursor = -1;
    for (const section of sections) {
      const index = report.indexOf(section);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(report).toContain("Ship the report module — Project Report");
  });

  it("summarizes subtask counts and lists remaining work", () => {
    const context = baseContext({
      subtasks: [
        {
          id: "s1",
          parentTaskId: "task-1",
          title: "Implement renderer",
          status: "done",
          priority: 3,
          dependsOn: [],
          acceptanceCriteria: ["renders markdown"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T01:00:00.000Z",
        },
        {
          id: "s2",
          parentTaskId: "task-1",
          title: "Wire CLI command",
          status: "blocked",
          priority: 3,
          dependsOn: [],
          acceptanceCriteria: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T01:00:00.000Z",
        },
      ],
      reviews: [
        {
          id: "review-1",
          taskId: "task-1",
          subtaskId: "s2",
          verdict: "rework",
          summary: "Missing fallback path",
          createdAt: "2026-01-01T02:00:00.000Z",
        },
      ],
    });
    const report = renderFallbackReport(context);
    expect(report).toContain("2 subtask(s) total: 1 done, 1 blocked/needs rework.");
    expect(report).toContain("Implement renderer");
    expect(report).toContain("Wire CLI command");
    expect(report).toContain("Missing fallback path");
  });

  it("falls back to placeholder text when there is no data", () => {
    const report = renderFallbackReport(baseContext());
    expect(report).toContain("_No assignments recorded._");
    expect(report).toContain("_No reviews recorded._");
    expect(report).toContain("_No file changes recorded._");
    expect(report).toContain("_No rework was needed._");
    expect(report).toContain("_No decisions or handoffs recorded._");
  });
});

describe("renderReporterPrompt", () => {
  it("asks for the same nine sections in the required order", () => {
    const prompt = renderReporterPrompt(baseContext());
    expect(prompt).toContain("Tóm tắt điều hành");
    expect(prompt).toContain("Phụ lục: timeline");
    expect(prompt).toContain("Reply with ONLY the markdown report");
  });
});
