import type Database from "better-sqlite3";
import { posix } from "node:path";
import type { SQLiteMemoryStore } from "./sqlite-store.js";
import type { AgentKind, EndTaskAttemptInput } from "./types.js";

export type ManagedDispatchPolicy = {
  maxConcurrency: number;
  tokenBudget: number;
  overheadTokens: { leader: number | null; reviewer: number | null; handoff: number | null };
  parallelEvidence?: string;
  actualOverheadTokens?: { leader: number | null; reviewer: number | null; handoff: number | null };
};
export type ManagedDispatchInput = {
  parentTaskId: string;
  taskId: string;
  agentId: string;
  agent: AgentKind;
  sessionId: string;
  requestId: string;
  reservedTokens: number;
  operation: string;
  hypothesis: string;
};
export type ManagedDispatch = ManagedDispatchInput & {
  runId: string;
  attemptId: string;
  leaseIds: string[];
  endedAt?: string;
  tokens: number | null;
  outcome?: "progressed" | "failed" | "blocked";
};

function scopePath(value: string): string {
  const path = posix.normalize(value.replace(/\\/g, "/")).replace(/\/$/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../") || path.startsWith("/") || /[:*?\[\]\0]/.test(path))
    throw new Error("Dispatch scope requires explicit repository-relative paths");
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class ManagedDispatchRepository {
  constructor(private db: Database.Database, private store: SQLiteMemoryStore) {}

  private owner(parentTaskId: string, agent: AgentKind, sessionId: string): void {
    const claim = this.store.getTaskOwnerClaim(parentTaskId);
    if (!claim || claim.agent !== agent || claim.sessionId !== sessionId) throw new Error("Parent claim owner/session mismatch");
  }

  configure(parentTaskId: string, policy: ManagedDispatchPolicy, agent: AgentKind, sessionId: string): ManagedDispatchPolicy {
    return this.db.transaction(() => {
      this.owner(parentTaskId, agent, sessionId);
      if (policy.actualOverheadTokens !== undefined) throw new Error("Record actual overhead separately");
      if (!Number.isSafeInteger(policy.maxConcurrency) || policy.maxConcurrency < 1 ||
          !Number.isSafeInteger(policy.tokenBudget) || policy.tokenBudget < 1 || !policy.overheadTokens ||
          [policy.overheadTokens.leader, policy.overheadTokens.reviewer, policy.overheadTokens.handoff].some(value =>
            value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("Invalid dispatch limits");
      if (policy.maxConcurrency > 1 && !policy.parallelEvidence?.trim()) throw new Error("Parallel dispatch requires measured benefit evidence");
      if (this.list(parentTaskId).length) throw new Error("Dispatch policy is immutable after first reservation");
      this.db.prepare("INSERT INTO managed_dispatch_policies(parent_task_id,payload) VALUES (?,?) ON CONFLICT(parent_task_id) DO UPDATE SET payload=excluded.payload")
        .run(parentTaskId, JSON.stringify(policy));
      return policy;
    }).immediate();
  }

  policy(parentTaskId: string): ManagedDispatchPolicy | undefined {
    const row = this.db.prepare("SELECT payload FROM managed_dispatch_policies WHERE parent_task_id = ?").get(parentTaskId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ManagedDispatchPolicy : undefined;
  }

  list(parentTaskId: string): ManagedDispatch[] {
    return (this.db.prepare("SELECT payload FROM managed_dispatches WHERE parent_task_id = ? ORDER BY rowid").all(parentTaskId) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as ManagedDispatch);
  }

  reserve(input: ManagedDispatchInput, leaderAgent: AgentKind, leaderSession: string): ManagedDispatch {
    return this.db.transaction(() => {
      this.owner(input.parentTaskId, leaderAgent, leaderSession);
      const existing = this.db.prepare("SELECT payload FROM managed_dispatches WHERE request_id = ?").get(input.requestId) as { payload: string } | undefined;
      if (existing) {
        const dispatch = JSON.parse(existing.payload) as ManagedDispatch;
        for (const key of Object.keys(input) as (keyof ManagedDispatchInput)[])
          if (input[key] !== dispatch[key]) throw new Error("Dispatch request id already bound to another invocation");
        return dispatch;
      }
      if (!input.requestId?.trim() || !input.sessionId?.trim() || !Number.isSafeInteger(input.reservedTokens) || input.reservedTokens <= 0)
        throw new Error("Dispatch requires request, session and positive token reservation");
      if (!["todo", "in_progress"].includes(this.store.getTask(input.parentTaskId)?.status ?? ""))
        throw new Error("Dispatch parent must be open");
      const plan = this.store.getTaskDecomposition(input.parentTaskId);
      if (!plan || plan.parentVersion !== this.store.getTaskContract(input.parentTaskId)?.version ||
          !plan.children.some(child => child.taskId === input.taskId)) throw new Error("Dispatch requires current decomposition membership");
      const policy = this.policy(input.parentTaskId);
      if (!policy) throw new Error("Configure dispatch policy first");
      if (policy.actualOverheadTokens) throw new Error("Coordination usage is finalized; no further dispatch allowed");
      const overhead = [policy.overheadTokens.leader, policy.overheadTokens.reviewer, policy.overheadTokens.handoff];
      if (overhead.some(value => value === null)) throw new Error("Dispatch overhead usage is unknown; reserve an explicit bound");
      const records = this.list(input.parentTaskId);
      if (records.filter(run => !run.endedAt).length >= policy.maxConcurrency) throw new Error("Dispatch concurrency limit reached");
      const charged = records.reduce((sum, run) => sum + (run.endedAt ? run.tokens ?? run.reservedTokens : run.reservedTokens), 0);
      if (charged + overhead.reduce<number>((sum, value) => sum + (value ?? 0), 0) + input.reservedTokens > policy.tokenBudget)
        throw new Error("Dispatch token budget exceeded");
      this.store.assertManagedTaskDependencies(input.taskId);
      const contract = this.store.getTaskContract(input.taskId)!;
      const scope = contract.scope.map(scopePath);
      const active = this.db.prepare("SELECT task_id FROM task_owner_claims WHERE task_id != ? AND task_id != ?")
        .all(input.taskId, input.parentTaskId) as { task_id: string }[];
      for (const task of active) {
        if (!["in_progress", "review"].includes(this.store.getTask(task.task_id)?.status ?? "")) continue;
        const other = this.store.getTaskContract(task.task_id)!.scope.map(scopePath);
        if (scope.some(path => other.some(other => overlaps(path, other)))) throw new Error("Dispatch scope conflicts with active task");
      }
      const live = this.db.prepare("SELECT id FROM agent_runs WHERE (task_id = ? OR session_id = ?) AND status NOT IN ('done','failed','stopped')")
        .get(input.taskId, input.sessionId);
      if (live) throw new Error("Task/session already has an active run");
      const registered = this.store.getRegisteredAgent(input.agentId);
      if (!registered?.enabled || registered.provider !== input.agent) throw new Error("Dispatch agent/provider mismatch or disabled");
      this.store.claimTask(input.taskId, input.agent, input.sessionId);
      const leases = this.store.acquireFileLeases(scope.map(path => ({ taskId: input.taskId, agent: input.agent, sessionId: input.sessionId, path, mode: "write" })));
      if (!leases.acquired) throw new Error("Dispatch lease conflict");
      this.store.transitionManagedTask(input.taskId, "in_progress", input.agent, input.sessionId);
      const attempt = this.store.beginTaskAttempt(input.taskId, input.operation, input.hypothesis, input.agent, input.sessionId);
      const run = this.store.createAgentRun({ taskId: input.taskId, agentId: input.agentId, sessionId: input.sessionId,
        provider: registered.provider, model: registered.model, status: "starting", phase: "implement", origin: "manual" });
      const dispatch: ManagedDispatch = { ...input, runId: run.id, attemptId: attempt.id,
        leaseIds: leases.leases!.map(lease => lease.id), tokens: null };
      this.db.prepare("INSERT INTO managed_dispatches(request_id,parent_task_id,task_id,run_id,payload) VALUES (?,?,?,?,?)")
        .run(input.requestId, input.parentTaskId, input.taskId, run.id, JSON.stringify(dispatch));
      return dispatch;
    }).immediate();
  }
  claimLaunch(runId: string, taskId: string, agentId: string, sessionId: string, provider: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM managed_dispatches WHERE run_id = ?").get(runId) as { payload: string } | undefined;
      const dispatch = row ? JSON.parse(row.payload) as ManagedDispatch : undefined;
      const run = this.store.getAgentRun(runId);
      if (!dispatch || dispatch.endedAt || dispatch.taskId !== taskId || dispatch.agentId !== agentId ||
          dispatch.sessionId !== sessionId || dispatch.agent !== provider || run?.status !== "starting" || run.pid)
        throw new Error("Reserved run is not eligible for launch");
      const plan = this.store.getTaskDecomposition(dispatch.parentTaskId);
      if (!plan || plan.parentVersion !== this.store.getTaskContract(dispatch.parentTaskId)?.version ||
          !plan.children.some(child => child.taskId === taskId)) throw new Error("Reserved decomposition changed; reassess before launch");
      const contract = this.store.getTaskContract(taskId)!;
      const owned = this.db.prepare("SELECT path FROM file_leases WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(dispatch.leaseIds)) as { path: string }[];
      if (owned.length !== contract.scope.length || contract.scope.map(scopePath).some(path => !owned.some(lease => lease.path === path)))
        throw new Error("Reserved scope changed; reassess before launch");
      const claim = this.store.getTaskOwnerClaim(taskId);
      if (claim?.sessionId !== sessionId || claim.agent !== dispatch.agent || this.store.getTask(taskId)?.status !== "in_progress")
        throw new Error("Reserved task owner/status changed");
      this.store.assertManagedTaskDependencies(taskId);
      for (const id of dispatch.leaseIds) {
        const lease = this.db.prepare("SELECT id FROM file_leases WHERE id = ? AND task_id = ? AND session_id = ? AND agent = ? AND released_at IS NULL AND expires_at > ?")
          .get(id, taskId, sessionId, dispatch.agent, new Date().toISOString());
        if (!lease) throw new Error("Reserved run no longer owns its leases");
      }
      return this.store.updateAgentRun(runId, { status: "running", origin: "spawned", startedAt: new Date().toISOString() })!;
    }).immediate();
  }

  settle(requestId: string, input: EndTaskAttemptInput & { repositoryRoot: string }, agent: AgentKind, sessionId: string): ManagedDispatch {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM managed_dispatches WHERE request_id = ?").get(requestId) as { payload: string } | undefined;
      if (!row) throw new Error("Dispatch not found");
      const dispatch = JSON.parse(row.payload) as ManagedDispatch;
      if (dispatch.agent !== agent || dispatch.sessionId !== sessionId) throw new Error("Dispatch owner/session mismatch");
      if (dispatch.endedAt) {
        if (dispatch.tokens !== input.tokens || dispatch.outcome !== input.outcome) throw new Error("Dispatch already settled with a different result");
        return dispatch;
      }
      const run = this.store.getAgentRun(dispatch.runId)!;
      if (!["done", "failed", "stopped"].includes(run.status)) throw new Error("Stop provider run before settlement");
      const checkpoint = this.store.listCheckpoints(dispatch.taskId, 1)[0];
      if (input.outcome === "progressed" && (run.status !== "done" || run.exitCode !== 0 ||
          checkpoint?.tests.status !== "passed" || checkpoint.tests.exitCode !== 0))
        throw new Error("Progress requires passing evidence and a successful run");
      if (run.status !== "done" && input.decision === "continue") throw new Error("Failed/stopped run requires recovery decision");
      this.store.recoverSessionFileLeases({ taskId: dispatch.taskId, agent, sessionId,
        checkpointId: input.checkpointId, repositoryRoot: input.repositoryRoot, reason: input.reason });
      this.store.endTaskAttempt(dispatch.taskId, dispatch.attemptId, input, agent, sessionId);
      if (input.outcome !== "progressed" && this.store.getTask(dispatch.taskId)?.status === "in_progress")
        this.store.transitionManagedTask(dispatch.taskId, "blocked", agent, sessionId, input.reason);
      dispatch.endedAt = new Date().toISOString();
      dispatch.tokens = input.tokens;
      dispatch.outcome = input.outcome;
      this.db.prepare("UPDATE managed_dispatches SET payload = ? WHERE request_id = ?").run(JSON.stringify(dispatch), requestId);
      return dispatch;
    }).immediate();
  }

  recordOverhead(parentTaskId: string, usage: NonNullable<ManagedDispatchPolicy["actualOverheadTokens"]>, agent: AgentKind, sessionId: string): void {
    this.db.transaction(() => {
      this.owner(parentTaskId, agent, sessionId);
      const policy = this.policy(parentTaskId);
      if (!policy || !usage || [usage.leader, usage.reviewer, usage.handoff].some(value =>
          value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("Invalid overhead usage");
      if (this.list(parentTaskId).some(run => !run.endedAt)) throw new Error("Settle all runs before final overhead accounting");
      if (policy.actualOverheadTokens) throw new Error("Overhead usage already recorded; include all coordination attempts");
      policy.actualOverheadTokens = usage;
      this.db.prepare("UPDATE managed_dispatch_policies SET payload = ? WHERE parent_task_id = ?").run(JSON.stringify(policy), parentTaskId);
    }).immediate();
  }

  report(parentTaskId: string) {
    const policy = this.policy(parentTaskId);
    const runs = this.list(parentTaskId);
    const overhead = policy?.actualOverheadTokens;
    const knownTokens = runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) +
      (overhead ? Object.values(overhead).reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0);
    const complete = Boolean(overhead && Object.values(overhead).every(value => value !== null) &&
      runs.every(run => run.endedAt && run.tokens !== null));
    return { policy, runs, knownTokens, totalTokens: complete ? knownTokens : null, monetaryCost: null,
      reservedTokens: runs.reduce((sum, run) => sum + (run.tokens ?? run.reservedTokens), 0) +
        (policy ? Object.values(policy.overheadTokens).reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0) };
  }

}
