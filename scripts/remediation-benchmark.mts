import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { SQLiteMemoryStore } from "../packages/memory/src/sqlite-store.ts";
import { compileContext } from "../packages/core/src/context-compiler.ts";

const size = Number(process.argv[2] ?? 1000);
const output = process.argv[3];
if (!Number.isInteger(size) || size < 100 || size > 100000 || !output) {
  throw new Error("Usage: tsx scripts/remediation-benchmark.mts <100..100000> <output.json>");
}
const directory = mkdtempSync(join(tmpdir(), "bridge-remediation-bench-"));
const path = join(directory, "fixture.db");
const store = new SQLiteMemoryStore(path);
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
try {
  const task = store.createTask({ title: "Redis namespace migration" });
  const internal = store as unknown as { db: { transaction<T>(fn: () => T): () => T } };
  internal.db.transaction(() => {
    for (let i = 0; i < size; i++) {
      store.addMemory({ taskId: task.id, type: "note", content: i % 100 === 0 ? `Redis namespace evidence ${i}` : `Unrelated fixture topic ${i}`, dedupe: false });
    }
    store.addMemory({ type: "note", content: "Redis uses a repository namespace" });
    store.addMemory({ taskId: task.id, type: "constraint", content: "Preserve the production database" });
  })();
  const run = () => compileContext(store, { taskId: task.id, agent: "codex", tokenBudget: 1500, includeFiles: false });
  for (let i = 0; i < 5; i++) run();
  const samples: number[] = [];
  const counters: Array<{ queries: number; hydratedRows: number }> = [];
  let queries = 0;
  let hydratedRows = 0;
  const database = (store as any).db;
  const prepare = database.prepare;
  database.prepare = function (...args: unknown[]) {
    const statement = prepare.apply(this, args);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...parameters: unknown[]) => {
          const result = value.apply(target, parameters);
          if (key === "all" || key === "get") {
            queries++;
            hydratedRows += key === "all" ? result.length : Number(result !== undefined);
          }
          return result;
        };
      },
    });
  };
  let failures = 0;
  for (let i = 0; i < 30; i++) {
    queries = 0;
    hydratedRows = 0;
    const start = performance.now();
    try { run(); } catch { failures++; }
    samples.push(performance.now() - start);
    counters.push({ queries, hydratedRows });
    await new Promise((resolve) => setImmediate(resolve));
  }
  samples.sort((a, b) => a - b);
  const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const fingerprintFiles = ["pnpm-lock.yaml", "scripts/remediation-benchmark.mts", ...["memory", "core"].flatMap((name) =>
    readdirSync(join(sourceRoot, "packages", name, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => `packages/${name}/src/${file}`))];
  const result = {
    schemaVersion: 1, timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
    workload: { seed: "remediation-v1", memories: size, samples: samples.length, warmup: 5 },
    fingerprint: Object.fromEntries(fingerprintFiles.map((file) => [file, createHash("sha256").update(readFileSync(resolve(fileURLToPath(new URL("..", import.meta.url)), file))).digest("hex")])),
    compile: { p50Ms: samples[15], p95Ms: samples[28], failures },
    eventLoopDelay: { p95Ms: delay.percentile(95) / 1e6 },
    memory: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 },
    dbBytes: statSync(path).size, samplesMs: samples,
    counters, counterScope: "Statement all/get calls and returned rows; excludes internal SQLite visits and iterate calls",
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ size, ...result.compile, peakRssBytes: result.memory.peakRssBytes })}\n`);
} finally {
  delay.disable();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
