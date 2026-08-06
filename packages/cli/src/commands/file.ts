import type { Command } from "commander";
import type { AgentKind } from "@agent-bridge/memory";
import { getActiveTaskId, openStore } from "../workspace.js";

export function registerFile(program: Command): void {
  const file = program.command("file").description("Manage per-task file leases");

  file
    .command("lease")
    .description("Acquire a read/write lease for a repository file")
    .argument("<path>", "repository-relative file path")
    .option("--task <taskId>", "task id (defaults to the active task)")
    .option("--mode <mode>", "read | write", "write")
    .option("--agent <agent>", "agent source", "codex")
    .option("--session <sessionId>", "session id")
    .option("--ttl <seconds>", "lease duration in seconds", "3600")
    .action((path: string, options: { task?: string; mode: string; agent: AgentKind; session?: string; ttl: string }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
        const result = store.acquireFileLease({
          taskId,
          path: path.replace(/\\/g, "/"),
          mode: parseLeaseMode(options.mode),
          agent: options.agent,
          sessionId: options.session,
          ttlSeconds: Number(options.ttl) || 3600
        });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
    });

  file
    .command("release")
    .description("Release a file lease")
    .argument("<leaseId>", "lease id")
    .action((leaseId: string) => {
      const store = openStore();
      try {
        const lease = store.releaseFileLease(leaseId);
        if (!lease) throw new Error(`Lease not found: ${leaseId}`);
        console.log(JSON.stringify(lease, null, 2));
      } finally {
        store.close();
      }
    });

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
