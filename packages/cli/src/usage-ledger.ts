import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { aggregateWorkflowUsage, normalizeProviderUsage, taskTelemetry, type TelemetryRun, type ProviderUsage } from "@agent-bridge/core";

export function startUsageAttempt(cwd: string, taskId: string, provider: string, binding: { sessionId?: string; model?: string; revision?: number; attemptId?: string } = {}) {
  const directory = join(cwd, ".agent-memory", "usage");
  mkdirSync(directory, { recursive: true });
  const attemptId = randomUUID();
  const path = join(directory, `${attemptId}.usage.json`);
  const startedAt = new Date().toISOString();
  const write = (status: string, usage: ProviderUsage, rawUsage?: unknown[]) => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, runId: attemptId, attemptId: binding.attemptId ?? null,
      sessionId: binding.sessionId ?? null, model: binding.model ?? null, revision: binding.revision ?? null,
      taskId, provider, status, usage, rawUsage, semantics: "unknown", startedAt,
      endedAt: status === "running" ? undefined : new Date().toISOString(),
      completeness: rawUsage?.length ? "terminal-summary" : "unknown", laterToolReads: "unknown" }), { flush: true });
    renameSync(temporary, path);
  };
  write("running", normalizeProviderUsage(undefined));
  return { finish(status: string, usage = normalizeProviderUsage(undefined), rawUsage?: unknown[]) { write(status, usage, rawUsage); } };
}

export function workflowUsage(cwd: string, taskId?: string) {
  const attempts: Array<{ status: string; usage: ProviderUsage; completeness?: string }> = [];
  let unreadable = 0;
  const runs: TelemetryRun[] = [];
  for (const directory of [join(cwd, ".agent-memory", "usage"), join(cwd, ".agent-memory", "runs")]) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".usage.json")) continue;
      try {
        const item = JSON.parse(readFileSync(join(directory, file), "utf8"));
        if (taskId && item.taskId !== taskId) continue;
        const usage = item.usage && "input" in item.usage ? item.usage : normalizeProviderUsage(undefined);
        attempts.push({ status: item.status, usage, completeness: item.completeness });
        runs.push({ ...item, usage, runId: item.runId ?? null, attemptId: item.attemptId ?? null,
          sessionId: item.sessionId ?? null, model: item.model ?? null, revision: item.revision ?? null });
      } catch { unreadable++; }
    }
  }
  const telemetry = taskTelemetry(runs);
  if (unreadable) {
    for (const key of Object.keys(telemetry.tokens)) telemetry.tokens[key] = null;
    telemetry.runDurationMs = null;
    telemetry.toolCalls = null;
  }
  return { ...aggregateWorkflowUsage(attempts), telemetry, unreadable };
}
