import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { toMemory } from "./memory-row.js";
import { indexVector, semanticCandidateIds } from "./vector-candidates.js";
import { embedWithPolicy } from "./embedding-work.js";
import {
  decodeVector,
  encodeVector,
  hybridRank,
  validateVector,
  type EmbeddingProvider,
  type HybridCandidate,
  type HybridWeights,
} from "./embeddings.js";
import type { Memory } from "./types.js";
import type { MemorySearchOptions } from "./memory-store.js";
type Row = Record<string, unknown>;

export class EmbeddingRepository {
  private anonymousEmbeddingId = randomUUID();
  private embeddingDiagnostic?: {
    code: "provider_error" | "invalid_embedding" | "approximate_search";
    message: string;
  };
  constructor(
    private db: Database.Database,
    private embeddingProvider: EmbeddingProvider | undefined,
    private searchMemories: (
      query: string,
      options: MemorySearchOptions,
    ) => Memory[],
    private memorySearchFilter: (
      options: MemorySearchOptions,
      alias: string,
    ) => { sql: string; params: Record<string, unknown> },
    private lifecycle: { hybrid?: HybridWeights },
  ) {}

  hasEmbeddingProvider(): boolean {
    return Boolean(this.embeddingProvider);
  }

  getEmbeddingDiagnostic() {
    return this.embeddingDiagnostic;
  }

  private embeddingFingerprint(): string {
    const provider = this.embeddingProvider!;
    return createHash("sha256")
      .update(
        JSON.stringify([
          provider.id ?? this.anonymousEmbeddingId,
          provider.model ?? null,
          provider.version ?? null,
          provider.dimensions ?? null,
        ]),
      )
      .digest("hex");
  }

  async reindexEmbeddings(
    options: {
      taskId?: string;
      maxItems?: number;
      timeoutMs?: number;
      retries?: number;
    } = {},
  ): Promise<number> {
    if (!this.embeddingProvider) {
      throw new Error(
        "No embedding provider configured. Set AGENT_BRIDGE_EMBEDDING_MODULE.",
      );
    }
    const maxItems = options.maxItems ?? 1000;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100000)
      throw new Error("Invalid reindex item limit");
    const fingerprint = this.embeddingFingerprint();
    const taskFilter = options.taskId ? "AND task_id = @taskId" : "";
    const update = this.db.prepare(
      `UPDATE memories SET embedding = @embedding, embedding_fingerprint = @fingerprint,
         embedding_dimensions = @dimensions, embedding_input_hash = @hash
       WHERE id = @id AND superseded_by IS NULL
         AND COALESCE(NULLIF(summary, ''), content) = @text`,
    );
    let count = 0;
    const taskKey = options.taskId ?? "";
    const bookmark = this.db
      .prepare(
        "SELECT after_id FROM embedding_progress WHERE fingerprint = ? AND task_key = ?",
      )
      .get(fingerprint, taskKey) as { after_id: string } | undefined;
    let afterId = bookmark?.after_id ?? "";
    const saveProgress = this.db.prepare(
      "INSERT INTO embedding_progress VALUES (?, ?, ?) ON CONFLICT(fingerprint, task_key) DO UPDATE SET after_id = excluded.after_id",
    );
    type PendingEmbedding = {
      id: string;
      vector: number[];
      text: string;
      hash: string;
    };
    const writeBatch = (pending: PendingEmbedding[], cursor: string): number =>
      this.db
        .transaction(() => {
          if (this.embeddingFingerprint() !== fingerprint)
            throw new Error(
              "Embedding provider changed during reindex; retry with a stable model",
            );
          let completed = 0;
          for (const item of pending) {
            const changes = update.run({
              id: item.id,
              embedding: encodeVector(item.vector),
              fingerprint,
              dimensions: item.vector.length,
              hash: item.hash,
              text: item.text,
            }).changes;
            if (changes)
              indexVector(this.db, item.id, fingerprint, item.vector);
            completed += changes;
          }
          saveProgress.run(fingerprint, taskKey, cursor);
          return completed;
        })
        .immediate();
    let processed = 0;
    while (processed < maxItems) {
      const rows = this.db
        .prepare(
          `SELECT id, content, summary FROM memories
        WHERE superseded_by IS NULL AND id > @afterId ${taskFilter}
          AND (embedding IS NULL OR embedding_fingerprint IS NOT @fingerprint OR embedding_input_hash IS NULL OR (SELECT COUNT(*) FROM embedding_buckets b WHERE b.memory_id = memories.id AND b.fingerprint = @fingerprint) <> 32)
        ORDER BY id LIMIT @batchLimit`,
        )
        .all({
          taskId: options.taskId,
          afterId,
          fingerprint,
          batchLimit: Math.min(100, maxItems - processed),
        }) as Row[];
      if (!rows.length) {
        afterId = "";
        break;
      }
      const pending: PendingEmbedding[] = [];
      try {
        for (const row of rows) {
          if (processed >= maxItems) break;
          processed++;
          afterId = String(row.id);
          const text = String(row.summary || row.content);
          const hash = createHash("sha256").update(text).digest("hex");
          let vector: number[];
          try {
            vector = await embedWithPolicy(
              this.embeddingProvider,
              text,
              options,
            );
            validateVector(vector, this.embeddingProvider.dimensions);
          } catch (error) {
            this.embeddingDiagnostic = {
              code: "provider_error",
              message: String(error),
            };
            if (
              error instanceof Error &&
              (error.message.startsWith("embedding_timeout") ||
                error.message.startsWith("embedding_capacity_exceeded"))
            )
              throw error;
            continue;
          }
          if (this.embeddingFingerprint() !== fingerprint)
            throw new Error(
              "Embedding provider changed during reindex; retry with a stable model",
            );
          pending.push({ id: String(row.id), vector, text, hash });
        }
      } finally {
        count += writeBatch(pending, afterId);
      }
    }
    saveProgress.run(fingerprint, taskKey, afterId);
    return count;
  }

  // Hybrid retrieval: blends bm25 with vector cosine. Candidate pool is the
  // union of bm25 hits and every embedded memory (so semantically-related
  // memories surface even with no shared keywords). Falls back to plain
  // searchMemories when no provider is configured.
  async semanticSearch(
    query: string,
    options: MemorySearchOptions & {
      weights?: HybridWeights;
      candidateLimit?: number;
      exactThreshold?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<Memory[]> {
    const limit = options.limit ?? 20;
    if (!this.embeddingProvider)
      return this.searchMemories(query, { ...options, limit });

    const lexical = this.searchMemories(query, {
      ...options,
      limit: Math.max(limit * 4, 50),
    });
    const rankById = new Map(
      lexical.map((memory, index) => [memory.id, index]),
    );

    this.embeddingDiagnostic = undefined;
    let queryVector: number[];
    const fingerprint = this.embeddingFingerprint();
    try {
      queryVector = await embedWithPolicy(this.embeddingProvider, query, {
        timeoutMs: options.timeoutMs,
      });
      validateVector(queryVector, this.embeddingProvider.dimensions);
      if (this.embeddingFingerprint() !== fingerprint)
        throw new Error("Embedding provider changed during search");
    } catch (error) {
      this.embeddingDiagnostic = {
        code: "provider_error",
        message: error instanceof Error ? error.message : String(error),
      };
      return lexical.slice(0, limit);
    }
    const filter = this.memorySearchFilter(options, "m");
    const candidateLimit = options.candidateLimit ?? 1000;
    const exactThreshold = options.exactThreshold ?? 1000;
    if (
      !Number.isInteger(candidateLimit) ||
      candidateLimit < 1 ||
      candidateLimit > 5000 ||
      !Number.isInteger(exactThreshold) ||
      exactThreshold < 0 ||
      exactThreshold > 5000
    )
      throw new Error("Invalid semantic candidate policy");
    const compatible = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories m WHERE m.embedding IS NOT NULL
      AND m.superseded_by IS NULL AND m.embedding_fingerprint = @fingerprint AND m.embedding_dimensions = @dimensions ${filter.sql}`,
      )
      .get({
        ...filter.params,
        fingerprint,
        dimensions: queryVector.length,
      }) as { n: number };
    const approximate = compatible.n > exactThreshold;
    const ids = approximate
      ? [
          ...new Set([
            ...semanticCandidateIds(
              this.db,
              queryVector,
              fingerprint,
              filter,
              candidateLimit,
            ),
            ...lexical.map((memory) => memory.id),
          ]),
        ]
      : [];
    const embeddedRows = this.db
      .prepare(
        `SELECT m.* FROM memories m
      WHERE m.embedding IS NOT NULL AND m.superseded_by IS NULL ${filter.sql}
        AND m.embedding_fingerprint = @fingerprint AND m.embedding_dimensions = @dimensions
        ${approximate ? "AND m.id IN (SELECT value FROM json_each(@ids))" : ""}`,
      )
      .all({
        ...filter.params,
        fingerprint,
        dimensions: queryVector.length,
        ids: JSON.stringify(ids),
      }) as Row[];
    if (approximate)
      this.embeddingDiagnostic = {
        code: "approximate_search",
        message: `Indexed candidates: ${embeddedRows.length}/${compatible.n}; limit ${candidateLimit}; recall depends on corpus`,
      };

    const byId = new Map<string, { memory: Memory; vector?: number[] }>();
    for (const memory of lexical) byId.set(memory.id, { memory });
    for (const row of embeddedRows) {
      const memory = toMemory(row);
      const text = memory.summary || memory.content;
      if (
        row.embedding_input_hash !==
        createHash("sha256").update(text).digest("hex")
      )
        continue;
      try {
        const vector = decodeVector(row.embedding as Buffer);
        validateVector(vector, queryVector.length);
        byId.set(memory.id, { memory, vector });
      } catch (error) {
        this.embeddingDiagnostic = {
          code: "invalid_embedding",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const candidates: Array<HybridCandidate<Memory>> = Array.from(
      byId.values(),
    ).map((entry) => ({
      item: entry.memory,
      bm25Rank: rankById.get(entry.memory.id) ?? Number.POSITIVE_INFINITY,
      vector: entry.vector,
    }));

    return hybridRank(
      candidates,
      queryVector,
      options.weights ?? this.lifecycle.hybrid,
    ).slice(0, limit);
  }
}
