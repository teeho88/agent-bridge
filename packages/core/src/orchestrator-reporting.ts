import type {
  AgentRun,
  MemoryStore,
  Orchestration,
  Subtask,
} from "@agent-bridge/memory";

import { contextKeyFor, planOriginKey, roundFor } from "./context-store.js";

import {
  type RunPlanLabel,
  type SubtaskPlanMeta,
  type ReviewerPlanMeta,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";

import {
  SUBTASK_META_PREFIX,
  REVIEWER_META_PREFIX,
  META_SCAN_LIMIT,
} from "./orchestrator-constants.js";
type Dependencies = {
  listPlanMetaEvents: import("./orchestrator-metadata.js").MetadataFunctions["listPlanMetaEvents"];
};
export type ReportingFunctions = ReturnType<typeof createReporting>;
export function createReporting(operations: Dependencies) {
  /**
   * Maps runs to the plan entry they came from so a board card can say
   * "s1: Build the parser" instead of only naming the agent. Reads the plan meta
   * events once for the whole batch — this runs on every dashboard poll.
   */
  function describeRunPlanLabels(
    store: MemoryStore,
    orchestrationId: string,
    runs: AgentRun[],
    subtasks: Subtask[],
  ): Record<string, RunPlanLabel> {
    const labels: Record<string, RunPlanLabel> = {};
    if (!runs.length) return labels;
    const titleBySubtaskId = new Map(
      subtasks.map((subtask) => [subtask.id, subtask.title]),
    );

    // Events come newest first, so the first meta for a key is the current plan's.
    const metaBySubtaskId = new Map<string, SubtaskPlanMeta>();
    const scopeByReviewerKey = new Map<
      string,
      Array<{ key: string; subtaskId: string }>
    >();
    for (const event of operations.listPlanMetaEvents(
      store,
      orchestrationId,
      SUBTASK_META_PREFIX,
    )) {
      if (!event.payload) continue;
      const parsed = safeParse<SubtaskPlanMeta>(event.payload);
      if (
        parsed?.type === "subtask" &&
        !metaBySubtaskId.has(parsed.subtaskId)
      ) {
        metaBySubtaskId.set(parsed.subtaskId, parsed);
      }
    }
    for (const event of operations.listPlanMetaEvents(
      store,
      orchestrationId,
      REVIEWER_META_PREFIX,
    )) {
      if (!event.payload) continue;
      const parsed = safeParse<ReviewerPlanMeta>(event.payload);
      if (
        parsed?.type === "reviewer" &&
        !scopeByReviewerKey.has(parsed.reviewerKey)
      ) {
        scopeByReviewerKey.set(parsed.reviewerKey, parsed.scope);
      }
    }

    // A reviewer run carries no subtaskId; its key lives in the spawn event.
    const reviewerKeyByRunId = new Map<string, string>();
    for (const event of store.listOrchestrationEvents({
      orchestrationId,
      kind: "spawn",
      limit: META_SCAN_LIMIT,
    })) {
      if (event.phase !== "review" || !event.summary) continue;
      const key = event.summary.match(/Spawned reviewer (\S+) for/)?.[1];
      const runId = event.summary.match(/\(([^()]+)\)\.?\s*$/)?.[1];
      if (key && runId && !reviewerKeyByRunId.has(runId))
        reviewerKeyByRunId.set(runId, key);
    }

    const needsSibling = runs.some(
      (run) =>
        run.phase === "review" &&
        !reviewerKeyByRunId.has(run.id) &&
        run.assignmentId,
    );
    // Retry runs have no spawn event of their own but inherit the assignment of
    // the run they replace, which does.
    if (needsSibling) {
      for (const sibling of store.listAgentRuns({
        orchestrationId,
        limit: 500,
      })) {
        const key = sibling.assignmentId && reviewerKeyByRunId.get(sibling.id);
        if (!key) continue;
        for (const run of runs) {
          if (
            run.assignmentId === sibling.assignmentId &&
            !reviewerKeyByRunId.has(run.id)
          ) {
            reviewerKeyByRunId.set(run.id, key);
          }
        }
      }
    }

    for (const run of runs) {
      if (run.phase === "review") {
        const reviewerKey = reviewerKeyByRunId.get(run.id);
        if (!reviewerKey) continue;
        // Named after the work being reviewed, not after the reviewer: on a board
        // the useful question is "which subtask is this about", and `r1` answers
        // it for nobody. A reviewer of c1-s1's second attempt reads
        // `c1-s1-round2`, lining
        // the card up with the implementer card it follows.
        //
        // A rework is folded into the scope of the reviewer that covered the
        // original, so the scope holds every attempt at the same work. One entry
        // per piece of work, at its latest round — otherwise the card would read
        // "c1-s1-round1, c1-s1-round2" and name the superseded attempt too.
        const latest = new Map<string, { round: number; subtaskId: string }>();
        for (const entry of scopeByReviewerKey.get(reviewerKey) ?? []) {
          const origin = planOriginKey(entry.key);
          const round = roundFor(entry.key);
          const previous = latest.get(origin);
          if (!previous || round > previous.round)
            latest.set(origin, { round, subtaskId: entry.subtaskId });
        }
        const keys: string[] = [];
        const titles: string[] = [];
        for (const [origin, entry] of latest) {
          const meta = metaBySubtaskId.get(entry.subtaskId);
          keys.push(
            folderRoundLabel(
              contextKeyFor(
                meta?.key ?? origin,
                entry.subtaskId,
                meta?.planCycle,
              ),
              entry.round,
            ),
          );
          titles.push(titleBySubtaskId.get(entry.subtaskId) ?? origin);
        }
        labels[run.id] = {
          key: keys.join(", ") || reviewerKey,
          title: titles.length ? `review ${titles.join(", ")}` : "review",
        };
        continue;
      }
      if (!run.subtaskId) continue;
      const meta = metaBySubtaskId.get(run.subtaskId);
      const title = titleBySubtaskId.get(run.subtaskId);
      if (meta || title) {
        labels[run.id] = {
          key: meta
            ? folderRoundLabel(
                contextKeyFor(meta.key, run.subtaskId, meta.planCycle),
                roundFor(meta.key),
              )
            : "",
          title: title ?? "",
        };
      }
    }
    return labels;
  }

  // Mirrors the on-disk task folder and spells out the attempt so a Runs card can
  // be matched directly to `.agent-memory/context/<orchestration>/tasks/<key>`.
  function folderRoundLabel(contextKey: string, round: number): string {
    return `${contextKey}-round${round}`;
  }

  function isRunConsumed(
    store: MemoryStore,
    orchestrationId: string,
    runId: string,
  ): boolean {
    return store
      .listOrchestrationEvents({
        orchestrationId,
        kind: "run_ended",
        limit: META_SCAN_LIMIT,
      })
      .some((event) => event.summary?.includes(runId));
  }

  // Marks a terminal run as dealt with, so no later step picks it up again.
  // isRunConsumed matches on the run id inside a "run_ended" event summary, so
  // the summary must name this run and no other.
  function consumeRun(
    store: MemoryStore,
    orchestration: Orchestration,
    phase: string,
    run: AgentRun,
    outcome: string,
  ): void {
    recordEvent(
      store,
      orchestration,
      phase,
      "run_ended",
      `Run ${run.id} ${outcome}.`,
    );
  }

  function recordEvent(
    store: MemoryStore,
    orchestration: Orchestration,
    phase: string,
    kind:
      | "leader_turn"
      | "spawn"
      | "run_ended"
      | "verdict"
      | "rework"
      | "forced_finalization"
      | "error"
      | "user_action",
    summary: string,
    payload?: string,
  ): void {
    store.recordOrchestrationEvent({
      orchestrationId: orchestration.id,
      cycle: orchestration.cycle,
      phase,
      kind,
      summary,
      payload,
    });
  }

  function latestByCreatedAt<T extends { createdAt: string }>(
    items: T[],
  ): T | undefined {
    return items
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  function safeTail(text: string, maxChars = 2000): string {
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  function safeParse<T>(payload: string): T | undefined {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return undefined;
    }
  }

  function noop(
    orchestration: Orchestration,
    summary: string,
  ): OrchestrationStepResult {
    return { orchestration, summary, spawnedRunIds: [] };
  }

  function result(
    orchestration: Orchestration,
    summary: string,
    spawnedRunIds: string[],
  ): OrchestrationStepResult {
    return { orchestration, summary, spawnedRunIds };
  }
  return {
    describeRunPlanLabels,
    folderRoundLabel,
    isRunConsumed,
    consumeRun,
    recordEvent,
    latestByCreatedAt,
    safeTail,
    safeParse,
    noop,
    result,
  };
}
