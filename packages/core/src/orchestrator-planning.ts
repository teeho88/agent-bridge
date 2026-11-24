import type { MemoryStore, Orchestration } from "@agent-bridge/memory";

import {
  parseLeaderTurn,
  type LeaderPlanTurn,
  type LeaderQuestion,
} from "./leader-contract.js";

import { renderPlanPrompt, type PlanRevisionInput } from "./leader-prompts.js";

import { readPlanLedger, recordPlanDraft } from "./turn-ledger.js";

import {
  type OrchestratorDeps,
  type OrchestrationStepResult,
  type QuestionAnswersPayload,
  type ChangeRequestPayload,
} from "./orchestrator-contracts.js";

import {
  ACTIVE_STATUSES,
  TERMINAL_RUN_STATUSES,
  DEFAULT_PLAN_QUESTION_ROUND_LIMIT,
  PLAN_QUESTION_EVENT_PREFIX,
} from "./orchestrator-constants.js";
type Dependencies = {
  noop: import("./orchestrator-reporting.js").ReportingFunctions["noop"];
  latestByCreatedAt: import("./orchestrator-reporting.js").ReportingFunctions["latestByCreatedAt"];
  isRunConsumed: import("./orchestrator-reporting.js").ReportingFunctions["isRunConsumed"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  safeParse: import("./orchestrator-reporting.js").ReportingFunctions["safeParse"];
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  safeTail: import("./orchestrator-reporting.js").ReportingFunctions["safeTail"];
  mustGetTask: import("./orchestrator-staffing.js").StaffingFunctions["mustGetTask"];
  resolveProviderOptions: import("./orchestrator-staffing.js").StaffingFunctions["resolveProviderOptions"];
  mustGetAgent: import("./orchestrator-staffing.js").StaffingFunctions["mustGetAgent"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  allApprovalNotes: import("./orchestrator-approvals.js").ApprovalsFunctions["allApprovalNotes"];
  agentForKey: import("./orchestrator-approvals.js").ApprovalsFunctions["agentForKey"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
  spawnTurn: import("./orchestrator-turns.js").TurnsFunctions["spawnTurn"];
  resolveLeaderReply: import("./orchestrator-turns.js").TurnsFunctions["resolveLeaderReply"];
  handleLeaderParseFailure: import("./orchestrator-turns.js").TurnsFunctions["handleLeaderParseFailure"];
  writePlanDocument: import("./orchestrator-context.js").ContextFunctions["writePlanDocument"];
  nextPlanContextCycle: import("./orchestrator-context.js").ContextFunctions["nextPlanContextCycle"];
  refreshContextIndex: import("./orchestrator-context.js").ContextFunctions["refreshContextIndex"];
  recordSubtaskMeta: import("./orchestrator-metadata.js").MetadataFunctions["recordSubtaskMeta"];
  recordReviewerMeta: import("./orchestrator-metadata.js").MetadataFunctions["recordReviewerMeta"];
};
export type PlanningFunctions = ReturnType<typeof createPlanning>;
export function createPlanning(operations: Dependencies) {
  // ---------------------------------------------------------------------------
  // Planning phase
  // ---------------------------------------------------------------------------

  function stepPlanning(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
  ): OrchestrationStepResult {
    const planRuns = store
      .listAgentRuns({ orchestrationId: orchestration.id, limit: 100 })
      .filter((run) => run.phase === "plan");

    const active = planRuns.find((run) => ACTIVE_STATUSES.has(run.status));
    if (active)
      return operations.noop(
        orchestration,
        `Leader is still planning (run ${active.id}).`,
      );

    // Consumed plan runs are excluded so a change request can send a finished
    // orchestration back to planning: without this the old, already-applied plan
    // run would be re-parsed and its subtasks created a second time.
    const finished = operations.latestByCreatedAt(
      planRuns.filter(
        (run) =>
          TERMINAL_RUN_STATUSES.has(run.status) &&
          !operations.isRunConsumed(store, orchestration.id, run.id),
      ),
    );
    const ctx = deps.contextStoreFor?.(orchestration.id);
    const buildPrompt = () => {
      const task = operations.mustGetTask(store, orchestration.taskId);
      return renderPlanPrompt({
        taskTitle: task.title,
        goal: task.goal,
        maxParallel: orchestration.maxParallel,
        contextRoot: ctx ? { root: ctx.root, plan: ctx.planPath } : undefined,
        ...operations.resolveProviderOptions(store, orchestration, deps),
        revision: buildPlanRevision(store, orchestration, deps),
        ledger: readPlanLedger(store, orchestration.id),
        answers: allQuestionAnswers(store, orchestration.id),
        approvalNotes: operations.allApprovalNotes(store, orchestration),
        ...renderQuestionBudget(
          orchestration,
          planQuestionRounds(store, orchestration.id),
        ),
      });
    };

    if (!finished) {
      const key = `plan:${planRuns.length}`;
      const leaderAgent =
        operations.agentForKey(store, orchestration, key) ??
        operations.mustGetAgent(store, orchestration.leaderAgentId);
      const gated = operations.gateSpawn(
        store,
        orchestration,
        key,
        `Run the planning turn with ${operations.describeAgent(leaderAgent)}`,
        leaderAgent.id,
      );
      if (gated) return gated;
      const run = operations.spawnTurn(
        deps,
        store,
        orchestration,
        leaderAgent,
        buildPrompt(),
        "plan",
      );
      return operations.result(
        orchestration,
        "Spawned the leader's plan turn.",
        [run.id],
      );
    }

    const parsed = operations.resolveLeaderReply(finished, deps, (text) =>
      parseLeaderTurn(text, "plan"),
    );
    if (!parsed.ok) {
      return operations.handleLeaderParseFailure(
        store,
        orchestration,
        deps,
        "plan",
        parsed.error,
        buildPrompt,
        finished,
      );
    }

    return applyPlanTurn(store, orchestration, parsed.turn, deps, finished.id);
  }

  // Questions the leader just asked that the user has not dealt with yet.
  // A question already answered (or dismissed) in a previous round must not
  // re-park the orchestration, or answering it would loop straight back here.
  function pendingQuestionsFor(
    store: MemoryStore,
    orchestration: Orchestration,
    questions: LeaderQuestion[],
  ): LeaderQuestion[] {
    if (!questions.length) return [];
    const settled = new Set<string>();
    for (const request of store.listAgentRequests({
      taskId: orchestration.taskId,
      limit: 500,
    })) {
      if (request.type === "question" && request.status !== "pending")
        settled.add(request.title);
    }
    return questions.filter((question) => !settled.has(question.question));
  }

  // Every answer the user has given across all planning rounds, for the next
  // plan turn. Only the newest batch used to be carried, so a leader that asked
  // again in round 3 never saw what it had been told in round 1 — it re-asked
  // the same thing in different words and the run looped through plan/approve
  // forever. Answers accumulate oldest-first; a question answered twice keeps
  // the newest answer.
  function allQuestionAnswers(
    store: MemoryStore,
    orchestrationId: string,
  ): Array<{ question: string; answer: string }> | undefined {
    const byQuestion = new Map<string, string>();
    const events = store.listOrchestrationEvents({
      orchestrationId,
      limit: 1000,
    });
    for (const event of [...events].reverse()) {
      if (event.kind !== "user_action" || !event.payload) continue;
      const parsed = operations.safeParse<QuestionAnswersPayload>(
        event.payload,
      );
      if (parsed?.type !== "question-answers") continue;
      for (const entry of parsed.answers)
        byQuestion.set(entry.question, entry.answer);
    }
    if (!byQuestion.size) return undefined;
    return [...byQuestion].map(([question, answer]) => ({ question, answer }));
  }

  function planQuestionRoundLimit(orchestration: Orchestration): number {
    if (
      orchestration.maxQuestionRounds !== undefined &&
      orchestration.maxQuestionRounds >= 0
    ) {
      return orchestration.maxQuestionRounds;
    }
    const raw = process.env.AGENT_BRIDGE_PLAN_QUESTION_ROUNDS;
    if (raw === undefined) return DEFAULT_PLAN_QUESTION_ROUND_LIMIT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_PLAN_QUESTION_ROUND_LIMIT;
  }

  // What the plan prompt is told about its remaining question budget: the exact
  // number left, so the leader can ration rounds instead of discovering the wall
  // only when it hits it.
  function renderQuestionBudget(
    orchestration: Orchestration,
    rounds: number,
  ): { questionRoundsLeft: number; noMoreQuestions: boolean } {
    const left = Math.max(0, planQuestionRoundLimit(orchestration) - rounds);
    return { questionRoundsLeft: left, noMoreQuestions: left === 0 };
  }

  function planQuestionRounds(
    store: MemoryStore,
    orchestrationId: string,
  ): number {
    return store
      .listOrchestrationEvents({ orchestrationId, limit: 1000 })
      .filter(
        (event) =>
          event.kind === "user_action" &&
          event.phase === "plan" &&
          event.summary?.startsWith(PLAN_QUESTION_EVENT_PREFIX),
      ).length;
  }

  function buildPlanRevision(
    store: MemoryStore,
    orchestration: Orchestration,
    deps: OrchestratorDeps,
  ): PlanRevisionInput | undefined {
    void deps;
    const events = store.listOrchestrationEvents({
      orchestrationId: orchestration.id,
      limit: 1000,
    });
    let latest: ChangeRequestPayload | undefined;
    for (const event of events) {
      if (event.kind !== "user_action" || !event.payload) continue;
      const parsed = operations.safeParse<ChangeRequestPayload>(event.payload);
      if (parsed?.type === "change-request") {
        latest = parsed;
        break;
      }
    }
    if (!latest) return undefined;

    const subtasks = store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    });
    const subtaskTitleById = new Map(
      subtasks.map((subtask) => [subtask.id, subtask.title]),
    );
    return {
      request: latest.request,
      previousPlan: latest.previousPlan,
      previousReport: latest.previousReport,
      previousSubtasks: subtasks.map((subtask) => ({
        title: subtask.title,
        status: subtask.status,
      })),
      previousReviews: store
        .listReviews({ taskId: orchestration.taskId, limit: 200 })
        .map((review) => ({
          subtaskTitle:
            (review.subtaskId && subtaskTitleById.get(review.subtaskId)) || "",
          verdict: review.verdict,
          summary: review.summary,
        })),
    };
  }

  function applyPlanTurn(
    store: MemoryStore,
    orchestration: Orchestration,
    turn: LeaderPlanTurn,
    deps: OrchestratorDeps,
    finishedRunId?: string,
  ): OrchestrationStepResult {
    // Record the draft before anything can return early. The question branch
    // below parks the orchestration without ever writing a plan file, so this is
    // the only place the leader's own draft survives to the next round — and its
    // absence is what made that round re-plan from the goal.
    recordPlanDraft(store, orchestration, turn);

    // Questions from a plan turn are gating, not decorative: the leader is
    // saying it had to guess. Applying the plan anyway bakes those guesses into
    // subtasks that implementers then build. Park the orchestration until the
    // user answers (or dismisses) them, then re-plan with the answers in hand.
    const unanswered = pendingQuestionsFor(
      store,
      orchestration,
      turn.questions,
    );
    const rounds = planQuestionRounds(store, orchestration.id);
    if (unanswered.length && rounds < planQuestionRoundLimit(orchestration)) {
      for (const question of unanswered)
        createQuestion(store, orchestration, question);
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError: `Leader asked ${unanswered.length} question(s) before it can plan properly. Answer them to continue.`,
        }) ?? orchestration;
      operations.recordEvent(
        store,
        updated,
        "plan",
        "user_action",
        `${PLAN_QUESTION_EVENT_PREFIX} ${unanswered.length} planning question(s); awaiting answers.`,
      );
      return operations.result(
        updated,
        `Leader raised ${unanswered.length} question(s); paused for your answers.`,
        [],
      );
    }
    // Past the limit the questions are no longer gating: parking again is what
    // produced the plan/answer/re-plan loop, since a reworded question never
    // matches an already-settled one. Record them and plan on with whatever the
    // leader assumed — the no-subtask branch below still stops for the user if
    // the turn produced nothing usable.
    if (unanswered.length) {
      operations.recordEvent(
        store,
        orchestration,
        "plan",
        "user_action",
        `Leader asked ${unanswered.length} more question(s) after ${rounds} answered round(s); proceeding on its stated assumptions.`,
      );
    }

    // "Nothing left to build" is a real answer on a re-plan: the change request
    // may already be satisfied by what exists. Finish instead of failing. On a
    // first plan it means the leader produced nothing usable, which is a failure
    // the user has to see.
    const ctx = deps.contextStoreFor?.(orchestration.id);
    const revision = buildPlanRevision(store, orchestration, deps);
    const revisionEntry = revision
      ? {
          trigger: `change request — ${revision.request}`,
          change: turn.planMarkdown.split("\n")[0] ?? "re-planned",
        }
      : {
          trigger: "re-plan",
          change: turn.planMarkdown.split("\n")[0] ?? "re-planned",
        };

    if (!turn.subtasks.length) {
      const planPath = operations.writePlanDocument(
        orchestration,
        deps,
        ctx,
        turn.planMarkdown,
        revisionEntry,
      );
      const existing = store.listSubtasks({
        parentTaskId: orchestration.taskId,
        limit: 500,
      });
      if (!existing.length) {
        createQuestion(store, orchestration, {
          question: `Leader planned no subtasks at all. Its reasoning: ${operations.safeTail(turn.planMarkdown, 400)}`,
          options: [],
        });
        const updated =
          store.updateOrchestration(orchestration.id, {
            status: "paused",
            planPath,
            lastError: "Leader returned a plan with no subtasks.",
          }) ?? orchestration;
        return operations.result(
          updated,
          "Leader produced no subtasks; paused for your input.",
          [],
        );
      }
      const superseded = existing.filter(
        (subtask) => !["done", "cancelled"].includes(subtask.status),
      );
      for (const subtask of superseded) {
        store.updateSubtask(subtask.id, {
          status: "cancelled",
          statusReason:
            "Superseded when the leader found no work left in the newer plan.",
        });
      }
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "reporting",
          complexity: turn.complexity,
          planPath,
        }) ?? orchestration;
      operations.recordEvent(
        store,
        updated,
        "plan",
        "leader_turn",
        `Leader found no work left to do; cancelled ${superseded.length} open subtask(s) from the superseded plan and is going to reporting.`,
      );
      if (finishedRunId)
        operations.recordEvent(
          store,
          updated,
          "plan",
          "run_ended",
          `Consumed plan run ${finishedRunId}.`,
        );
      return operations.result(
        updated,
        "Leader found nothing left to build; ready for reporting.",
        [],
      );
    }

    const roles = store.ensureDefaultWorkforceRoles();
    const subtaskIdByKey = new Map<string, string>();
    // `orchestration.cycle` is a rework budget and is reset to 1 whenever a new
    // plan is applied. It therefore cannot namespace plan keys: two replans that
    // both happen at cycle 1 would overwrite each other's c1-s1 context folder.
    // Use the monotonic plan application number instead.
    const planContextCycle = operations.nextPlanContextCycle(
      store,
      orchestration.id,
    );

    for (const item of turn.subtasks) {
      const subtask = store.createSubtask({
        parentTaskId: orchestration.taskId,
        title: item.title,
        goal: item.goal,
        priority: item.priority,
        acceptanceCriteria: item.acceptanceCriteria,
      });
      subtaskIdByKey.set(item.key, subtask.id);
    }
    for (const item of turn.subtasks) {
      const dependsOn = item.dependsOn
        .map((key) => subtaskIdByKey.get(key))
        .filter((id): id is string => Boolean(id));
      if (dependsOn.length)
        store.updateSubtask(subtaskIdByKey.get(item.key)!, { dependsOn });
      operations.recordSubtaskMeta(store, orchestration, {
        type: "subtask",
        key: item.key,
        subtaskId: subtaskIdByKey.get(item.key)!,
        planCycle: planContextCycle,
        role: item.role,
        parallelSafe: item.parallelSafe,
        files: item.files,
        agentPreference: item.agentPreference,
      });
    }
    for (const reviewer of turn.reviewers) {
      const scope = reviewer.scope
        .map((key) => ({ key, subtaskId: subtaskIdByKey.get(key) }))
        .filter((entry): entry is { key: string; subtaskId: string } =>
          Boolean(entry.subtaskId),
        );
      operations.recordReviewerMeta(store, orchestration, {
        type: "reviewer",
        reviewerKey: reviewer.key,
        scope,
        role: reviewer.role,
        agentPreference: reviewer.agentPreference,
      });
    }

    // A re-plan supersedes the previous one — the leader is told to plan only
    // the work that is still needed — so every non-terminal subtask it did not
    // carry over is stale. This includes `review`: reviewer scopes are replaced
    // by the new plan, so those rows otherwise wait for a reviewer forever.
    const planned = new Set(subtaskIdByKey.values());
    const superseded = store
      .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
      .filter(
        (subtask) =>
          !["done", "cancelled"].includes(subtask.status) &&
          !planned.has(subtask.id),
      );
    for (const subtask of superseded) {
      store.updateSubtask(subtask.id, {
        status: "cancelled",
        statusReason: "Superseded by a newer leader plan.",
      });
      for (const review of store.listReviews({
        subtaskId: subtask.id,
        consumed: false,
      })) {
        store.markReviewConsumed(review.id);
      }
    }
    if (superseded.length) {
      operations.recordEvent(
        store,
        orchestration,
        "plan",
        "leader_turn",
        `Cancelled ${superseded.length} unstarted subtask(s) left over from the superseded plan.`,
      );
    }

    const planPath = operations.writePlanDocument(
      orchestration,
      deps,
      ctx,
      turn.planMarkdown,
      revisionEntry,
    );
    const updated =
      store.updateOrchestration(orchestration.id, {
        status: "executing",
        complexity: turn.complexity,
        planPath,
        cycle: 1,
      }) ?? orchestration;
    if (ctx) operations.refreshContextIndex(store, updated, ctx);
    operations.recordEvent(
      store,
      updated,
      "plan",
      "leader_turn",
      `Leader produced ${turn.subtasks.length} subtask(s) and ${turn.reviewers.length} reviewer group(s).`,
    );
    // Marks this plan run consumed so a later change request re-enters planning
    // with a clean slate instead of re-applying this same plan.
    if (finishedRunId)
      operations.recordEvent(
        store,
        updated,
        "plan",
        "run_ended",
        `Consumed plan run ${finishedRunId}.`,
      );
    void roles; // roles are ensured as a side effect (seeds defaults for later lookups)
    return operations.result(
      updated,
      `Plan applied: ${turn.subtasks.length} subtask(s), ${turn.reviewers.length} reviewer group(s).`,
      [],
    );
  }

  function createQuestion(
    store: MemoryStore,
    orchestration: Orchestration,
    question: LeaderQuestion,
    // Set when the orchestrator itself acts on the answer rather than only
    // replaying it to the leader, so the row can be found again by machine
    // instead of by matching its prose.
    kind?: string,
  ): void {
    const payload = {
      ...(question.options.length ? { options: question.options } : {}),
      ...(kind ? { kind } : {}),
    };
    store.createAgentRequest({
      taskId: orchestration.taskId,
      type: "question",
      title: question.question,
      // Options ride in the payload so the dashboard can offer them as choices
      // instead of a blank box; the title stays the plain question text, which
      // is what the answered/settled bookkeeping matches on.
      payload: Object.keys(payload).length
        ? JSON.stringify(payload)
        : undefined,
    });
  }
  return {
    stepPlanning,
    pendingQuestionsFor,
    allQuestionAnswers,
    planQuestionRoundLimit,
    renderQuestionBudget,
    planQuestionRounds,
    buildPlanRevision,
    applyPlanTurn,
    createQuestion,
  };
}
