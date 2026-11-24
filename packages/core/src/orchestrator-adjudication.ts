import type {
  AgentRun,
  MemoryStore,
  Orchestration,
  Subtask,
} from "@agent-bridge/memory";

import { type ContextStore } from "./context-store.js";

import {
  parseLeaderTurn,
  type LeaderAdjudicateTurn,
} from "./leader-contract.js";

import { renderAdjudicatePrompt } from "./leader-prompts.js";

import {
  readAdjudicationLedger,
  recordAdjudicationDecisions,
} from "./turn-ledger.js";

import {
  type OrchestratorDeps,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";

import {
  ACTIVE_STATUSES,
  TERMINAL_RUN_STATUSES,
  BLOCK_REASON_CHARS,
  SEND_OPEN_SUBTASKS_BACK_OPTION,
  DROP_OPEN_SUBTASKS_OPTION,
  OPEN_SUBTASKS_QUESTION_KIND,
} from "./orchestrator-constants.js";
type Dependencies = {
  applyOpenSubtaskDrop: import("./orchestrator-execution.js").ExecutionFunctions["applyOpenSubtaskDrop"];
  noop: import("./orchestrator-reporting.js").ReportingFunctions["noop"];
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  latestByCreatedAt: import("./orchestrator-reporting.js").ReportingFunctions["latestByCreatedAt"];
  isRunConsumed: import("./orchestrator-reporting.js").ReportingFunctions["isRunConsumed"];
  consumeRun: import("./orchestrator-reporting.js").ReportingFunctions["consumeRun"];
  refreshContextIndex: import("./orchestrator-context.js").ContextFunctions["refreshContextIndex"];
  retryForMissingContext: import("./orchestrator-context.js").ContextFunctions["retryForMissingContext"];
  contextTargetFor: import("./orchestrator-context.js").ContextFunctions["contextTargetFor"];
  priorRoundPaths: import("./orchestrator-context.js").ContextFunctions["priorRoundPaths"];
  findCapabilityAgent: import("./orchestrator-staffing.js").StaffingFunctions["findCapabilityAgent"];
  mustGetAgent: import("./orchestrator-staffing.js").StaffingFunctions["mustGetAgent"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  mustGetTask: import("./orchestrator-staffing.js").StaffingFunctions["mustGetTask"];
  resolveProviderOptions: import("./orchestrator-staffing.js").StaffingFunctions["resolveProviderOptions"];
  agentForKey: import("./orchestrator-approvals.js").ApprovalsFunctions["agentForKey"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
  allApprovalNotes: import("./orchestrator-approvals.js").ApprovalsFunctions["allApprovalNotes"];
  spawnTurn: import("./orchestrator-turns.js").TurnsFunctions["spawnTurn"];
  resolveLeaderReply: import("./orchestrator-turns.js").TurnsFunctions["resolveLeaderReply"];
  handleLeaderParseFailure: import("./orchestrator-turns.js").TurnsFunctions["handleLeaderParseFailure"];
  allQuestionAnswers: import("./orchestrator-planning.js").PlanningFunctions["allQuestionAnswers"];
  createQuestion: import("./orchestrator-planning.js").PlanningFunctions["createQuestion"];
  findSubtaskMetaByKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskMetaByKey"];
  findSubtaskKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskKey"];
  recordSubtaskMeta: import("./orchestrator-metadata.js").MetadataFunctions["recordSubtaskMeta"];
  listReviewerMetas: import("./orchestrator-metadata.js").MetadataFunctions["listReviewerMetas"];
  recordReviewerMeta: import("./orchestrator-metadata.js").MetadataFunctions["recordReviewerMeta"];
  isFinalizationCycle: typeof import("./orchestrator.js").isFinalizationCycle;
  priorReviewsForSubtask: import("./orchestrator-review.js").ReviewFunctions["priorReviewsForSubtask"];
};
export type AdjudicationFunctions = ReturnType<typeof createAdjudication>;
export function createAdjudication(operations: Dependencies) {
  function stepAdjudicating(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
  ): OrchestrationStepResult {
    const dropped = operations.applyOpenSubtaskDrop(store, orchestration);
    if (dropped) return dropped;

    consumeTerminalPendingReviews(store, orchestration);

    const adjudicateRuns = store
      .listAgentRuns({ orchestrationId: orchestration.id, limit: 100 })
      .filter((run) => run.phase === "adjudicate");
    const active = adjudicateRuns.find((run) =>
      ACTIVE_STATUSES.has(run.status),
    );
    if (active)
      return operations.noop(
        orchestration,
        `Adjudication is still running (run ${active.id}).`,
      );

    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    if (
      subtasks.length > 0 &&
      subtasks.every((subtask) =>
        ["done", "cancelled"].includes(subtask.status),
      )
    ) {
      operations.recordEvent(
        store,
        orchestration,
        "adjudicate",
        "verdict",
        "All subtasks are finished or cancelled; proceeding to reporting without another leader decision.",
      );
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "reporting",
          lastError: null,
        }) ?? orchestration;
      const ctx = deps.contextStoreFor?.(orchestration.id);
      if (ctx) operations.refreshContextIndex(store, updated, ctx);
      return operations.result(
        updated,
        "All subtasks are terminal; ready for reporting.",
        [],
      );
    }

    const finished = operations.latestByCreatedAt(
      adjudicateRuns.filter(
        (run) =>
          TERMINAL_RUN_STATUSES.has(run.status) &&
          !operations.isRunConsumed(store, orchestration.id, run.id),
      ),
    );
    if (!finished) {
      const key = `adjudicate:${adjudicateRuns.length}`;
      const adjudicator = operations.findCapabilityAgent(
        store,
        "adjudicate",
        orchestration.leaderAgentId,
      );
      const chosen = operations.agentForKey(store, orchestration, key);
      const agent =
        chosen ??
        adjudicator ??
        operations.mustGetAgent(store, orchestration.leaderAgentId);
      // A user-picked agent takes the adjudicator seat regardless of who would
      // have had it, unless it is the leader itself — then this is a leader turn.
      const actor =
        agent.id === orchestration.leaderAgentId ? "leader" : "adjudicator";
      const gated = operations.gateSpawn(
        store,
        orchestration,
        key,
        `Run the ${actor}'s adjudication turn with ${operations.describeAgent(agent)}`,
        agent.id,
      );
      if (gated) return gated;
      const prompt = buildAdjudicationPrompt(store, orchestration, deps, actor);
      const run = operations.spawnTurn(
        deps,
        store,
        orchestration,
        agent,
        prompt,
        "adjudicate",
      );
      operations.recordEvent(
        store,
        orchestration,
        "adjudicate",
        "spawn",
        `Spawned ${actor} adjudicate turn (${run.id}).`,
      );
      return operations.result(
        orchestration,
        `Spawned the ${actor}'s adjudicate turn.`,
        [run.id],
      );
    }

    const parsed = operations.resolveLeaderReply(finished, deps, (text) =>
      parseLeaderTurn(text, "adjudicate"),
    );
    if (!parsed.ok) {
      return operations.handleLeaderParseFailure(
        store,
        orchestration,
        deps,
        "adjudicate",
        parsed.error,
        () => {
          const task = operations.mustGetTask(store, orchestration.taskId);
          return renderAdjudicatePrompt({
            taskTitle: task.title,
            cycle: orchestration.cycle,
            maxCycles: orchestration.maxCycles,
            reviews: [],
            subtasks: [],
            answers: operations.allQuestionAnswers(store, orchestration.id),
            approvalNotes: operations.allApprovalNotes(store, orchestration),
          });
        },
        finished,
      );
    }

    const isLeader = finished.agentId === orchestration.leaderAgentId;
    const validationError = validateAdjudicationTurn(
      store,
      orchestration,
      parsed.turn,
    );
    if (validationError) {
      return retryInvalidAdjudicationTurn(
        store,
        orchestration,
        deps,
        finished,
        isLeader ? "leader" : "adjudicator",
        validationError,
        parsed.turn,
      );
    }
    if (
      !isLeader &&
      requiresLeaderAdjudication(store, orchestration, parsed.turn)
    ) {
      const leader = operations.mustGetAgent(
        store,
        orchestration.leaderAgentId,
      );
      const gated = operations.gateSpawn(
        store,
        orchestration,
        `adjudicate:leader-confirm:${finished.id}`,
        `Escalate adjudication to the Leader with ${operations.describeAgent(leader)}`,
        leader.id,
      );
      if (gated) return gated;
      operations.consumeRun(
        store,
        orchestration,
        "adjudicate",
        finished,
        "escalated its proposal to the Leader",
      );
      const proposal = `\`\`\`json\n${JSON.stringify(parsed.turn, null, 2)}\n\`\`\``;
      const prompt = buildAdjudicationPrompt(
        store,
        orchestration,
        deps,
        "leader",
        proposal,
      );
      const run = operations.spawnTurn(
        deps,
        store,
        orchestration,
        leader,
        prompt,
        "adjudicate",
      );
      operations.recordEvent(
        store,
        orchestration,
        "adjudicate",
        "spawn",
        `Escalated adjudication to Leader (${run.id}).`,
      );
      return operations.result(
        orchestration,
        "Adjudicator proposal requires Leader confirmation.",
        [run.id],
      );
    }

    // The decision documents are gated before anything is applied, and the run is
    // deliberately left unconsumed while the retry runs: the next step re-parses
    // this same turn and applies it then, with its files in place.
    const ctx = deps.contextStoreFor?.(orchestration.id);
    if (ctx) {
      const missing = missingAdjudicationDocuments(
        store,
        orchestration,
        ctx,
        parsed.turn,
      );
      if (missing.length) {
        const retry = operations.retryForMissingContext(
          store,
          orchestration,
          deps,
          {
            phase: "adjudicate",
            agent: store.getRegisteredAgent(finished.agentId),
            tag: `adjudication:${finished.id}`,
            missing,
            sourceRun: finished,
          },
        );
        if (retry) return retry;
      }
    }

    return applyAdjudicateTurn(store, orchestration, {
      turn: parsed.turn,
      finishedRunId: finished.id,
      actor: isLeader ? "Leader" : "Adjudicator",
      contextStore: ctx,
    });
  }

  function consumeTerminalPendingReviews(
    store: MemoryStore,
    orchestration: Orchestration,
  ): void {
    const terminalSubtaskIds = new Set(
      store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .filter((subtask) => ["done", "cancelled"].includes(subtask.status))
        .map((subtask) => subtask.id),
    );
    if (!terminalSubtaskIds.size) return;

    for (const review of store.listReviews({
      taskId: orchestration.taskId,
      consumed: false,
    })) {
      if (review.subtaskId && terminalSubtaskIds.has(review.subtaskId)) {
        store.markReviewConsumed(review.id);
      }
    }
  }

  function validateAdjudicationTurn(
    store: MemoryStore,
    orchestration: Orchestration,
    turn: LeaderAdjudicateTurn,
  ): string | undefined {
    const subtasks = new Map(
      store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .map((subtask) => [subtask.id, subtask]),
    );
    const decided = new Set<string>();
    for (const decision of turn.decisions) {
      if (decided.has(decision.subtaskKey))
        return `Duplicate decision for subtask key: ${decision.subtaskKey}`;
      decided.add(decision.subtaskKey);
      const meta = operations.findSubtaskMetaByKey(
        store,
        orchestration.id,
        decision.subtaskKey,
      );
      const subtask = meta ? subtasks.get(meta.subtaskId) : undefined;
      if (!subtask) return `Unknown subtask key: ${decision.subtaskKey}`;
      if (["done", "cancelled"].includes(subtask.status)) {
        return `Cannot ${decision.verdict} terminal subtask: ${decision.subtaskKey}`;
      }
      if (decision.verdict === "rework") {
        if (!decision.rework)
          return `Rework decision is missing replacement details for: ${decision.subtaskKey}`;
        if (
          orchestration.cycle >= orchestration.maxCycles &&
          !operations.isFinalizationCycle(orchestration)
        ) {
          return `Cannot rework ${decision.subtaskKey}: rework cycle limit ${orchestration.maxCycles} has been reached`;
        }
      }
    }
    if (operations.isFinalizationCycle(orchestration)) {
      const openKeys = [...subtasks.values()]
        .filter((subtask) => !["done", "cancelled"].includes(subtask.status))
        .map(
          (subtask) =>
            operations.findSubtaskKey(store, orchestration.id, subtask.id) ??
            subtask.id,
        );
      const missing = openKeys.filter((key) => !decided.has(key));
      const forbidden = turn.decisions
        .filter((decision) => !["accept", "drop"].includes(decision.verdict))
        .map((decision) => `${decision.subtaskKey}:${decision.verdict}`);
      const errors: string[] = [];
      if (missing.length)
        errors.push(`missing decisions for ${missing.join(", ")}`);
      if (forbidden.length)
        errors.push(`forbidden finalization verdicts ${forbidden.join(", ")}`);
      if (!turn.projectComplete) errors.push("projectComplete must be true");
      if (turn.questions.length) errors.push("questions must be empty");
      if (errors.length)
        return `Finalization contract violated: ${errors.join("; ")}`;
    }
    return undefined;
  }

  function retryInvalidAdjudicationTurn(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
    failedRun: AgentRun,
    actor: "leader" | "adjudicator",
    error: string,
    invalidTurn: LeaderAdjudicateTurn,
  ): OrchestrationStepResult {
    const priorFailures = store
      .listOrchestrationEvents({
        orchestrationId: orchestration.id,
        limit: 500,
      })
      .filter(
        (event) =>
          event.phase === "adjudicate" &&
          event.kind === "error" &&
          event.summary?.startsWith("Invalid adjudication decision:"),
      );
    if (priorFailures.length >= 1) {
      operations.recordEvent(
        store,
        orchestration,
        "adjudicate",
        "error",
        `Invalid adjudication decision: ${error}`,
      );
      operations.consumeRun(
        store,
        orchestration,
        "adjudicate",
        failedRun,
        `had an invalid decision (${error})`,
      );
      if (operations.isFinalizationCycle(orchestration)) {
        return forceFinalization(
          store,
          orchestration,
          failedRun.id,
          error,
          deps.contextStoreFor?.(orchestration.id),
          invalidTurn,
        );
      }
      operations.createQuestion(store, orchestration, {
        question: `Adjudication returned invalid decisions after retrying: ${error}`,
        options: [],
      });
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError: error,
        }) ?? orchestration;
      return operations.result(
        updated,
        "Adjudication returned invalid decisions twice; paused for user input.",
        [],
      );
    }
    const agent = operations.mustGetAgent(store, failedRun.agentId);
    const gated = operations.gateSpawn(
      store,
      orchestration,
      `adjudicate:validation-retry:${failedRun.id}`,
      `Retry the ${actor} adjudication turn with ${operations.describeAgent(agent)} after invalid decisions`,
      agent.id,
    );
    if (gated) return gated;
    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "error",
      `Invalid adjudication decision: ${error}`,
    );
    operations.consumeRun(
      store,
      orchestration,
      "adjudicate",
      failedRun,
      `had an invalid decision (${error})`,
    );
    const prompt = [
      buildAdjudicationPrompt(store, orchestration, deps, actor),
      "",
      "## Correct Your Previous Output",
      `Your previous output was rejected before any state changed: ${error}`,
      "Return a complete replacement adjudication JSON using only current, non-terminal subtask keys.",
    ].join("\n");
    const run = operations.spawnTurn(
      deps,
      store,
      orchestration,
      agent,
      prompt,
      "adjudicate",
    );
    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "spawn",
      `Retried ${actor} adjudication after invalid decision (${run.id}).`,
    );
    return operations.result(
      orchestration,
      "Retrying adjudication after invalid decisions.",
      [run.id],
    );
  }

  function forceFinalization(
    store: MemoryStore,
    orchestration: Orchestration,
    finishedRunId: string,
    reason: string,
    contextStore?: ContextStore,
    invalidTurn?: LeaderAdjudicateTurn,
  ): OrchestrationStepResult {
    const openSubtasks = store
      .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
      .filter((subtask) => !["done", "cancelled"].includes(subtask.status));
    const validByKey = new Map(
      (invalidTurn?.decisions ?? [])
        .filter(
          (decision) =>
            decision.verdict === "accept" || decision.verdict === "drop",
        )
        .map((decision) => [decision.subtaskKey, decision]),
    );
    const decisions: LeaderAdjudicateTurn["decisions"] = openSubtasks.map(
      (subtask) => {
        const subtaskKey =
          operations.findSubtaskKey(store, orchestration.id, subtask.id) ??
          subtask.id;
        return (
          validByKey.get(subtaskKey) ?? { subtaskKey, verdict: "drop" as const }
        );
      },
    );
    if (contextStore) {
      for (const decision of decisions) {
        const meta = operations.findSubtaskMetaByKey(
          store,
          orchestration.id,
          decision.subtaskKey,
        );
        const subtask = openSubtasks.find(
          (candidate) => candidate.id === meta?.subtaskId,
        );
        if (!subtask) continue;
        const target = operations.contextTargetFor(
          store,
          orchestration,
          subtask,
        );
        contextStore.writeTurn(
          "adjudication",
          target.contextKey,
          target.round,
          `# Adjudication — ${decision.subtaskKey} round ${target.round}\n\n## Summary\n${decision.verdict === "accept" ? "Accepted from the leader's valid final-cycle decision." : `Dropped at the cycle limit: ${reason}`}\n\n## Detail\nForced finalization closed this subtask without further rework.`,
        );
      }
    }
    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "forced_finalization",
      `forced_finalization: dropped ${decisions.length} open subtask(s) after invalid final-cycle adjudication.`,
      JSON.stringify({
        reason,
        droppedSubtasks: decisions.map((decision) => decision.subtaskKey),
      }),
    );
    return applyAdjudicateTurn(store, orchestration, {
      turn: {
        version: 1,
        phase: "adjudicate",
        decisions,
        projectComplete: true,
        questions: [],
      },
      finishedRunId,
      actor: "Leader",
      contextStore,
      forcedDropReason: `Dropped at cycle limit after adjudication failed: ${reason}`,
    });
  }

  // A decision needs its own document, and an accepted subtask needs the
  // `summary.md` that every downstream subtask reads in place of its folder.
  // Without the summary the hand-off between subtasks is empty and the next
  // implementer rediscovers the same ground.
  function missingAdjudicationDocuments(
    store: MemoryStore,
    orchestration: Orchestration,
    ctx: ContextStore,
    turn: LeaderAdjudicateTurn,
  ): Array<{ path: string; reason: string }> {
    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    const missing: Array<{ path: string; reason: string }> = [];
    for (const decision of turn.decisions) {
      const meta = operations.findSubtaskMetaByKey(
        store,
        orchestration.id,
        decision.subtaskKey,
      );
      const subtask = subtasks.find(
        (candidate) => candidate.id === meta?.subtaskId,
      );
      if (!subtask) continue;
      const target = operations.contextTargetFor(store, orchestration, subtask);
      const check = ctx.checkTurn(
        "adjudication",
        target.contextKey,
        target.round,
      );
      if (!check.ok) missing.push({ path: check.path, reason: check.reason });
      if (decision.verdict !== "accept") continue;
      const summaryPath = ctx.summaryPath(target.contextKey);
      if (!ctx.existingPaths([summaryPath]).length) {
        missing.push({
          path: summaryPath,
          reason: `you accepted ${decision.subtaskKey} without writing its hand-off summary at ${summaryPath}; later subtasks read that file and nothing else from this one`,
        });
      }
    }
    return missing;
  }

  function buildAdjudicationPrompt(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
    actor: "leader" | "adjudicator",
    adjudicatorProposal?: string,
  ): string {
    const task = operations.mustGetTask(store, orchestration.taskId);
    const pendingReviews = store.listReviews({
      taskId: orchestration.taskId,
      consumed: false,
    });
    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    const stranded = strandedSubtaskIds(subtasks);
    const ctx = deps.contextStoreFor?.(orchestration.id);
    const contextFor = (subtaskId: string | undefined) => {
      const subtask = subtasks.find((candidate) => candidate.id === subtaskId);
      if (!ctx || !subtask) return undefined;
      const target = operations.contextTargetFor(store, orchestration, subtask);
      return {
        brief: ctx.briefPath(target.contextKey),
        review: ctx.turnPath("review", target.contextKey, target.round),
        // Earlier rounds in full — this is how a defect reported for the third
        // time stops looking like a fresh one.
        prior: operations.priorRoundPaths(ctx, target, [
          "report",
          "review",
          "adjudication",
        ]),
        write: ctx.turnPath("adjudication", target.contextKey, target.round),
        summary: ctx.summaryPath(target.contextKey),
      };
    };
    return renderAdjudicatePrompt({
      taskTitle: task.title,
      cycle: orchestration.cycle,
      maxCycles: orchestration.maxCycles,
      actor,
      adjudicatorProposal,
      decisionLog: readAdjudicationLedger(store, orchestration.id),
      // The user's replies belong to this turn as much as to a plan turn: the
      // question that stopped the run was asked from here.
      answers: operations.allQuestionAnswers(store, orchestration.id),
      approvalNotes: operations.allApprovalNotes(store, orchestration),
      ...operations.resolveProviderOptions(store, orchestration, deps),
      reviews: pendingReviews.map((review) => ({
        subtaskKey:
          operations.findSubtaskKey(
            store,
            orchestration.id,
            review.subtaskId,
          ) ??
          review.subtaskId ??
          "?",
        subtaskTitle:
          subtasks.find((subtask) => subtask.id === review.subtaskId)?.title ??
          "",
        verdict: review.verdict,
        score: review.score,
        summary: review.summary,
        // Both give way to the files once there is a store: a findings blob is
        // the largest thing in this prompt and it is replayed every cycle.
        findings: ctx ? undefined : review.findings,
        priorReviews: ctx
          ? undefined
          : operations.priorReviewsForSubtask(
              store,
              orchestration,
              review.subtaskId,
              subtasks,
            ),
        context: contextFor(review.subtaskId),
      })),
      subtasks: subtasks.map((subtask) => ({
        key:
          operations.findSubtaskKey(store, orchestration.id, subtask.id) ??
          subtask.id,
        title: subtask.title,
        status: subtask.status,
        acceptanceCriteria: subtask.acceptanceCriteria,
        strandedBy: stranded
          .get(subtask.id)
          ?.map(
            (depId) =>
              operations.findSubtaskKey(store, orchestration.id, depId) ??
              depId,
          ),
        blockedReason:
          subtask.status === "blocked"
            ? blockedReasonFor(store, subtask)
            : undefined,
      })),
    });
  }

  function blockedReasonFor(
    store: MemoryStore,
    subtask: Subtask,
  ): string | undefined {
    if (subtask.statusReason) return truncateReason(subtask.statusReason);
    const review = operations.latestByCreatedAt(
      store.listReviews({ subtaskId: subtask.id, limit: 20 }),
    );
    if (review?.verdict === "block") {
      const findings = review.findings ? ` findings: ${review.findings}` : "";
      return truncateReason(
        `reviewer blocked it — ${review.summary}${findings}`,
      );
    }
    const assignment = operations.latestByCreatedAt(
      store.listAssignments({ subtaskId: subtask.id, limit: 20 }),
    );
    if (assignment?.status === "failed" && assignment.resultSummary) {
      return truncateReason(
        `the implementer run failed — ${assignment.resultSummary}`,
      );
    }
    if (review) {
      const findings = review.findings ? ` findings: ${review.findings}` : "";
      return truncateReason(
        `last review [${review.verdict}] — ${review.summary}${findings}`,
      );
    }
    return assignment?.resultSummary
      ? truncateReason(assignment.resultSummary)
      : undefined;
  }

  function truncateReason(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > BLOCK_REASON_CHARS
      ? `${flat.slice(0, BLOCK_REASON_CHARS)}…`
      : flat;
  }

  function requiresLeaderAdjudication(
    store: MemoryStore,
    orchestration: Orchestration,
    turn: LeaderAdjudicateTurn,
  ): boolean {
    if (
      turn.projectComplete ||
      turn.questions.length ||
      turn.decisions.some((decision) => decision.verdict === "block")
    )
      return true;
    const reviews = store.listReviews({
      taskId: orchestration.taskId,
      consumed: false,
    });
    const verdictsBySubtask = new Map<string, Set<string>>();
    for (const review of reviews) {
      const key = review.subtaskId ?? "?";
      const verdicts = verdictsBySubtask.get(key) ?? new Set<string>();
      verdicts.add(review.verdict);
      verdictsBySubtask.set(key, verdicts);
    }
    if ([...verdictsBySubtask.values()].some((verdicts) => verdicts.size > 1))
      return true;
    const riskText = reviews
      .map((review) => `${review.summary ?? ""} ${review.findings ?? ""}`)
      .join(" ");
    return /\b(security|vulnerab|credential|authentication|authorization|data loss|breaking change|architecture)\b/i.test(
      riskText,
    );
  }

  function applyAdjudicateTurn(
    store: MemoryStore,
    orchestration: Orchestration,
    input: {
      turn: LeaderAdjudicateTurn;
      finishedRunId: string;
      actor: "Leader" | "Adjudicator";
      contextStore?: ContextStore;
      forcedDropReason?: string;
    },
  ): OrchestrationStepResult {
    const { turn, finishedRunId, actor } = input;
    // Logged before the decisions are applied, so the next cycle sees what was
    // ruled even if applying it ends the orchestration here.
    recordAdjudicationDecisions(store, orchestration, actor, turn);
    for (const question of turn.questions)
      operations.createQuestion(store, orchestration, question);

    let blocked = false;
    for (const decision of turn.decisions) {
      const meta = operations.findSubtaskMetaByKey(
        store,
        orchestration.id,
        decision.subtaskKey,
      );
      const subtaskId = meta?.subtaskId;
      if (!subtaskId) continue;
      const reviews = store.listReviews({ subtaskId, consumed: false });
      for (const review of reviews) store.markReviewConsumed(review.id);
      const targetAssignment = operations.latestByCreatedAt(
        store.listAssignments({ subtaskId, limit: 20 }),
      );

      if (decision.verdict === "accept") {
        store.updateSubtask(subtaskId, { status: "done" });
        if (targetAssignment)
          store.updateAssignment(targetAssignment.id, { status: "done" });
      } else if (decision.verdict === "rework" && decision.rework) {
        // "cancelled", not "blocked": a replacement subtask is created right
        // below, so the original is superseded, not stuck. Leaving it "blocked"
        // makes it look like unfinished work forever — enough that the leader
        // later refuses to call the project complete because of it.
        store.updateSubtask(subtaskId, {
          status: "cancelled",
          statusReason: `Superseded by rework: ${decision.rework.title}.`,
        });
        if (targetAssignment) {
          // Prepend the rework note rather than replacing the summary: this is
          // the only surviving record of what the previous attempt actually did,
          // and the next attempt's prompt replays it to avoid redoing that work.
          const previousSummary = targetAssignment.resultSummary?.trim();
          store.updateAssignment(targetAssignment.id, {
            status: "failed",
            resultSummary: previousSummary
              ? `Sent back for rework: ${decision.rework.title}\n${previousSummary}`
              : `Sent back for rework: ${decision.rework.title}`,
          });
        }
        const reworkSubtask = store.createSubtask({
          parentTaskId: orchestration.taskId,
          title: decision.rework.title,
          goal: decision.rework.goal,
          acceptanceCriteria: decision.rework.acceptanceCriteria,
        });
        // The replacement inherits the original's dependencies, and everything
        // that depended on the original is re-pointed at it. Without this the
        // dependents keep pointing at a subtask that is now `cancelled` — and
        // `dispatchable` only counts a dependency satisfied when it is `done`,
        // which a cancelled subtask never becomes. They sit in `todo` forever,
        // execution reports no dispatchable work, and adjudication then has no
        // pending review to decide on: exactly the deadlock that surfaces as
        // "Leader adjudicated with no decisions and did not mark the project
        // complete".
        inheritAndRepointDependencies(
          store,
          orchestration,
          subtaskId,
          reworkSubtask.id,
        );
        const reworkKey = `${decision.subtaskKey}-rework-${orchestration.cycle}`;
        operations.recordSubtaskMeta(store, orchestration, {
          type: "subtask",
          key: reworkKey,
          subtaskId: reworkSubtask.id,
          // The folder belongs to the work, not to the attempt: a rework raised
          // in cycle 4 for a subtask planned in cycle 2 still writes into the
          // cycle-2 folder, as round n+1.
          planCycle: meta?.planCycle,
          role: meta?.role,
          parallelSafe: meta?.parallelSafe,
          files: meta?.files ?? [],
          agentPreference:
            decision.rework.agentPreference ?? meta?.agentPreference,
        });
        // Fold the rework subtask into whichever reviewer originally covered
        // the subtask it replaces, so it gets reviewed again instead of
        // silently skipping review the second time around.
        const owningReviewer = operations
          .listReviewerMetas(store, orchestration.id)
          .find((candidate) =>
            candidate.scope.some((entry) => entry.key === decision.subtaskKey),
          );
        if (owningReviewer) {
          operations.recordReviewerMeta(store, orchestration, {
            ...owningReviewer,
            scope: [
              ...owningReviewer.scope,
              { key: reworkKey, subtaskId: reworkSubtask.id },
            ],
          });
        }
      } else if (decision.verdict === "drop") {
        // The subtask is not being done, and that is the decision — not a defect
        // to fix and not a question for the user. Cancelling is what lets the
        // completion guard below pass: an open subtask the leader has no verb for
        // is what kept a run the user asked to finish from ever finishing.
        store.updateSubtask(subtaskId, {
          status: "cancelled",
          statusReason:
            input.forcedDropReason ??
            "Dropped by the leader during adjudication.",
        });
        if (targetAssignment)
          store.updateAssignment(targetAssignment.id, { status: "cancelled" });
      } else if (decision.verdict === "block") {
        store.updateSubtask(subtaskId, {
          status: "blocked",
          statusReason: truncateReason(
            reviews
              .map((review) => review.summary)
              .filter(Boolean)
              .join("; ") || "Blocked by the leader during adjudication.",
          ),
        });
        blocked = true;
      }
    }

    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "verdict",
      `${actor} adjudicated ${turn.decisions.length} decision(s); projectComplete=${turn.projectComplete}.`,
    );
    // Marks finishedRunId as consumed so a later re-entry into "adjudicating"
    // (a new cycle, new pending reviews) spawns a fresh turn instead of
    // re-parsing and re-applying this same decision set again.
    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "run_ended",
      `Consumed adjudicate run ${finishedRunId}.`,
    );

    if (blocked) {
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError:
            "One or more subtasks were blocked by the leader; see agent_requests.",
        }) ?? orchestration;
      if (input.contextStore)
        operations.refreshContextIndex(store, updated, input.contextStore);
      return operations.result(
        updated,
        "Adjudication blocked on one or more subtasks; paused for user input.",
        [],
      );
    }
    if (turn.projectComplete) {
      const outstanding = store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .filter((subtask) => !["done", "cancelled"].includes(subtask.status));
      if (outstanding.length) {
        const listed = outstanding
          .slice(0, 8)
          .map((subtask) => `"${subtask.title}" [${subtask.status}]`)
          .join(", ");
        const more =
          outstanding.length > 8 ? `, and ${outstanding.length - 8} more` : "";
        // The old wording ("resolve or explicitly drop them") described an action
        // nothing could carry out: the leader had no verb for dropping a subtask
        // and the answer was only ever replayed to it as prose. A run the user
        // had told to finish came back here every turn. Now the first option is
        // executed by the orchestrator itself.
        operations.createQuestion(
          store,
          orchestration,
          {
            question: `${actor} marked the project complete, but ${outstanding.length} subtask(s) are still open: ${listed}${more}. Drop them and finish, or send them back to the leader?`,
            // The safe answer goes first: the dashboard pre-selects option one,
            // and that must never be the one that cancels work.
            options: [
              SEND_OPEN_SUBTASKS_BACK_OPTION,
              DROP_OPEN_SUBTASKS_OPTION,
            ],
          },
          OPEN_SUBTASKS_QUESTION_KIND,
        );
        const updated =
          store.updateOrchestration(orchestration.id, {
            status: "paused",
            lastError: `${actor} marked the project complete while subtasks were still open.`,
          }) ?? orchestration;
        if (input.contextStore)
          operations.refreshContextIndex(store, updated, input.contextStore);
        return operations.result(
          updated,
          `${actor} tried to finish with open subtasks; paused for user input.`,
          [],
        );
      }
      const updated =
        store.updateOrchestration(orchestration.id, { status: "reporting" }) ??
        orchestration;
      if (input.contextStore)
        operations.refreshContextIndex(store, updated, input.contextStore);
      return operations.result(
        updated,
        `${actor} marked the project complete; ready for reporting.`,
        [],
      );
    }
    // Nothing decided and not complete: execution already reported no
    // dispatchable work, so bumping the cycle would just spawn the same empty
    // adjudicate turn until max_cycles. Stop and ask the user instead.
    if (!turn.decisions.length) {
      // Name what is actually outstanding. "It needs direction on what remains"
      // asks the user to work out the answer from the dashboard; the subtasks
      // that stalled the run are known here, so say them.
      const outstanding = store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .filter((subtask) => !["done", "cancelled"].includes(subtask.status));
      const listed = outstanding
        .slice(0, 8)
        .map((subtask) => {
          // The status alone ("[blocked]") asks the user to go dig the reason out
          // of the dashboard. It is known right here, so say it.
          const reason =
            subtask.status === "blocked"
              ? blockedReasonFor(store, subtask)
              : undefined;
          return `"${subtask.title}" [${subtask.status}]${reason ? ` — ${reason}` : ""}`;
        })
        .join(", ");
      const more =
        outstanding.length > 8 ? `, and ${outstanding.length - 8} more` : "";
      operations.createQuestion(store, orchestration, {
        question: outstanding.length
          ? `The leader returned no decisions and would not mark the project complete, but ${outstanding.length} subtask(s) are still open: ${listed}${more}. Nothing can be dispatched — should these be dropped, or do they need something from you?`
          : "The leader returned no decisions and did not mark the project complete, yet every subtask is finished or cancelled. Confirm whether this project is done.",
        options: [],
      });
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError:
            "Leader returned no decisions and did not mark the project complete.",
        }) ?? orchestration;
      if (input.contextStore)
        operations.refreshContextIndex(store, updated, input.contextStore);
      return operations.result(
        updated,
        "Leader had nothing to decide and would not finish; paused for user input.",
        [],
      );
    }
    // A cycle is a round of work that had to be REDONE, which is what max_cycles
    // is there to bound. Charging one for an accept-only adjudication makes the
    // budget a cap on how many reviewer groups a project may have: each group's
    // reviews land separately, each lands its own adjudication, and a five-group
    // plan burned five cycles making perfect forward progress — then failed with
    // "Exceeded max_cycles" having never reworked anything. Accepts strictly
    // reduce outstanding work, so they cannot loop; only rework can.
    const reworked = turn.decisions.some(
      (decision) => decision.verdict === "rework" && decision.rework,
    );
    const updated =
      store.updateOrchestration(orchestration.id, {
        status: "executing",
        ...(reworked ? { cycle: orchestration.cycle + 1 } : {}),
      }) ?? orchestration;
    if (input.contextStore)
      operations.refreshContextIndex(store, updated, input.contextStore);
    return operations.result(
      updated,
      reworked
        ? `Applied adjudication decisions; starting rework cycle ${updated.cycle}.`
        : "Applied adjudication decisions; resuming execution.",
      [],
    );
  }

  function inheritAndRepointDependencies(
    store: MemoryStore,
    orchestration: Orchestration,
    supersededId: string,
    replacementId: string,
  ): void {
    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
    const superseded = byId.get(supersededId);
    // Dead dependencies are dropped rather than inherited: reworking a stranded
    // subtask is how the leader clears the strand, so carrying the dependency
    // that stranded it onto the replacement would strand that one too.
    const inherited = (superseded?.dependsOn ?? []).filter((id) => {
      const dep = byId.get(id);
      return dep && dep.status !== "cancelled" && dep.status !== "blocked";
    });
    if (inherited.length)
      store.updateSubtask(replacementId, { dependsOn: inherited });
    for (const subtask of subtasks) {
      if (
        subtask.id === replacementId ||
        !subtask.dependsOn.includes(supersededId)
      )
        continue;
      store.updateSubtask(subtask.id, {
        dependsOn: subtask.dependsOn.map((id) =>
          id === supersededId ? replacementId : id,
        ),
      });
    }
  }

  // Subtasks that can never be dispatched because something they depend on will
  // never be `done` — cancelled by a re-plan, blocked, or itself stranded. They
  // are invisible to the leader otherwise: adjudication only shows pending
  // reviews, and a stranded subtask has none and never will. Surfacing them is
  // what turns "there is nothing I can decide" into a decision the leader can
  // actually make.
  function strandedSubtaskIds(subtasks: Subtask[]): Map<string, string[]> {
    const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
    const unreachable = new Set(
      subtasks
        .filter(
          (subtask) =>
            subtask.status === "cancelled" || subtask.status === "blocked",
        )
        .map((s) => s.id),
    );
    const stranded = new Map<string, string[]>();
    // Fixpoint: stranding propagates down the dependency chain, so one pass over
    // the list is not enough — a subtask two hops from a cancelled one only
    // becomes visible once its own dependency has been marked.
    let changed = true;
    while (changed) {
      changed = false;
      for (const subtask of subtasks) {
        if (subtask.status !== "todo" || stranded.has(subtask.id)) continue;
        const culprits = subtask.dependsOn.filter(
          (id) => unreachable.has(id) || !byId.has(id),
        );
        if (!culprits.length) continue;
        stranded.set(subtask.id, culprits);
        unreachable.add(subtask.id);
        changed = true;
      }
    }
    return stranded;
  }
  return {
    stepAdjudicating,
    consumeTerminalPendingReviews,
    validateAdjudicationTurn,
    retryInvalidAdjudicationTurn,
    forceFinalization,
    missingAdjudicationDocuments,
    buildAdjudicationPrompt,
    blockedReasonFor,
    truncateReason,
    requiresLeaderAdjudication,
    applyAdjudicateTurn,
    inheritAndRepointDependencies,
    strandedSubtaskIds,
  };
}
