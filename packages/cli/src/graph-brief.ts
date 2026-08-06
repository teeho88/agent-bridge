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
// indexed.
export function automaticBrief(store: Store, root: string, path: string): { summary: string; ranges: string[] } {
  const indexed = store.listGraphFiles(5000).find((file) => file.path === path);
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
};

// Regenerate briefs for the given files (or all indexed files). Automatic
// refreshes preserve an existing manual priority and never create one.
export function refreshBriefs(
  store: Store,
  root: string,
  options: RefreshBriefsOptions
): { path: string; manualPriority?: number }[] {
  const targets = options.all ? store.listGraphFiles(5000).map((file) => file.path) : options.paths ?? [];

  const results: { path: string; manualPriority?: number }[] = [];
  for (const target of targets) {
    const normalizedPath = target.replace(/\\/g, "/");
    const brief = automaticBrief(store, root, normalizedPath);
    const file = store.upsertFileSummary({
      path: normalizedPath,
      summary: redactIfEnabled(brief.summary),
      manualPriority: options.manualPriority,
      importantRanges: brief.ranges,
      lastSeenHash: contentHash(root, normalizedPath),
      lastTaskId: options.taskId,
      markTaskEdited: options.taskEdited
    });
    results.push({ path: file.path, manualPriority: file.manualPriority });
  }
  // First real edit promotes the task out of the "todo" backlog: a task is only
  // "in_progress" once work touches a file, not the moment a prompt creates it.
  if (options.taskEdited && options.taskId && results.length) {
    const task = store.getTask(options.taskId);
    if (task?.status === "todo") store.updateTaskStatus(options.taskId, "in_progress");
  }
  return results;
}
