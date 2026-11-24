import type { TaskAttempt } from "@agent-bridge/memory";
import type { LeaderAgentPreference } from "./leader-contract.js";

export type RoutingDifficulty = "small" | "debug" | "multi" | "handoff";
export type RoutingSignals = {
  files: string[];
  debugging?: boolean;
  handoff?: boolean;
  highRisk?: boolean;
};
export type ModelRoute = LeaderAgentPreference & { model: string; capabilities: string[] };
export type ModelRoutingPolicy = {
  routes: Record<RoutingDifficulty, ModelRoute[]>;
  failuresBeforeEscalation: number;
};
export type RoutedAttempt = {
  attempt: TaskAttempt;
  provider: string;
  model: string;
  cost: number | null;
};

export function classifyRoutingDifficulty(signals: RoutingSignals): RoutingDifficulty {
  if (signals.highRisk || new Set(signals.files).size > 2) return "multi";
  if (signals.debugging) return "debug";
  if (signals.handoff) return "handoff";
  return "small";
}

export function selectModelRoute(input: {
  signals: RoutingSignals;
  policy: ModelRoutingPolicy;
  attempts?: RoutedAttempt[];
  requiredCapabilities?: string[];
  override?: LeaderAgentPreference;
}) {
  const { policy, override } = input;
  if (!Number.isSafeInteger(policy.failuresBeforeEscalation) || policy.failuresBeforeEscalation < 1) {
    throw new Error("failuresBeforeEscalation must be a positive integer");
  }
  const difficulty = classifyRoutingDifficulty(input.signals);
  const attempts = input.attempts ?? [];
  const taskIds = new Set(attempts.map(({ attempt }) => attempt.taskId));
  if (taskIds.size > 1 || new Set(attempts.map(({ attempt }) => attempt.id)).size !== attempts.length) {
    throw new Error("Routing requires unique attempts from one task");
  }
  if (attempts.some(({ attempt }) => !attempt.endedAt)) throw new Error("Cannot route while an attempt is active");
  if (attempts.at(-1)?.attempt.outcome === "blocked" || attempts.at(-1)?.attempt.decision === "blocked") {
    throw new Error("Blocked attempt requires resolution before routing");
  }
  const required = (input.requiredCapabilities ?? []).map((value) => value.trim().toLowerCase());
  const routes = policy.routes[difficulty].filter((route) => {
    if (!route.provider.trim() || !route.model.trim()) throw new Error("Route requires provider and model");
    const capabilities = route.capabilities.map((value) => value.trim().toLowerCase());
    return required.every((capability) => capabilities.includes(capability));
  });
  let index = 0;
  let failures = 0;
  for (const { attempt, provider, model } of attempts) {
    const routeIndex = routes.findIndex((route) => route.provider === provider && route.model === model);
    if (routeIndex < 0) continue;
    if (routeIndex > index) { index = routeIndex; failures = 0; }
    if (routeIndex !== index) continue;
    if (attempt.outcome === "blocked" || attempt.decision === "blocked") {
      throw new Error("Blocked attempt requires resolution before routing");
    }
    failures = attempt.outcome === "failed" ? failures + 1 : 0;
    if (attempt.decision === "escalate" || failures >= policy.failuresBeforeEscalation) {
      index++;
      failures = 0;
    }
  }
  const preference = override ?? routes[index];
  if (!preference?.provider.trim() || !preference.model?.trim()) {
    throw new Error("No eligible model route remains; checkpoint and revise the routing policy");
  }
  let knownTokens = 0;
  let knownCost = 0;
  let tokensComplete = true;
  let costComplete = true;
  for (const { attempt, cost } of attempts) {
    for (const value of [attempt.tokens, cost]) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid attempt usage");
    }
    knownTokens += attempt.tokens ?? 0;
    knownCost += cost ?? 0;
    tokensComplete &&= attempt.tokens !== null;
    costComplete &&= cost !== null;
  }
  return {
    difficulty,
    preference,
    reason: override ? "user_override" : index > 0 ? "escalation" : "difficulty",
    usage: {
      attemptCount: attempts.length,
      knownTokens,
      tokens: tokensComplete ? knownTokens : null,
      knownCost,
      cost: costComplete ? knownCost : null,
    },
  };
}
