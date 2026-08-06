import { describe, expect, it } from "vitest";
import {
  CACHE_BREAKPOINT_MARKER,
  splitCacheable,
  toCacheableBlocks,
} from "./prompt-cache.js";
import { renderPromptPack } from "./prompt-pack.js";

describe("splitCacheable", () => {
  it("splits at the breakpoint marker", () => {
    const { prefix, suffix } = splitCacheable(
      `stable\n${CACHE_BREAKPOINT_MARKER}\ndynamic`,
    );
    expect(prefix).toBe("stable");
    expect(suffix).toBe("dynamic");
  });

  it("treats markerless text as all-dynamic", () => {
    expect(splitCacheable("just text")).toEqual({
      prefix: "",
      suffix: "just text",
    });
  });
});

describe("toCacheableBlocks", () => {
  it("puts cache_control only on the stable prefix block", () => {
    const blocks = toCacheableBlocks(
      `stable\n${CACHE_BREAKPOINT_MARKER}\ndynamic`,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(blocks[1]?.text).toBe("dynamic");
  });

  it("emits a single uncached block when there is no prefix", () => {
    const blocks = toCacheableBlocks("just text");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toBeUndefined();
  });
});

describe("renderPromptPack cache layout", () => {
  it("places stable sections before the breakpoint and dynamic ones after", () => {
    const markdown = renderPromptPack({
      agent: "codex",
      task: {
        id: "t1",
        title: "Fix auth",
        goal: "Session survives refresh",
        status: "in_progress",
      },
      currentState: ["Cookie not restored"],
      sharedMemory: ["Objective: Session survives refresh"],
      relevantFiles: [],
      knownDecisions: ["Use httpOnly cookies"],
      constraints: ["Do not touch payment auth flow"],
      nextActions: [],
      risks: [],
    });

    const { prefix, suffix } = splitCacheable(markdown);
    expect(prefix).toContain("## Constraints");
    expect(prefix).toContain("Do not touch payment auth flow");
    expect(prefix).toContain("## Known Decisions");
    expect(prefix).not.toContain("## Current State");
    expect(prefix).not.toContain("## Shared Memory");
    expect(suffix).toContain("## Goal");
    expect(suffix).toContain("## Shared Memory");
    expect(suffix).toContain("## Current State");
    expect(suffix).toContain("Cookie not restored");
  });
});
