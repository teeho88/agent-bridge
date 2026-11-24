import type { AddMemoryInput, Memory } from "./types.js";

export function validateReusableMemory(input: AddMemoryInput): void {
  const evidence = input.evidence;
  if (!evidence?.reuse) return;
  const reuse = evidence.reuse;
  if (input.taskId || !["note", "constraint", "decision"].includes(input.type)) {
    throw new Error("Reusable knowledge must be a repository note, constraint or decision; task history is separate");
  }
  if (!evidence.source.trim() || !Number.isFinite(Date.parse(evidence.observedAt)) ||
    !reuse.key.trim() || !reuse.revision.trim() || !reuse.invalidation.trim() ||
    !Number.isFinite(Date.parse(reuse.expiresAt)) || Date.parse(reuse.expiresAt) <= Date.now() ||
    Date.parse(reuse.expiresAt) <= Date.parse(evidence.observedAt) || !reuse.scope.length ||
    reuse.scope.some((path) => !path.trim() || path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some((part) => [".", "..", ""].includes(part)))) {
    throw new Error("Reusable memory requires source, observation, revision, relative scope, future expiry and invalidation rule");
  }
  const serialized = JSON.stringify(input);
  if (input.tags?.some((tag) => ["secret", "private", "prompt", "latest-response", "checkpoint"].includes(tag.toLowerCase())) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{6,}|\bsk-[A-Za-z0-9_-]{16,}/i.test(serialized)) {
    throw new Error("Remove sensitive information before saving reusable memory");
  }
}

export function reusableMemoryIsCurrent(memory: Memory, context?: {
  scope: string[]; revision: string; timestamp?: number;
}): boolean {
  const reuse = memory.evidence?.reuse;
  if (!reuse) return true;
  if (!context || memory.stale || memory.supersededBy || reuse.revision !== context.revision ||
    !Number.isFinite(Date.parse(reuse.expiresAt)) || Date.parse(reuse.expiresAt) <= (context.timestamp ?? Date.now())) return false;
  return context.scope.some((path) => reuse.scope.some((scope) => path === scope || path.startsWith(`${scope}/`)));
}
