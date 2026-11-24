import type {
  AgentRun,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
  Subtask,
} from "@agent-bridge/memory";

import { type ContextStore } from "./context-store.js";

import {
  renderReviewerPrompt,
  renderReviewRetryPrompt,
  type PriorReviewInput,
} from "./review-contract.js";

import {
  type ReviewerPlanMeta,
  type OrchestratorDeps,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";
type Dependencies = {
  approvedAgentOverride: import("./orchestrator-approvals.js").ApprovalsFunctions["approvedAgentOverride"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
  resolveStaffAgent: import("./orchestrator-staffing.js").StaffingFunctions["resolveStaffAgent"];
  mustGetRole: import("./orchestrator-staffing.js").StaffingFunctions["mustGetRole"];
  mustGetTask: import("./orchestrator-staffing.js").StaffingFunctions["mustGetTask"];
  mustGetAgent: import("./orchestrator-staffing.js").StaffingFunctions["mustGetAgent"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  latestByCreatedAt: import("./orchestrator-reporting.js").ReportingFunctions["latestByCreatedAt"];
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  consumeRun: import("./orchestrator-reporting.js").ReportingFunctions["consumeRun"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  contextTargetFor: import("./orchestrator-context.js").ContextFunctions["contextTargetFor"];
  priorRoundPaths: import("./orchestrator-context.js").ContextFunctions["priorRoundPaths"];
  spawnTurn: import("./orchestrator-turns.js").TurnsFunctions["spawnTurn"];
  findSubtaskMetaByKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskMetaByKey"];
  findSubtaskKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskKey"];
  createQuestion: import("./orchestrator-planning.js").PlanningFunctions["createQuestion"];
};
export type ReviewFunctions = ReturnType<typeof createReview>;
export function createReview(operations: Dependencies) {
  function resolveReviewerAgent(
    store: MemoryStore,
    orchestration: Orchestration,
    reviewerMeta: ReviewerPlanMeta,
    deps: OrchestratorDeps,
    approvalKey: string,
  ): RegisteredAgent {
    const chosen = operations.approvedAgentOverride(
      store,
      orchestration,
      approvalKey,
    );
    if (chosen) {
      const agent = store.getRegisteredAgent(chosen);
      if (agent) return agent;
    }
    const preference = reviewerMeta.agentPreference;
    return operations.resolveStaffAgent(
      store,
      orchestration,
      deps,
      "review",
      preference,
    );
  }

  function spawnReviewer(
    store: MemoryStore,
    orchestration: Orchestration,
    reviewerMeta: ReviewerPlanMeta,
    scopeSubtasks: Array<{
      entry: { key: string; subtaskId: string };
      subtask: Subtask;
    }>,
    deps: OrchestratorDeps,
    approvalKey: string,
  ): AgentRun {
    const role = operations.mustGetRole(store, reviewerMeta.role ?? "reviewer");
    const agent = resolveReviewerAgent(
      store,
      orchestration,
      reviewerMeta,
      deps,
      // Use the exact key that was displayed and approved. Rebuilding the base
      // key here discarded attempt suffixes, so a retry approved as Codex still
      // resolved the leader's original Claude preference at spawn time.
      approvalKey,
    );
    const task = operations.mustGetTask(store, orchestration.taskId);
    const assignmentsBySubtask = new Map(
      scopeSubtasks.map((pair) => [
        pair.subtask.id,
        operations.latestByCreatedAt(
          store.listAssignments({ subtaskId: pair.subtask.id, limit: 20 }),
        ),
      ]),
    );
    const titleBySubtaskId = new Map(
      store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .map((subtask) => [subtask.id, subtask.title]),
    );
    const ctx = deps.contextStoreFor?.(orchestration.id);
    const prompt = renderReviewerPrompt({
      taskTitle: task.title,
      subtasks: scopeSubtasks.map((pair) => {
        const target = ctx
          ? operations.contextTargetFor(store, orchestration, pair.subtask)
          : undefined;
        return {
          key: pair.entry.key,
          title: pair.subtask.title,
          goal: pair.subtask.goal,
          acceptanceCriteria: pair.subtask.acceptanceCriteria,
          // Both of these are replaced by the documents once there is a store:
          // the 800-character log tail by the implementer's own report, and the
          // replayed prior reviews by the files they were summarised from.
          resultSummary: ctx
            ? undefined
            : assignmentsBySubtask.get(pair.subtask.id)?.resultSummary,
          priorReviews: ctx
            ? undefined
            : priorReviewsForScopeEntry(
                store,
                reviewerMeta,
                pair.entry.key,
                titleBySubtaskId,
              ),
          context:
            ctx && target
              ? {
                  brief: ctx.briefPath(target.contextKey),
                  report: ctx.turnPath(
                    "report",
                    target.contextKey,
                    target.round,
                  ),
                  prior: operations.priorRoundPaths(ctx, target, [
                    "review",
                    "adjudication",
                  ]),
                  write: ctx.turnPath(
                    "review",
                    target.contextKey,
                    target.round,
                  ),
                }
              : undefined,
        };
      }),
    });
    const assignment = store.createAssignment({
      taskId: orchestration.taskId,
      workforceId: orchestration.workforceId,
      agentId: agent.id,
      roleId: role.id,
      prompt,
    });
    const run = operations.spawnTurn(
      deps,
      store,
      orchestration,
      agent,
      prompt,
      "review",
      {
        assignmentId: assignment.id,
        roleId: role.id,
      },
    );
    operations.recordEvent(
      store,
      orchestration,
      "review",
      "spawn",
      `Spawned reviewer ${reviewerMeta.reviewerKey} for ${scopeSubtasks.map((pair) => pair.entry.key).join(", ")} (${run.id}).`,
    );
    return run;
  }

  // Reviews already written for this scope entry — including the ones written
  // against the subtask it replaced. Adjudication cancels a reworked subtask and
  // creates a new one keyed `<origin>-rework-<cycle>`, so the reviewer of the
  // second attempt is looking at a subtask with no review history of its own
  // while the findings it must verify sit on the cancelled original. Walking the
  // suffix back gives it that history (and keeps working for a rework of a
  // rework).
  function priorReviewsForScopeEntry(
    store: MemoryStore,
    reviewerMeta: ReviewerPlanMeta,
    key: string,
    titleBySubtaskId: Map<string, string>,
  ): PriorReviewInput[] | undefined {
    const subtaskIdByKey = new Map(
      reviewerMeta.scope.map((entry) => [entry.key, entry.subtaskId]),
    );
    const chain: string[] = [];
    let current: string | undefined = key;
    while (current) {
      chain.unshift(current);
      const origin: string | undefined =
        current.match(/^(.+)-rework-\d+$/)?.[1];
      current = origin && subtaskIdByKey.has(origin) ? origin : undefined;
    }
    const priors: PriorReviewInput[] = [];
    for (const entryKey of chain) {
      const subtaskId = subtaskIdByKey.get(entryKey);
      if (!subtaskId) continue;
      for (const review of store.listReviews({ subtaskId, limit: 20 })) {
        priors.push({
          subtaskTitle: titleBySubtaskId.get(subtaskId) ?? entryKey,
          verdict: review.verdict,
          summary: review.summary,
          findings: review.findings,
        });
      }
    }
    return priors.length ? priors : undefined;
  }

  function missingReviewDocuments(
    store: MemoryStore,
    orchestration: Orchestration,
    ctx: ContextStore,
    reviewerMeta: ReviewerPlanMeta | undefined,
    items: Array<{ subtaskKey: string }>,
    subtasks: Subtask[],
  ): Array<{ path: string; reason: string }> {
    const missing: Array<{ path: string; reason: string }> = [];
    for (const item of items) {
      const scopeEntry = reviewerMeta?.scope.find(
        (entry) => entry.key === item.subtaskKey,
      );
      const subtaskId =
        scopeEntry?.subtaskId ??
        operations.findSubtaskMetaByKey(
          store,
          orchestration.id,
          item.subtaskKey,
        )?.subtaskId;
      const subtask = subtasks.find((candidate) => candidate.id === subtaskId);
      if (!subtask) continue;
      const target = operations.contextTargetFor(store, orchestration, subtask);
      const check = ctx.checkTurn("review", target.contextKey, target.round);
      if (!check.ok) missing.push({ path: check.path, reason: check.reason });
    }
    return missing;
  }

  function applyReviewTurn(
    store: MemoryStore,
    orchestration: Orchestration,
    run: AgentRun,
    reviewerMeta: ReviewerPlanMeta | undefined,
    items: Array<{
      subtaskKey: string;
      verdict: "pass" | "rework" | "block";
      score?: number;
      summary: string;
      findings?: unknown;
    }>,
    subtasks: Subtask[],
  ): void {
    for (const item of items) {
      const scopeEntry = reviewerMeta?.scope.find(
        (entry) => entry.key === item.subtaskKey,
      );
      const subtaskId =
        scopeEntry?.subtaskId ??
        operations.findSubtaskMetaByKey(
          store,
          orchestration.id,
          item.subtaskKey,
        )?.subtaskId;
      if (!subtaskId) continue;
      const targetAssignment = operations.latestByCreatedAt(
        store.listAssignments({ subtaskId, limit: 20 }),
      );
      store.createReview({
        taskId: orchestration.taskId,
        subtaskId,
        reviewerAssignmentId: run.assignmentId,
        targetAssignmentId: targetAssignment?.id,
        verdict: item.verdict === "pass" ? "pass" : item.verdict,
        score: item.score,
        summary: item.summary,
        findings: item.findings ? JSON.stringify(item.findings) : undefined,
      });
    }
    if (run.assignmentId)
      store.updateAssignment(run.assignmentId, { status: "done" });
    void subtasks;
  }

  // Reviews written against the attempts this subtask replaces, so adjudication
  // can see a defect being reported for the second or third time instead of
  // treating each cycle's review as the first word on the subject.
  function priorReviewsForSubtask(
    store: MemoryStore,
    orchestration: Orchestration,
    subtaskId: string | undefined,
    subtasks: Subtask[],
  ):
    | Array<{
        subtaskTitle: string;
        verdict: string;
        summary: string;
        findings?: string;
      }>
    | undefined {
    const key = subtaskId
      ? operations.findSubtaskKey(store, orchestration.id, subtaskId)
      : undefined;
    if (!key) return undefined;
    const priors: Array<{
      subtaskTitle: string;
      verdict: string;
      summary: string;
      findings?: string;
    }> = [];
    let ancestorKey: string | undefined = key.match(/^(.+)-rework-\d+$/)?.[1];
    const chain: string[] = [];
    while (ancestorKey) {
      chain.unshift(ancestorKey);
      ancestorKey = ancestorKey.match(/^(.+)-rework-\d+$/)?.[1];
    }
    for (const entryKey of chain) {
      const meta = operations.findSubtaskMetaByKey(
        store,
        orchestration.id,
        entryKey,
      );
      if (!meta) continue;
      const title =
        subtasks.find((subtask) => subtask.id === meta.subtaskId)?.title ??
        entryKey;
      for (const review of store.listReviews({
        subtaskId: meta.subtaskId,
        limit: 20,
      })) {
        priors.push({
          subtaskTitle: title,
          verdict: review.verdict,
          summary: review.summary,
          findings: review.findings,
        });
      }
    }
    return priors.length ? priors : undefined;
  }

  function handleReviewParseFailure(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
    run: AgentRun,
    reviewerMeta: ReviewerPlanMeta | undefined,
    error: string,
  ): OrchestrationStepResult {
    // The event names the assignment, and attempts are counted by it: a retry run
    // inherits the original run's assignmentId but has no reviewer spawn event of
    // its own, so findReviewerMetaForRun returns undefined for it. Counting by
    // reviewerKey therefore counted zero every time — the "failed twice" guard
    // never fired and the loop retried forever (observed live: 20+ identical
    // parse errors, 5 seconds apart, until the user killed the tool).
    const assignmentId = run.assignmentId;
    const priorAttempts = assignmentId
      ? store
          .listOrchestrationEvents({
            orchestrationId: orchestration.id,
            limit: 500,
          })
          .filter(
            (event) =>
              event.kind === "error" &&
              event.phase === "review" &&
              event.summary?.includes(assignmentId),
          )
      : [];
    const original = assignmentId
      ? store
          .listAssignments({ taskId: orchestration.taskId, limit: 500 })
          .find((item) => item.id === assignmentId)
      : undefined;
    if (priorAttempts.length >= 1 || !original || !run.roleId) {
      operations.recordEvent(
        store,
        orchestration,
        "review",
        "error",
        `Reviewer output could not be parsed${assignmentId ? ` (assignment ${assignmentId})` : ""}: ${error}`,
      );
      operations.consumeRun(
        store,
        orchestration,
        "review",
        run,
        `could not be parsed (${error})`,
      );
      const reason =
        original && run.roleId
          ? `after retrying: ${error}`
          : `and could not be retried (missing context): ${error}`;
      operations.createQuestion(store, orchestration, {
        question: `Reviewer output could not be parsed ${reason}`,
        options: [],
      });
      if (assignmentId)
        store.updateAssignment(assignmentId, {
          status: "failed",
          resultSummary: error,
        });
      // Pausing is the point: leaving it "executing" means auto-run keeps
      // stepping, and with the review still missing it would just spawn a fresh
      // reviewer for the same scope on the next tick.
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError: error,
        }) ?? orchestration;
      return operations.result(
        updated,
        "Reviewer parsing failed; paused for user input.",
        [],
      );
    }
    const agent = operations.mustGetAgent(store, run.agentId);
    const gated = operations.gateSpawn(
      store,
      orchestration,
      `review:parse-retry:${run.id}`,
      `Retry the reviewer turn with ${operations.describeAgent(agent)} after an invalid response`,
      agent.id,
    );
    if (gated) return gated;
    operations.recordEvent(
      store,
      orchestration,
      "review",
      "error",
      `Reviewer output could not be parsed${assignmentId ? ` (assignment ${assignmentId})` : ""}: ${error}`,
    );
    operations.consumeRun(
      store,
      orchestration,
      "review",
      run,
      `could not be parsed (${error})`,
    );
    // The original prompt has to be replayed. Every turn is a fresh CLI process
    // with no memory of the last one, so a bare "your previous reply did not
    // parse" retry asked the agent to fix something it had never seen — observed
    // live, it answered "I don't have a prior reply or schema in this
    // conversation", which of course failed to parse too.
    const retryPrompt = `${original.prompt}\n\n${renderReviewRetryPrompt(error)}`;
    const retryRun = operations.spawnTurn(
      deps,
      store,
      orchestration,
      agent,
      retryPrompt,
      "review",
      {
        assignmentId,
        roleId: run.roleId,
      },
    );
    void reviewerMeta;
    return operations.result(
      orchestration,
      "Retrying reviewer turn after a parse failure.",
      [retryRun.id],
    );
  }
  return {
    resolveReviewerAgent,
    spawnReviewer,
    priorReviewsForScopeEntry,
    missingReviewDocuments,
    applyReviewTurn,
    priorReviewsForSubtask,
    handleReviewParseFailure,
  };
}
