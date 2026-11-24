import { foldDiacritics } from "./text-normalize.js";
import type { Memory, MemoryType } from "./types.js";

// Defaults for memory-pool lifecycle. Kept as named constants here; wiring them
// to project config is a separate concern (see plan P3.4).
export const DEFAULT_DEDUPE_THRESHOLD = 0.85;
export const DEFAULT_DECAY_HALF_LIFE_DAYS = 30;
export const DEFAULT_MAX_POOL_SIZE = 2000;
// Consolidation groups *related* (not just near-identical) memories, so it uses
// a looser similarity threshold than dedupe and only acts on clusters of at
// least this many members.
export const DEFAULT_CONSOLIDATE_THRESHOLD = 0.5;
export const DEFAULT_MIN_CLUSTER_SIZE = 2;

// Memory types that carry standing rules / history and must never be evicted or
// silently merged away by pool maintenance.
export const PROTECTED_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(["constraint", "decision", "handoff"]);

const MS_PER_DAY = 86_400_000;

// Split text into a set of diacritic-folded alphanumeric tokens for similarity.
export function tokenSet(text: string): Set<string> {
  return new Set(
    foldDiacritics(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

// Jaccard similarity of two texts' token sets, in [0, 1]. Two empty texts are
// considered identical (1); one empty and one not are disjoint (0).
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return a.normalize("NFC").trim() === b.normalize("NFC").trim() ? 1 : 0;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const token of sa) if (sb.has(token)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Importance discounted by age: importance * 0.5^(ageDays / halfLifeDays).
// A fresh memory scores its full importance; one a half-life old scores half.
// Future-dated timestamps clamp to age 0.
export function decayedScore(memory: Memory, nowMs: number, halfLifeDays = DEFAULT_DECAY_HALF_LIFE_DAYS): number {
  const createdMs = Date.parse(memory.createdAt);
  const ageDays = Math.max(0, (nowMs - (Number.isNaN(createdMs) ? nowMs : createdMs)) / MS_PER_DAY);
  return memory.importance * Math.pow(0.5, ageDays / halfLifeDays);
}

export type EvictionOptions = {
  maxPoolSize?: number;
  nowMs: number;
  halfLifeDays?: number;
};

// Choose memory ids to evict so the pool fits within maxPoolSize. Protected
// types are never selected; among the rest, the lowest decayed score goes first
// (oldest breaks ties). Returns ids in eviction order. May return fewer than the
// overflow when too many memories are protected — protected memories are kept
// even if that leaves the pool above the cap.
export function selectEvictions(memories: Memory[], options: EvictionOptions): string[] {
  const maxPoolSize = options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE;
  const overflow = memories.length - maxPoolSize;
  if (overflow <= 0) return [];

  const evictable = memories.filter((memory) => !PROTECTED_TYPES.has(memory.type));
  evictable.sort((a, b) => {
    const sa = decayedScore(a, options.nowMs, options.halfLifeDays);
    const sb = decayedScore(b, options.nowMs, options.halfLifeDays);
    if (sa !== sb) return sa - sb;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });

  return evictable.slice(0, Math.min(overflow, evictable.length)).map((memory) => memory.id);
}

// Greedy star-clustering by content similarity. Each unclustered memory becomes
// a seed; every other still-unclustered memory whose similarity to the seed
// meets the threshold joins its cluster. Only clusters with at least
// minClusterSize members are returned; rejected candidates remain available for
// later seeds. Order of `memories` determines seed order (pass a stable order
// for deterministic results).
export function clusterBySimilarity(
  memories: Memory[],
  threshold = DEFAULT_CONSOLIDATE_THRESHOLD,
  minClusterSize = DEFAULT_MIN_CLUSTER_SIZE
): Memory[][] {
  const used = new Set<string>();
  const tokens = new Map(memories.map((memory) => [memory.id, tokenSet(memory.content)]));
  const related = (a: Memory, b: Memory) => {
    const left = tokens.get(a.id)!;
    const right = tokens.get(b.id)!;
    if (!left.size && !right.size) return a.content.normalize("NFC").trim() === b.content.normalize("NFC").trim() ? 1 : 0;
    let shared = 0;
    for (const term of left) if (right.has(term)) shared++;
    return shared / (left.size + right.size - shared || 1);
  };
  const clusters: Memory[][] = [];
  for (const seed of memories) {
    if (used.has(seed.id)) continue;
    used.add(seed.id);
    const members = memories.filter(
      (other) => !used.has(other.id) && related(seed, other) >= threshold
    );
    if (members.length + 1 < minClusterSize) continue;
    for (const member of members) used.add(member.id);
    clusters.push([seed, ...members]);
  }
  return clusters;
}
