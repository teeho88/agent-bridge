import type {
  AgentRun,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
  Subtask,
} from "@agent-bridge/memory";

import { parseReviewTurn } from "./review-contract.js";

import { describeInfraFailure, detectInfraFailure } from "./run-health.js";

import {
  type OrchestratorDeps,
  type OrchestrationStepResult,
  type ImplementerContextPaths,
} from "./orchestrator-contracts.js";

import {
  ACTIVE_STATUSES,
  TERMINAL_RUN_STATUSES,
  ASSIGNMENT_SUMMARY_CHARS,
  OPEN_SUBTASKS_QUESTION_KIND,
  DROP_OPEN_SUBTASKS_OPTION,
  META_SCAN_LIMIT,
} from "./orchestrator-constants.js";
type Dependencies = {
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  noop: import("./orchestrator-reporting.js").ReportingFunctions["noop"];
  isRunConsumed: import("./orchestrator-reporting.js").ReportingFunctions["isRunConsumed"];
  safeTail: import("./orchestrator-reporting.js").ReportingFunctions["safeTail"];
  consumeRun: import("./orchestrator-reporting.js").ReportingFunctions["consumeRun"];
  safeParse: import("./orchestrator-reporting.js").ReportingFunctions["safeParse"];
  tryResolveAgent: import("./orchestrator-staffing.js").StaffingFunctions["tryResolveAgent"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  mustGetRole: import("./orchestrator-staffing.js").StaffingFunctions["mustGetRole"];
  resolveStaffAgent: import("./orchestrator-staffing.js").StaffingFunctions["resolveStaffAgent"];
  gateSpawnDetailed: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawnDetailed"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
  approvedAgentOverride: import("./orchestrator-approvals.js").ApprovalsFunctions["approvedAgentOverride"];
  contextTargetFor: import("./orchestrator-context.js").ContextFunctions["contextTargetFor"];
  retryForMissingContext: import("./orchestrator-context.js").ContextFunctions["retryForMissingContext"];
  writeAssignmentBrief: import("./orchestrator-context.js").ContextFunctions["writeAssignmentBrief"];
  priorRoundPaths: import("./orchestrator-context.js").ContextFunctions["priorRoundPaths"];
  renderImplementerPrompt: import("./orchestrator-context.js").ContextFunctions["renderImplementerPrompt"];
  reworkContextFor: import("./orchestrator-context.js").ContextFunctions["reworkContextFor"];
  createQuestion: import("./orchestrator-planning.js").PlanningFunctions["createQuestion"];
  listReviewerMetas: import("./orchestrator-metadata.js").MetadataFunctions["listReviewerMetas"];
  findReviewerMetaForRun: import("./orchestrator-metadata.js").MetadataFunctions["findReviewerMetaForRun"];
  getSubtaskMeta: import("./orchestrator-metadata.js").MetadataFunctions["getSubtaskMeta"];
  handleReviewParseFailure: import("./orchestrator-review.js").ReviewFunctions["handleReviewParseFailure"];
  missingReviewDocuments: import("./orchestrator-review.js").ReviewFunctions["missingReviewDocuments"];
  applyReviewTurn: import("./orchestrator-review.js").ReviewFunctions["applyReviewTurn"];
  resolveReviewerAgent: import("./orchestrator-review.js").ReviewFunctions["resolveReviewerAgent"];
  spawnReviewer: import("./orchestrator-review.js").ReviewFunctions["spawnReviewer"];
  spawnTurn: import("./orchestrator-turns.js").TurnsFunctions["spawnTurn"];
};
export type ExecutionFunctions = ReturnType<typeof createExecution>;
export function createExecution(operations: Dependencies) {
  // ---------------------------------------------------------------------------
  // Executing phase
  // ---------------------------------------------------------------------------

  function stepExecuting(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
  ): OrchestrationStepResult {
    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    const reviewReadyIds = new Set(
      subtasks
        .filter((subtask) => subtask.status === "review")
        .map((subtask) => subtask.id),
    );
    // Reviews are task-scoped in storage, while an orchestration can be replanned
    // many times. A review left on a superseded/cancelled subtask must not send a
    // fresh plan directly to adjudication before any of its work is dispatched.
    const pendingReviews = store
      .listReviews({ taskId: orchestration.taskId, consumed: false })
      .filter(
        (review) => review.subtaskId && reviewReadyIds.has(review.subtaskId),
      );
    if (pendingReviews.length) {
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "adjudicating",
        }) ?? orchestration;
      return operations.result(
        updated,
        `${pendingReviews.length} review(s) pending; moving to adjudication.`,
        [],
      );
    }

    const activeRuns = store.listAgentRuns({
      orchestrationId: orchestration.id,
      limit: 500,
    });
    const ctx = deps.contextStoreFor?.(orchestration.id);

    // 1) Spawn implementers for anything dispatchable, up to maxParallel.
    const doneIds = new Set(
      subtasks
        .filter((subtask) => subtask.status === "done")
        .map((subtask) => subtask.id),
    );
    const hasRun = (subtaskId: string) =>
      activeRuns.some(
        (run) => run.subtaskId === subtaskId && run.status !== "stopped",
      );
    const dispatchable = subtasks
      .filter((subtask) => subtask.status === "todo")
      .filter((subtask) =>
        subtask.dependsOn.every((depId) => doneIds.has(depId)),
      )
      .filter((subtask) => !hasRun(subtask.id))
      .sort((a, b) => b.priority - a.priority);

    const runningImplementers = activeRuns.filter(
      (run) => run.phase === "implement" && ACTIVE_STATUSES.has(run.status),
    ).length;
    const slots = Math.max(0, orchestration.maxParallel - runningImplementers);
    if (slots > 0 && dispatchable.length) {
      const spawnedRunIds: string[] = [];
      let waitingSince: string | undefined;
      let waitingCount = 0;
      let rejectedCount = 0;
      for (const subtask of dispatchable.slice(0, slots)) {
        // Approved one subtask at a time: "approve each" would mean little if a
        // single yes launched three agents at once. The agent is resolved before
        // the gate so the question names who would get the work — "approve this
        // assignment" is not a real choice without that.
        const candidate = operations.tryResolveAgent(() =>
          resolveImplementerAgent(store, orchestration, subtask, deps),
        );
        const gate = operations.gateSpawnDetailed(
          store,
          orchestration,
          `implement:${subtask.id}`,
          `Assign "${subtask.title}" to ${operations.describeAgent(candidate)} and start it`,
          candidate?.id,
          "skip",
        );
        // Saying no to one assignment means "don't do this piece", not "stop the
        // project": the subtask is blocked and everything else carries on. The
        // leader sees the blocked subtask at adjudication and can re-plan around
        // it. (Pausing the whole run here used to make a single "no" the end of
        // the orchestration, which is a very expensive way to skip one subtask.)
        if (gate.decision === "rejected") {
          rejectedCount += 1;
          store.updateSubtask(subtask.id, {
            status: "blocked",
            statusReason: "Assignment rejected by the user.",
          });
          operations.recordEvent(
            store,
            orchestration,
            "implement",
            "user_action",
            `You rejected the assignment for "${subtask.title}"; it is blocked and the rest of the run continues.`,
          );
          continue;
        }
        if (gate.decision === "halt") return gate.result;
        // But a still-unanswered approval is only about THIS subtask. Carrying on
        // means every dispatchable subtask gets its own request in one pass, and
        // whichever ones you approve start immediately — previously the first
        // unanswered question stalled the entire queue behind it, including
        // parallel work that had nothing to do with it.
        if (gate.decision === "wait") {
          waitingCount += 1;
          if (!waitingSince || gate.since < waitingSince)
            waitingSince = gate.since;
          continue;
        }
        spawnedRunIds.push(
          spawnImplementer(store, orchestration, subtask, deps).id,
        );
      }
      const blocked = rejectedCount
        ? ` Blocked ${rejectedCount} you rejected.`
        : "";
      if (spawnedRunIds.length) {
        const waiting = waitingCount
          ? ` ${waitingCount} more await your approval.`
          : "";
        return {
          ...operations.result(
            orchestration,
            `Spawned ${spawnedRunIds.length} implementer run(s).${waiting}${blocked}`,
            spawnedRunIds,
          ),
          awaitingApprovalSince: waitingSince,
        };
      }
      if (waitingCount) {
        return {
          ...operations.noop(
            orchestration,
            `Waiting for your approval on ${waitingCount} agent assignment(s).${blocked}`,
          ),
          awaitingApprovalSince: waitingSince,
        };
      }
      if (rejectedCount) {
        return operations.result(
          orchestration,
          `Blocked ${rejectedCount} subtask(s) you rejected; nothing else was dispatchable.`,
          [],
        );
      }
    }

    // 2) Reconcile implementer runs that finished since the last step.
    const finishedImplementerRuns = activeRuns.filter(
      (run) =>
        run.phase === "implement" &&
        TERMINAL_RUN_STATUSES.has(run.status) &&
        run.subtaskId &&
        !operations.isRunConsumed(store, orchestration.id, run.id),
    );
    for (const run of finishedImplementerRuns) {
      const subtask = subtasks.find(
        (candidate) => candidate.id === run.subtaskId,
      );
      if (
        !subtask ||
        (subtask.status !== "assigned" && subtask.status !== "in_progress")
      )
        continue;
      // A context-document retry for this subtask is still running: reconciling
      // now would spend the gate's budget on the very file that run is writing.
      if (
        activeRuns.some(
          (other) =>
            other.subtaskId === subtask.id && ACTIVE_STATUSES.has(other.status),
        )
      )
        continue;
      const log = deps.readLog(run);
      // An agent the OS never let run a command exits 0 and signs off politely.
      // Routed through review that is indistinguishable from bad work: the
      // reviewer says the criteria are unmet, adjudication spends a rework
      // cycle, and the replacement fails identically. Catch it here instead.
      const infra = detectInfraFailure(log);
      // "detached" only means the process vanished before a clean exit event
      // reached us — with agents spawned by one process and reaped by another
      // that is routine, and the work is usually finished (observed live: a
      // detached implementer had written 12KB of correct code). Send it to
      // review rather than blocking: the reviewer catches genuinely incomplete
      // work cheaply, whereas a false "blocked" throws the work away and stalls
      // the whole orchestration. Only a real failure or a user cancellation
      // blocks.
      const treatAsFailure =
        run.status === "failed" || run.status === "stopped" || Boolean(infra);
      // The report is the only account of this attempt that the reviewer, the
      // adjudicator and any later attempt will ever see, so ask for it before
      // the subtask leaves the implementer's hands. Skipped for a failed run:
      // there is nothing to report and the retry would only waste a spawn.
      if (!treatAsFailure && ctx) {
        const target = operations.contextTargetFor(
          store,
          orchestration,
          subtask,
        );
        const check = ctx.checkTurn("report", target.contextKey, target.round);
        if (!check.ok) {
          const retry = operations.retryForMissingContext(
            store,
            orchestration,
            deps,
            {
              phase: "implement",
              agent: store.getRegisteredAgent(run.agentId),
              tag: `report:${target.contextKey}:${target.round}`,
              missing: [{ path: check.path, reason: check.reason }],
              sourceRun: run,
              extra: {
                subtaskId: subtask.id,
                assignmentId: run.assignmentId,
                roleId: run.roleId,
              },
            },
          );
          if (retry) return retry;
        }
      }
      const nextStatus = treatAsFailure ? "blocked" : "review";
      store.updateSubtask(subtask.id, {
        status: nextStatus,
        statusReason: treatAsFailure
          ? infra
            ? describeInfraFailure(infra)
            : `Implementer run ended with status ${run.status}.`
          : undefined,
      });
      if (run.assignmentId) {
        store.updateAssignment(run.assignmentId, {
          status: treatAsFailure ? "failed" : "waiting",
          // Deliberately short. Every assignment's resultSummary is replayed into
          // the reviewer prompt and into every later reporter prompt, so this is
          // per-subtask context that accumulates for the whole project — 2000
          // chars each measured ~2.5k tokens on a 12-assignment task. The tail of
          // an agent log is its closing summary, which fits comfortably here.
          // The log tail of an environment failure is the agent's own apology,
          // which reads as "it chose not to do the work" in every prompt that
          // replays this summary. Say what actually happened instead.
          resultSummary: infra
            ? describeInfraFailure(infra)
            : operations.safeTail(log, ASSIGNMENT_SUMMARY_CHARS),
        });
      }
      if (infra) {
        // Only the user can fix this, so raise it once per orchestration rather
        // than per run — but do not pause: other providers may be unaffected
        // (observed live: every codex run was refused while every claude run on
        // the same machine worked), and the leader can re-staff around it at
        // adjudication once it sees the blocked subtask and this summary.
        const agent = store.getRegisteredAgent(run.agentId);
        const title = `Agent "${agent?.name ?? run.agentId}" cannot run commands on this machine (${infra.kind}). ${infra.detail}`;
        const alreadyRaised = store
          .listAgentRequests({ taskId: orchestration.taskId, limit: 500 })
          .some((request) => request.title === title);
        if (!alreadyRaised)
          operations.createQuestion(store, orchestration, {
            question: title,
            options: [],
          });
        operations.recordEvent(
          store,
          orchestration,
          "implement",
          "error",
          `Implementer run ${run.id} never executed a command (${infra.kind}, ${infra.occurrences} refusals); blocked "${subtask.title}" instead of sending unrun work to review.`,
        );
        return operations.result(
          orchestration,
          `Implementer run ${run.id} hit an environment failure (${infra.kind}); blocked the subtask.`,
          [],
        );
      }
      operations.recordEvent(
        store,
        orchestration,
        "implement",
        "run_ended",
        `Implementer run ${run.id} finished (${run.status}) for ${subtask.title}.`,
      );
      return operations.result(
        orchestration,
        `Recorded completion of implementer run ${run.id}.`,
        [],
      );
    }

    // 3) Parse finished reviewer runs into `reviews` rows FIRST — before
    // considering spawning a new reviewer for the same scope. Otherwise a
    // reviewer run that just finished but hasn't been parsed yet would look
    // identical to "no reviewer has ever covered this subtask" and get a
    // duplicate reviewer spawned on top of it every step.
    const reviewerMetas = operations.listReviewerMetas(store, orchestration.id);
    const finishedReviewerRuns = activeRuns.filter(
      (run) => run.phase === "review" && TERMINAL_RUN_STATUSES.has(run.status),
    );
    const assignmentsById = new Map(
      store
        .listAssignments({ taskId: orchestration.taskId, limit: 500 })
        .map((item) => [item.id, item]),
    );
    for (const run of finishedReviewerRuns) {
      if (!run.assignmentId) continue;
      if (operations.isRunConsumed(store, orchestration.id, run.id)) continue;
      // Same reason as the implementer branch: wait for a document retry on this
      // assignment before judging whether its document is missing.
      if (
        activeRuns.some(
          (other) =>
            other.assignmentId === run.assignmentId &&
            ACTIVE_STATUSES.has(other.status),
        )
      )
        continue;
      // A retry run and the run it replaced share one assignment. Once either of
      // them has delivered the verdicts, the others have nothing left to say —
      // re-parsing their truncated logs would only fail and drag the whole
      // orchestration into the parse-failure path a second time.
      if (assignmentsById.get(run.assignmentId)?.status === "done") {
        operations.consumeRun(
          store,
          orchestration,
          "review",
          run,
          "superseded by another turn on the same assignment",
        );
        continue;
      }

      if (run.status === "failed") {
        operations.recordEvent(
          store,
          orchestration,
          "review",
          "run_ended",
          `Reviewer run ${run.id} failed to execute.`,
        );
        return operations.result(
          orchestration,
          `Reviewer run ${run.id} failed; leader will see this at adjudication.`,
          [],
        );
      }

      const reviewerMeta = operations.findReviewerMetaForRun(
        store,
        orchestration.id,
        run,
        reviewerMetas,
      );
      const parsed = parseReviewTurn(deps.readLog(run));
      if (!parsed.ok) {
        return operations.handleReviewParseFailure(
          store,
          orchestration,
          deps,
          run,
          reviewerMeta,
          parsed.error,
        );
      }
      // The JSON verdict is what the orchestrator acts on; the review document is
      // what the next attempt and the adjudicator read. Ask for it before the
      // verdicts are recorded, while the reviewer's own turn is still the thing
      // being retried.
      if (ctx) {
        const missing = operations.missingReviewDocuments(
          store,
          orchestration,
          ctx,
          reviewerMeta,
          parsed.turn.reviews,
          subtasks,
        );
        if (missing.length) {
          const retry = operations.retryForMissingContext(
            store,
            orchestration,
            deps,
            {
              phase: "review",
              agent: store.getRegisteredAgent(run.agentId),
              tag: `review:${run.assignmentId}`,
              missing,
              sourceRun: run,
              extra: { assignmentId: run.assignmentId, roleId: run.roleId },
            },
          );
          if (retry) return retry;
        }
      }
      operations.applyReviewTurn(
        store,
        orchestration,
        run,
        reviewerMeta,
        parsed.turn.reviews,
        subtasks,
      );
      operations.recordEvent(
        store,
        orchestration,
        "review",
        "run_ended",
        `Reviewer run ${run.id} produced ${parsed.turn.reviews.length} verdict(s).`,
      );
      return operations.result(
        orchestration,
        `Recorded ${parsed.turn.reviews.length} review verdict(s) from run ${run.id}.`,
        [],
      );
    }

    // 4) Spawn reviewer groups covering whichever of their scoped subtasks
    // don't have a review yet. Scope grows over time (a rework subtask is
    // folded into its original reviewer's scope), so only the still-unreviewed
    // members need to be "review"-ready — an older, now-terminal (done/blocked)
    // sibling in the same scope must not block this forever.
    const activeReviewerKeys = new Set(
      activeRuns
        .filter(
          (run) => run.phase === "review" && ACTIVE_STATUSES.has(run.status),
        )
        .map(
          (run) =>
            operations.findReviewerMetaForRun(
              store,
              orchestration.id,
              run,
              reviewerMetas,
            )?.reviewerKey,
        )
        .filter((key): key is string => Boolean(key)),
    );
    for (const reviewerMeta of reviewerMetas) {
      if (activeReviewerKeys.has(reviewerMeta.reviewerKey)) continue;
      const scopeSubtasks = reviewerMeta.scope
        .map((entry) => ({
          entry,
          subtask: subtasks.find(
            (candidate) => candidate.id === entry.subtaskId,
          ),
        }))
        .filter(
          (
            pair,
          ): pair is {
            entry: { key: string; subtaskId: string };
            subtask: Subtask;
          } => Boolean(pair.subtask),
        );
      const unreviewed = scopeSubtasks.filter(
        (pair) =>
          store.listReviews({ subtaskId: pair.subtask.id, limit: 5 }).length ===
          0,
      );
      const ready = unreviewed.filter(
        (pair) => pair.subtask.status === "review",
      );
      if (!ready.length) continue;
      // Reviewing the whole group in one pass is the cheap path, so wait while a
      // scope member can still reach "review" on its own. But a member that only
      // depends on work sitting in this very group cannot: dependencies count as
      // met only once a subtask is "done", and "done" is what adjudication grants
      // after this review. Waiting for it deadlocks the orchestration — reviewer
      // waits for the dependent, dependent waits for the review — and the leader
      // then adjudicates with no pending reviews and nothing it can decide.
      const canStillProgress = (pair: { subtask: Subtask }) =>
        pair.subtask.status === "assigned" ||
        pair.subtask.status === "in_progress" ||
        (pair.subtask.status === "todo" &&
          pair.subtask.dependsOn.every((depId) => doneIds.has(depId)));
      if (
        unreviewed.some(
          (pair) => pair.subtask.status !== "review" && canStillProgress(pair),
        )
      )
        continue;
      const reviewBaseKey = `review:${reviewerMeta.reviewerKey}:${ready.map((pair) => pair.entry.key).join(",")}`;
      const priorReviewerRuns = activeRuns.filter(
        (run) =>
          run.phase === "review" &&
          operations.findReviewerMetaForRun(
            store,
            orchestration.id,
            run,
            reviewerMetas,
          )?.reviewerKey === reviewerMeta.reviewerKey,
      ).length;
      // The first attempt keeps the historic key so an approval already pending
      // during an upgrade is still usable. Every later spawn gets a fresh key:
      // one accepted review approval must not authorise infinite failed retries
      // or a later rework round for the same reviewer group.
      const reviewKey = priorReviewerRuns
        ? `${reviewBaseKey}:attempt-${priorReviewerRuns + 1}`
        : reviewBaseKey;
      const candidate = operations.tryResolveAgent(() =>
        operations.resolveReviewerAgent(
          store,
          orchestration,
          reviewerMeta,
          deps,
          reviewKey,
        ),
      );
      const gated = operations.gateSpawn(
        store,
        orchestration,
        reviewKey,
        `Assign review of ${ready.map((pair) => pair.subtask.title).join(", ")} to ${operations.describeAgent(candidate)}`,
        candidate?.id,
      );
      if (gated) return gated;
      const run = operations.spawnReviewer(
        store,
        orchestration,
        reviewerMeta,
        ready,
        deps,
        reviewKey,
      );
      return operations.result(
        orchestration,
        `Spawned reviewer run for ${reviewerMeta.reviewerKey}.`,
        [run.id],
      );
    }

    const stillActive = activeRuns.filter((run) =>
      ACTIVE_STATUSES.has(run.status),
    );
    if (stillActive.length) {
      return operations.noop(
        orchestration,
        `Waiting on ${stillActive.length} active run(s).`,
      );
    }

    // Nothing left to spawn or reconcile and no active work: ask the leader to
    // confirm completion (or point out what's still missing).
    const updated =
      store.updateOrchestration(orchestration.id, { status: "adjudicating" }) ??
      orchestration;
    return operations.result(
      updated,
      "No dispatchable work remains; asking the leader to adjudicate.",
      [],
    );
  }

  function spawnImplementer(
    store: MemoryStore,
    orchestration: Orchestration,
    subtask: Subtask,
    deps: OrchestratorDeps,
  ): AgentRun {
    const meta = operations.getSubtaskMeta(store, orchestration.id, subtask.id);
    const role = operations.mustGetRole(store, meta?.role ?? "implementer");
    const agent = resolveImplementerAgent(store, orchestration, subtask, deps);
    const ctx = deps.contextStoreFor?.(orchestration.id);
    const files = meta?.files ?? [];
    let context: ImplementerContextPaths | undefined;
    if (ctx) {
      const target = operations.contextTargetFor(store, orchestration, subtask);
      operations.writeAssignmentBrief(
        store,
        orchestration,
        ctx,
        subtask,
        files,
        target,
      );
      context = {
        brief: ctx.briefPath(target.contextKey),
        // Every document from the attempts this one replaces, in full. This is
        // what the truncated rework blob in the prompt used to stand in for.
        prior: operations.priorRoundPaths(ctx, target, [
          "report",
          "review",
          "adjudication",
        ]),
        write: ctx.turnPath("report", target.contextKey, target.round),
        round: target.round,
      };
      ctx.appendAssignment({
        contextKey: target.contextKey,
        round: target.round,
        role: role.name,
        agent: agent.name,
        subtaskTitle: subtask.title,
      });
    }
    const prompt = operations.renderImplementerPrompt(
      subtask,
      files,
      // With the documents on disk there is nothing left for the inlined rework
      // blob to add, and it is the larger of the two by an order of magnitude.
      context
        ? undefined
        : operations.reworkContextFor(store, orchestration, subtask),
      context,
    );
    const assignment = store.createAssignment({
      taskId: orchestration.taskId,
      subtaskId: subtask.id,
      workforceId: orchestration.workforceId,
      agentId: agent.id,
      roleId: role.id,
      prompt,
    });
    store.updateSubtask(subtask.id, { status: "assigned" });
    const run = operations.spawnTurn(
      deps,
      store,
      orchestration,
      agent,
      prompt,
      "implement",
      {
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        roleId: role.id,
      },
    );
    operations.recordEvent(
      store,
      orchestration,
      "implement",
      "spawn",
      `Spawned implementer for "${subtask.title}" (${run.id}).`,
    );
    return run;
  }

  // Resolving the implementer's agent is deliberately separate from spawning it:
  // the approve-each gate has to name the agent it is asking about ("who exactly
  // will get this subtask?"), and that answer must be the very same one the spawn
  // then uses.
  function resolveImplementerAgent(
    store: MemoryStore,
    orchestration: Orchestration,
    subtask: Subtask,
    deps: OrchestratorDeps,
  ): RegisteredAgent {
    // The user's pick, when they approved this assignment with a different agent,
    // outranks both the leader's preference and the roster default: they were
    // shown exactly this decision and answered it.
    const chosen = operations.approvedAgentOverride(
      store,
      orchestration,
      `implement:${subtask.id}`,
    );
    if (chosen) {
      const agent = store.getRegisteredAgent(chosen);
      if (agent) return agent;
    }
    const meta = operations.getSubtaskMeta(store, orchestration.id, subtask.id);
    const preference = meta?.agentPreference;
    return operations.resolveStaffAgent(
      store,
      orchestration,
      deps,
      "implement",
      preference,
    );
  }

  // Cancels the still-open subtasks and moves to reporting when the user picked
  // the drop option on the newest completion guard. Returns undefined when there
  // is nothing to act on, so the caller carries on with a normal turn — a
  // free-text answer is left to the leader, which can now `drop` them itself.
  function applyOpenSubtaskDrop(
    store: MemoryStore,
    orchestration: Orchestration,
  ): OrchestrationStepResult | undefined {
    const guard = store
      .listAgentRequests({ taskId: orchestration.taskId, limit: 500 })
      .find((request) => {
        if (request.type !== "question") return false;
        return (
          operations.safeParse<{ kind?: string }>(request.payload ?? "")
            ?.kind === OPEN_SUBTASKS_QUESTION_KIND
        );
      });
    if (
      !guard ||
      guard.status === "pending" ||
      guard.response?.trim() !== DROP_OPEN_SUBTASKS_OPTION
    )
      return undefined;
    // Acted on once only. A later cycle that opens new subtasks must not be
    // cleared out by an answer the user gave about a different set of them.
    const applied = store
      .listOrchestrationEvents({
        orchestrationId: orchestration.id,
        kind: "user_action",
        limit: META_SCAN_LIMIT,
      })
      .some((event) => event.summary?.includes(guard.id));
    if (applied) return undefined;

    const outstanding = store
      .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
      .filter((subtask) => !["done", "cancelled"].includes(subtask.status));
    if (!outstanding.length) return undefined;

    for (const subtask of outstanding) {
      store.updateSubtask(subtask.id, {
        status: "cancelled",
        statusReason:
          "Dropped at your request so the orchestration could finish.",
      });
    }
    operations.recordEvent(
      store,
      orchestration,
      "adjudicate",
      "user_action",
      `Dropped ${outstanding.length} open subtask(s) at your request (${guard.id}); finishing the orchestration.`,
    );
    const updated =
      store.updateOrchestration(orchestration.id, {
        status: "reporting",
        lastError: null,
      }) ?? orchestration;
    return operations.result(
      updated,
      `Dropped ${outstanding.length} open subtask(s); ready for reporting.`,
      [],
    );
  }
  return {
    stepExecuting,
    spawnImplementer,
    resolveImplementerAgent,
    applyOpenSubtaskDrop,
  };
}
