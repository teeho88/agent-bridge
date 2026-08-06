import { describe, expect, it } from "vitest";
import { compactText, dedupeStrings, estimateTokens, trimToTokenBudget } from "./token-optimizer.js";

describe("estimateTokens", () => {
  it("matches the legacy length/4 estimate for pure ASCII", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil("hello world".length / 4));
  });

  it("returns 0 for empty or whitespace-only input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t ")).toBe(0);
  });

  it("estimates Vietnamese higher than a flat length/4 heuristic", () => {
    const text = "Sửa lỗi đăng nhập tiếng Việt";
    const flat = Math.ceil(text.length / 4);
    expect(estimateTokens(text)).toBeGreaterThan(flat);
  });

  it("weights CJK roughly one token per character", () => {
    const cjk = "登录会话刷新令牌优化"; // 10 ideographs
    expect(estimateTokens(cjk)).toBe(10);
  });
});

describe("dedupeStrings", () => {
  it("removes case- and whitespace-insensitive duplicates, keeping first form", () => {
    expect(dedupeStrings([" Fix Auth ", "fix auth", "Other"])).toEqual(["Fix Auth", "Other"]);
  });
});

describe("trimToTokenBudget", () => {
  it("stops once the budget would be exceeded", () => {
    const items = ["aaaa", "bbbb", "cccc"]; // 1 token each
    expect(trimToTokenBudget(items, 2)).toEqual(["aaaa", "bbbb"]);
  });
});

describe("compactText", () => {
  it("truncates past the max char budget", () => {
    const out = compactText("x".repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("[truncated]");
  });
});
