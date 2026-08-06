import type { Memory } from "./types.js";

// Merge a full memory set with a relevance-ranked subset (e.g. bm25 results from
// the FTS index). Memories present in `ranked` come first, in ranked order; the
// rest follow in their original order (importance/recency as returned by the
// store). This keeps always-needed memories (constraints, decisions) in the
// result even when they do not lexically match the task query, while still
// surfacing the most relevant memories first.
//
// Relies on a stable sort (guaranteed by ECMAScript 2019+) so that unranked
// memories retain their incoming order.
export function orderByRelevance(all: Memory[], ranked: Memory[]): Memory[] {
  if (!ranked.length) return [...all];
  const rank = new Map<string, number>();
  ranked.forEach((memory, index) => {
    if (!rank.has(memory.id)) rank.set(memory.id, index);
  });
  return [...all].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.id) ?? Number.POSITIVE_INFINITY;
    return ra - rb;
  });
}
