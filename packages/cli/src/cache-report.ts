import { execFileSync } from "node:child_process";

// Measured prompt-cache usage, read back from ccusage. Everything else in the
// token stack is an estimate agent-bridge computes about a context it built;
// this is the only signal that says what the providers actually billed. The
// agents that produce it (Claude Code, Codex) manage their own cache
// breakpoints, so these numbers describe their behaviour, not ours - they are
// the baseline that says whether there is any headroom left to chase.

export type CacheUsageTotals = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
};

export type CacheUsageSummary = CacheUsageTotals & {
  days: number;
  firstPeriod?: string;
  lastPeriod?: string;
  // Share of prompt tokens served from cache. Output tokens are excluded: they
  // are never cacheable, and folding them in would understate the rate.
  promptTokens: number;
  hitRatePct: number;
  // Cache writes cost a premium (Anthropic bills them at ~1.25x input). A ratio
  // below 1 means we are paying to fill a cache nothing reads back.
  readPerWrite: number;
  models: Array<CacheUsageTotals & { model: string; hitRatePct: number }>;
};

type DailyModelBreakdown = {
  modelName?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
  cost?: unknown;
};

type DailyEntry = {
  period?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationTokens?: unknown;
  cacheReadTokens?: unknown;
  totalCost?: unknown;
  modelBreakdowns?: unknown;
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratePct(cacheRead: number, promptTokens: number): number {
  if (promptTokens <= 0) return 0;
  return Math.round((cacheRead / promptTokens) * 1000) / 10;
}

// Parse `ccusage daily --json`. Kept separate from the process call so the
// shape stays testable without ccusage installed.
export function summarizeCcusageDaily(raw: unknown): CacheUsageSummary {
  const daily: DailyEntry[] = Array.isArray((raw as { daily?: unknown })?.daily)
    ? ((raw as { daily: DailyEntry[] }).daily)
    : [];

  const totals: CacheUsageTotals = {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 0
  };
  const byModel = new Map<string, CacheUsageTotals>();
  const periods: string[] = [];

  for (const entry of daily) {
    totals.inputTokens += num(entry.inputTokens);
    totals.cacheCreationTokens += num(entry.cacheCreationTokens);
    totals.cacheReadTokens += num(entry.cacheReadTokens);
    totals.outputTokens += num(entry.outputTokens);
    totals.cost += num(entry.totalCost);
    if (typeof entry.period === "string") periods.push(entry.period);

    const breakdowns: DailyModelBreakdown[] = Array.isArray(entry.modelBreakdowns)
      ? (entry.modelBreakdowns as DailyModelBreakdown[])
      : [];
    for (const breakdown of breakdowns) {
      const model = typeof breakdown.modelName === "string" ? breakdown.modelName : "unknown";
      const bucket = byModel.get(model) ?? {
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        cost: 0
      };
      bucket.inputTokens += num(breakdown.inputTokens);
      bucket.cacheCreationTokens += num(breakdown.cacheCreationTokens);
      bucket.cacheReadTokens += num(breakdown.cacheReadTokens);
      bucket.outputTokens += num(breakdown.outputTokens);
      bucket.cost += num(breakdown.cost);
      byModel.set(model, bucket);
    }
  }

  const promptTokens = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  periods.sort();

  return {
    ...totals,
    days: daily.length,
    firstPeriod: periods[0],
    lastPeriod: periods[periods.length - 1],
    promptTokens,
    hitRatePct: ratePct(totals.cacheReadTokens, promptTokens),
    readPerWrite:
      totals.cacheCreationTokens > 0
        ? Math.round((totals.cacheReadTokens / totals.cacheCreationTokens) * 10) / 10
        : 0,
    models: [...byModel.entries()]
      .map(([model, bucket]) => ({
        model,
        ...bucket,
        hitRatePct: ratePct(
          bucket.cacheReadTokens,
          bucket.inputTokens + bucket.cacheCreationTokens + bucket.cacheReadTokens
        )
      }))
      .sort((a, b) => b.cost - a.cost)
  };
}

export type CcusageResult =
  | { ok: true; summary: CacheUsageSummary }
  | { ok: false; reason: string };

// `since` is ccusage's YYYYMMDD form.
export function readCacheUsage(since?: string): CcusageResult {
  const args = ["daily", "--json"];
  if (since) args.push("--since", since);
  let stdout: string;
  try {
    stdout = execFileSync("ccusage", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // ccusage ships as an npm bin, which on Windows resolves through a shim.
      shell: process.platform === "win32"
    });
  } catch {
    return {
      ok: false,
      reason: "Could not run ccusage. Install it with `npm i -g ccusage`, then retry."
    };
  }

  try {
    return { ok: true, summary: summarizeCcusageDaily(JSON.parse(stdout)) };
  } catch {
    return { ok: false, reason: "ccusage returned output that is not the expected JSON." };
  }
}

export function daysAgoStamp(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}
