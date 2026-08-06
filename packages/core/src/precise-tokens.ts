// Optional precise token counting. The built-in estimateTokens() is a fast
// script-aware heuristic (~20% off real tokenizers); good enough for budgeting
// and used everywhere internally. When an exact count is wanted (e.g. reporting),
// a real tokenizer can be loaded on demand from a module named by
// AGENT_BRIDGE_TOKENIZER_MODULE — no hard dependency, so the package builds and
// runs without it. Missing/broken module => null => callers fall back to the
// heuristic.

export type TokenCounter = (text: string) => number;

export async function loadOptionalTokenizer(
  moduleName: string | undefined = process.env.AGENT_BRIDGE_TOKENIZER_MODULE
): Promise<TokenCounter | null> {
  if (!moduleName) return null;
  try {
    // Variable specifier keeps this out of static module resolution.
    const mod: Record<string, unknown> = await import(moduleName);
    const counter = resolveCounter(mod);
    if (counter) return counter;
    const factory = (mod.createTokenizer ?? mod.default) as unknown;
    const instance = typeof factory === "function" ? await (factory as () => unknown)() : factory;
    return instance ? resolveCounter(instance as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Accept the common shapes: countTokens(text) -> number, or encode(text) -> array.
function resolveCounter(source: Record<string, unknown>): TokenCounter | null {
  if (typeof source.countTokens === "function") {
    return (text) => Number((source.countTokens as (t: string) => number)(text));
  }
  if (typeof source.encode === "function") {
    return (text) => ((source.encode as (t: string) => unknown[])(text) ?? []).length;
  }
  return null;
}
