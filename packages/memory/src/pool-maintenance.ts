import type Database from "better-sqlite3";
import { decodeVector } from "./embeddings.js";
import { indexVector } from "./vector-candidates.js";

export type MaintenancePolicy = {
  maxPoolSize?: number;
  maxPoolBytes?: number;
  maxBatch?: number;
  nowMs?: number;
  halfLifeDays?: number;
  dryRun?: boolean;
};

export class PoolMaintenance {
  constructor(private db: Database.Database) {
    db.function("pool_decay", { deterministic: true }, (importance: unknown, created: unknown, now: unknown, halfLife: unknown) =>
      Number(importance) * Math.pow(0.5, Math.max(0, (Number(now) - (Date.parse(String(created)) || Number(now))) / 86400000) / Number(halfLife)));
  }

  prune(policy: MaintenancePolicy = {}): Record<string, unknown>[] {
    const maxCount = policy.maxPoolSize ?? 2000;
    const maxBytes = policy.maxPoolBytes ?? 134217728;
    const maxBatch = policy.maxBatch ?? 500;
    const halfLife = policy.halfLifeDays ?? 30;
    const now = policy.nowMs ?? Date.now();
    for (const [value, minimum] of [[maxCount, 0], [maxBytes, 0], [maxBatch, 1], [halfLife, Number.MIN_VALUE]]) {
      if (!Number.isFinite(value) || value < minimum) throw new Error("Invalid maintenance policy");
    }
    if (!Number.isInteger(maxCount) || !Number.isInteger(maxBatch) || maxBatch > 5000) throw new Error("Invalid maintenance batch/count");
    return this.db.transaction(() => {
      const totals = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(content AS BLOB)) + COALESCE(length(CAST(summary AS BLOB)), 0) + COALESCE(length(embedding), 0)), 0) AS bytes FROM memories").get() as { count: number; bytes: number };
      if (totals.count <= maxCount && totals.bytes <= maxBytes) return [];
      const rows = this.db.prepare(`SELECT * FROM memories WHERE type NOT IN ('constraint', 'decision', 'handoff')
        AND evidence IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN ('checkpoint', 'latest-response', 'prompt', 'task-label-source'))
        ORDER BY pool_decay(importance, created_at, ?, ?) ASC, created_at ASC, id ASC LIMIT ?`).all(now, halfLife, maxBatch) as Record<string, unknown>[];
      const victims: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (totals.count <= maxCount && totals.bytes <= maxBytes) break;
        victims.push(row);
        totals.count--;
        totals.bytes -= Buffer.byteLength(String(row.content)) + Buffer.byteLength(String(row.summary ?? "")) + (Buffer.isBuffer(row.embedding) ? row.embedding.length : 0);
      }
      if (!policy.dryRun) {
        const archive = this.db.prepare("INSERT INTO memory_archive SELECT *, ?, 'pool-cap' FROM memories WHERE id = ?");
        const remove = this.db.prepare("DELETE FROM memories WHERE id = ?");
        for (const row of victims) { archive.run(new Date(now).toISOString(), row.id); remove.run(row.id); }
      }
      return victims;
    }).immediate();
  }

  scheduled(policy: MaintenancePolicy, intervalMs = 60000): number {
    return this.db.transaction(() => {
      const now = policy.nowMs ?? Date.now();
      const lease = this.db.prepare("SELECT next_at FROM maintenance_schedule WHERE name = 'pool'").get() as { next_at: number } | undefined;
      if (lease && lease.next_at > now) return 0;
      this.db.prepare("INSERT INTO maintenance_schedule(name, next_at) VALUES ('pool', ?) ON CONFLICT(name) DO UPDATE SET next_at = excluded.next_at").run(now + intervalMs);
      return this.prune(policy).length;
    }).immediate();
  }

  restore(id: string): boolean {
    return this.db.transaction(() => {
      const columns = (this.db.pragma("table_info(memories)") as { name: string }[]).map((column) => `"${column.name}"`).join(", ");
      const result = this.db.prepare(`INSERT OR IGNORE INTO memories (${columns}) SELECT ${columns} FROM memory_archive WHERE id = ?`).run(id);
      if (result.changes) {
        const restored = this.db.prepare("SELECT embedding, embedding_fingerprint FROM memories WHERE id = ?").get(id) as { embedding: Buffer | null; embedding_fingerprint: string | null };
        if (restored.embedding && restored.embedding_fingerprint) indexVector(this.db, id, restored.embedding_fingerprint, decodeVector(restored.embedding));
        this.db.prepare("DELETE FROM memory_archive WHERE id = ?").run(id);
      }
      return result.changes > 0;
    }).immediate();
  }
}
