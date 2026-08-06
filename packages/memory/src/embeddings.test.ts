import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  hybridRank,
  loadOptionalEmbeddingProvider,
  type HybridCandidate
} from "./embeddings.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("is 0 when a vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("encodeVector/decodeVector", () => {
  it("round-trips a float32 vector", () => {
    const vector = [0.5, -0.25, 1, 0];
    const decoded = decodeVector(encodeVector(vector));
    decoded.forEach((value, index) => expect(value).toBeCloseTo(vector[index], 5));
  });
});

describe("hybridRank", () => {
  const candidates: Array<HybridCandidate<string>> = [
    { item: "lexical-hit", bm25Rank: 0, vector: [1, 0] },
    { item: "semantic-hit", bm25Rank: Number.POSITIVE_INFINITY, vector: [0, 1] }
  ];

  it("favours the lexical hit when beta is 0 (no query vector)", () => {
    expect(hybridRank(candidates, undefined)[0]).toBe("lexical-hit");
  });

  it("surfaces a keyword-disjoint but vector-close memory when beta dominates", () => {
    const ranked = hybridRank(candidates, [0, 1], { alpha: 0.1, beta: 0.9 });
    expect(ranked[0]).toBe("semantic-hit");
  });
});

describe("loadOptionalEmbeddingProvider", () => {
  it("returns null when no module is named", async () => {
    expect(await loadOptionalEmbeddingProvider(undefined)).toBeNull();
  });

  it("returns null when the module cannot be imported", async () => {
    expect(await loadOptionalEmbeddingProvider("this-module-does-not-exist-xyz")).toBeNull();
  });
});
