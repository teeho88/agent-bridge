import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMemoryStore } from "../packages/memory/src/sqlite-store.ts";

const [sizeText, dimensionsText, output] = process.argv.slice(2);
const size = Number(sizeText);
const dimensions = Number(dimensionsText);
if (!output || !Number.isInteger(size) || size < 1000 || size > 100000 || ![16, 32].includes(dimensions)) throw new Error("Usage: tsx scripts/backfill-benchmark.mts <1000..100000> <16|32> <report.json>");
const root = mkdtempSync(join(tmpdir(), "bridge-backfill-benchmark-"));
const provider = { id: "synthetic-backfill", model: `fixture-${dimensions}`, version: "1", dimensions,
  async embed(text: string) { return Array.from({ length: dimensions }, (_, index) => (text.charCodeAt(index % text.length) + index) / 100); } };
const store = new SQLiteMemoryStore(join(root, "memories.db"), { embeddingProvider: provider });
try {
  const db = (store as any).db;
  db.transaction(() => {
    for (let index = 0; index < size; index++) store.addMemory({ type: "note", content: `Backfill fixture ${index}`, dedupe: false });
  }).immediate();
  const maxItems = Math.min(100, Math.floor(size / 35));
  const samples: number[] = [];
  let completed = 0;
  let failures = 0;
  for (let index = -5; index < 30; index++) {
    const started = performance.now();
    try { completed += await store.reindexEmbeddings({ maxItems, retries: 0 }); } catch { failures++; }
    if (index >= 0) samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const fingerprint = Object.fromEntries(["scripts/backfill-benchmark.mts", "packages/memory/src/embedding-repository.ts", "packages/memory/src/embedding-work.ts", "packages/memory/src/vector-candidates.ts", "packages/memory/src/schema.ts", "pnpm-lock.yaml"].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  const report = { schemaVersion: 1, timestamp: new Date().toISOString(), size, dimensions, provider: provider.model,
    note: "Synthetic zero-network provider; measures local backfill/index overhead and excludes real embedding-provider latency",
    warmup: 5, samples: 30, maxItems, completed, expectedCompleted: 35 * maxItems, failures,
    p50Ms: sorted[15], p95Ms: sorted[28], peakRssBytes: process.resourceUsage().maxRSS * 1024,
    samplesMs: samples, fingerprint };
  if (completed !== 35 * maxItems) throw new Error("Backfill skipped fixture records");
  writeFileSync(output, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ size, dimensions, completed, p95Ms: report.p95Ms, failures }) + "\n");
} finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
