import { existsSync, statSync, watch } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Command } from "commander";
import { isGraphSourceFile } from "@agent-bridge/memory";
import { refreshBriefs } from "../graph-brief.js";
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
          // The watcher catches every on-disk edit regardless of agent; the config
          // flag lets the UI pause it without stopping the process.
          if (readConfig(root).graph?.watchAutoBrief === false) return;
          const full = resolve(root, rel);
          if (!existsSync(full) || statSync(full).size > 1_000_000) return;
          const taskId =
            resolveActiveTaskId(store, root, undefined, undefined) ?? undefined;
          refreshBriefs(store, root, { paths: [rel], taskId, taskEdited: true });
          console.log(`briefed ${rel}`);
        } catch {
          // Best-effort: a brief failure must never crash the watcher.
        }
      };

      console.log(`agent-bridge watch: watching ${root}`);
      console.log(
        "Auto-briefs source files on change for any agent. Ctrl+C to stop.",
      );
      // Recursive fs.watch is supported on Windows and macOS; on Linux it is not,
      // so only top-level changes fire there.
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
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

      const shutdown = (): void => {
        watcher.close();
        for (const timer of pending.values()) clearTimeout(timer);
        store.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
