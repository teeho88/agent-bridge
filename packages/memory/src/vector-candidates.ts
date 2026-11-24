import type Database from "better-sqlite3";

export function vectorBuckets(vector: number[]): number[] {
  const buckets: number[] = [];
  for (let table = 0; table < 32; table++) {
    let bucket = 0;
    for (let bit = 0; bit < 8; bit++) {
      let projection = 0;
      for (let dimension = 0; dimension < vector.length; dimension++) {
        let seed = Math.imul(dimension + 1, 0x9e3779b1) ^ Math.imul(table * 8 + bit + 1, 0x85ebca6b);
        seed = Math.imul(seed ^ (seed >>> 16), 0x7feb352d);
        seed = Math.imul(seed ^ (seed >>> 15), 0x846ca68b);
        seed ^= seed >>> 16;
        projection += vector[dimension] * ((seed & 1) ? 1 : -1);
      }
      if (projection >= 0) bucket |= 1 << bit;
    }
    buckets.push(bucket);
  }
  return buckets;
}

export function indexVector(db: Database.Database, id: string, fingerprint: string, vector: number[]): void {
  db.prepare("DELETE FROM embedding_buckets WHERE memory_id = ?").run(id);
  const insert = db.prepare("INSERT INTO embedding_buckets(memory_id, fingerprint, table_no, bucket) VALUES (?, ?, ?, ?)");
  vectorBuckets(vector).forEach((bucket, table) => insert.run(id, fingerprint, table, bucket));
}

export function semanticCandidateIds(db: Database.Database, vector: number[], fingerprint: string, scope: { sql: string; params: Record<string, unknown> }, limit: number): string[] {
  const probes: [number, number][] = [];
  vectorBuckets(vector).forEach((bucket, table) => {
    probes.push([table, bucket]);
    for (let bit = 0; bit < 8; bit++) probes.push([table, bucket ^ (1 << bit)]);
  });
  const parameters: Record<string, unknown> = { ...scope.params, fingerprint, limit };
  const values = probes.map(([table, bucket], index) => { parameters[`table${index}`] = table; parameters[`bucket${index}`] = bucket; return `(@table${index}, @bucket${index})`; });
  return (db.prepare(`WITH probes(table_no, bucket) AS (VALUES ${values.join(",")})
    SELECT b.memory_id FROM probes p CROSS JOIN embedding_buckets b INDEXED BY idx_embedding_bucket_lookup
      ON b.fingerprint = @fingerprint AND b.table_no = p.table_no AND b.bucket = p.bucket
      JOIN memories m ON m.id = b.memory_id WHERE m.superseded_by IS NULL ${scope.sql}
      GROUP BY b.memory_id ORDER BY COUNT(*) DESC, b.memory_id LIMIT @limit`).all(parameters) as { memory_id: string }[]).map((row) => row.memory_id);
}
