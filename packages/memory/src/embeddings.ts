// Optional semantic-retrieval layer. The tool works fully without it (pure
// bm25/FTS); when an embedding provider is configured, search blends lexical
// rank with vector cosine similarity so semantically-related memories surface
// even without shared keywords.
//
// No embedding model is bundled (keeps install light and offline-safe). A
// provider is loaded on demand from a module named by AGENT_BRIDGE_EMBEDDING_MODULE
// (or passed explicitly), which must export `createEmbeddingProvider()` or a
// default that yields an { embed } object. Missing/!broken module => null =>
// semantic disabled, never an error.

export interface EmbeddingProvider {
  readonly id?: string;
  readonly model?: string;
  readonly version?: string;
  readonly dimensions?: number;
  embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

export function validateVector(vector: number[], dimensions?: number): void {
  if (!vector.length || (dimensions !== undefined && vector.length !== dimensions) ||
      vector.some((value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new Error("Invalid embedding vector: expected finite values and matching nonzero dimensions");
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  validateVector(a);
  validateVector(b, a.length);
  const length = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Store a vector compactly as a little-endian float32 BLOB.
export function encodeVector(vector: number[]): Buffer {
  validateVector(vector);
  return Buffer.from(Float32Array.from(vector).buffer);
}

export function decodeVector(buffer: Buffer): number[] {
  if (!buffer.byteLength || buffer.byteLength % 4 !== 0) throw new Error("Invalid embedding BLOB length");
  // Copy into an aligned buffer; the row Buffer may be a slice of a larger one.
  const floats = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < floats.length; i += 1) floats[i] = buffer.readFloatLE(i * 4);
  const vector = Array.from(floats);
  validateVector(vector);
  return vector;
}

export type HybridCandidate<T> = {
  item: T;
  // 0-based lexical (bm25) rank; use Infinity when the item was not a lexical hit.
  bm25Rank: number;
  vector?: number[];
};

export type HybridWeights = { alpha?: number; beta?: number };

// Blend lexical rank and vector cosine into one score and sort descending.
// Lexical contributes 1/(1+rank) (so rank 0 -> 1, misses -> 0). Cosine is mapped
// from [-1,1] to [0,1]. beta defaults to 0 effect when no query vector is given.
export function hybridRank<T>(
  candidates: Array<HybridCandidate<T>>,
  queryVector: number[] | undefined,
  weights: HybridWeights = {}
): T[] {
  const alpha = weights.alpha ?? 0.5;
  const beta = queryVector ? weights.beta ?? 0.5 : 0;
  const scored = candidates.map((candidate) => {
    const lexical = Number.isFinite(candidate.bm25Rank) ? 1 / (1 + candidate.bm25Rank) : 0;
    const cosine =
      queryVector && candidate.vector ? (cosineSimilarity(queryVector, candidate.vector) + 1) / 2 : 0;
    return { item: candidate.item, score: alpha * lexical + beta * cosine };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

export async function loadOptionalEmbeddingProvider(
  moduleName: string | undefined = process.env.AGENT_BRIDGE_EMBEDDING_MODULE
): Promise<EmbeddingProvider | null> {
  if (!moduleName) return null;
  try {
    // Variable specifier keeps this out of static module resolution, so the
    // package builds without the optional module present.
    const mod: { createEmbeddingProvider?: unknown; default?: unknown } = await import(moduleName);
    const factory = (mod.createEmbeddingProvider ?? mod.default) as unknown;
    const provider = typeof factory === "function" ? await (factory as () => unknown)() : factory;
    if (provider && typeof (provider as EmbeddingProvider).embed === "function") {
      return provider as EmbeddingProvider;
    }
    return null;
  } catch {
    return null;
  }
}
