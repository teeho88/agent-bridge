import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, type TokenCounter } from "@agent-bridge/core";
import { renderRepoMap, type RepoMapFile } from "@agent-bridge/memory";

// Files larger than this are recorded in the graph but not scanned; mirror that
// cap here so the baseline does not pretend an agent would read a 5 MB blob.
const MAX_BASELINE_FILE_BYTES = 512 * 1024;

export type BaselineFileCost = { path: string; tokens: number };

export type BaselineSummary = {
  fileCount: number;
  baselineTokens: number; // cost of reading the files' raw source
  optimizedTokens: number; // cost of the compact repo-map index that replaces it
  savedTokens: number;
  savedPct: number; // 0-100, one decimal
};

export type BaselineResult = {
  summary: BaselineSummary;
  topFiles: BaselineFileCost[];
  skipped: string[];
  precise: boolean;
  limit: number;
  focus?: string[];
};

// Minimal structural view of the store so this stays decoupled from the SQLite
// implementation (and avoids an import cycle through workspace).
export type RepoStore = {
  getGraphStats(): { files: number };
  buildRepoMap(options: { limit?: number; focusPaths?: string[] }): RepoMapFile[];
};

// Pure savings math, kept separate from IO so it can be unit-tested.
export function summarizeBaseline(files: BaselineFileCost[], optimizedTokens: number): BaselineSummary {
  const baselineTokens = files.reduce((sum, file) => sum + file.tokens, 0);
  const savedTokens = baselineTokens - optimizedTokens;
  const savedPct = baselineTokens > 0 ? Math.round((savedTokens / baselineTokens) * 1000) / 10 : 0;
  return { fileCount: files.length, baselineTokens, optimizedTokens, savedTokens, savedPct };
}

// Measure the central knowledge-graph claim: reading the repo-map files' raw
// source vs. the compact repo map index that lets an agent navigate without
// reading them. Returns null when there is no graph or nothing to compare.
export function computeBaseline(
  store: RepoStore,
  root: string,
  options: { limit: number; focusPaths?: string[]; count?: TokenCounter; topN?: number }
): BaselineResult | null {
  if (store.getGraphStats().files === 0) return null;
  const files = store.buildRepoMap({ limit: options.limit, focusPaths: options.focusPaths });
  if (!files.length) return null;

  const count = options.count ?? estimateTokens;
  const costs: BaselineFileCost[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const full = join(root, file.path);
    try {
      if (!existsSync(full) || statSync(full).size > MAX_BASELINE_FILE_BYTES) {
        skipped.push(file.path);
        continue;
      }
      costs.push({ path: file.path, tokens: count(readFileSync(full, "utf8")) });
    } catch {
      skipped.push(file.path);
    }
  }

  const summary = summarizeBaseline(costs, count(renderRepoMap(files)));
  const topFiles = costs
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, Math.max(0, options.topN ?? 10));
  return { summary, topFiles, skipped, precise: count !== estimateTokens, limit: options.limit, focus: options.focusPaths };
}

// Stable, parseable phrasing recorded in the `runs` table for a baseline run, so
// `optimize report` and the UI can reconstruct the savings trend without a schema
// change. Keep in sync with parseBaselineRun.
export function formatBaselineRunSummary(summary: BaselineSummary): string {
  return `Saved ${summary.savedPct}% (${summary.savedTokens} tokens) over ${summary.fileCount} files`;
}

export type BaselineRunPoint = {
  createdAt: string;
  agent?: string;
  savedPct: number;
  savedTokens: number;
  fileCount: number;
  optimizedTokens?: number;
};

export function parseBaselineRun(run: {
  createdAt: string;
  agent?: string;
  resultSummary?: string;
  tokenEstimate?: number;
}): BaselineRunPoint | null {
  const match = /Saved\s+(-?[\d.]+)%\s+\((-?\d+)\s+tokens\)\s+over\s+(\d+)\s+files/.exec(run.resultSummary ?? "");
  if (!match) return null;
  return {
    createdAt: run.createdAt,
    agent: run.agent,
    savedPct: Number(match[1]),
    savedTokens: Number(match[2]),
    fileCount: Number(match[3]),
    optimizedTokens: run.tokenEstimate
  };
}
