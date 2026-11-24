import type {
  MemoryStore,
  Orchestration,
  RegisteredAgent,
} from "@agent-bridge/memory";

import { resolveLeaderAgent } from "./agent-selector.js";

import { type LeaderAgentPreference } from "./leader-contract.js";

import {
  type ChangeLeaderResult,
  type SpawnApprovalPayload,
  type SpawnApprovalResponse,
  type SpawnGate,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";
type Dependencies = {
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  safeParse: import("./orchestrator-reporting.js").ReportingFunctions["safeParse"];
  noop: import("./orchestrator-reporting.js").ReportingFunctions["noop"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
};
export type ApprovalsFunctions = ReturnType<typeof createApprovals>;
export function createApprovals(operations: Dependencies) {
  // Moves a running orchestration onto another leader. The only supported repair
  // for a run whose leader row was deleted or misconfigured — before this, the
  // leader was fixed at creation and every step of such a run died with
  // "Registered agent not found".
  //
  // It always resolves a dedicated lead-only row (find-or-create), never a staff
  // agent: leader rows are plumbing and are deliberately kept out of the Agents
  // tab, so promoting an agent the user hired there would put the same trap back.
  function changeOrchestrationLeader(
    store: MemoryStore,
    orchestrationId: string,
    preference: LeaderAgentPreference,
    defaults: { command?: string } = {},
  ): ChangeLeaderResult {
    const orchestration = store.getOrchestration(orchestrationId);
    if (!orchestration)
      throw new Error(`Orchestration not found: ${orchestrationId}`);
    const previousLeaderId = orchestration.leaderAgentId;
    const leader = resolveLeaderAgent(store, preference, defaults);
    if (leader.id === previousLeaderId) {
      return { orchestration, leader, previousLeaderId, changed: false };
    }
    // The stored error is almost always the unresolvable leader itself; leaving
    // it would keep the board red after the run is healthy again.
    const updated = store.updateOrchestration(orchestrationId, {
      leaderAgentId: leader.id,
      lastError: null,
    });
    if (!updated)
      throw new Error(`Orchestration not found: ${orchestrationId}`);
    const previous = store.getRegisteredAgent(previousLeaderId);
    operations.recordEvent(
      store,
      updated,
      "plan",
      "user_action",
      `Leader changed from ${previous ? operations.describeAgent(previous) : previousLeaderId} to ${operations.describeAgent(leader)}.`,
    );
    return { orchestration: updated, leader, previousLeaderId, changed: true };
  }

  // Every note the user typed when approving a spawn, oldest first. A note is an
  // instruction attached to a yes ("go ahead, but stop after this one"), and
  // nothing read them: only `agentId` was ever pulled out of the response, so the
  // text was accepted, stored, and silently dropped. They are standing user
  // directives, so they are carried into the leader turns the same way answers
  // are, not just into the one turn the approval unblocked.
  function allApprovalNotes(
    store: MemoryStore,
    orchestration: Orchestration,
  ): Array<{ approved: string; note: string }> | undefined {
    const notes: Array<{ approved: string; note: string }> = [];
    for (const request of store.listAgentRequests({
      taskId: orchestration.taskId,
      limit: 500,
    })) {
      if (
        request.type !== "approval" ||
        request.status !== "accepted" ||
        !request.response
      )
        continue;
      const payload = operations.safeParse<SpawnApprovalPayload>(
        request.payload ?? "",
      );
      if (
        payload?.type !== "spawn-approval" ||
        payload.orchestrationId !== orchestration.id
      )
        continue;
      const parsed = operations.safeParse<SpawnApprovalResponse>(
        request.response,
      );
      const note =
        parsed?.type === "spawn-approval-response"
          ? parsed.note
          : request.response;
      if (note?.trim())
        notes.push({ approved: request.title, note: note.trim() });
    }
    if (!notes.length) return undefined;
    return notes.reverse();
  }

  function approvalFor(
    store: MemoryStore,
    orchestration: Orchestration,
    key: string,
  ):
    | { id: string; status: string; createdAt: string; response?: string }
    | undefined {
    for (const request of store.listAgentRequests({
      taskId: orchestration.taskId,
      limit: 500,
    })) {
      if (request.type !== "approval" || !request.payload) continue;
      const parsed = operations.safeParse<SpawnApprovalPayload>(
        request.payload,
      );
      if (
        parsed?.type === "spawn-approval" &&
        parsed.key === key &&
        parsed.orchestrationId === orchestration.id
      ) {
        return {
          id: request.id,
          status: request.status,
          createdAt: request.createdAt,
          response: request.response,
        };
      }
    }
    return undefined;
  }

  // The agent the user picked when they approved this key, if they overrode the
  // orchestrator's choice. Read at spawn time, so the swap survives a restart
  // and applies to the retry of a step just as much as to the first attempt.
  function approvedAgentOverride(
    store: MemoryStore,
    orchestration: Orchestration,
    key: string,
  ): string | undefined {
    const existing = approvalFor(store, orchestration, key);
    if (existing?.status !== "accepted" || !existing.response) return undefined;
    const parsed = operations.safeParse<SpawnApprovalResponse>(
      existing.response,
    );
    return parsed?.type === "spawn-approval-response"
      ? parsed.agentId
      : undefined;
  }

  // The agent the user named when approving this key, resolved to a row. Returns
  // undefined when they simply approved, when the row is gone, or when there is
  // no gate at all.
  function agentForKey(
    store: MemoryStore,
    orchestration: Orchestration,
    key: string,
  ): RegisteredAgent | undefined {
    const chosen = approvedAgentOverride(store, orchestration, key);
    return chosen ? store.getRegisteredAgent(chosen) : undefined;
  }

  function gateSpawnDetailed(
    store: MemoryStore,
    orchestration: Orchestration,
    key: string,
    description: string,
    agentId?: string,
    // What a "no" means here. "pause" is the safe default for turns nothing can
    // proceed without; "skip" is for work that is one item among many.
    onReject: "pause" | "skip" = "pause",
  ): SpawnGate {
    if (orchestration.autonomy !== "approve-each") return { decision: "go" };

    const existing = approvalFor(store, orchestration, key);
    if (existing?.status === "accepted") return { decision: "go" };
    if (existing?.status === "pending") {
      return {
        decision: "wait",
        since: existing.createdAt,
        result: {
          ...operations.noop(
            orchestration,
            `Waiting for your approval: ${description}`,
          ),
          awaitingApprovalSince: existing.createdAt,
        },
      };
    }
    if (existing?.status === "rejected") {
      if (onReject === "skip") return { decision: "rejected" };
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError: `You rejected: ${description}`,
        }) ?? orchestration;
      return {
        decision: "halt",
        result: operations.result(
          updated,
          `Rejected: ${description}. Paused.`,
          [],
        ),
      };
    }

    const request = store.createAgentRequest({
      taskId: orchestration.taskId,
      type: "approval",
      title: description,
      payload: JSON.stringify({
        type: "spawn-approval",
        key,
        orchestrationId: orchestration.id,
        agentId,
      } satisfies SpawnApprovalPayload),
    });
    operations.recordEvent(
      store,
      orchestration,
      "plan",
      "user_action",
      `Approval requested: ${description}`,
    );
    return {
      decision: "wait",
      since: request.createdAt,
      result: {
        ...operations.noop(orchestration, `Approval requested: ${description}`),
        awaitingApprovalSince: request.createdAt,
      },
    };
  }

  // Returns a step result when the caller must NOT spawn (approval missing,
  // still pending, or refused); undefined means "go ahead".
  function gateSpawn(
    store: MemoryStore,
    orchestration: Orchestration,
    key: string,
    description: string,
    agentId?: string,
  ): OrchestrationStepResult | undefined {
    const gate = gateSpawnDetailed(
      store,
      orchestration,
      key,
      description,
      agentId,
    );
    // "rejected" never comes back here: this wrapper is only used by the gates
    // that pause on a no.
    return gate.decision === "go" || gate.decision === "rejected"
      ? undefined
      : gate.result;
  }
  return {
    changeOrchestrationLeader,
    allApprovalNotes,
    approvalFor,
    approvedAgentOverride,
    agentForKey,
    gateSpawnDetailed,
    gateSpawn,
  };
}
