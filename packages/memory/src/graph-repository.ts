import { foldDiacritics } from "./text-normalize.js";
import type Database from "better-sqlite3";

import type { GraphStats } from "./sqlite-codecs.js";

import type { ExtractedGraph, GraphNode, RepoMapFile } from "./graph.js";
import type { MemoryStore } from "./memory-store.js";
import type { FileSummary } from "./types.js";
import { now, toGraphNode } from "./sqlite-codecs.js";
type Row = Record<string, unknown>;

export class GraphRepository {
  constructor(
    private db: Database.Database,
    private host: Pick<MemoryStore, "listFileSummaries">,
  ) {}

  replaceGraph(graph: ExtractedGraph, paths?: string[]): { nodes: number; edges: number } {
    const timestamp = now();
    const insertNode = this.db.prepare(
      `INSERT OR REPLACE INTO graph_nodes (id, kind, path, name, language, symbol_kind, line, signature, content_hash, updated_at)
       VALUES (@id, @kind, @path, @name, @language, @symbolKind, @line, @signature, @contentHash, @updatedAt)`,
    );
    const insertEdge = this.db.prepare(
      `INSERT OR REPLACE INTO graph_edges (src, dst, kind, raw, updated_at)
       VALUES (@src, @dst, @kind, @raw, @updatedAt)`,
    );
    const tx = this.db.transaction(() => {
      if (paths) {
        const deleteNodes = this.db.prepare("DELETE FROM graph_nodes WHERE path = ?");
        const deleteEdges = this.db.prepare("DELETE FROM graph_edges WHERE src = ?");
        for (const path of paths) {
          deleteNodes.run(path);
          deleteEdges.run(path);
        }
      } else {
        this.db.prepare("DELETE FROM graph_nodes").run();
        this.db.prepare("DELETE FROM graph_edges").run();
      }
      for (const node of graph.nodes) {
        insertNode.run({
          id: node.id,
          kind: node.kind,
          path: node.path,
          name: node.name ?? null,
          language: node.language ?? null,
          symbolKind: node.symbolKind ?? null,
          line: node.line ?? null,
          signature: node.signature ?? null,
          contentHash: node.contentHash ?? null,
          updatedAt: timestamp,
        });
      }
      for (const edge of graph.edges) {
        insertEdge.run({
          src: edge.src,
          dst: edge.dst,
          kind: edge.kind,
          raw: edge.raw ?? null,
          updatedAt: timestamp,
        });
      }
    });
    tx();
    return { nodes: graph.nodes.length, edges: graph.edges.length };
  }

  getGraphStats(): GraphStats {
    const count = (sql: string): number =>
      Number((this.db.prepare(sql).get() as Row).n ?? 0);
    return {
      files: count("SELECT COUNT(*) AS n FROM graph_nodes WHERE kind = 'file'"),
      symbols: count(
        "SELECT COUNT(*) AS n FROM graph_nodes WHERE kind = 'symbol'",
      ),
      edges: count("SELECT COUNT(*) AS n FROM graph_edges"),
      internalEdges: count(
        "SELECT COUNT(*) AS n FROM graph_edges WHERE dst NOT LIKE 'ext:%'",
      ),
      externalEdges: count(
        "SELECT COUNT(*) AS n FROM graph_edges WHERE dst LIKE 'ext:%'",
      ),
    };
  }

  listGraphFiles(limit = 1000): GraphNode[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM graph_nodes WHERE kind = 'file' ORDER BY path LIMIT ?",
        )
        .all(limit) as Row[]
    ).map(toGraphNode);
  }

  getFileSymbols(path: string): GraphNode[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM graph_nodes WHERE kind = 'symbol' AND path = ? ORDER BY line",
        )
        .all(path) as Row[]
    ).map(toGraphNode);
  }

  getImports(path: string): { internal: string[]; external: string[] } {
    const rows = this.db
      .prepare("SELECT dst FROM graph_edges WHERE src = ? ORDER BY dst")
      .all(path) as Row[];
    const internal: string[] = [];
    const external: string[] = [];
    for (const row of rows) {
      const dst = String(row.dst);
      if (dst.startsWith("ext:")) external.push(dst.slice(4));
      else internal.push(dst);
    }
    return { internal, external };
  }

  getDependents(path: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT src FROM graph_edges WHERE dst = ? ORDER BY src",
        )
        .all(path) as Row[]
    ).map((row) => String(row.src));
  }

  searchGraphNodes(
    query: string,
    options: { kind?: GraphNode["kind"]; limit?: number } = {},
  ): GraphNode[] {
    const limit = options.limit ?? 30;
    const needle = `%${foldDiacritics(query)}%`;
    const kindFilter = options.kind ? "AND kind = @kind" : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM graph_nodes
           WHERE (fold(name) LIKE @needle OR fold(path) LIKE @needle) ${kindFilter}
           ORDER BY CASE kind WHEN 'symbol' THEN 0 ELSE 1 END, path, line
           LIMIT @limit`,
        )
        .all({ needle, kind: options.kind, limit }) as Row[]
    ).map(toGraphNode);
  }

  buildRepoMap(
    options: {
      limit?: number;
      focusPaths?: string[];
      maxSymbolsPerFile?: number;
      recentTaskFiles?: string[];
      task?: { id?: string; title: string; goal?: string };
    } = {},
  ): RepoMapFile[] {
    const limit = options.limit ?? 40;
    const dependentCounts = new Map<string, number>();
    for (const row of this.db
      .prepare(
        "SELECT dst, COUNT(DISTINCT src) AS n FROM graph_edges WHERE dst NOT LIKE 'ext:%' GROUP BY dst",
      )
      .all() as Row[]) {
      dependentCounts.set(String(row.dst), Number(row.n));
    }
    const summaries = new Map(
      this.host.listFileSummaries().map((summary) => [summary.path, summary]),
    );
    const recentTaskFiles = new Set(options.recentTaskFiles ?? []);

    let files = this.listGraphFiles(5000);
    if (options.focusPaths?.length) {
      const needles = options.focusPaths.map((value) => value.toLowerCase());
      files = files.filter((file) =>
        needles.some((needle) => file.path.toLowerCase().includes(needle)),
      );
    }
    const taskTerms = taskQueryTerms(options.task);
    const relevance = new Map(
      files.map((file) => [
        file.path,
        taskRelevance(file, summaries.get(file.path), taskTerms, this),
      ]),
    );
    const structuralScore = (file: GraphNode): number =>
      Math.log2((dependentCounts.get(file.path) ?? 0) + 1) * 10 +
      (summaries.get(file.path)?.manualPriority ?? 0) * 2;
    const sortBy =
      (score: (file: GraphNode) => number) => (a: GraphNode, b: GraphNode) =>
        score(b) - score(a) || a.path.localeCompare(b.path);

    if (!options.task && !recentTaskFiles.size)
      files.sort(sortBy(structuralScore));

    const selected: Array<{
      file: GraphNode;
      reason?: RepoMapFile["selectionReason"];
    }> = [];
    const selectedPaths = new Set<string>();
    const add = (
      candidates: GraphNode[],
      count: number,
      reason?: RepoMapFile["selectionReason"],
      score = structuralScore,
    ): void => {
      for (const file of candidates.sort(sortBy(score))) {
        if (selected.length >= limit || selectedPaths.has(file.path)) continue;
        selected.push({ file, reason });
        selectedPaths.add(file.path);
        if (selected.filter((entry) => entry.reason === reason).length >= count)
          break;
      }
    };

    if (options.task || recentTaskFiles.size) {
      const taskQuota = Math.min(limit, Math.max(1, Math.ceil(limit * 0.4)));
      const taskSeeds = files.filter((file) => {
        const summary = summaries.get(file.path);
        return (
          recentTaskFiles.has(file.path) ||
          (summary?.lastTaskId === options.task?.id &&
            Boolean(summary?.lastTaskEditedAt)) ||
          (relevance.get(file.path) ?? 0) > 0
        );
      });
      add(
        taskSeeds,
        taskQuota,
        "task",
        (file) =>
          (recentTaskFiles.has(file.path) ? 1_000 : 0) +
          (summaries.get(file.path)?.lastTaskId === options.task?.id &&
          summaries.get(file.path)?.lastTaskEditedAt
            ? 500
            : 0) +
          (relevance.get(file.path) ?? 0) * 60 +
          structuralScore(file),
      );

      const neighbourPaths = new Set<string>();
      for (const { file } of selected) {
        for (const path of this.getImports(file.path).internal)
          neighbourPaths.add(path);
        for (const path of this.getDependents(file.path))
          neighbourPaths.add(path);
      }
      const neighbourQuota = Math.min(
        limit - selected.length,
        Math.ceil(limit / 3),
      );
      add(
        files.filter((file) => neighbourPaths.has(file.path)),
        neighbourQuota,
        "neighbor",
        (file) => (relevance.get(file.path) ?? 0) * 60 + structuralScore(file),
      );
    }
    add(
      files,
      limit - selected.length,
      options.task || recentTaskFiles.size ? "structural" : undefined,
    );

    const maxSymbols = options.maxSymbolsPerFile ?? 12;
    return selected.map(({ file, reason }) => {
      const imports = this.getImports(file.path);
      const summary = summaries.get(file.path);
      return {
        path: file.path,
        language: file.language,
        symbols: this.getFileSymbols(file.path)
          .slice(0, maxSymbols)
          .map((symbol) => ({
            name: symbol.name ?? "",
            kind: symbol.symbolKind ?? "symbol",
          })),
        importsInternal: imports.internal,
        importsExternal: imports.external,
        usedByCount: dependentCounts.get(file.path) ?? 0,
        brief: summary?.summary,
        manualPriority: summary?.manualPriority,
        briefStale: Boolean(
          summary?.summary &&
          summary.lastSeenHash &&
          file.contentHash &&
          summary.lastSeenHash !== file.contentHash,
        ),
        selectionReason: reason,
      };
    });
  }
}

function taskQueryTerms(
  task: { id?: string; title: string; goal?: string } | undefined,
): string[] {
  if (!task) return [];
  return [
    ...new Set(
      foldDiacritics([task.title, task.goal ?? ""].join(" ")).match(
        /[\p{L}\p{N}_-]{3,}/gu,
      ) ?? [],
    ),
  ];
}

function taskRelevance(
  file: GraphNode,
  summary: FileSummary | undefined,
  terms: string[],
  store: GraphRepository,
): number {
  if (!terms.length) return 0;
  const text = foldDiacritics(
    [
      file.path,
      summary?.summary ?? "",
      ...store.getFileSymbols(file.path).map((symbol) => symbol.name ?? ""),
    ].join(" "),
  );
  return terms.filter((term) => text.includes(term)).length / terms.length;
}
