import type {
  AgentRun,
  MemoryStore,
  Orchestration,
} from "@agent-bridge/memory";

import {
  type SubtaskPlanMeta,
  type ReviewerPlanMeta,
} from "./orchestrator-contracts.js";

import {
  META_SCAN_LIMIT,
  SUBTASK_META_PREFIX,
  REVIEWER_META_PREFIX,
} from "./orchestrator-constants.js";
type Dependencies = {
  safeParse: import("./orchestrator-reporting.js").ReportingFunctions["safeParse"];
};
export type MetadataFunctions = ReturnType<typeof createMetadata>;
export function createMetadata(operations: Dependencies) {
  function recordSubtaskMeta(
    store: MemoryStore,
    orchestration: Orchestration,
    meta: SubtaskPlanMeta,
  ): void {
    store.recordOrchestrationEvent({
      orchestrationId: orchestration.id,
      cycle: orchestration.cycle,
      phase: "plan",
      kind: "leader_turn",
      summary: `subtask-meta:${meta.key}`,
      payload: JSON.stringify(meta),
    });
  }

  function recordReviewerMeta(
    store: MemoryStore,
    orchestration: Orchestration,
    meta: ReviewerPlanMeta,
  ): void {
    store.recordOrchestrationEvent({
      orchestrationId: orchestration.id,
      cycle: orchestration.cycle,
      phase: "plan",
      kind: "leader_turn",
      summary: `reviewer-meta:${meta.reviewerKey}`,
      payload: JSON.stringify(meta),
    });
  }

  function listPlanMetaEvents(
    store: MemoryStore,
    orchestrationId: string,
    prefix: string,
  ): import("@agent-bridge/memory").OrchestrationEvent[] {
    return store.listOrchestrationEvents({
      orchestrationId,
      kind: "leader_turn",
      summaryPrefix: prefix,
      limit: META_SCAN_LIMIT,
    });
  }

  function getSubtaskMeta(
    store: MemoryStore,
    orchestrationId: string,
    subtaskId: string,
  ): SubtaskPlanMeta | undefined {
    for (const event of listPlanMetaEvents(
      store,
      orchestrationId,
      SUBTASK_META_PREFIX,
    )) {
      if (!event.payload) continue;
      const parsed = operations.safeParse<SubtaskPlanMeta>(event.payload);
      if (parsed?.type === "subtask" && parsed.subtaskId === subtaskId)
        return parsed;
    }
    return undefined;
  }

  function findSubtaskMetaByKey(
    store: MemoryStore,
    orchestrationId: string,
    key: string,
  ): SubtaskPlanMeta | undefined {
    for (const event of listPlanMetaEvents(
      store,
      orchestrationId,
      SUBTASK_META_PREFIX,
    )) {
      if (!event.payload) continue;
      const parsed = operations.safeParse<SubtaskPlanMeta>(event.payload);
      if (parsed?.type === "subtask" && parsed.key === key) return parsed;
    }
    return undefined;
  }

  function findSubtaskKey(
    store: MemoryStore,
    orchestrationId: string,
    subtaskId: string | undefined,
  ): string | undefined {
    if (!subtaskId) return undefined;
    return getSubtaskMeta(store, orchestrationId, subtaskId)?.key;
  }

  function listReviewerMetas(
    store: MemoryStore,
    orchestrationId: string,
  ): ReviewerPlanMeta[] {
    const seen = new Set<string>();
    const metas: ReviewerPlanMeta[] = [];
    for (const event of listPlanMetaEvents(
      store,
      orchestrationId,
      REVIEWER_META_PREFIX,
    )) {
      if (!event.payload) continue;
      const parsed = operations.safeParse<ReviewerPlanMeta>(event.payload);
      if (parsed?.type === "reviewer" && !seen.has(parsed.reviewerKey)) {
        seen.add(parsed.reviewerKey);
        metas.push(parsed);
      }
    }
    return metas;
  }

  function findReviewerMetaForRun(
    store: MemoryStore,
    orchestrationId: string,
    run: AgentRun,
    metas: ReviewerPlanMeta[],
  ): ReviewerPlanMeta | undefined {
    const events = store.listOrchestrationEvents({
      orchestrationId,
      kind: "spawn",
      limit: META_SCAN_LIMIT,
    });
    const keyForRun = (runId: string): string | undefined =>
      events
        .find(
          (event) =>
            event.kind === "spawn" &&
            event.phase === "review" &&
            event.summary?.includes(`(${runId})`),
        )
        ?.summary?.match(/Spawned reviewer (\S+) for/)?.[1];

    let key = keyForRun(run.id);
    // A retry turn has no reviewer spawn event of its own, so it used to resolve
    // to no reviewer at all: it never counted as an active reviewer, and the same
    // step that started it also started a duplicate reviewer for the very same
    // scope. It does inherit the assignment of the run it replaces, which does
    // have the event.
    if (!key && run.assignmentId) {
      for (const sibling of store.listAgentRuns({
        orchestrationId,
        limit: 500,
      })) {
        if (sibling.id === run.id || sibling.assignmentId !== run.assignmentId)
          continue;
        key = keyForRun(sibling.id);
        if (key) break;
      }
    }
    return key ? metas.find((meta) => meta.reviewerKey === key) : undefined;
  }
  return {
    recordSubtaskMeta,
    recordReviewerMeta,
    listPlanMetaEvents,
    getSubtaskMeta,
    findSubtaskMetaByKey,
    findSubtaskKey,
    listReviewerMetas,
    findReviewerMetaForRun,
  };
}
