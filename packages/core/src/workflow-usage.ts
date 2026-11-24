export type ProviderUsage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
};

export function normalizeProviderUsage(raw: unknown): ProviderUsage {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const value = (...values: unknown[]): number | null => {
    const selected = values.find((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
    return typeof selected === "number" ? selected : null;
  };
  const inputDetails = record.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputTokenDetails = record.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = record.completion_tokens_details as Record<string, unknown> | undefined;
  return { input: value(record.input_tokens, record.prompt_tokens), output: value(record.output_tokens, record.completion_tokens),
    cacheRead: value(record.cache_read_input_tokens, inputDetails?.cached_tokens, inputTokenDetails?.cached_tokens, record.cached_input_tokens),
    cacheWrite: value(record.cache_creation_input_tokens, record.cache_write_input_tokens), reasoning: value(record.reasoning_tokens, record.reasoning_output_tokens, outputDetails?.reasoning_tokens),
    total: value(record.total_tokens) };
}

export function aggregateWorkflowUsage(attempts: Array<{ status: string; usage: ProviderUsage; completeness?: string }>) {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;
  const totals = Object.fromEntries(keys.map((key) => [key, attempts.length && attempts.every((attempt) => attempt.usage[key] !== null && attempt.completeness !== "partial" && attempt.completeness !== "unknown" && attempt.status !== "running")
    ? attempts.reduce((sum, attempt) => sum + attempt.usage[key]!, 0) : null])) as ProviderUsage;
  return { schemaVersion: 1, attempts: attempts.length, interrupted: attempts.filter((attempt) => attempt.status === "interrupted").length,
    failed: attempts.filter((attempt) => attempt.status === "failed").length, totals,
    observed: Object.fromEntries(keys.map((key) => [key, { attempts: attempts.filter((attempt) => attempt.usage[key] !== null).length,
      tokens: attempts.reduce((sum, attempt) => sum + (attempt.usage[key] ?? 0), 0) }])), measuredSavings: null, laterToolReads: "unknown" };
}
