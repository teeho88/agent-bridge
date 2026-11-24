import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SQLiteMemoryStore } from "../packages/memory/src/sqlite-store.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: tsx scripts/retrieval-eval.mts <corpus.json> <report.json>");
const corpus = JSON.parse(readFileSync(input, "utf8"));
const results = [];
for (const fixture of corpus.cases) {
  const store = new SQLiteMemoryStore(":memory:");
  try {
    const task = store.createTask({ title: fixture.query });
    const other = store.createTask({ title: "Other task" });
    for (const document of fixture.documents) store.addMemory({ content: document.content, type: document.type ?? "note",
      taskId: document.scope === "repo" ? undefined : document.scope === "other" ? other.id : task.id,
      tags: document.tags ?? [] });
    const started = performance.now();
    const ranked = store.searchMemories(fixture.query, { taskId: task.id, scope: "task-and-repo", excludeTags: ["private", "secret"], limit: 5 });
    const labels = ranked.map((memory) => fixture.documents.find((document) => document.content === memory.content)?.label ?? "unknown");
    const hits = labels.filter((label) => fixture.relevant.includes(label)).length;
    results.push({ id: fixture.id, category: fixture.category, relevant: fixture.relevant, retrieved: labels,
      recallAt5: fixture.relevant.length ? hits / fixture.relevant.length : null,
      precisionAt5: labels.length ? hits / labels.length : null,
      noHitCorrect: fixture.relevant.length ? null : labels.length === 0, durationMs: performance.now() - started });
  } finally { store.close(); }
}
const positives = results.filter((result) => result.recallAt5 !== null);
const returned = results.filter((result) => result.precisionAt5 !== null);
const noHits = results.filter((result) => result.noHitCorrect !== null);
const report = { schemaVersion: 1, timestamp: new Date().toISOString(), corpusSha256: createHash("sha256").update(readFileSync(input)).digest("hex"),
  cases: results.length, recallAt5: positives.reduce((sum, row) => sum + row.recallAt5!, 0) / positives.length,
  precisionAt5: returned.reduce((sum, row) => sum + row.precisionAt5!, 0) / returned.length,
  precisionDefinition: "Relevant results divided by returned slots among the first five; empty results excluded from precision and reported separately",
  noHitCorrect: noHits.filter((result) => result.noHitCorrect).length, noHitCases: noHits.length, results };
writeFileSync(output, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify({ cases: report.cases, recallAt5: report.recallAt5, precisionAt5: report.precisionAt5, noHitCorrect: report.noHitCorrect }) + "\n");
