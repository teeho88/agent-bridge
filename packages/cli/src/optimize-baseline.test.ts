import { describe, expect, it } from "vitest";
import { formatBaselineRunSummary, parseBaselineRun, summarizeBaseline } from "./optimize-baseline.js";

describe("summarizeBaseline", () => {
  it("computes saved tokens and percentage from raw-read vs index cost", () => {
    const summary = summarizeBaseline(
      [
        { path: "a.ts", tokens: 600 },
        { path: "b.ts", tokens: 400 }
      ],
      100
    );
    expect(summary.fileCount).toBe(2);
    expect(summary.baselineTokens).toBe(1000);
    expect(summary.optimizedTokens).toBe(100);
    expect(summary.savedTokens).toBe(900);
    expect(summary.savedPct).toBe(90);
  });

  it("rounds percentage to one decimal", () => {
    const summary = summarizeBaseline([{ path: "a.ts", tokens: 3000 }], 1000);
    expect(summary.savedPct).toBe(66.7);
  });

  it("handles an empty file set without dividing by zero", () => {
    const summary = summarizeBaseline([], 0);
    expect(summary.baselineTokens).toBe(0);
    expect(summary.savedPct).toBe(0);
  });

  it("reports negative savings when the index costs more than the source", () => {
    const summary = summarizeBaseline([{ path: "tiny.ts", tokens: 50 }], 200);
    expect(summary.savedTokens).toBe(-150);
    expect(summary.savedPct).toBe(-300);
  });
});

describe("baseline run round-trip", () => {
  it("formats and parses back the same numbers", () => {
    const summary = summarizeBaseline([{ path: "a.ts", tokens: 1000 }], 50);
    const point = parseBaselineRun({
      createdAt: "2026-06-22T00:00:00.000Z",
      agent: "claude",
      resultSummary: formatBaselineRunSummary(summary),
      tokenEstimate: summary.optimizedTokens
    });
    expect(point).not.toBeNull();
    expect(point?.savedPct).toBe(summary.savedPct);
    expect(point?.savedTokens).toBe(summary.savedTokens);
    expect(point?.fileCount).toBe(summary.fileCount);
    expect(point?.optimizedTokens).toBe(50);
  });

  it("parses negative savings", () => {
    const point = parseBaselineRun({ createdAt: "t", resultSummary: "Saved -300% (-150 tokens) over 1 files" });
    expect(point?.savedPct).toBe(-300);
    expect(point?.savedTokens).toBe(-150);
  });

  it("returns null for non-baseline summaries", () => {
    expect(parseBaselineRun({ createdAt: "t", resultSummary: "Compiled for claude" })).toBeNull();
    expect(parseBaselineRun({ createdAt: "t" })).toBeNull();
  });
});
