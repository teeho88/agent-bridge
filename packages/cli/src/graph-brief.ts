import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractGraph } from "@agent-bridge/memory";
import { composeBrief, extractLeadingDoc } from "./brief.js";
import { openStore, redactIfEnabled } from "./workspace.js";

type Store = ReturnType<typeof openStore>;

export function contentHash(root: string, path: string): string | undefined {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  return createHash("sha256").update(readFileSync(full, "utf8")).digest("hex");
}

// Build a brief for one file from the indexed graph data plus the file's own
// leading comment. Falls back to a one-off extraction when the file is not yet
// indexed. `indexedFiles` lets a batch caller pay for the graph listing once
// instead of once per file.
export function automaticBrief(
  store: Store,
  root: string,
  path: string,
  indexedFiles?: ReturnType<Store["listGraphFiles"]>
): { summary: string; ranges: string[] } {
  const indexed = (indexedFiles ?? store.listGraphFiles(5000)).find((file) => file.path === path);
  let symbols = store.getFileSymbols(path);
  let imports = store.getImports(path);

  if (!indexed && !symbols.length && !imports.internal.length && !imports.external.length) {
    const extracted = extractGraph(root, { include: [path] });
    symbols = extracted.nodes.filter((node) => node.kind === "symbol" && node.path === path);
    imports = {
      internal: extracted.edges.filter((edge) => edge.src === path && !edge.dst.startsWith("ext:")).map((edge) => edge.dst),
      external: extracted.edges.filter((edge) => edge.src === path && edge.dst.startsWith("ext:")).map((edge) => edge.dst.slice(4))
    };
  }

  const dependents = store.getDependents(path);

  // The file's own leading comment is the best statically available signal for
  // its purpose; fall back to role + primary symbol when there is none.
  let docComment: string | undefined;
  try {
    const full = join(root, path);
    if (existsSync(full)) docComment = extractLeadingDoc(readFileSync(full, "utf8"));
  } catch {
    docComment = undefined;
  }

  const summary = composeBrief({
    path,
    language: indexed?.language,
    symbols: symbols.map((symbol) => ({ name: symbol.name ?? "", kind: symbol.symbolKind ?? "symbol" })),
    importsInternal: imports.internal,
    importsExternal: imports.external,
    dependentsCount: dependents.length,
    docComment
  });
  const ranges = symbols
    .slice(0, 8)
    .map((symbol) => symbol.line)
    .filter((line): line is number => typeof line === "number")
    .map(String);
  return { summary, ranges };
}

export type RefreshBriefsOptions = {
  paths?: string[]; // explicit targets (ignored when all is true)
  all?: boolean; // refresh every indexed file
  manualPriority?: number; // explicit override
  taskId?: string;
  taskEdited?: boolean;
  // Rebuild even when the file content is unchanged. `all` implies it: a
  // whole-repo refresh is usually run right after `graph build`, when the graph
  // relations a brief draws on have moved even though the files have not.
  force?: boolean;
};

// Regenerate briefs for the given files (or all indexed files). Automatic
// refreshes preserve an existing manual priority and never create one.
//
// Briefs are content-addressed: agents run `graph brief-auto` after every file
// they read, so the same unchanged file is re-briefed many times per session.
// When the stored last_seen_hash still matches the file on disk we reuse the
// stored summary and only touch the task metadata, which skips the symbol and
// import queries plus the fallback extractGraph parse.
export function refreshBriefs(
  store: Store,
  root: string,
  options: RefreshBriefsOptions
): { path: string; manualPriority?: number; reused: boolean }[] {
  const indexedFiles = store.listGraphFiles(5000);
  const targets = options.all ? indexedFiles.map((file) => file.path) : options.paths ?? [];
  const force = options.force || options.all;

  const results: { path: string; manualPriority?: number; reused: boolean }[] = [];
  for (const target of targets) {
    const normalizedPath = target.replace(/\\/g, "/");
    const hash = contentHash(root, normalizedPath);
    const stored = force ? undefined : store.getFileSummary(normalizedPath);
    // A hash is only a valid cache key when we can compute one for a file that
    // is actually on disk; a deleted file yields undefined and must not match
    // a stored undefined.
    const reused = Boolean(hash && stored?.summary && stored.lastSeenHash === hash);

    const brief = reused
      ? { summary: stored!.summary!, ranges: stored!.importantRanges }
      : automaticBrief(store, root, normalizedPath, indexedFiles);

    const file = store.upsertFileSummary({
      path: normalizedPath,
      // Reused summaries were redacted on the way in; redacting again would
      // rewrite already-masked text.
      summary: reused ? brief.summary : redactIfEnabled(brief.summary),
      manualPriority: options.manualPriority,
      importantRanges: brief.ranges,
      lastSeenHash: hash,
      lastTaskId: options.taskId,
      markTaskEdited: options.taskEdited
    });
    results.push({ path: file.path, manualPriority: file.manualPriority, reused });
  }
  // First real edit promotes the task out of the "todo" backlog: a task is only
  // "in_progress" once work touches a file, not the moment a prompt creates it.
  if (options.taskEdited && options.taskId && results.length) {
    const task = store.getTask(options.taskId);
    if (task?.status === "todo") store.updateTaskStatus(options.taskId, "in_progress");
  }
  return results;
}
