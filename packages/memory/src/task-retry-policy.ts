import type { TaskAttempt, TaskRetryKind, TaskRetryPolicy } from "./types.js";

const limits = {
  small: [3, 20000, 15], debug: [4, 50000, 30], multi: [6, 100000, 60], handoff: [3, 30000, 20],
} as const;

export function taskRetryPolicy(kind: TaskRetryKind): TaskRetryPolicy {
  if (!Object.hasOwn(limits, kind)) throw new Error("Unknown task retry kind");
  const [maxAttempts, maxTokens, minutes] = limits[kind];
  return { kind, maxAttempts, maxRepeatedFailures: 2, maxTokens, maxElapsedMs: minutes * 60000 };
}

export function taskRetryLimit(policy: TaskRetryPolicy, attempts: TaskAttempt[], timestamp = Date.now()): string | undefined {
  if (attempts.length >= policy.maxAttempts) return "Attempt limit reached";
  if (attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0) >= policy.maxTokens) return "Token limit reached";
  if (attempts.length && timestamp - Date.parse(attempts[0].startedAt) >= policy.maxElapsedMs) return "Elapsed time limit reached";
  const last = attempts.at(-1);
  if (last?.outcome === "blocked") return "Attempt reported a blocker";
  if (last?.outcome === "failed") {
    let repeated = 0;
    for (let index = attempts.length - 1; index >= 0; index--) {
      if (attempts[index].operation !== last.operation || attempts[index].outcome !== "failed") break;
      repeated++;
    }
    if (repeated >= policy.maxRepeatedFailures) return "Repeated failure limit reached";
  }
  return undefined;
}
