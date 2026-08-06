import { describe, expect, it } from "vitest";
import { clusterBySimilarity, decayedScore, selectEvictions, similarity } from "./lifecycle.js";
import type { Memory, MemoryType } from "./types.js";

function mem(id: string, opts: Partial<Memory> & { type?: MemoryType } = {}): Memory {
  return {
    id,
    type: opts.type ?? "note",
    content: opts.content ?? id,
    importance: opts.importance ?? 3,
    tags: [],
    createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...opts
  };
}

describe("similarity", () => {
  it("is 1 for identical text and accent-insensitive", () => {
    expect(similarity("Đăng nhập lỗi", "dang nhap loi")).toBe(1);
  });

  it("is 0 for fully disjoint text", () => {
    expect(similarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("is between 0 and 1 for partial overlap", () => {
    const score = similarity("session cookie refresh", "session cookie lost");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("decayedScore", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  it("returns full importance for a fresh memory", () => {
    const fresh = mem("a", { importance: 4, createdAt: "2026-02-01T00:00:00.000Z" });
    expect(decayedScore(fresh, now, 30)).toBeCloseTo(4, 6);
  });

  it("halves importance after one half-life", () => {
    const old = mem("a", { importance: 4, createdAt: "2026-01-02T00:00:00.000Z" }); // 30 days earlier
    expect(decayedScore(old, now, 30)).toBeCloseTo(2, 6);
  });
});

describe("selectEvictions", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  it("returns nothing when within the cap", () => {
    const memories = [mem("a"), mem("b")];
    expect(selectEvictions(memories, { maxPoolSize: 5, nowMs: now })).toEqual([]);
  });

  it("evicts the lowest decayed score first", () => {
    const memories = [
      mem("keep", { importance: 5, createdAt: "2026-02-01T00:00:00.000Z" }),
      mem("drop", { importance: 1, createdAt: "2025-01-01T00:00:00.000Z" })
    ];
    expect(selectEvictions(memories, { maxPoolSize: 1, nowMs: now })).toEqual(["drop"]);
  });

  it("never evicts protected types", () => {
    const memories = [
      mem("c", { type: "constraint", importance: 1, createdAt: "2020-01-01T00:00:00.000Z" }),
      mem("d", { type: "decision", importance: 1, createdAt: "2020-01-01T00:00:00.000Z" }),
      mem("n", { type: "note", importance: 5, createdAt: "2026-02-01T00:00:00.000Z" })
    ];
    // Cap of 1 means 2 overflow, but only the single note is evictable.
    expect(selectEvictions(memories, { maxPoolSize: 1, nowMs: now })).toEqual(["n"]);
  });
});

describe("clusterBySimilarity", () => {
  it("groups similar memories and excludes dissimilar ones", () => {
    const memories = [
      mem("a", { content: "session cookie not restored after refresh" }),
      mem("b", { content: "session cookie not restored after refresh reload" }),
      mem("z", { content: "completely unrelated logging configuration topic" })
    ];
    const clusters = clusterBySimilarity(memories, 0.5, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("returns no cluster when below the minimum size", () => {
    const memories = [
      mem("a", { content: "session cookie refresh" }),
      mem("b", { content: "session cookie refresh reload" })
    ];
    expect(clusterBySimilarity(memories, 0.5, 3)).toHaveLength(0);
  });
});
