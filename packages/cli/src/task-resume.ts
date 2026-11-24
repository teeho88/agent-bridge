import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { AgentKind, SQLiteMemoryStore } from "@agent-bridge/memory";
import { repositoryIdentity } from "./runtime-identity.js";
import { readConfig } from "./workspace.js";

export function readResumePacket(store: SQLiteMemoryStore, cwd: string,
  options: { task: string; session: string; agent: AgentKind; revision?: string }) {
  const task = store.getTask(options.task);
  if (!task) throw new Error("Task not found");
  if (!options.session.trim()) throw new Error("Session ID is required");
  const config = readConfig(cwd);
  const bound = config.sessionTasks?.[options.session];
  if (bound && bound !== task.id) throw new Error("Session/task mismatch");
  const identity = repositoryIdentity(cwd);
  if (task.repositoryId && (task.repositoryId !== identity.repositoryId || task.branch !== identity.branch))
    throw new Error("Task repository/branch mismatch");
  const checkpoint = store.listCheckpoints(task.id, 1)[0];
  if (!checkpoint) throw new Error("Checkpoint required before resume");
  if (options.revision !== undefined && (!/^\d+$/.test(options.revision) || Number(options.revision) !== checkpoint.revision))
    throw new Error("Checkpoint revision mismatch");
  const contract = store.getTaskContract(task.id);
  const decisions = store.listDecisions(task.id);
  const stateChanged = checkpoint.goal !== task.goal || checkpoint.contractVersion !== contract?.version ||
    JSON.stringify(checkpoint.decisions) !== JSON.stringify(decisions.map(({ id, decision, reason }) => ({ id, decision, reason })));
  const sources = checkpoint.files.map(file => {
    const path = resolve(cwd, file.path);
    const local = relative(cwd, path);
    if (local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local))
      throw new Error(`Checkpoint source outside workspace: ${file.path}`);
    const hash = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    return { ...file, currentHash: hash, verified: Boolean(file.hash && file.hash === hash) };
  });
  const claim = store.getTaskOwnerClaim(task.id);
  const ownerMatches = claim?.agent === options.agent && claim.sessionId === options.session;
  const leases = store.listFileLeases({ taskId: task.id, activeOnly: true, limit: 10000 });
  const foreignLeases = leases.filter(lease => lease.agent !== options.agent || lease.sessionId !== options.session);
  return { task, contract, checkpoint, decisions, claim, leases, sources, stateChanged,
    binding: { taskId: task.id, agent: options.agent, sessionId: options.session, revision: checkpoint.revision },
    readyToEdit: !stateChanged && sources.every(source => source.verified) && foreignLeases.length === 0 &&
      (!contract || ownerMatches) && !["done", "cancelled", "blocked"].includes(task.status),
    requiredActions: [
      ...(["done", "cancelled", "blocked"].includes(task.status) ? [`Resolve task status ${task.status} through its managed lifecycle before editing`] : []),
      ...(stateChanged ? ["Reconcile current goal, constraints and decisions; save a fresh checkpoint"] : []),
      ...(sources.some(source => !source.verified) ? ["Read changed or unverified sources and rerun affected checks"] : []),
      ...(contract && !ownerMatches ? ["Previous owner must release claim; receiver must claim this same task"] : []),
      ...(foreignLeases.length ? ["Previous owner must record edits and release its leases"] : []),
      "Acquire receiver write leases before editing; refresh session context with explicit task/session",
    ] };
}

