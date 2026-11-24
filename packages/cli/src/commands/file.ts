import { isAbsolute, posix } from "node:path";
import type { Command } from "commander";
import type { AgentKind } from "@agent-bridge/memory";
import { getActiveTaskId, openStore, readConfig } from "../workspace.js";

export function registerFile(program: Command): void {
  const file = program.command("file").description("Manage per-task file leases");

  file.command("recover").requiredOption("--task <taskId>").requiredOption("--session <sessionId>")
    .requiredOption("--checkpoint <checkpointId>").requiredOption("--reason <reason>")
    .option("--agent <agent>", "lease owner", "codex")
    .action((options: { task: string; session: string; checkpoint: string; reason: string; agent: AgentKind }) => {
      const store = openStore();
      try { console.log(JSON.stringify(store.recoverSessionFileLeases({ taskId: options.task, sessionId: options.session,
        checkpointId: options.checkpoint, reason: options.reason, agent: options.agent, repositoryRoot: process.cwd() }), null, 2)); }
      finally { store.close(); }
    });
  file
    .command("lease")
    .description("Acquire a read/write lease for a repository file")
    .argument("<path>", "repository-relative file path")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--mode <mode>", "read | write", "write")
    .option("--agent <agent>", "agent source", "codex")
    .option("--session <sessionId>", "session id")
    .option("--ttl <seconds>", "lease duration in seconds", "3600")
    .option("--compact", "return minimal JSON")
    .action((path: string, options: { task?: string; mode: string; agent: AgentKind; session?: string; ttl: string; compact?: boolean }) => {
      const store = openStore();
      try {
        const caller = leaseCaller(options);
        const taskId = caller.taskId ?? getActiveTaskId(store, undefined, undefined, options.agent);
        const result = store.acquireFileLease({
          taskId,
          path: normalizeLeasePath(path),
          mode: parseLeaseMode(options.mode),
          agent: options.agent,
          sessionId: caller.sessionId,
          ttlSeconds: Number(options.ttl) || 3600
        });
        console.log(JSON.stringify(options.compact && result.acquired ? { acquired: true, lease: { id: result.lease?.id, path: result.lease?.path } } : result, null, options.compact ? undefined : 2));
      } finally {
        store.close();
      }
    });

  file.command("lease-batch").argument("<paths...>")
    .option("--task <taskId>").option("--agent <agent>", "agent source", "codex")
    .option("--session <sessionId>").option("--mode <mode>", "read | write", "write")
    .option("--ttl <seconds>", "lease duration", "3600").option("--compact")
    .action((paths: string[], options: { task?: string; agent: AgentKind; session?: string; mode: string; ttl: string; compact?: boolean }) => {
      const normalized = [...new Set(paths.map(normalizeLeasePath))];
      const ttl = Number(options.ttl);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("TTL must be positive");
      const store = openStore();
      try {
        const caller = leaseCaller(options);
        const taskId = caller.taskId ?? getActiveTaskId(store, undefined, undefined, options.agent);
        const result = store.acquireFileLeases(normalized.map((path) => ({ taskId, path,
          agent: options.agent, sessionId: caller.sessionId, mode: parseLeaseMode(options.mode), ttlSeconds: ttl })));
        console.log(JSON.stringify(options.compact && result.acquired ? {
          acquired: true, leases: result.leases?.map(({ id, path }) => ({ id, path }))
        } : result, null, options.compact ? undefined : 2));
        if (!result.acquired) process.exitCode = 1;
      } finally { store.close(); }
    });

  for (const batch of [false, true]) {
    file.command(batch ? "release-batch" : "release").argument(batch ? "<leaseIds...>" : "<leaseId>")
      .option("--task <taskId>").option("--agent <agent>", "agent source", "codex")
      .option("--session <sessionId>").option("--compact")
      .action((ids: string | string[], options: { task?: string; agent: AgentKind; session?: string; compact?: boolean }) => {
        const store = openStore();
        try {
          const caller = leaseCaller(options);
          const taskId = caller.taskId ?? getActiveTaskId(store, undefined, undefined, options.agent);
          const leases = store.releaseFileLeases(Array.isArray(ids) ? ids : [ids], { taskId, agent: options.agent, sessionId: caller.sessionId });
          const result = options.compact ? { released: leases.map(({ id }) => id) } : batch ? leases : leases[0];
          console.log(JSON.stringify(result, null, options.compact ? undefined : 2));
        } finally { store.close(); }
      });
  }

  file
    .command("leases")
    .description("List file leases")
    .option("--task <taskId>", "task id")
    .option("--path <path>", "repository-relative file path")
    .option("--all", "include released and expired leases")
    .action((options: { task?: string; path?: string; all?: boolean }) => {
      const store = openStore();
      try {
        console.log(JSON.stringify(store.listFileLeases({
          taskId: options.task,
          path: options.path?.replace(/\\/g, "/"),
          activeOnly: !options.all,
          limit: 200
        }), null, 2));
      } finally {
        store.close();
      }
    });
}

function parseLeaseMode(value: string): "read" | "write" {
  if (value === "read" || value === "write") return value;
  throw new Error('Invalid lease mode. Use "read" or "write".');
}

export function normalizeLeasePath(value: string): string {
  const path = value.replace(/\\/g, "/");
  const normalized = posix.normalize(path);
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || normalized === ".." || normalized.startsWith("../") || normalized === ".")
    throw new Error(`Not a repository-relative file path: ${value}`);
  return normalized;
}

function leaseCaller(options: { task?: string; agent: AgentKind; session?: string }) {
  const config = readConfig();
  const sessionId = options.session ?? process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID ?? config.currentSessions?.[options.agent];
  const boundTask = sessionId ? config.sessionTasks?.[sessionId] : undefined;
  if (options.session && !boundTask) throw new Error("Unknown lease session");
  if (options.task && boundTask && options.task !== boundTask) throw new Error("Lease session/task mismatch");
  return { taskId: options.task ?? boundTask, sessionId: boundTask ? sessionId : undefined };
}
