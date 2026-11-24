import { renderRepoMap } from "@agent-bridge/memory";
import { openStore } from "../../workspace.js";

// Laying out the repository graph the dashboard draws.

export function buildGraphView(
  store: ReturnType<typeof openStore>,
  limit: number,
  focus?: string[],
  taskContext?: {
    task: { id: string; title: string; goal?: string };
    recentTaskFiles?: string[];
  },
  now = Date.now(),
): {
  stats: ReturnType<ReturnType<typeof openStore>["getGraphStats"]>;
  nodes: Array<{
    id: string;
    path: string;
    language?: string;
    symbols: number;
    usedBy: number;
    structuralScore: number;
    editScore: number;
    score: number;
    imports: number;
    outgoing: string[];
    incoming: string[];
    external: string[];
    brief?: string;
    manualPriority?: number;
    briefStale?: boolean;
    recentKind?: "edit";
    lastEditedAt?: string;
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
  const activityRows = [...summaries.values()]
    .filter((summary) => summary.lastTaskEditedAt)
    .map((summary) => ({
      path: summary.path,
      kind: "edit" as const,
      timestamp: summary.lastTaskEditedAt!,
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.path.localeCompare(b.path));
  const activity = new Map(activityRows.map((item) => [item.path, item]));
  const recent = new Map(
    activityRows.map((item, index) => [
      item.path,
      { ...item, rank: index + 1, total: activityRows.length },
    ]),
  );

  const degree = new Map<string, { usedBy: number; imports: number }>();
  const dependents = new Map<string, string[]>();
  const incomingFor = (path: string): string[] => {
    let incoming = dependents.get(path);
    if (!incoming) {
      incoming = [...new Set(store.getDependents(path))];
      dependents.set(path, incoming);
    }
    return incoming;
  };
  for (const file of files) degree.set(file.path, { usedBy: 0, imports: 0 });
  const internalEdges: Array<{ source: string; target: string }> = [];
  for (const file of files) {
    const imports = store.getImports(file.path);
    const entry = degree.get(file.path);
    if (entry) {
      entry.imports = imports.internal.length;
      entry.usedBy = incomingFor(file.path).length;
    }
    for (const target of imports.internal) {
      internalEdges.push({ source: file.path, target });
    }
  }

  let ranked = files;
  if (focus?.length) {
    const needles = focus.map((value) => value.toLowerCase());
    ranked = ranked.filter((file) =>
      needles.some((needle) => file.path.toLowerCase().includes(needle)),
    );
  }
  const structuralScore = (path: string): number =>
    10 * Math.log2(incomingFor(path).length + 1) + 2 * (summaries.get(path)?.manualPriority ?? 0);
  const editScore = (path: string): number => {
    const timestamp = Date.parse(summaries.get(path)?.lastTaskEditedAt ?? "");
    if (!Number.isFinite(timestamp)) return 0;
    const age = Math.max(0, now - timestamp);
    if (age <= 10 * 60_000) return 20;
    if (age <= 3 * 60 * 60_000) return 10;
    if (age <= 24 * 60 * 60_000) return 5;
    return 1;
  };
  const scores = new Map(files.map((file) => [file.path, structuralScore(file.path) + editScore(file.path)]));
  const comparePaths = (a: string, b: string): number => {
    return (
      (scores.get(b) ?? 0) - (scores.get(a) ?? 0) ||
      (activity.get(b)?.timestamp ?? "").localeCompare(activity.get(a)?.timestamp ?? "") ||
      a.localeCompare(b)
    );
  };
  ranked = [...ranked].sort((a, b) => comparePaths(a.path, b.path));

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
      structuralScore: structuralScore(file.path),
      editScore: editScore(file.path),
      score: scores.get(file.path) ?? 0,
      imports: entry.imports,
      outgoing: [...store.getImports(file.path).internal].sort(comparePaths),
      incoming: [...incomingFor(file.path)].sort(comparePaths),
      external: store.getImports(file.path).external,
      brief: summary?.summary,
      manualPriority: summary?.manualPriority,
      briefStale: Boolean(
        summary?.summary &&
        summary.lastSeenHash &&
        file.contentHash &&
        summary.lastSeenHash !== file.contentHash,
      ),
      recentKind: recentInfo?.kind,
      lastEditedAt: summary?.lastTaskEditedAt,
      recentRank: recentInfo?.rank,
      recentTotal: recentInfo?.total,
    };
  });
  const edges = internalEdges.filter(
    (edge) => selectedPaths.has(edge.source) && selectedPaths.has(edge.target),
  );

  return { stats, nodes, edges, repoMap: renderRepoMap(repoMapFiles) };
}
