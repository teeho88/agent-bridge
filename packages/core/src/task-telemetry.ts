import { normalizeProviderUsage, type ProviderUsage } from "./workflow-usage.js";

export type UsageSemantics = "inclusive" | "exclusive" | "unknown";
export type TelemetryRun = {
  taskId: string; runId: string | null; attemptId: string | null; sessionId: string | null;
  provider: string; model: string | null; revision: number | null; status: string;
  usage: ProviderUsage; completeness?: string; semantics?: UsageSemantics;
  rawUsage?: unknown[]; startedAt?: string; endedAt?: string; toolCalls?: number | null;
};

export function partitionUsage(usage: ProviderUsage, semantics: UsageSemantics) {
  const { input, cacheRead, cacheWrite, output, reasoning } = usage;
  const uncachedInput = semantics === "exclusive" ? input : semantics === "inclusive" && input !== null && cacheRead !== null && cacheWrite !== null
    ? input - cacheRead - cacheWrite : null;
  if (uncachedInput !== null && uncachedInput < 0 || output !== null && reasoning !== null && reasoning > output) {
    throw new Error("Inconsistent provider usage partitions");
  }
  const total = uncachedInput !== null && cacheRead !== null && cacheWrite !== null && output !== null
    ? uncachedInput + cacheRead + cacheWrite + output : usage.total;
  return { uncachedInput, cachedInput: cacheRead, cacheWrite, output, reasoning, total };
}

export function taskTelemetry(runs: TelemetryRun[]) {
  const seen = new Set<string>();
  const rows = runs.map(run => {
    const key = run.runId ? `run:${run.runId}` : run.attemptId ? `attempt:${run.attemptId}` : null;
    if (key && seen.has(key)) throw new Error(`Duplicate telemetry identity: ${key}`);
    if (key) seen.add(key);
    for (const value of Object.values(run.usage)) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Invalid telemetry usage");
    }
    const raw = run.rawUsage?.map(normalizeProviderUsage);
    const reconciled = raw?.length ? Object.keys(run.usage).every(key => {
      const field = key as keyof ProviderUsage;
      return run.usage[field] === (raw.every(item => item[field] !== null) ? raw.reduce((sum, item) => sum + item[field]!, 0) : null);
    }) : null;
    const started = Date.parse(run.startedAt ?? "");
    const ended = Date.parse(run.endedAt ?? "");
    return { ...run, tokens: partitionUsage(run.usage, run.semantics ?? "unknown"), rawReconciled: reconciled,
      durationMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null };
  });
  const sum = (values: Array<number | null>) => values.length && values.every(value => value !== null) ? values.reduce<number>((a, b) => a + b!, 0) : null;
  const complete = rows.every(row => row.completeness === "terminal-summary" && !["running", "starting"].includes(row.status) && row.rawReconciled !== false);
  return { schemaVersion: 2, runs: rows, tokens: Object.fromEntries(
    (["uncachedInput", "cachedInput", "cacheWrite", "output", "reasoning", "total"] as const).map(key => [key, complete ? sum(rows.map(row => row.tokens[key])) : null])),
    runDurationMs: sum(rows.map(row => row.durationMs)), toolCalls: sum(rows.map(row => row.toolCalls ?? null)),
    cost: null, pricing: null, measuredSavings: null };
}
