import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SQLiteMemoryStore } from "@agent-bridge/memory";
import { openWorkspaceState } from "./config-persistence.js";

export function collectArtifacts(cwd: string, store: SQLiteMemoryStore, options: { dryRun?: boolean; graceMs?: number; nowMs?: number; maxFiles?: number } = {}) {
  const root = realpathSync(join(cwd, ".agent-memory"));
  const graceMs = options.graceMs ?? 30 * 86400000;
  const maxFiles = options.maxFiles ?? 10000;
  if (!Number.isFinite(graceMs) || graceMs < 86400000 || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100000) throw new Error("Invalid artifact retention policy");
  const within = (path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel); };
  const marked = new Set<string>();
  const hashes = new Set<string>();
  const mark = (value: unknown): void => {
    if (typeof value === "string") {
      for (const hash of value.match(/[a-f0-9]{64}/g) ?? []) hashes.add(hash);
      const path = resolve(cwd, value);
      if (within(path)) marked.add(path);
      if (value.startsWith("{") || value.startsWith("[")) { try { mark(JSON.parse(value)); } catch {} }
    } else if (Array.isArray(value)) value.forEach(mark);
    else if (value && typeof value === "object") Object.values(value).forEach(mark);
  };
  const candidates: string[] = [];
  let files = 0;
  let incomplete = false;
  const scan = (directory: string) => {
    if (incomplete || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (incomplete) return;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { scan(path); continue; }
      if (++files > maxFiles) { incomplete = true; return; }
      if (entry.name === "metadata.json" || entry.name === "cursor.json" || entry.name.endsWith(".segments.json")) {
        try { mark(JSON.parse(readFileSync(path, "utf8"))); } catch { incomplete = true; }
      }
      if (/^(context|task|request)-[a-f0-9]{64}\.(md|txt)$/.test(entry.name) || /^delta-[a-f0-9-]+\.json$/.test(entry.name)) candidates.push(path);
    }
  };
  const runtime = openWorkspaceState(cwd);
  try {
    return runtime.transaction(() => store.withRetentionLock(() => {
      for (const publication of runtime.listPublications()) mark(JSON.parse(publication.manifest));
      store.forEachRetentionReference(mark);
      scan(join(root, "sessions"));
      scan(join(root, "tasks"));
      scan(join(root, "runs"));
      const now = options.nowMs ?? Date.now();
      const victims = incomplete ? [] : candidates.filter((path) => !marked.has(path) && ![...hashes].some((hash) => path.includes(hash)) && within(realpathSync(path)) && !lstatSync(path).isSymbolicLink() && now - statSync(path).mtimeMs >= graceMs);
      const bytes = victims.reduce((sum, path) => sum + statSync(path).size, 0);
      let archiveManifest: string | undefined;
      if (options.dryRun === false && victims.length) {
        const archive = join(root, "artifact-archive", randomUUID());
        if (!within(resolve(archive))) throw new Error("Archive path escapes workspace");
        mkdirSync(archive, { recursive: true });
        const entries = victims.map((path, index) => ({ source: resolve(path), archive: join(archive, `${index}.artifact`), hash: createHash("sha256").update(readFileSync(path)).digest("hex") }));
        archiveManifest = join(archive, "manifest.json");
        writeFileSync(archiveManifest, JSON.stringify({ schemaVersion: 1, archivedAt: new Date(now).toISOString(), entries }), { flush: true });
        for (const entry of entries) {
          if (!within(entry.source) || !within(resolve(entry.archive))) throw new Error("Retention path escapes workspace");
          renameSync(entry.source, entry.archive);
        }
      }
      return { dryRun: options.dryRun ?? true, incomplete, filesScanned: files, marked: marked.size, candidates: victims, bytes, archiveManifest };
    }));
  } finally { runtime.close(); }
}

export function restoreArtifacts(cwd: string, manifestPath: string): number {
  const root = realpathSync(join(cwd, ".agent-memory"));
  const archiveRoot = join(root, "artifact-archive");
  const inside = (base: string, path: string) => { const rel = relative(base, resolve(path)); return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel); };
  if (!inside(archiveRoot, realpathSync(manifestPath))) throw new Error("Manifest is outside artifact archive");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries: Array<{ source: string; archive: string; hash: string }> };
  let restored = 0;
  for (const entry of manifest.entries) {
    if (!inside(root, entry.source) || !inside(archiveRoot, entry.archive) || !inside(root, realpathSync(join(entry.source, "..")))) throw new Error("Restore path escapes workspace");
    if (!/^(context|task|request|delta)-[a-f0-9-]+\.(md|txt|json)$/.test(entry.source.split(/[\\/]/).pop() ?? "")) throw new Error("Invalid artifact destination");
    if (existsSync(entry.source)) {
      if (lstatSync(entry.source).isSymbolicLink() || createHash("sha256").update(readFileSync(entry.source)).digest("hex") !== entry.hash) throw new Error("Restore destination already exists with different content");
      continue;
    }
    if (!inside(archiveRoot, realpathSync(entry.archive))) throw new Error("Archive entry escapes workspace");
    const content = readFileSync(entry.archive);
    if (createHash("sha256").update(content).digest("hex") !== entry.hash) throw new Error("Archived artifact hash mismatch");
    renameSync(entry.archive, entry.source);
    restored++;
  }
  return restored;
}
