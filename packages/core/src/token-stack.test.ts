import { describe, expect, it } from "vitest";
import { estimateTokenSavings } from "./token-stack.js";

describe("estimateTokenSavings", () => {
  it("reports token-saving stages for the common stack", () => {
    const estimate = estimateTokenSavings({
      task: {
        id: "task-1",
        title: "Fix auth",
        goal: "Keep users logged in after refresh",
        status: "in_progress",
        ownerAgent: "claude",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      memories: [
        {
          id: "mem-1",
          taskId: "task-1",
          type: "bug",
          content: "Cookie exists but session is not restored after refresh.",
          importance: 5,
          tags: ["auth", "cookie"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      compiledContext: [
        "# Agent Task Brief",
        "## Goal",
        "Keep users logged in after refresh",
        "## Constraints",
        "- Do not touch payment auth flow.",
        "## Expected Output",
        "- Minimal diff."
      ].join("\n"),
      rawLog: "Progress: resolved 100 packages\nError: auth test failed\nError: auth test failed"
    });

    expect(estimate.rawTokens).toBeGreaterThan(0);
    expect(estimate.stages.map((stage) => stage.id)).toEqual([
      "rtk",
      "context-compile",
      "cache-proxy",
      "token-optimizer"
    ]);
    expect(estimate.savingsPercent).toBeGreaterThanOrEqual(0);
  });
});
