import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import Database from "../packages/memory/node_modules/better-sqlite3/lib/index.js";
import { SQLiteMemoryStore } from "../packages/memory/src/sqlite-store.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: tsx scripts/followup-migration-check.mts <source-db> <report.json>");
const source = resolve(input);
const directory = mkdtempSync(join(tmpdir(), "bridge-migration-copy-"));
const copy = join(directory, "memories.db");
const checksum = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const originalFileHash = checksum(source);
const original = new Database(source, { readonly: true, fileMustExist: true });
let store: SQLiteMemoryStore | undefined;
try {
  const beforeVersion = original.pragma("user_version", { simple: true });
  const columns = original.pragma("table_info(memories)").map((row: any) => String(row.name));
  const fields = columns.map((name: string) => `"${name.replaceAll('"', '""')}"`).join(",");
  const digest = (db: any) => {
    const hash = createHash("sha256");
    let count = 0;
    for (const row of db.prepare(`SELECT ${fields} FROM memories ORDER BY id`).iterate()) { hash.update(JSON.stringify(row)); count++; }
    return { hash: hash.digest("hex"), count };
  };
  const before = digest(original);
  const legacyTables = original.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts%' ORDER BY name").all().map((row: any) => {
    const name = String(row.name);
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = original.prepare(`PRAGMA table_info(${quoted})`).all().map((column: any) => `"${String(column.name).replaceAll('"', '""')}"`);
    return { name, fields: columns.join(",") };
  });
  const legacyDigest = (db: any) => legacyTables.map(({ name, fields }: { name: string; fields: string }) => {
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of db.prepare(`SELECT ${fields} FROM "${name.replaceAll('"', '""')}" ORDER BY ${fields}`).iterate()) { hash.update(JSON.stringify(row)); rows++; }
    return { table: name, rows, hash: hash.digest("hex") };
  });
  const legacyBefore = legacyDigest(original);
  await original.backup(copy);
  original.close();
  store = new SQLiteMemoryStore(copy);
  const db = (store as any).db;
  const migrated = digest(db);
  if (JSON.stringify(legacyBefore) !== JSON.stringify(legacyDigest(db))) throw new Error("Migration changed original user table rows");
  if (JSON.stringify(before) !== JSON.stringify(migrated)) throw new Error("Migration changed original memory rows");
  const dryRun = store.pruneMemories({ maxPoolSize: 0, maxPoolBytes: 0, maxBatch: 5000, dryRun: true });
  if (JSON.stringify(digest(db)) !== JSON.stringify(before)) throw new Error("Dry-run changed memory rows");
  const archived = store.pruneMemories({ maxPoolSize: 0, maxPoolBytes: 0, maxBatch: 5000 });
  for (const memory of archived) if (!store.restoreMemory(memory.id)) throw new Error("Archive restore failed");
  const restored = digest(db);
  if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error("Archive round-trip changed original memory rows");
  const afterVersion = db.pragma("user_version", { simple: true });
  store.close();
  store = new SQLiteMemoryStore(copy);
  if (JSON.stringify(digest((store as any).db)) !== JSON.stringify(before)) throw new Error("Migration reopen changed memory rows");
  if (JSON.stringify(legacyBefore) !== JSON.stringify(legacyDigest((store as any).db))) throw new Error("Migration reopen changed original user table rows");
  store.close(); store = undefined;
  const sourceUnchanged = checksum(source) === originalFileHash;
  if (!sourceUnchanged) throw new Error("Source changed during validation; cannot claim a stable source snapshot");
  const report = { timestamp: new Date().toISOString(), beforeVersion, afterVersion, rows: before.count,
    originalColumns: columns, rowDigestBefore: before.hash, rowDigestAfter: restored.hash,
    dryRunCandidates: dryRun.length, archivedAndRestored: archived.length,
    migrationBackups: readdirSync(directory).filter((name) => name.endsWith(".backup")).length,
    sourceUnchanged, originalFileHash, performedOnTemporaryCopy: true, legacyTables: legacyBefore, legacyUserRowsUnchanged: true };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ beforeVersion, afterVersion, rows: before.count, archivedAndRestored: archived.length, sourceUnchanged }) + "\n");
} finally {
  if (original.open) original.close();
  store?.close();
  if (!directory.startsWith(resolve(tmpdir()) + sep)) throw new Error("Temporary cleanup escaped its root");
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
