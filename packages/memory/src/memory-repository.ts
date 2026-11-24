import type Database from "better-sqlite3";

import { randomUUID } from "node:crypto";

import { clusterBySimilarity } from "./lifecycle.js";
import { PoolMaintenance, type MaintenancePolicy } from "./pool-maintenance.js";
import { toMemory } from "./memory-row.js";
import { validateReusableMemory } from "./reusable-memory.js";
import type {
  LifecycleConfig,
  ConsolidationCluster,
  ConsolidationResult,
} from "./memory-policy.js";

import type { MemoryEvidence } from "./types.js";

import type { MemorySearchOptions } from "./memory-store.js";
import type {
  AddMemoryInput,
  UpdateMemoryInput,
  FileSummary,
  Memory,
  UpsertFileSummaryInput,
} from "./types.js";
import { now, toFtsMatchExpression, toFileSummary } from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class MemoryRepository {
  private additions = 0;
  private pool: PoolMaintenance;
  constructor(
    private db: Database.Database,
    private host: object,
    private lifecycle: LifecycleConfig,
  ) {
    this.pool = new PoolMaintenance(db);
  }

  setMemoryEvidence(id: string, evidence: MemoryEvidence): void {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Memory not found: ${id}`);
    if (toMemory(row).evidence?.reuse) throw new Error("Replace reusable memory with a new evidenced revision");
    if (evidence.reuse) throw new Error("Use addMemory to attach reusable provenance with conflict handling");
    const result = this.db
      .prepare("UPDATE memories SET evidence = ?, stale = 0 WHERE id = ?")
      .run(JSON.stringify(evidence), id);
    if (!result.changes) throw new Error(`Memory not found: ${id}`);
  }

  markMemoryStale(id: string): void {
    this.db.prepare("UPDATE memories SET stale = 1 WHERE id = ?").run(id);
    this.db.prepare("UPDATE decisions SET stale = 1 WHERE id = ?").run(id);
  }

  addMemory(input: AddMemoryInput): Memory {
    if (input.evidence?.reuse) input = { ...input, evidence: { ...input.evidence,
      reuse: { ...input.evidence.reuse, scope: [...new Set(input.evidence.reuse.scope)].sort() } } };
    validateReusableMemory(input);
    const memory = this.db
      .transaction(() => this.insertOrCoalesceMemory(input))
      .immediate();
    if (
      ++this.additions % 100 === 0 &&
      this.lifecycle.maintenanceEnabled === true
    )
      this.runMaintenance();
    return memory;
  }

  private insertOrCoalesceMemory(input: AddMemoryInput): Memory {
    if (input.evidence?.reuse && input.dedupe !== false) {
      const duplicate = this.db.prepare(`SELECT * FROM memories WHERE task_id IS NULL AND type = ?
        AND content = ? AND summary IS ? AND evidence = ? AND stale = 0 AND superseded_by IS NULL LIMIT 1`)
        .get(input.type, input.content, input.summary ?? null, JSON.stringify(input.evidence)) as Row | undefined;
      if (duplicate) return toMemory(duplicate);
    }
    if (!input.evidence && input.dedupe !== false) {
      const merged = this.tryMergeDuplicate(input);
      if (merged) return merged;
    }

    const timestamp = now();
    const memory: Memory = {
      evidence: input.evidence,
      id: `mem-${randomUUID()}`,
      taskId: input.taskId,
      type: input.type,
      content: input.content,
      summary: input.summary,
      importance: input.importance ?? 3,
      tags: input.tags ?? [],
      sourceAgent: input.sourceAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db
      .prepare(
        `INSERT INTO memories
         (id, task_id, type, content, summary, importance, tags, source_agent, created_at, updated_at, evidence)
         VALUES (@id, @taskId, @type, @content, @summary, @importance, @tags, @sourceAgent, @createdAt, @updatedAt, @evidence)`,
      )
      .run({ ...memory, tags: JSON.stringify(memory.tags), evidence: input.evidence ? JSON.stringify(input.evidence) : null });
    if (input.evidence?.reuse) {
      this.db.prepare(`UPDATE memories SET superseded_by = ?, stale = 1
        WHERE id <> ? AND task_id IS NULL AND type = ? AND superseded_by IS NULL
        AND json_extract(evidence, '$.reuse.key') = ?
        AND json_extract(evidence, '$.reuse.scope') = ?`).run(memory.id, memory.id, input.type,
        input.evidence.reuse.key, JSON.stringify(input.evidence.reuse.scope));
    }
    return memory;
  }

  updateRepoMemory(id: string, input: UpdateMemoryInput): Memory | undefined {
    const current = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND task_id IS NULL")
      .get(id) as Row | undefined;
    if (!current) return undefined;

    const memory = toMemory(current);
    if (memory.evidence?.reuse) throw new Error("Replace reusable memory with a new evidenced revision instead of editing provenance in place");
    const updated: Memory = {
      ...memory,
      type: input.type ?? memory.type,
      content: input.content ?? memory.content,
      summary: input.summary ?? memory.summary,
      importance: input.importance ?? memory.importance,
      tags: input.tags ?? memory.tags,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE memories
         SET type = @type, content = @content, summary = @summary,
             importance = @importance, tags = @tags, updated_at = @updatedAt
         WHERE id = @id AND task_id IS NULL`,
      )
      .run({
        ...updated,
        summary: updated.summary ?? null,
        tags: JSON.stringify(updated.tags),
      });
    return updated;
  }

  deleteRepoMemory(id: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM memories WHERE id = ? AND task_id IS NULL")
        .run(id).changes > 0
    );
  }

  upsertLatestMemory(
    input: AddMemoryInput,
    options: {
      latestTag: string;
      legacyContentPrefix?: string;
      staleImportance?: number;
    },
  ): Memory {
    if (input.evidence?.reuse) throw new Error("Use addMemory for reusable knowledge; latest task response is not reusable knowledge");
    const timestamp = now();
    const tags = Array.from(
      new Set([...(input.tags ?? []), options.latestTag]),
    );
    const taskFilter = input.taskId ? "task_id = @taskId" : "task_id IS NULL";
    const sourceFilter = input.sourceAgent
      ? "source_agent = @sourceAgent"
      : "source_agent IS NULL";
    const legacyFilter = options.legacyContentPrefix
      ? "OR content LIKE @legacyPattern"
      : "";
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE type = @type AND ${taskFilter} AND ${sourceFilter} AND superseded_by IS NULL
           AND json_extract(evidence, '$.reuse') IS NULL
           AND (tags LIKE @tagPattern ${legacyFilter})
           ORDER BY updated_at DESC, created_at DESC`,
        )
        .all({
          type: input.type,
          taskId: input.taskId ?? null,
          sourceAgent: input.sourceAgent ?? null,
          tagPattern: `%"${options.latestTag}"%`,
          legacyPattern: `${options.legacyContentPrefix ?? ""}%`,
        }) as Row[]
    ).map(toMemory);

    if (!rows.length) {
      return this.addMemory({ ...input, tags, dedupe: false });
    }

    const current = rows[0];
    const updated: Memory = {
      ...current,
      content: input.content,
      summary: input.summary,
      importance: input.importance ?? 3,
      tags,
      sourceAgent: input.sourceAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE memories
           SET content = @content, summary = @summary, importance = @importance, tags = @tags,
               source_agent = @sourceAgent, created_at = @createdAt, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({
          id: updated.id,
          content: updated.content,
          summary: updated.summary ?? null,
          importance: updated.importance,
          tags: JSON.stringify(updated.tags),
          sourceAgent: updated.sourceAgent ?? null,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        });

      const stale = rows.slice(1);
      if (stale.length) {
        const mark = this.db.prepare(
          "UPDATE memories SET superseded_by = ?, importance = ?, updated_at = ? WHERE id = ?",
        );
        for (const memory of stale) {
          mark.run(
            updated.id,
            options.staleImportance ?? 1,
            timestamp,
            memory.id,
          );
        }
      }
    });
    tx();
    return updated;
  }

  private tryMergeDuplicate(input: AddMemoryInput): Memory | undefined {
    const scopeTags = [
      "secret",
      "private",
      "prompt",
      "task-label-source",
      "latest-response",
    ];
    const tagFilters = scopeTags.map(
      (_, index) =>
        `EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = @scopeTag${index}) = @hasScopeTag${index}`,
    );
    const tagParams = Object.fromEntries(
      scopeTags.flatMap((tag, index) => [
        [`scopeTag${index}`, tag],
        [`hasScopeTag${index}`, Number(input.tags?.includes(tag) ?? false)],
      ]),
    );
    const row = this.db
      .prepare(
        `SELECT * FROM memories
      WHERE type = @type AND task_id IS @taskId AND source_agent IS @sourceAgent
      AND content = @content AND superseded_by IS NULL AND evidence IS NULL AND stale = 0
      AND ${tagFilters.join(" AND ")}
      ORDER BY created_at, id LIMIT 1`,
      )
      .get({
        type: input.type,
        taskId: input.taskId ?? null,
        sourceAgent: input.sourceAgent ?? null,
        content: input.content,
        ...tagParams,
      }) as Row | undefined;
    if (!row) return undefined;
    const best = toMemory(row);

    const merged: Memory = {
      ...best,
      content: best.content,
      summary: input.summary ?? best.summary,
      importance: Math.max(best.importance, input.importance ?? 3),
      tags: Array.from(new Set([...best.tags, ...(input.tags ?? [])])),
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE memories
         SET content = @content, summary = @summary, importance = @importance, tags = @tags, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: merged.id,
        content: merged.content,
        summary: merged.summary ?? null,
        importance: merged.importance,
        tags: JSON.stringify(merged.tags),
        updatedAt: merged.updatedAt,
      });
    return merged;
  }

  runMaintenance(options: MaintenancePolicy = {}): number {
    return this.pool.scheduled({
      maxPoolSize: this.lifecycle.maxPoolSize,
      maxPoolBytes: this.lifecycle.maxPoolBytes,
      halfLifeDays: this.lifecycle.decayHalfLifeDays,
      ...options,
    });
  }

  listArchivedMemories(taskId?: string, limit = 50): Memory[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid archive limit");
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_archive ${taskId ? "WHERE task_id = @taskId" : ""} ORDER BY archived_at DESC LIMIT @limit`,
        )
        .all({ taskId, limit }) as Row[]
    ).map(toMemory);
  }

  restoreMemory(id: string): boolean {
    return this.pool.restore(id);
  }

  getMemoryHistory(id: string, taskId: string): Memory | undefined {
    const active = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND task_id = ?")
      .get(id, taskId) as Row | undefined;
    const archived = active
      ? undefined
      : (this.db
          .prepare("SELECT * FROM memory_archive WHERE id = ? AND task_id = ?")
          .get(id, taskId) as Row | undefined);
    return active || archived ? toMemory((active ?? archived)!) : undefined;
  }

  pruneMemories(options: MaintenancePolicy = {}): Memory[] {
    return this.pool
      .prune({
        maxPoolSize: this.lifecycle.maxPoolSize,
        maxPoolBytes: this.lifecycle.maxPoolBytes,
        halfLifeDays: this.lifecycle.decayHalfLifeDays,
        ...options,
      })
      .map(toMemory);
  }

  consolidateMemories(options: {
    taskId: string;
    threshold?: number;
    minClusterSize?: number;
    dryRun?: boolean;
    batchSize?: number;
  }): ConsolidationResult {
    return this.db
      .transaction(() => this.consolidateBatch(options))
      .immediate();
  }

  private consolidateBatch(options: {
    taskId: string;
    threshold?: number;
    minClusterSize?: number;
    dryRun?: boolean;
    batchSize?: number;
  }): ConsolidationResult {
    const batch = options.batchSize ?? 200;
    if (
      !Number.isInteger(batch) ||
      batch < 2 ||
      batch > 1000 ||
      (options.threshold !== undefined &&
        (!Number.isFinite(options.threshold) ||
          options.threshold < 0 ||
          options.threshold > 1))
    )
      throw new Error("Invalid consolidation policy");
    const cursor = this.db
      .prepare("SELECT after_id FROM consolidation_cursors WHERE task_id = ?")
      .get(options.taskId) as { after_id: string } | undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE task_id = ? AND id > ? AND superseded_by IS NULL
      AND type NOT IN ('constraint', 'decision', 'handoff') AND evidence IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN ('private', 'secret', 'checkpoint', 'latest-response', 'prompt', 'task-label-source'))
      ORDER BY id LIMIT ?`,
      )
      .all(options.taskId, cursor?.after_id ?? "", batch) as Row[];
    const memories = rows.map(toMemory);
    const nextCursor =
      rows.length === batch ? String(rows[rows.length - 1].id) : "";

    const byType = new Map<Memory["type"], Memory[]>();
    for (const memory of memories) {
      const group = byType.get(memory.type) ?? [];
      group.push(memory);
      byType.set(memory.type, group);
    }

    const plans: Array<{
      type: Memory["type"];
      content: string;
      importance: number;
      tags: string[];
      members: Memory[];
    }> = [];
    for (const [type, group] of byType) {
      // Stable seed order (oldest first) for deterministic clustering.
      const ordered = [...group].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const threshold =
        options.threshold ?? this.lifecycle.consolidateThreshold;
      const minClusterSize =
        options.minClusterSize ?? this.lifecycle.minClusterSize;
      for (const cluster of clusterBySimilarity(
        ordered,
        threshold,
        minClusterSize,
      )) {
        const seen = new Set<string>();
        const parts: string[] = [];
        for (const member of cluster) {
          const key = member.content
            .normalize("NFC")
            .replace(/\s+/g, " ")
            .trim();
          if (seen.has(key)) continue;
          seen.add(key);
          parts.push(member.content.trim());
        }
        const words = parts.map((part) => part.split(/\s+/));
        let common = words[0]?.length ?? 0;
        for (const part of words.slice(1)) {
          let index = 0;
          while (index < common && part[index] === words[0][index]) index++;
          common = index;
        }
        const joined = parts.join("; ");
        const compact =
          common >= 3
            ? `Shared prefix: ${words[0].slice(0, common).join(" ")}\nSuffixes: ${words.map((part) => part.slice(common).join(" ") || "(none)").join(" | ")}`
            : joined;
        plans.push({
          type,
          content: compact.length < joined.length ? compact : joined,
          importance: Math.max(...cluster.map((member) => member.importance)),
          tags: Array.from(new Set(cluster.flatMap((member) => member.tags))),
          members: cluster,
        });
      }
    }

    if (options.dryRun) {
      return {
        nextCursor,
        clusters: plans.map((plan) => ({
          representativeId: "(dry-run)",
          representativeContent: plan.content,
          supersededIds: plan.members.map((member) => member.id),
        })),
        supersededCount: plans.reduce(
          (total, plan) => total + plan.members.length,
          0,
        ),
      };
    }

    const clusters: ConsolidationCluster[] = [];
    let supersededCount = 0;
    const tx = this.db.transaction(() => {
      const mark = this.db.prepare(
        "UPDATE memories SET superseded_by = ? WHERE id = ?",
      );
      for (const plan of plans) {
        const representative = this.addMemory({
          taskId: options.taskId,
          type: plan.type,
          content: plan.content,
          importance: plan.importance,
          tags: plan.tags,
          dedupe: false,
        });
        for (const member of plan.members) {
          mark.run(representative.id, member.id);
          this.db
            .prepare("INSERT INTO consolidation_provenance VALUES (?, ?, ?)")
            .run(representative.id, member.id, now());
          supersededCount += 1;
        }
        clusters.push({
          representativeId: representative.id,
          representativeContent: representative.content,
          supersededIds: plan.members.map((member) => member.id),
        });
      }
    });
    tx();
    this.db
      .prepare(
        "INSERT INTO consolidation_cursors VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET after_id = excluded.after_id",
      )
      .run(options.taskId, nextCursor);
    return { clusters, supersededCount, nextCursor };
  }

  searchMemories(query: string, options: MemorySearchOptions = {}): Memory[] {
    const limit = options.limit ?? 20;
    const matchExpr = toFtsMatchExpression(query);
    const filter = this.memorySearchFilter(options, "m");
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid memory search limit");
    if (!matchExpr) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.mem_id
         WHERE memories_fts MATCH @matchExpr
         AND m.superseded_by IS NULL
         ${filter.sql}
         ORDER BY bm25(memories_fts) ASC, m.importance DESC, m.created_at DESC
         LIMIT @limit`,
      )
      .all({ matchExpr, ...filter.params, limit }) as Row[];

    return rows.map(toMemory);
  }

  memorySearchFilter(options: MemorySearchOptions, alias: string) {
    const scope = options.scope ?? (options.taskId ? "task" : "all");
    if ((scope === "task" || scope === "task-and-repo") && !options.taskId)
      throw new Error("Memory scope requires taskId");
    const filters: string[] = [];
    const params: Record<string, string | null> = {};
    if (scope === "task") filters.push(`${alias}.task_id = @scopeTaskId`);
    if (scope === "repo") filters.push(`${alias}.task_id IS NULL`);
    if (scope === "task-and-repo")
      filters.push(
        `(${alias}.task_id = @scopeTaskId OR ${alias}.task_id IS NULL)`,
      );
    if (scope === "task" || scope === "task-and-repo")
      params.scopeTaskId = options.taskId!;
    for (const [index, tag] of (options.excludeTags ?? []).entries()) {
      params[`excludeTag${index}`] = tag;
      filters.push(
        `NOT EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE value = @excludeTag${index})`,
      );
    }
    return {
      sql: filters.length ? `AND ${filters.join(" AND ")}` : "",
      params,
    };
  }

  getMemory(id: string, taskId: string): Memory | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM memories WHERE id = ? AND task_id = ? AND superseded_by IS NULL",
      )
      .get(id, taskId) as Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  getLatestResponse(taskId: string): Memory | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM memories m WHERE task_id = ? AND superseded_by IS NULL
      AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = 'latest-response')
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  getContextMemories(
    taskId: string,
    query: string,
    excludeTags: string[] = [],
  ): Memory[] {
    const options: MemorySearchOptions = {
      taskId,
      scope: "task-and-repo",
      excludeTags,
    };
    const filter = this.memorySearchFilter(options, "m");
    const standing = (
      this.db
        .prepare(
          `SELECT m.* FROM memories m WHERE m.superseded_by IS NULL
      ${filter.sql} AND (m.type IN ('constraint', 'decision') OR
        (m.type = 'test' AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = 'checkpoint')))
      ORDER BY m.importance DESC, m.created_at DESC, m.id`,
        )
        .all(filter.params) as Row[]
    ).map(toMemory);
    const ranked = this.searchMemories(query, { ...options, limit: 200 });
    return [
      ...new Map(
        [...ranked, ...standing].map((memory) => [memory.id, memory]),
      ).values(),
    ];
  }

  listMemories(
    options: {
      taskId?: string;
      limit?: number;
      includeSuperseded?: boolean;
    } = {},
  ): Memory[] {
    const limit = options.limit ?? 100;
    const includeSuperseded = options.includeSuperseded ?? true;
    const filters: string[] = [];
    if (options.taskId) filters.push("task_id = @taskId");
    if (!includeSuperseded) filters.push("superseded_by IS NULL");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const orderBy = options.taskId
      ? "importance DESC, created_at DESC"
      : "created_at DESC";
    return (
      this.db
        .prepare(
          `SELECT * FROM memories ${where} ORDER BY ${orderBy} LIMIT @limit`,
        )
        .all({ taskId: options.taskId, limit }) as Row[]
    ).map(toMemory);
  }

  listMemoriesForTask(taskId: string, limit = 50): Memory[] {
    return this.listMemories({ taskId, limit, includeSuperseded: false });
  }

  listRepoMemories(limit = 50): Memory[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memories
           WHERE task_id IS NULL AND superseded_by IS NULL
           ORDER BY importance DESC, created_at DESC
           LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(toMemory);
  }

  getFileSummary(path: string): FileSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(path) as Row | undefined;
    return row ? toFileSummary(row) : undefined;
  }

  listFileSummaries(): FileSummary[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM files ORDER BY manual_priority DESC, updated_at DESC",
        )
        .all() as Row[]
    ).map(toFileSummary);
  }

  upsertFileSummary(input: UpsertFileSummaryInput): FileSummary {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO files
         (path, summary, last_seen_hash, important_ranges, manual_priority, last_task_id, last_task_edited_at, updated_at)
         VALUES (@path, @summary, @lastSeenHash, @importantRanges, @manualPriority, @lastTaskId, @lastTaskEditedAt, @updatedAt)
         ON CONFLICT(path) DO UPDATE SET
           summary = excluded.summary,
           last_seen_hash = excluded.last_seen_hash,
           important_ranges = excluded.important_ranges,
           manual_priority = COALESCE(excluded.manual_priority, files.manual_priority),
           last_task_id = COALESCE(excluded.last_task_id, files.last_task_id),
           last_task_edited_at = COALESCE(excluded.last_task_edited_at, files.last_task_edited_at),
           updated_at = excluded.updated_at`,
      )
      .run({
        path: input.path,
        summary: input.summary ?? null,
        lastSeenHash: input.lastSeenHash ?? null,
        importantRanges: JSON.stringify(input.importantRanges ?? []),
        manualPriority:
          input.manualPriority == null
            ? null
            : Math.max(1, Math.min(5, input.manualPriority)),
        lastTaskId: input.lastTaskId ?? null,
        lastTaskEditedAt: input.markTaskEdited ? timestamp : null,
        updatedAt: timestamp,
      });
    const row = this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(input.path) as Row;
    return toFileSummary(row);
  }
}
