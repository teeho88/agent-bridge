import { estimateTokens } from "./token-optimizer.js";

export type TokenCounterDescriptor = {
  count(text: string): number;
  provenance: "exact" | "configured" | "estimated";
  fingerprint: string;
  provider?: string;
  model?: string;
};

export type InvocationBudget = {
  inputTokenBudget?: number;
  outputReserve?: number;
  contextWindowTokens?: number;
  safetyMargin?: number;
};

export function checkInvocationBudget(text: string, policy: InvocationBudget = {}, counter?: TokenCounterDescriptor) {
  const effectiveCounter = counter ?? { count: estimateTokens, provenance: "estimated" as const, fingerprint: "script-aware-v1" };
  const inputBudget = policy.inputTokenBudget ?? 32000;
  const outputReserve = policy.outputReserve ?? 4000;
  const safetyMargin = policy.safetyMargin ?? (effectiveCounter.provenance === "estimated" ? 0.15 : 0);
  if (!Number.isFinite(inputBudget) || inputBudget <= 0 || !Number.isFinite(outputReserve) || outputReserve < 0 ||
      !Number.isFinite(safetyMargin) || safetyMargin < 0 || safetyMargin >= 1 ||
      (policy.contextWindowTokens !== undefined && (!Number.isFinite(policy.contextWindowTokens) || policy.contextWindowTokens <= outputReserve))) {
    throw new Error("Invalid invocation token budget policy");
  }
  const countedTokens = effectiveCounter.count(text);
  if (!Number.isFinite(countedTokens) || countedTokens < 0) throw new Error("Token counter must return a nonnegative finite number");
  const requiredTokens = Math.ceil(countedTokens * (1 + safetyMargin));
  const limit = Math.min(inputBudget, policy.contextWindowTokens === undefined ? inputBudget : policy.contextWindowTokens - outputReserve);
  if (requiredTokens > limit) throw Object.assign(new Error(`invocation_budget_exceeded: required ${requiredTokens}; input limit ${limit}; output reserve ${outputReserve}`),
    { code: "invocation_budget_exceeded", requiredTokens, inputLimit: limit, outputReserve });
  return { schemaVersion: 1 as const, inputTokens: Math.ceil(countedTokens), requiredTokens, inputLimit: limit, outputReserve,
    safetyMargin, counter: { provenance: effectiveCounter.provenance, fingerprint: effectiveCounter.fingerprint, provider: effectiveCounter.provider, model: effectiveCounter.model },
    laterToolReads: "unknown" as const };
}
