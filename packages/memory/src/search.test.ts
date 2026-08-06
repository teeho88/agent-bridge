import { describe, expect, it } from "vitest";
import { orderByRelevance } from "./search.js";
import type { Memory } from "./types.js";

function mem(id: string, importance = 3): Memory {
  return {
    id,
    type: "note",
    content: id,
    importance,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("orderByRelevance", () => {
  it("puts ranked memories first in ranked order, keeps the rest in place", () => {
    const all = [mem("a"), mem("b"), mem("c"), mem("d")];
    const ranked = [mem("c"), mem("a")];
    const ordered = orderByRelevance(all, ranked).map((m) => m.id);
    expect(ordered).toEqual(["c", "a", "b", "d"]);
  });

  it("returns the full list unchanged when nothing is ranked", () => {
    const all = [mem("a"), mem("b")];
    expect(orderByRelevance(all, []).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("never drops unranked memories (e.g. constraints not matching the query)", () => {
    const all = [mem("constraint"), mem("hit")];
    const ranked = [mem("hit")];
    const ordered = orderByRelevance(all, ranked).map((m) => m.id);
    expect(ordered).toContain("constraint");
    expect(ordered[0]).toBe("hit");
  });
});
