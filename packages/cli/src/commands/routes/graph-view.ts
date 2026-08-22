import { renderRepoMap } from "@agent-bridge/memory";
import { openStore } from "../../workspace.js";

// Laying out the repository graph the dashboard draws.

// Assemble a bounded graph view for the UI: the `limit` highest-degree files and
// the import edges among them, plus the repo map. Keeping it degree-ranked means
// the most architecturally central files always make the cut.
export function buildGraphView(
  store: ReturnType<typeof openStore>,
  limit: number,
  focus?: string[],
  taskContext?: {
    task: { id: string; title: string; goal?: string };
    recentTaskFiles?: string[];
  },
): {
  stats: ReturnType<ReturnType<typeof openStore>["getGraphStats"]>;
  nodes: Array<{
    id: string;
    path: string;
    language?: string;
    symbols: number;
    usedBy: number;
    imports: number;
    brief?: string;
    manualPriority?: number;
    briefStale?: boolean;
    recentKind?: "read" | "edit";
    recentRank?: number;
    recentTotal?: number;
  }>;
  edges: Array<{ source: string; target: string }>;
  repoMap: string;
} {
  const stats = store.getGraphStats();
  const repoMapFiles = store.buildRepoMap({
    limit: Math.min(limit, 60),
    focusPaths: focus,
    ...taskContext,
  });
  const files = store.listGraphFiles(5000);
  const summaries = new Map(
    store.listFileSummaries().map((summary) => [summary.path, summary]),
  );
  const recentLimit = Math.min(24, Math.max(6, Math.ceil(limit * 0.25)));
  const recentRows = [...summaries.values()]
    .map((summary) => ({
      path: summary.path,
      kind: summary.lastTaskEditedAt ? ("edit" as const) : ("read" as const),
      timestamp: summary.lastTaskEditedAt ?? summary.updatedAt,
    }))
    .filter((item) => item.timestamp)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, recentLimit);
  const recent = new Map(
    recentRows.map((item, index) => [
      item.path,
      { ...item, rank: index + 1, total: recentRows.length },
    ]),
  );

  const degree = new Map<string, { usedBy: number; imports: number }>();
  for (const file of files) degree.set(file.path, { usedBy: 0, imports: 0 });
  const internalEdges: Array<{ source: string; target: string }> = [];
  for (const file of files) {
    const imports = store.getImports(file.path);
    const entry = degree.get(file.path);
    if (entry) entry.imports = imports.internal.length;
    for (const target of imports.internal) {
      internalEdges.push({ source: file.path, target });
      const targetEntry = degree.get(target);
      if (targetEntry) targetEntry.usedBy += 1;
    }
  }

  let ranked = files;
  if (focus?.length) {
    const needles = focus.map((value) => value.toLowerCase());
    ranked = ranked.filter((file) =>
      needles.some((needle) => file.path.toLowerCase().includes(needle)),
    );
  }
  ranked = [...ranked].sort((a, b) => {
    const da = degree.get(a.path) ?? { usedBy: 0, imports: 0 };
    const db = degree.get(b.path) ?? { usedBy: 0, imports: 0 };
    const recentA = recent.get(a.path);
    const recentB = recent.get(b.path);
    const recentScoreA = recentA
      ? 1000 - recentA.rank * 20 + (recentA.kind === "edit" ? 10 : 0)
      : 0;
    const recentScoreB = recentB
      ? 1000 - recentB.rank * 20 + (recentB.kind === "edit" ? 10 : 0)
      : 0;
    return (
      recentScoreB +
        db.usedBy +
        db.imports -
        (recentScoreA + da.usedBy + da.imports) || a.path.localeCompare(b.path)
    );
  });

  const selected = ranked.slice(0, limit);
  const selectedPaths = new Set(selected.map((file) => file.path));
  const nodes = selected.map((file) => {
    const entry = degree.get(file.path) ?? { usedBy: 0, imports: 0 };
    const summary = summaries.get(file.path);
    const recentInfo = recent.get(file.path);
    return {
      id: file.path,
      path: file.path,
      language: file.language,
      symbols: store.getFileSymbols(file.path).length,
      usedBy: entry.usedBy,
      imports: entry.imports,
      brief: summary?.summary,
      manualPriority: summary?.manualPriority,
      briefStale: Boolean(
        summary?.summary &&
        summary.lastSeenHash &&
        file.contentHash &&
        summary.lastSeenHash !== file.contentHash,
      ),
      recentKind: recentInfo?.kind,
      recentRank: recentInfo?.rank,
      recentTotal: recentInfo?.total,
    };
  });
  const edges = internalEdges.filter(
    (edge) => selectedPaths.has(edge.source) && selectedPaths.has(edge.target),
  );

  return { stats, nodes, edges, repoMap: renderRepoMap(repoMapFiles) };
}
