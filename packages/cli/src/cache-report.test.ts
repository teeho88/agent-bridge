import { describe, expect, it } from "vitest";
import { daysAgoStamp, summarizeCcusageDaily } from "./cache-report.js";

const sample = {
  daily: [
    {
      period: "2026-08-10",
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 300,
      cacheReadTokens: 600,
      totalCost: 1.5,
      modelBreakdowns: [
        {
          modelName: "claude-opus-5",
          inputTokens: 20,
          outputTokens: 30,
          cacheCreationTokens: 300,
          cacheReadTokens: 500,
          cost: 1.2
        },
        {
          modelName: "gpt-5.6-sol",
          inputTokens: 80,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 100,
          cost: 0.3
        }
      ]
    },
    {
      period: "2026-08-11",
      inputTokens: 0,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 900,
      totalCost: 0.5,
      modelBreakdowns: [
        {
          modelName: "claude-opus-5",
          inputTokens: 0,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 900,
          cost: 0.5
        }
      ]
    }
  ]
};

describe("summarizeCcusageDaily", () => {
  it("totals cache reads and writes across days", () => {
    const summary = summarizeCcusageDaily(sample);
    expect(summary.days).toBe(2);
    expect(summary.cacheReadTokens).toBe(1500);
    expect(summary.cacheCreationTokens).toBe(300);
    expect(summary.inputTokens).toBe(100);
    expect(summary.cost).toBeCloseTo(2.0);
    expect(summary.firstPeriod).toBe("2026-08-10");
    expect(summary.lastPeriod).toBe("2026-08-11");
  });

  // Output tokens are never cacheable; counting them in the denominator would
  // make a well-cached session look worse the more it wrote.
  it("computes the hit rate over prompt tokens only", () => {
    const summary = summarizeCcusageDaily(sample);
    expect(summary.promptTokens).toBe(1900);
    expect(summary.hitRatePct).toBe(78.9);
    expect(summary.readPerWrite).toBe(5);
  });

  it("splits totals per model, most expensive first", () => {
    const summary = summarizeCcusageDaily(sample);
    expect(summary.models.map((model) => model.model)).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
    expect(summary.models[0]?.cacheReadTokens).toBe(1400);
    expect(summary.models[1]?.hitRatePct).toBe(55.6);
  });

  // A cache that is written but never read back costs more than no cache at
  // all, so the zero-write and zero-read cases must not divide by zero.
  it("reports zeroes instead of NaN for empty usage", () => {
    const summary = summarizeCcusageDaily({ daily: [] });
    expect(summary.days).toBe(0);
    expect(summary.hitRatePct).toBe(0);
    expect(summary.readPerWrite).toBe(0);
    expect(summary.models).toEqual([]);
  });

  it("tolerates malformed payloads", () => {
    expect(summarizeCcusageDaily(undefined).days).toBe(0);
    expect(summarizeCcusageDaily({ daily: "nope" }).days).toBe(0);
    expect(
      summarizeCcusageDaily({ daily: [{ cacheReadTokens: "12", modelBreakdowns: null }] })
        .cacheReadTokens
    ).toBe(0);
  });
});

describe("daysAgoStamp", () => {
  it("renders ccusage's YYYYMMDD form", () => {
    expect(daysAgoStamp(0)).toMatch(/^\d{8}$/);
  });
});
