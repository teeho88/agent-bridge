import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "../packages/memory/node_modules/better-sqlite3/lib/index.js";
import { openStore, rememberSessionTask } from "../packages/cli/src/workspace.ts";
import { routeGetState } from "../packages/cli/src/commands/routes/state.ts";
import { createRunLog } from "../packages/adapters/src/run-log.ts";
import { preloadEvidence } from "../packages/cli/src/context-retrieval.ts";
import { vectorBuckets } from "../packages/memory/src/vector-candidates.ts";
import { cosineSimilarity } from "../packages/memory/src/embeddings.ts";

const [workload, sizeText, output, variantText] = process.argv.slice(2);
const size = Number(sizeText);
const variant = variantText === undefined ? undefined : Number(variantText);
if (variant !== undefined && (!Number.isInteger(variant) || variant < 1 || variant > 200)) throw new Error("Invalid workload variant");
if (!["state", "log", "evidence", "semantic"].includes(workload) || !Number.isInteger(size) || size < 1 || !output) throw new Error("Usage: tsx scripts/followup-benchmark.mts <state|log|evidence|semantic> <size> <output.json>");
const cwd = mkdtempSync(join(tmpdir(), "bridge-followup-benchmark-"));
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const samples: number[] = [];
let failures = 0;
let detail: Record<string, unknown> = {};
const fingerprint = Object.fromEntries(["scripts/followup-benchmark.mts", "packages/memory/src/sqlite-store.ts", "packages/memory/src/memory-repository.ts", "packages/memory/src/task-repository.ts", "packages/memory/src/session-repository.ts", "packages/memory/src/vector-candidates.ts", "packages/memory/src/embedding-repository.ts", "packages/cli/src/context-retrieval.ts", "packages/cli/src/commands/routes/state.ts", "packages/core/src/context-allocation.ts", "packages/adapters/src/run-log.ts", "pnpm-lock.yaml"].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
try {
  if (workload === "state") {
    const store = openStore(cwd);
    const internal = store as unknown as { db: Database.Database };
    internal.db.transaction(() => {
      for (let index = 0; index < size; index++) {
        const task = store.createTask({ title: `Dashboard fixture ${index}` });
        store.createHandoff({ taskId: task.id, summary: `Finished step ${index}` });
        if (index >= size - (variant ?? 8)) {
          rememberSessionTask(`bench-${index}`, task.id, cwd);
          store.recordSessionEvent({ sessionId: `bench-${index}`, taskId: task.id, agent: "codex", kind: "session_start", summary: "Benchmark active" });
        }
      }
    })();
    store.close();
    let queries = 0;
    let rows = 0;
    const original = Database.prototype.prepare;
    Database.prototype.prepare = function (sql: string) {
      const statement = original.call(this, sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "all" || key === "get") return (...args: unknown[]) => {
          queries++;
          const result = value.apply(target, args);
          rows += Array.isArray(result) ? result.length : result ? 1 : 0;
          return result;
        };
        return value.bind(target);
      } });
    } as typeof original;
    const counters: Array<{ queries: number; rows: number; bytes: number }> = [];
    try {
      for (let iteration = -5; iteration < 30; iteration++) {
        const beforeQueries = queries; const beforeRows = rows;
        let body = "";
        const res = { writeHead() {}, end(text: string) { body = text; } };
        const start = performance.now();
        await routeGetState({ cwd, req: { headers: {} }, res, url: { pathname: "/api/state", query: {} }, method: "GET", port: 0 } as never);
        const elapsed = performance.now() - start;
        if (iteration >= 0) {
          samples.push(elapsed);
          counters.push({ queries: queries - beforeQueries, rows: rows - beforeRows, bytes: Buffer.byteLength(body) });
          if (JSON.parse(body).dbError) failures++;
        }
      }
    } finally { Database.prototype.prepare = original; }
    detail = { tasks: size, activeSessions: Math.min(variant ?? 8, size), counters, maxPayloadBytes: Math.max(...counters.map((item) => item.bytes)) };
  } else if (workload === "evidence") {
    const store = openStore(cwd);
    try {
      const data = Buffer.alloc(size, 97);
      const files = variant ?? 1;
      const memories = Array.from({ length: files }, (_, index) => {
        const source = `evidence-${index}.txt`;
        writeFileSync(join(cwd, source), data);
        const memory = store.addMemory({ type: "note", content: `Shared evidence ${index}`, dedupe: false });
        memory.evidence = { source, contentHash: createHash("sha256").update(data).digest("hex"), observedAt: new Date().toISOString() };
        return memory;
      });
      let hashes = 0;
      for (let index = -5; index < 30; index++) {
        const start = performance.now();
        const round = await preloadEvidence(cwd, Array.from({ length: 200 }, (_, reference) => memories[reference % files]));
        if (index >= 0) { samples.push(performance.now() - start); hashes += round.hashes.size; }
      }
      detail = { fileBytes: size, files, referencesPerRound: 200, totalHashes: hashes, expectedHashes: 30 * files, bytesHashed: 30 * files * size };
    } finally { store.close(); }
  } else if (workload === "log") {
    const paused = Array.from({ length: size }, () => false);
    let pauses = 0;
    const errors: string[] = [];
    const logs = Array.from({ length: size }, (_, index) => createRunLog(join(cwd, `${index}.log`), (value) => { paused[index] = value; if (value) pauses++; }, (error) => errors.push(error.message)));
    const start = performance.now();
    const chunk = "x".repeat(Math.floor(1048576 / 10 / size));
    let bytes = 0;
    for (let tick = 0; tick < 600; tick++) {
      const sample = performance.now();
      while (paused.some(Boolean)) await new Promise((resolve) => setTimeout(resolve, 1));
      logs.forEach((log) => log.write(chunk)); bytes += chunk.length * size;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, start + (tick + 1) * 100 - performance.now())));
      if (tick % 20 === 19) samples.push(performance.now() - sample);
    }
    const finishes = await Promise.all(logs.map((log) => log.finish()));
    failures = finishes.filter(Boolean).length;
    detail = { simulatedAgents: size, bytes, durationMs: performance.now() - start, pauses, errors, throughputBytesPerSecond: bytes / ((performance.now() - start) / 1000) };
  } else {
    const store = openStore(cwd);
    const internal = store as unknown as { db: Database.Database };
    const dimensions = variant ?? 32;
    const vector = (index: number) => { let seed = index + 1; return Array.from({ length: dimensions }, () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2147483648 - 1; }); };
    try {
      const vectors: number[][] = [];
      const table = internal.db;
      table.exec("CREATE TABLE benchmark_vectors (id INTEGER PRIMARY KEY, vector BLOB)");
      table.exec("CREATE TABLE benchmark_buckets (id INTEGER, table_no INTEGER, bucket INTEGER)");
      const insert = table.prepare("INSERT INTO benchmark_vectors VALUES (?, ?)");
      const bucketInsert = table.prepare("INSERT INTO benchmark_buckets VALUES (?, ?, ?)");
      table.transaction(() => { for (let index = 0; index < size; index++) {
        const current = vector(index); vectors.push(current); insert.run(index, Buffer.from(Float32Array.from(current).buffer));
        vectorBuckets(current).forEach((bucket, number) => bucketInsert.run(index, number, bucket));
      } })();
      table.exec("CREATE INDEX benchmark_bucket_index ON benchmark_buckets(table_no, bucket, id)");
      const counts: number[] = []; const recall: number[] = [];
      for (let index = -5; index < 30; index++) {
        const target = ((index + 5) * 7919) % size;
        const query = vectors[target];
        const start = performance.now();
        const probes: string[] = [];
        vectorBuckets(query).forEach((bucket, number) => { probes.push(`(${number},${bucket})`); for (let bit = 0; bit < 8; bit++) probes.push(`(${number},${bucket ^ (1 << bit)})`); });
        const ids = table.prepare(`WITH probes(table_no,bucket) AS (VALUES ${probes.join(",")}) SELECT b.id FROM probes p CROSS JOIN benchmark_buckets b INDEXED BY benchmark_bucket_index ON p.table_no=b.table_no AND p.bucket=b.bucket GROUP BY b.id ORDER BY COUNT(*) DESC,b.id LIMIT 1000`).all() as { id: number }[];
        const ranked = ids.map(({ id }) => ({ id, score: cosineSimilarity(query, vectors[id]) })).sort((a, b) => b.score - a.score).slice(0, 5);
        const elapsed = performance.now() - start;
        if (index >= 0) {
          const reference = vectors.map((value, id) => ({ id, score: cosineSimilarity(query, value) })).sort((a, b) => b.score - a.score).slice(0, 5);
          recall.push(reference.filter((item) => ranked.some((candidate) => candidate.id === item.id)).length / 5);
          counts.push(ids.length); samples.push(elapsed);
        }
      }
      detail = { vectors: size, dimensions, candidateLimit: 1000, candidateCounts: counts, recallAt5: recall.reduce((sum, value) => sum + value, 0) / recall.length, recallSamples: recall,
        note: "Kernel benchmark with an in-memory exact reference; RSS includes the reference corpus, and latency excludes reference ranking." };
    } finally { store.close(); }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const result = { schemaVersion: 1, workload, size, node: process.version, platform: process.platform, timestamp: new Date().toISOString(), fingerprint,
    warmup: workload === "log" ? 0 : 5, samples: samples.length, failures, p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    peakRssBytes: process.resourceUsage().maxRSS * 1024, eventLoopP95Ms: delay.percentile(95) / 1e6, detail, samplesMs: samples };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ workload, size, failures, p95Ms: result.p95Ms, detail: workload === "state" ? { maxPayloadBytes: detail.maxPayloadBytes } : workload === "semantic" ? { recallAt5: detail.recallAt5 } : detail })}\n`);
} finally { delay.disable(); rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
