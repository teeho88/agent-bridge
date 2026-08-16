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
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
    });

    const { prefix, suffix } = splitCacheable(markdown);
    expect(prefix).toContain("## Constraints");
    expect(prefix).toContain("Do not touch payment auth flow");
    expect(prefix).toContain("## Known Decisions");
    expect(prefix).toContain("## Goal");
    expect(prefix).not.toContain("## Current State");
    expect(suffix).toContain("## Current State");
    expect(suffix).toContain("Cookie not restored");
  });

  // Shared Memory is distilled from the handoff, so it is rewritten whenever an
  // agent hands off. Above the marker it would invalidate every section behind
  // it — in practice the repo map, the largest block in the pack.
  it("keeps handoff-derived shared memory out of the prefix", () => {
    const markdown = renderPromptPack({
      agent: "claude",
      task: { id: "t1", title: "Fix auth", status: "in_progress" },
      currentState: [],
      sharedMemory: ["Latest handoff: reordered the pack"],
      relevantFiles: [],
      knownDecisions: [],
      constraints: [],
      nextActions: [],
      risks: [],
      repoMap: "- src/auth.ts: session helpers",
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
    });

    const { prefix, suffix } = splitCacheable(markdown);
    expect(prefix).not.toContain("## Shared Memory");
    expect(suffix).toContain("## Shared Memory");
    expect(suffix).toContain("Latest handoff: reordered the pack");
  });

  // Ordering inside the prefix is what limits the blast radius of a change:
  // the repo map is the largest block, so nothing more volatile may precede it.
  it("puts the repo map last in the prefix", () => {
    const markdown = renderPromptPack({
      agent: "claude",
      task: { id: "t1", title: "Fix auth", status: "todo" },
      currentState: [],
      sharedMemory: [],
      relevantFiles: [],
      knownDecisions: ["Use httpOnly cookies"],
      constraints: ["Do not touch payment auth flow"],
      nextActions: [],
      risks: [],
      repoMap: "- src/auth.ts: session helpers",
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
    });

    const { prefix } = splitCacheable(markdown);
    const headings = prefix.split("\n").filter((line) => line.startsWith("## "));
    expect(headings[headings.length - 1]).toBe("## Repo Map");
  });

  // The whole point of the prefix is byte-for-byte reuse across the turns of
  // one task. Task status is the one field that moves on its own (the first
  // recorded edit flips todo -> in_progress), so it must not sit above the
  // marker: a one-word change there would invalidate the entire cached prefix.
  it("keeps the prefix byte-identical when only the task status changes", () => {
    const base = {
      agent: "codex" as const,
      task: { id: "t1", title: "Fix auth", goal: "Session survives refresh" },
      currentState: ["Cookie not restored"],
      sharedMemory: ["Objective: Session survives refresh"],
      relevantFiles: [],
      knownDecisions: ["Use httpOnly cookies"],
      constraints: ["Do not touch payment auth flow"],
      nextActions: [],
      risks: [],
      repoMap: "- src/auth.ts: session helpers",
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
    };

    const todo = renderPromptPack({ ...base, task: { ...base.task, status: "todo" } });
    const running = renderPromptPack({ ...base, task: { ...base.task, status: "in_progress" } });

    expect(splitCacheable(todo).prefix).toBe(splitCacheable(running).prefix);
    expect(splitCacheable(running).suffix).toContain("- Task: in_progress");
  });

  // Repo Map is the largest stable block in the pack; if it drifts below the
  // marker the cacheable prefix collapses to a few hundred tokens and no
  // provider minimum is ever met.
  it("keeps the repo map inside the cacheable prefix", () => {
    const markdown = renderPromptPack({
      agent: "claude",
      task: { id: "t1", title: "Fix auth", status: "todo" },
      currentState: [],
      sharedMemory: [],
      relevantFiles: [],
      knownDecisions: [],
      constraints: [],
      nextActions: [],
      risks: [],
      repoMap: "- src/auth.ts: session helpers",
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
    });

    const { prefix, suffix } = splitCacheable(markdown);
    expect(prefix).toContain("## Repo Map");
    expect(prefix).toContain("src/auth.ts: session helpers");
    expect(suffix).not.toContain("## Repo Map");
  });
});
