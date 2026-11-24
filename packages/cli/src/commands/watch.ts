import { existsSync, statSync, watch } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Command } from "commander";
import { extractGraph, isGraphSourceFile, listGraphSourcePaths } from "@agent-bridge/memory";
import { contentHash, refreshBriefs } from "../graph-brief.js";
import {
  ensureWorkspace,
  openStore,
  readConfig,
  resolveActiveTaskId,
} from "../workspace.js";

// Decide whether a raw fs.watch path should be briefed, returning the repo-relative
// POSIX path or null. Centralizes the source/ignore filtering so it can be tested
// without spinning up a real watcher. A null result means "ignore this change".
export function watchBriefTarget(root: string, rawPath: string): string | null {
  if (!rawPath) return null;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) return null;
  if (!isGraphSourceFile(rel)) return null;
  return rel;
}

export function briefWatchedFile(store: ReturnType<typeof openStore>, root: string, rawPath: string): boolean {
  const rel = watchBriefTarget(root, rawPath);
  if (!rel) return false;
  const config = readConfig(root);
  if (config.enabled === false || config.graph?.watchAutoBrief === false) return false;
  const full = resolve(root, rel);
  if (!existsSync(full)) return false;
  const info = statSync(full);
  if (!info.isFile() || info.size > 1_000_000) return false;
  const files = store.listGraphFiles(5000);
  const indexed = files.find((file) => file.path === rel);
  const hash = contentHash(root, rel);
  const previousHash = store.getFileSummary(rel)?.lastSeenHash ?? indexed?.contentHash;
  if (!hash || (hash === previousHash && hash === indexed?.contentHash)) return false;
  let taskId: string | undefined;
  try {
    taskId = resolveActiveTaskId(store, root, undefined, undefined) ?? undefined;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Ambiguous active task")) throw error;
  }
  const extracted = extractGraph(root, {
    include: [rel],
    ignore: [...(config.security?.ignorePaths ?? []), ...(config.graph?.ignorePaths ?? [])],
    knownPaths: files.map((file) => file.path),
  });
  if (!extracted.nodes.some((node) => node.kind === "file" && node.path === rel)) return false;
  store.replaceGraph(extracted, [rel]);
  refreshBriefs(store, root, { paths: [rel], taskId, taskEdited: hash !== previousHash });
  return true;
}

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description(
      "Watch the repo and auto-brief source files as they change (works for any agent)",
    )
    .option("--project <path>", "project path", process.cwd())
    .option("--debounce <ms>", "debounce window per file in ms", "300")
    .action((options: { project: string; debounce: string }) => {
      const root = resolve(options.project);
      ensureWorkspace(root);
      const debounceMs = Math.max(0, Number(options.debounce) || 300);
      const store = openStore(root);

      // fs.watch fires several times per save (temp file + rename). Coalesce per
      // path so a burst of events produces one brief.
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      const brief = (rel: string): void => {
        try {
          if (briefWatchedFile(store, root, rel)) console.log(`briefed ${rel}`);
        } catch {
          // Best-effort: a brief failure must never crash the watcher.
        }
      };

      // Recursive fs.watch is supported on Windows and macOS; on Linux it is not,
      // so only top-level changes fire there.
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (readConfig(root).enabled === false) { shutdown(); return; }
        if (!filename) return;
        const rel = watchBriefTarget(root, filename.toString());
        if (!rel) return;
        const existing = pending.get(rel);
        if (existing) clearTimeout(existing);
        pending.set(
          rel,
          setTimeout(() => {
            pending.delete(rel);
            brief(rel);
          }, debounceMs),
        );
      });
      const reconciled = new Map<string, string>();
      const reconcile = (): void => {
        const config = readConfig(root);
        if (config.enabled === false) { shutdown(); return; }
        if (config.graph?.watchAutoBrief === false) return;
        try {
          const targets = listGraphSourcePaths(root, {
            include: config.graph?.includePaths,
            ignore: [...(config.security?.ignorePaths ?? []), ...(config.graph?.ignorePaths ?? [])],
          });
          const hashes = new Map(store.listGraphFiles(5000).map((file) => [file.path, file.contentHash]));
          const graphHashes = new Map(hashes);
          for (const summary of store.listFileSummaries()) if (summary.lastSeenHash) hashes.set(summary.path, summary.lastSeenHash);
          for (const rel of targets) {
            if (pending.has(rel)) continue;
            try {
              const info = statSync(resolve(root, rel));
              if (info.size > 1_000_000) continue;
              const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${hashes.get(rel)}:${graphHashes.get(rel)}`;
              if (reconciled.get(rel) === signature) continue;
              const hash = contentHash(root, rel);
              if (hash !== hashes.get(rel) || hash !== graphHashes.get(rel)) brief(rel);
              if (hash === hashes.get(rel) && hash === graphHashes.get(rel)) reconciled.set(rel, signature);
            } catch {
              continue;
            }
          }
          const present = new Set(targets);
          for (const rel of reconciled.keys()) if (!present.has(rel)) reconciled.delete(rel);
        } catch (error) {
          console.error(`Watcher reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const reconciliation = setInterval(reconcile, 60_000);
      const initialReconciliation = setTimeout(reconcile, debounceMs);
      console.log(`agent-bridge watch: watching ${root}`);
      console.log(
        "Auto-briefs source files on content change for any agent. Ctrl+C to stop.",
      );

      const shutdown = (): void => {
        watcher.close();
        clearInterval(reconciliation);
        clearTimeout(initialReconciliation);
        for (const timer of pending.values()) clearTimeout(timer);
        store.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
