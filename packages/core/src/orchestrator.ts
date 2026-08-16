import type {
  AgentRun,
  AgentRunPhase,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
  Subtask,
} from "@agent-bridge/memory";
import { agentSupportsCapabilities, resolveAgentForPreference, uniqueAgentName } from "./agent-selector.js";
import {
  buildRetryPrompt,
  parseLeaderTurn,
  type LeaderAgentPreference,
  type LeaderAdjudicateTurn,
  type LeaderPlanTurn,
  type LeaderQuestion,
} from "./leader-contract.js";
import { renderAdjudicatePrompt, renderPlanPrompt, type PlanRevisionInput } from "./leader-prompts.js";
import { parseReviewTurn, renderReviewerPrompt, renderReviewRetryPrompt } from "./review-contract.js";

export type SpawnAgentTurnInput = {
  agent: RegisteredAgent;
  prompt: string;
  taskId: string;
  orchestrationId: string;
  // Lets the caller stamp the run with the cycle it belongs to, so the Runs
  // board can show just this round instead of everything ever spawned.
  cycle: number;
  phase: AgentRunPhase;
  subtaskId?: string;
  assignmentId?: string;
  workforceId?: string;
  roleId?: string;
};

export type OrchestratorDeps = {
  // Spawns (or, in tests, fabricates) an agent run for the given turn and
  // returns it. Real callers wire this to buildSpawnPreview + spawnAgentRun
  // from @agent-bridge/adapters — core cannot depend on adapters (adapters
  // already depends on core), so this stays injected.
  spawn: (input: SpawnAgentTurnInput) => AgentRun;
  // Returns the (already redacted) output of a finished run.
  readLog: (run: AgentRun) => string;
  // Persists the leader's plan markdown and returns its path.
  writePlanFile: (markdown: string) => string;
  // Which CLI providers this machine can actually launch, with their usable
  // model ids. Injected because "is the claude CLI on PATH" is an adapters/CLI
  // concern. No longer used to widen the leader's staffing options — only
  // registered, enabled agents are offered now — but still accepted so the CLI
  // and dashboard can keep reporting what is installed.
  listProviders?: () => ProviderOption[];
  // Maps a provider to the executable that launches it. Needed for auto-staffing:
  // an agent row whose command is just the provider name spawns nothing for
  // providers whose CLI is named differently (antigravity's binary is `agy`),
  // and "spawn antigravity ENOENT" is a worse failure than not staffing at all.
  defaultCommandFor?: (provider: string) => string | undefined;
};

export type ProviderOption = { provider: string; models: string[] };

export type OrchestrationStepResult = {
  orchestration: Orchestration;
  summary: string;
  spawnedRunIds: string[];
  // Set when this step could not proceed because an approval is still pending:
  // the createdAt of the oldest one. Callers that keep stepping on a timer use
  // it to stop spinning on a run that is waiting on a human (see the UI's
  // auto-run loop), and to say how long it has been waiting.
  awaitingApprovalSince?: string;
};

const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);
// "detached" (process died without a normal exit event, e.g. reaped after a
// crash) and "stopped" (user cancelled it) are just as final as "failed" —
// without them here a dead run is neither active nor finished, so the
// orchestrator step logic stalls forever instead of reading the log and
// surfacing the failure.
const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "detached", "stopped"]);
// How much of an implementer's log is kept as its assignment summary.
const ASSIGNMENT_SUMMARY_CHARS = 800;

// Advances an orchestration by exactly one step. Callers (CLI `workforce
// step`/`watch`) are expected to have already called reapAgentRuns for this
// task so run statuses reflect reality before this is called.
export function stepOrchestration(
  store: MemoryStore,
  orchestrationId: string,
  deps: OrchestratorDeps,
): OrchestrationStepResult {
  const orchestration = store.getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Orchestration not found: ${orchestrationId}`);

  if (["done", "failed", "paused"].includes(orchestration.status)) {
    return noop(orchestration, `Orchestration is ${orchestration.status}; nothing to do.`);
  }

  if (orchestration.cycle > orchestration.maxCycles) {
    const updated = store.updateOrchestration(orchestration.id, {
      status: "failed",
      lastError: `Exceeded max_cycles (${orchestration.maxCycles}).`,
    }) ?? orchestration;
    createQuestion(store, updated, { question: `Orchestration exceeded ${orchestration.maxCycles} cycles without completing.`, options: [] });
    return noop(updated, "Exceeded max cycles; marked failed and raised a question for the user.");
  }

  switch (orchestration.status) {
    case "planning":
      return stepPlanning(store, orchestration, deps);
    case "executing":
      return stepExecuting(store, orchestration, deps);
    case "adjudicating":
      return stepAdjudicating(store, orchestration, deps);
    case "reporting":
      return noop(orchestration, "Awaiting `report generate` to finish this orchestration.");
    default:
      return noop(orchestration, `Unhandled orchestration status: ${orchestration.status}.`);
  }
}

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
  if (active) return noop(orchestration, `Leader is still planning (run ${active.id}).`);

  // Consumed plan runs are excluded so a change request can send a finished
  // orchestration back to planning: without this the old, already-applied plan
  // run would be re-parsed and its subtasks created a second time.
  const finished = latestByCreatedAt(
    planRuns.filter(
      (run) => TERMINAL_RUN_STATUSES.has(run.status) && !isRunConsumed(store, orchestration.id, run.id),
    ),
  );
  const buildPrompt = () => {
    const task = mustGetTask(store, orchestration.taskId);
    return renderPlanPrompt({
      taskTitle: task.title,
      goal: task.goal,
      maxParallel: orchestration.maxParallel,
      ...resolveProviderOptions(store, orchestration, deps),
      revision: buildPlanRevision(store, orchestration, deps),
      answers: latestQuestionAnswers(store, orchestration.id),
    });
  };

  if (!finished) {
    const key = `plan:${planRuns.length}`;
    const leaderAgent = agentForKey(store, orchestration, key) ?? mustGetAgent(store, orchestration.leaderAgentId);
    const gated = gateSpawn(
      store,
      orchestration,
      key,
      `Run the planning turn with ${describeAgent(leaderAgent)}`,
      leaderAgent.id,
    );
    if (gated) return gated;
    const run = spawnTurn(deps, store, orchestration, leaderAgent, buildPrompt(), "plan");
    return result(orchestration, "Spawned the leader's plan turn.", [run.id]);
  }

  const parsed = resolveLeaderReply(finished, deps, (text) => parseLeaderTurn(text, "plan"));
  if (!parsed.ok) {
    return handleLeaderParseFailure(store, orchestration, deps, "plan", parsed.error, buildPrompt, finished);
  }

  return applyPlanTurn(store, orchestration, parsed.turn, deps, finished.id);
}

// Which phase a paused orchestration should come back to. Resuming blindly
// into "executing" is wrong when the pause happened during planning (e.g. two
// failed leader parses): with no subtasks to dispatch, stepExecuting would
// jump straight to adjudication and the plan turn would never be retried.
// The newest recorded event's phase is the most reliable marker of where it
// actually stopped.
export function resumeStatusFor(
  store: MemoryStore,
  orchestrationId: string,
): "planning" | "executing" | "adjudicating" {
  const [newest] = store.listOrchestrationEvents({ orchestrationId, limit: 1 });
  if (newest?.phase === "plan") return "planning";
  if (newest?.phase === "adjudicate") return "adjudicating";
  return "executing";
}

// The change request (and the prior plan/report text the caller captured for
// it) is recorded as an orchestration event rather than a column: it is a
// point-in-time user action, and core stays free of filesystem access by
// having the caller pass the file contents in.
export const CHANGE_REQUEST_EVENT_PREFIX = "change-request:";

export type ChangeRequestPayload = {
  type: "change-request";
  request: string;
  previousPlan?: string;
  previousReport?: string;
};

// --- approve-each ------------------------------------------------------
//
// "approve-each" means every agent the orchestrator wants to launch needs a
// human yes first. The gate has to sit *before* the side effects of a spawn
// (assignment rows, subtask status changes), so it is checked at each call
// site rather than inside spawnTurn.
//
// The approval is an agent_request row keyed by what it authorises, so
// re-stepping finds the same decision instead of asking again.
export type SpawnApprovalPayload = {
  type: "spawn-approval";
  key: string;
  orchestrationId: string;
  // The agent the orchestrator intended to use, so the dashboard can offer to
  // swap it for another one instead of only accept/reject.
  agentId?: string;
};

// What the user sent back when they resolved the approval. Approving with a
// different agent is a third answer beyond yes/no: the work is authorised, but
// somebody else does it.
export type SpawnApprovalResponse = {
  type: "spawn-approval-response";
  agentId?: string;
  note?: string;
};

function approvalFor(
  store: MemoryStore,
  orchestration: Orchestration,
  key: string,
): { id: string; status: string; createdAt: string; response?: string } | undefined {
  for (const request of store.listAgentRequests({ taskId: orchestration.taskId, limit: 500 })) {
    if (request.type !== "approval" || !request.payload) continue;
    const parsed = safeParse<SpawnApprovalPayload>(request.payload);
    if (parsed?.type === "spawn-approval" && parsed.key === key && parsed.orchestrationId === orchestration.id) {
      return { id: request.id, status: request.status, createdAt: request.createdAt, response: request.response };
    }
  }
  return undefined;
}

// The agent the user picked when they approved this key, if they overrode the
// orchestrator's choice. Read at spawn time, so the swap survives a restart
// and applies to the retry of a step just as much as to the first attempt.
export function approvedAgentOverride(
  store: MemoryStore,
  orchestration: Orchestration,
  key: string,
): string | undefined {
  const existing = approvalFor(store, orchestration, key);
  if (existing?.status !== "accepted" || !existing.response) return undefined;
  const parsed = safeParse<SpawnApprovalResponse>(existing.response);
  return parsed?.type === "spawn-approval-response" ? parsed.agentId : undefined;
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

type SpawnGate =
  // Approved, or no gate at all.
  | { decision: "go" }
  // Waiting on the user. The caller may still gate other work in the same step
  // — one unanswered approval must not hold up subtasks that could run now.
  | { decision: "wait"; result: OrchestrationStepResult; since: string }
  // The user said no to a piece of work the run can survive without: only that
  // piece is dropped, the caller decides how to record it.
  | { decision: "rejected" }
  // The user said no to something the run cannot continue past (the plan turn,
  // adjudication, a review): the orchestration pauses.
  | { decision: "halt"; result: OrchestrationStepResult };

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
      result: { ...noop(orchestration, `Waiting for your approval: ${description}`), awaitingApprovalSince: existing.createdAt },
    };
  }
  if (existing?.status === "rejected") {
    if (onReject === "skip") return { decision: "rejected" };
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: `You rejected: ${description}`,
    }) ?? orchestration;
    return { decision: "halt", result: result(updated, `Rejected: ${description}. Paused.`, []) };
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
  recordEvent(store, orchestration, "plan", "user_action", `Approval requested: ${description}`);
  return {
    decision: "wait",
    since: request.createdAt,
    result: { ...noop(orchestration, `Approval requested: ${description}`), awaitingApprovalSince: request.createdAt },
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
  const gate = gateSpawnDetailed(store, orchestration, key, description, agentId);
  // "rejected" never comes back here: this wrapper is only used by the gates
  // that pause on a no.
  return gate.decision === "go" || gate.decision === "rejected" ? undefined : gate.result;
}

export type QuestionAnswersPayload = {
  type: "question-answers";
  answers: Array<{ question: string; answer: string }>;
};

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
  for (const request of store.listAgentRequests({ taskId: orchestration.taskId, limit: 500 })) {
    if (request.type === "question" && request.status !== "pending") settled.add(request.title);
  }
  return questions.filter((question) => !settled.has(question.question));
}

// The most recent batch of answers the user sent back, for the next plan turn.
function latestQuestionAnswers(
  store: MemoryStore,
  orchestrationId: string,
): Array<{ question: string; answer: string }> | undefined {
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "user_action" || !event.payload) continue;
    const parsed = safeParse<QuestionAnswersPayload>(event.payload);
    if (parsed?.type === "question-answers") return parsed.answers;
  }
  return undefined;
}

function buildPlanRevision(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
): PlanRevisionInput | undefined {
  void deps;
  const events = store.listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 1000 });
  let latest: ChangeRequestPayload | undefined;
  for (const event of events) {
    if (event.kind !== "user_action" || !event.payload) continue;
    const parsed = safeParse<ChangeRequestPayload>(event.payload);
    if (parsed?.type === "change-request") {
      latest = parsed;
      break;
    }
  }
  if (!latest) return undefined;

  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const subtaskTitleById = new Map(subtasks.map((subtask) => [subtask.id, subtask.title]));
  return {
    request: latest.request,
    previousPlan: latest.previousPlan,
    previousReport: latest.previousReport,
    previousSubtasks: subtasks.map((subtask) => ({ title: subtask.title, status: subtask.status })),
    previousReviews: store.listReviews({ taskId: orchestration.taskId, limit: 200 }).map((review) => ({
      subtaskTitle: (review.subtaskId && subtaskTitleById.get(review.subtaskId)) || "",
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
  // Questions from a plan turn are gating, not decorative: the leader is
  // saying it had to guess. Applying the plan anyway bakes those guesses into
  // subtasks that implementers then build. Park the orchestration until the
  // user answers (or dismisses) them, then re-plan with the answers in hand.
  const unanswered = pendingQuestionsFor(store, orchestration, turn.questions);
  if (unanswered.length) {
    for (const question of unanswered) createQuestion(store, orchestration, question);
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: `Leader asked ${unanswered.length} question(s) before it can plan properly. Answer them to continue.`,
    }) ?? orchestration;
    recordEvent(store, updated, "plan", "user_action", `Leader raised ${unanswered.length} planning question(s); awaiting answers.`);
    return result(updated, `Leader raised ${unanswered.length} question(s); paused for your answers.`, []);
  }

  // "Nothing left to build" is a real answer on a re-plan: the change request
  // may already be satisfied by what exists. Finish instead of failing. On a
  // first plan it means the leader produced nothing usable, which is a failure
  // the user has to see.
  if (!turn.subtasks.length) {
    const planPath = deps.writePlanFile(turn.planMarkdown);
    const existing = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
    if (!existing.length) {
      createQuestion(store, orchestration, {
        question: `Leader planned no subtasks at all. Its reasoning: ${safeTail(turn.planMarkdown, 400)}`,
        options: [],
      });
      const updated = store.updateOrchestration(orchestration.id, {
        status: "paused",
        planPath,
        lastError: "Leader returned a plan with no subtasks.",
      }) ?? orchestration;
      return result(updated, "Leader produced no subtasks; paused for your input.", []);
    }
    const updated = store.updateOrchestration(orchestration.id, {
      status: "reporting",
      complexity: turn.complexity,
      planPath,
    }) ?? orchestration;
    recordEvent(store, updated, "plan", "leader_turn", "Leader found no work left to do; going straight to reporting.");
    if (finishedRunId) recordEvent(store, updated, "plan", "run_ended", `Consumed plan run ${finishedRunId}.`);
    return result(updated, "Leader found nothing left to build; ready for reporting.", []);
  }

  const roles = store.ensureDefaultWorkforceRoles();
  const subtaskIdByKey = new Map<string, string>();

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
    const dependsOn = item.dependsOn.map((key) => subtaskIdByKey.get(key)).filter((id): id is string => Boolean(id));
    if (dependsOn.length) store.updateSubtask(subtaskIdByKey.get(item.key)!, { dependsOn });
    recordSubtaskMeta(store, orchestration, {
      type: "subtask",
      key: item.key,
      subtaskId: subtaskIdByKey.get(item.key)!,
      role: item.role,
      parallelSafe: item.parallelSafe,
      files: item.files,
      agentPreference: item.agentPreference,
    });
  }
  for (const reviewer of turn.reviewers) {
    const scope = reviewer.scope
      .map((key) => ({ key, subtaskId: subtaskIdByKey.get(key) }))
      .filter((entry): entry is { key: string; subtaskId: string } => Boolean(entry.subtaskId));
    recordReviewerMeta(store, orchestration, {
      type: "reviewer",
      reviewerKey: reviewer.key,
      scope,
      role: reviewer.role,
      agentPreference: reviewer.agentPreference,
    });
  }

  // A re-plan supersedes the previous one — the leader is told to plan only
  // the work that is still needed — so subtasks it did not carry over are
  // stale. Leaving them "todo" strands them: reviewer keys are reused, so the
  // new scope replaced the old one and nothing would ever review them, and
  // anything depending on them could never start.
  const planned = new Set(subtaskIdByKey.values());
  const superseded = store
    .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
    .filter((subtask) => subtask.status === "todo" && !planned.has(subtask.id));
  for (const subtask of superseded) store.updateSubtask(subtask.id, { status: "cancelled" });
  if (superseded.length) {
    recordEvent(
      store,
      orchestration,
      "plan",
      "leader_turn",
      `Cancelled ${superseded.length} unstarted subtask(s) left over from the superseded plan.`,
    );
  }

  const planPath = deps.writePlanFile(turn.planMarkdown);
  const updated = store.updateOrchestration(orchestration.id, {
    status: "executing",
    complexity: turn.complexity,
    planPath,
    cycle: 1,
  }) ?? orchestration;
  recordEvent(store, updated, "plan", "leader_turn", `Leader produced ${turn.subtasks.length} subtask(s) and ${turn.reviewers.length} reviewer group(s).`);
  // Marks this plan run consumed so a later change request re-enters planning
  // with a clean slate instead of re-applying this same plan.
  if (finishedRunId) recordEvent(store, updated, "plan", "run_ended", `Consumed plan run ${finishedRunId}.`);
  void roles; // roles are ensured as a side effect (seeds defaults for later lookups)
  return result(updated, `Plan applied: ${turn.subtasks.length} subtask(s), ${turn.reviewers.length} reviewer group(s).`, []);
}

// ---------------------------------------------------------------------------
// Executing phase
// ---------------------------------------------------------------------------

function stepExecuting(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
): OrchestrationStepResult {
  const pendingReviews = store.listReviews({ taskId: orchestration.taskId, consumed: false });
  if (pendingReviews.length) {
    const updated = store.updateOrchestration(orchestration.id, { status: "adjudicating" }) ?? orchestration;
    return result(updated, `${pendingReviews.length} review(s) pending; moving to adjudication.`, []);
  }

  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const activeRuns = store.listAgentRuns({ orchestrationId: orchestration.id, limit: 500 });

  // 1) Spawn implementers for anything dispatchable, up to maxParallel.
  const doneIds = new Set(subtasks.filter((subtask) => subtask.status === "done").map((subtask) => subtask.id));
  const hasRun = (subtaskId: string) =>
    activeRuns.some((run) => run.subtaskId === subtaskId && run.status !== "stopped");
  const dispatchable = subtasks
    .filter((subtask) => subtask.status === "todo")
    .filter((subtask) => subtask.dependsOn.every((depId) => doneIds.has(depId)))
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
      const candidate = tryResolveAgent(() => resolveImplementerAgent(store, orchestration, subtask, deps));
      const gate = gateSpawnDetailed(
        store,
        orchestration,
        `implement:${subtask.id}`,
        `Assign "${subtask.title}" to ${describeAgent(candidate)} and start it`,
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
        store.updateSubtask(subtask.id, { status: "blocked" });
        recordEvent(
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
        if (!waitingSince || gate.since < waitingSince) waitingSince = gate.since;
        continue;
      }
      spawnedRunIds.push(spawnImplementer(store, orchestration, subtask, deps).id);
    }
    const blocked = rejectedCount ? ` Blocked ${rejectedCount} you rejected.` : "";
    if (spawnedRunIds.length) {
      const waiting = waitingCount ? ` ${waitingCount} more await your approval.` : "";
      return {
        ...result(orchestration, `Spawned ${spawnedRunIds.length} implementer run(s).${waiting}${blocked}`, spawnedRunIds),
        awaitingApprovalSince: waitingSince,
      };
    }
    if (waitingCount) {
      return {
        ...noop(orchestration, `Waiting for your approval on ${waitingCount} agent assignment(s).${blocked}`),
        awaitingApprovalSince: waitingSince,
      };
    }
    if (rejectedCount) {
      return result(orchestration, `Blocked ${rejectedCount} subtask(s) you rejected; nothing else was dispatchable.`, []);
    }
  }

  // 2) Reconcile implementer runs that finished since the last step.
  const finishedImplementerRuns = activeRuns.filter(
    (run) => run.phase === "implement" && TERMINAL_RUN_STATUSES.has(run.status) && run.subtaskId,
  );
  for (const run of finishedImplementerRuns) {
    const subtask = subtasks.find((candidate) => candidate.id === run.subtaskId);
    if (!subtask || (subtask.status !== "assigned" && subtask.status !== "in_progress")) continue;
    // "detached" only means the process vanished before a clean exit event
    // reached us — with agents spawned by one process and reaped by another
    // that is routine, and the work is usually finished (observed live: a
    // detached implementer had written 12KB of correct code). Send it to
    // review rather than blocking: the reviewer catches genuinely incomplete
    // work cheaply, whereas a false "blocked" throws the work away and stalls
    // the whole orchestration. Only a real failure or a user cancellation
    // blocks.
    const treatAsFailure = run.status === "failed" || run.status === "stopped";
    const nextStatus = treatAsFailure ? "blocked" : "review";
    store.updateSubtask(subtask.id, { status: nextStatus });
    if (run.assignmentId) {
      store.updateAssignment(run.assignmentId, {
        status: treatAsFailure ? "failed" : "waiting",
        // Deliberately short. Every assignment's resultSummary is replayed into
        // the reviewer prompt and into every later reporter prompt, so this is
        // per-subtask context that accumulates for the whole project — 2000
        // chars each measured ~2.5k tokens on a 12-assignment task. The tail of
        // an agent log is its closing summary, which fits comfortably here.
        resultSummary: safeTail(deps.readLog(run), ASSIGNMENT_SUMMARY_CHARS),
      });
    }
    recordEvent(store, orchestration, "implement", "run_ended", `Implementer run ${run.id} finished (${run.status}) for ${subtask.title}.`);
    return result(orchestration, `Recorded completion of implementer run ${run.id}.`, []);
  }

  // 3) Parse finished reviewer runs into `reviews` rows FIRST — before
  // considering spawning a new reviewer for the same scope. Otherwise a
  // reviewer run that just finished but hasn't been parsed yet would look
  // identical to "no reviewer has ever covered this subtask" and get a
  // duplicate reviewer spawned on top of it every step.
  const reviewerMetas = listReviewerMetas(store, orchestration.id);
  const finishedReviewerRuns = activeRuns.filter(
    (run) => run.phase === "review" && TERMINAL_RUN_STATUSES.has(run.status),
  );
  const assignmentsById = new Map(
    store.listAssignments({ taskId: orchestration.taskId, limit: 500 }).map((item) => [item.id, item]),
  );
  for (const run of finishedReviewerRuns) {
    if (!run.assignmentId) continue;
    if (isRunConsumed(store, orchestration.id, run.id)) continue;
    // A retry run and the run it replaced share one assignment. Once either of
    // them has delivered the verdicts, the others have nothing left to say —
    // re-parsing their truncated logs would only fail and drag the whole
    // orchestration into the parse-failure path a second time.
    if (assignmentsById.get(run.assignmentId)?.status === "done") {
      consumeRun(store, orchestration, "review", run, "superseded by another turn on the same assignment");
      continue;
    }

    if (run.status === "failed") {
      recordEvent(store, orchestration, "review", "run_ended", `Reviewer run ${run.id} failed to execute.`);
      return result(orchestration, `Reviewer run ${run.id} failed; leader will see this at adjudication.`, []);
    }

    const reviewerMeta = findReviewerMetaForRun(store, orchestration.id, run, reviewerMetas);
    const parsed = parseReviewTurn(deps.readLog(run));
    if (!parsed.ok) {
      return handleReviewParseFailure(store, orchestration, deps, run, reviewerMeta, parsed.error);
    }
    applyReviewTurn(store, orchestration, run, reviewerMeta, parsed.turn.reviews, subtasks);
    recordEvent(store, orchestration, "review", "run_ended", `Reviewer run ${run.id} produced ${parsed.turn.reviews.length} verdict(s).`);
    return result(orchestration, `Recorded ${parsed.turn.reviews.length} review verdict(s) from run ${run.id}.`, []);
  }

  // 4) Spawn reviewer groups covering whichever of their scoped subtasks
  // don't have a review yet. Scope grows over time (a rework subtask is
  // folded into its original reviewer's scope), so only the still-unreviewed
  // members need to be "review"-ready — an older, now-terminal (done/blocked)
  // sibling in the same scope must not block this forever.
  const activeReviewerKeys = new Set(
    activeRuns
      .filter((run) => run.phase === "review" && ACTIVE_STATUSES.has(run.status))
      .map((run) => findReviewerMetaForRun(store, orchestration.id, run, reviewerMetas)?.reviewerKey)
      .filter((key): key is string => Boolean(key)),
  );
  for (const reviewerMeta of reviewerMetas) {
    if (activeReviewerKeys.has(reviewerMeta.reviewerKey)) continue;
    const scopeSubtasks = reviewerMeta.scope
      .map((entry) => ({ entry, subtask: subtasks.find((candidate) => candidate.id === entry.subtaskId) }))
      .filter((pair): pair is { entry: { key: string; subtaskId: string }; subtask: Subtask } => Boolean(pair.subtask));
    const unreviewed = scopeSubtasks.filter(
      (pair) => store.listReviews({ subtaskId: pair.subtask.id, limit: 5 }).length === 0,
    );
    const ready = unreviewed.filter((pair) => pair.subtask.status === "review");
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
      (pair.subtask.status === "todo" && pair.subtask.dependsOn.every((depId) => doneIds.has(depId)));
    if (unreviewed.some((pair) => pair.subtask.status !== "review" && canStillProgress(pair))) continue;
    const reviewKey = `review:${reviewerMeta.reviewerKey}:${ready.map((pair) => pair.entry.key).join(",")}`;
    const candidate = tryResolveAgent(() => resolveReviewerAgent(store, orchestration, reviewerMeta, deps, reviewKey));
    const gated = gateSpawn(
      store,
      orchestration,
      reviewKey,
      `Assign review of ${ready.map((pair) => pair.subtask.title).join(", ")} to ${describeAgent(candidate)}`,
      candidate?.id,
    );
    if (gated) return gated;
    const run = spawnReviewer(store, orchestration, reviewerMeta, ready, deps);
    return result(orchestration, `Spawned reviewer run for ${reviewerMeta.reviewerKey}.`, [run.id]);
  }

  const stillActive = activeRuns.filter((run) => ACTIVE_STATUSES.has(run.status));
  if (stillActive.length) {
    return noop(orchestration, `Waiting on ${stillActive.length} active run(s).`);
  }

  // Nothing left to spawn or reconcile and no active work: ask the leader to
  // confirm completion (or point out what's still missing).
  const updated = store.updateOrchestration(orchestration.id, { status: "adjudicating" }) ?? orchestration;
  return result(updated, "No dispatchable work remains; asking the leader to adjudicate.", []);
}

function spawnImplementer(
  store: MemoryStore,
  orchestration: Orchestration,
  subtask: Subtask,
  deps: OrchestratorDeps,
): AgentRun {
  const meta = getSubtaskMeta(store, orchestration.id, subtask.id);
  const role = mustGetRole(store, meta?.role ?? "implementer");
  const agent = resolveImplementerAgent(store, orchestration, subtask, deps);
  const prompt = renderImplementerPrompt(subtask, meta?.files ?? []);
  const assignment = store.createAssignment({
    taskId: orchestration.taskId,
    subtaskId: subtask.id,
    workforceId: orchestration.workforceId,
    agentId: agent.id,
    roleId: role.id,
    prompt,
  });
  store.updateSubtask(subtask.id, { status: "assigned" });
  const run = spawnTurn(deps, store, orchestration, agent, prompt, "implement", {
    subtaskId: subtask.id,
    assignmentId: assignment.id,
    roleId: role.id,
  });
  recordEvent(store, orchestration, "implement", "spawn", `Spawned implementer for "${subtask.title}" (${run.id}).`);
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
  const chosen = approvedAgentOverride(store, orchestration, `implement:${subtask.id}`);
  if (chosen) {
    const agent = store.getRegisteredAgent(chosen);
    if (agent) return agent;
  }
  const meta = getSubtaskMeta(store, orchestration.id, subtask.id);
  if (meta?.agentPreference) assertProviderAllowed(orchestration, meta.agentPreference.provider, "implementer");
  return resolveStaffAgent(store, orchestration, deps, "implement", meta?.agentPreference);
}

function resolveReviewerAgent(
  store: MemoryStore,
  orchestration: Orchestration,
  reviewerMeta: ReviewerPlanMeta,
  deps: OrchestratorDeps,
  approvalKey: string,
): RegisteredAgent {
  const chosen = approvedAgentOverride(store, orchestration, approvalKey);
  if (chosen) {
    const agent = store.getRegisteredAgent(chosen);
    if (agent) return agent;
  }
  if (reviewerMeta.agentPreference) assertProviderAllowed(orchestration, reviewerMeta.agentPreference.provider, "reviewer");
  return resolveStaffAgent(store, orchestration, deps, "review", reviewerMeta.agentPreference);
}

function spawnReviewer(
  store: MemoryStore,
  orchestration: Orchestration,
  reviewerMeta: ReviewerPlanMeta,
  scopeSubtasks: Array<{ entry: { key: string; subtaskId: string }; subtask: Subtask }>,
  deps: OrchestratorDeps,
): AgentRun {
  const role = mustGetRole(store, reviewerMeta.role ?? "reviewer");
  const agent = resolveReviewerAgent(
    store,
    orchestration,
    reviewerMeta,
    deps,
    `review:${reviewerMeta.reviewerKey}:${scopeSubtasks.map((pair) => pair.entry.key).join(",")}`,
  );
  const task = mustGetTask(store, orchestration.taskId);
  const assignmentsBySubtask = new Map(
    scopeSubtasks.map((pair) => [
      pair.subtask.id,
      latestByCreatedAt(store.listAssignments({ subtaskId: pair.subtask.id, limit: 20 })),
    ]),
  );
  const prompt = renderReviewerPrompt({
    taskTitle: task.title,
    subtasks: scopeSubtasks.map((pair) => ({
      key: pair.entry.key,
      title: pair.subtask.title,
      goal: pair.subtask.goal,
      acceptanceCriteria: pair.subtask.acceptanceCriteria,
      resultSummary: assignmentsBySubtask.get(pair.subtask.id)?.resultSummary,
    })),
  });
  const assignment = store.createAssignment({
    taskId: orchestration.taskId,
    workforceId: orchestration.workforceId,
    agentId: agent.id,
    roleId: role.id,
    prompt,
  });
  const run = spawnTurn(deps, store, orchestration, agent, prompt, "review", {
    assignmentId: assignment.id,
    roleId: role.id,
  });
  recordEvent(
    store,
    orchestration,
    "review",
    "spawn",
    `Spawned reviewer ${reviewerMeta.reviewerKey} for ${scopeSubtasks.map((pair) => pair.entry.key).join(", ")} (${run.id}).`,
  );
  return run;
}

function applyReviewTurn(
  store: MemoryStore,
  orchestration: Orchestration,
  run: AgentRun,
  reviewerMeta: ReviewerPlanMeta | undefined,
  items: Array<{ subtaskKey: string; verdict: "pass" | "rework" | "block"; score?: number; summary: string; findings?: unknown }>,
  subtasks: Subtask[],
): void {
  for (const item of items) {
    const scopeEntry = reviewerMeta?.scope.find((entry) => entry.key === item.subtaskKey);
    const subtaskId = scopeEntry?.subtaskId ?? findSubtaskMetaByKey(store, orchestration.id, item.subtaskKey)?.subtaskId;
    if (!subtaskId) continue;
    const targetAssignment = latestByCreatedAt(store.listAssignments({ subtaskId, limit: 20 }));
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
  if (run.assignmentId) store.updateAssignment(run.assignmentId, { status: "done" });
  void subtasks;
}

// ---------------------------------------------------------------------------
// Adjudicating phase
// ---------------------------------------------------------------------------

function stepAdjudicating(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
): OrchestrationStepResult {
  const adjudicateRuns = store
    .listAgentRuns({ orchestrationId: orchestration.id, limit: 100 })
    .filter((run) => run.phase === "adjudicate");
  const active = adjudicateRuns.find((run) => ACTIVE_STATUSES.has(run.status));
  if (active) return noop(orchestration, `Adjudication is still running (run ${active.id}).`);

  const finished = latestByCreatedAt(
    adjudicateRuns.filter(
      (run) => TERMINAL_RUN_STATUSES.has(run.status) && !isRunConsumed(store, orchestration.id, run.id),
    ),
  );
  if (!finished) {
    const key = `adjudicate:${adjudicateRuns.length}`;
    const adjudicator = findCapabilityAgent(store, "adjudicate", orchestration.teamProviders, orchestration.leaderAgentId);
    const chosen = agentForKey(store, orchestration, key);
    const agent = chosen ?? adjudicator ?? mustGetAgent(store, orchestration.leaderAgentId);
    // A user-picked agent takes the adjudicator seat regardless of who would
    // have had it, unless it is the leader itself — then this is a leader turn.
    const actor = agent.id === orchestration.leaderAgentId ? "leader" : "adjudicator";
    const gated = gateSpawn(
      store,
      orchestration,
      key,
      `Run the ${actor}'s adjudication turn with ${describeAgent(agent)}`,
      agent.id,
    );
    if (gated) return gated;
    const prompt = buildAdjudicationPrompt(store, orchestration, deps, actor);
    const run = spawnTurn(deps, store, orchestration, agent, prompt, "adjudicate");
    recordEvent(store, orchestration, "adjudicate", "spawn", `Spawned ${actor} adjudicate turn (${run.id}).`);
    return result(orchestration, `Spawned the ${actor}'s adjudicate turn.`, [run.id]);
  }

  const parsed = resolveLeaderReply(finished, deps, (text) => parseLeaderTurn(text, "adjudicate"));
  if (!parsed.ok) {
    return handleLeaderParseFailure(store, orchestration, deps, "adjudicate", parsed.error, () => {
      const task = mustGetTask(store, orchestration.taskId);
      return renderAdjudicatePrompt({
        taskTitle: task.title,
        cycle: orchestration.cycle,
        maxCycles: orchestration.maxCycles,
        reviews: [],
        subtasks: [],
      });
    }, finished);
  }

  const isLeader = finished.agentId === orchestration.leaderAgentId;
  if (!isLeader && requiresLeaderAdjudication(store, orchestration, parsed.turn)) {
    consumeRun(store, orchestration, "adjudicate", finished, "escalated its proposal to the Leader");
    const leader = mustGetAgent(store, orchestration.leaderAgentId);
    const proposal = `\`\`\`json\n${JSON.stringify(parsed.turn, null, 2)}\n\`\`\``;
    const prompt = buildAdjudicationPrompt(store, orchestration, deps, "leader", proposal);
    const run = spawnTurn(deps, store, orchestration, leader, prompt, "adjudicate");
    recordEvent(store, orchestration, "adjudicate", "spawn", `Escalated adjudication to Leader (${run.id}).`);
    return result(orchestration, "Adjudicator proposal requires Leader confirmation.", [run.id]);
  }

  return applyAdjudicateTurn(store, orchestration, {
    turn: parsed.turn,
    finishedRunId: finished.id,
    actor: isLeader ? "Leader" : "Adjudicator",
  });
}

function buildAdjudicationPrompt(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  actor: "leader" | "adjudicator",
  adjudicatorProposal?: string,
): string {
  const task = mustGetTask(store, orchestration.taskId);
  const pendingReviews = store.listReviews({ taskId: orchestration.taskId, consumed: false });
  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  return renderAdjudicatePrompt({
    taskTitle: task.title,
    cycle: orchestration.cycle,
    maxCycles: orchestration.maxCycles,
    actor,
    adjudicatorProposal,
    ...resolveProviderOptions(store, orchestration, deps),
    reviews: pendingReviews.map((review) => ({
      subtaskKey: findSubtaskKey(store, orchestration.id, review.subtaskId) ?? review.subtaskId ?? "?",
      subtaskTitle: subtasks.find((subtask) => subtask.id === review.subtaskId)?.title ?? "",
      verdict: review.verdict,
      score: review.score,
      summary: review.summary,
      findings: review.findings,
    })),
    subtasks: subtasks.map((subtask) => ({
      key: findSubtaskKey(store, orchestration.id, subtask.id) ?? subtask.id,
      title: subtask.title,
      status: subtask.status,
      acceptanceCriteria: subtask.acceptanceCriteria,
    })),
  });
}

function requiresLeaderAdjudication(
  store: MemoryStore,
  orchestration: Orchestration,
  turn: LeaderAdjudicateTurn,
): boolean {
  if (turn.projectComplete || turn.questions.length || turn.decisions.some((decision) => decision.verdict === "block")) return true;
  const reviews = store.listReviews({ taskId: orchestration.taskId, consumed: false });
  const verdictsBySubtask = new Map<string, Set<string>>();
  for (const review of reviews) {
    const key = review.subtaskId ?? "?";
    const verdicts = verdictsBySubtask.get(key) ?? new Set<string>();
    verdicts.add(review.verdict);
    verdictsBySubtask.set(key, verdicts);
  }
  if ([...verdictsBySubtask.values()].some((verdicts) => verdicts.size > 1)) return true;
  const riskText = reviews.map((review) => `${review.summary ?? ""} ${review.findings ?? ""}`).join(" ");
  return /\b(security|vulnerab|credential|authentication|authorization|data loss|breaking change|architecture)\b/i.test(riskText);
}

function applyAdjudicateTurn(
  store: MemoryStore,
  orchestration: Orchestration,
  input: { turn: LeaderAdjudicateTurn; finishedRunId: string; actor: "Leader" | "Adjudicator" },
): OrchestrationStepResult {
  const { turn, finishedRunId, actor } = input;
  for (const question of turn.questions) createQuestion(store, orchestration, question);

  let blocked = false;
  for (const decision of turn.decisions) {
    const meta = findSubtaskMetaByKey(store, orchestration.id, decision.subtaskKey);
    const subtaskId = meta?.subtaskId;
    if (!subtaskId) continue;
    const reviews = store.listReviews({ subtaskId, consumed: false });
    for (const review of reviews) store.markReviewConsumed(review.id);
    const targetAssignment = latestByCreatedAt(store.listAssignments({ subtaskId, limit: 20 }));

    if (decision.verdict === "accept") {
      store.updateSubtask(subtaskId, { status: "done" });
      if (targetAssignment) store.updateAssignment(targetAssignment.id, { status: "done" });
    } else if (decision.verdict === "rework" && decision.rework) {
      // "cancelled", not "blocked": a replacement subtask is created right
      // below, so the original is superseded, not stuck. Leaving it "blocked"
      // makes it look like unfinished work forever — enough that the leader
      // later refuses to call the project complete because of it.
      store.updateSubtask(subtaskId, { status: "cancelled" });
      if (targetAssignment) {
        store.updateAssignment(targetAssignment.id, {
          status: "failed",
          resultSummary: `Sent back for rework: ${decision.rework.title}`,
        });
      }
      const reworkSubtask = store.createSubtask({
        parentTaskId: orchestration.taskId,
        title: decision.rework.title,
        goal: decision.rework.goal,
        acceptanceCriteria: decision.rework.acceptanceCriteria,
      });
      const reworkKey = `${decision.subtaskKey}-rework-${orchestration.cycle}`;
      recordSubtaskMeta(store, orchestration, {
        type: "subtask",
        key: reworkKey,
        subtaskId: reworkSubtask.id,
        role: meta?.role,
        parallelSafe: meta?.parallelSafe,
        files: meta?.files ?? [],
        agentPreference: decision.rework.agentPreference ?? meta?.agentPreference,
      });
      // Fold the rework subtask into whichever reviewer originally covered
      // the subtask it replaces, so it gets reviewed again instead of
      // silently skipping review the second time around.
      const owningReviewer = listReviewerMetas(store, orchestration.id).find((candidate) =>
        candidate.scope.some((entry) => entry.key === decision.subtaskKey),
      );
      if (owningReviewer) {
        recordReviewerMeta(store, orchestration, {
          ...owningReviewer,
          scope: [...owningReviewer.scope, { key: reworkKey, subtaskId: reworkSubtask.id }],
        });
      }
    } else if (decision.verdict === "block") {
      store.updateSubtask(subtaskId, { status: "blocked" });
      blocked = true;
    }
  }

  recordEvent(
    store,
    orchestration,
    "adjudicate",
    "verdict",
    `${actor} adjudicated ${turn.decisions.length} decision(s); projectComplete=${turn.projectComplete}.`,
  );
  // Marks finishedRunId as consumed so a later re-entry into "adjudicating"
  // (a new cycle, new pending reviews) spawns a fresh turn instead of
  // re-parsing and re-applying this same decision set again.
  recordEvent(store, orchestration, "adjudicate", "run_ended", `Consumed adjudicate run ${finishedRunId}.`);

  if (blocked) {
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: "One or more subtasks were blocked by the leader; see agent_requests.",
    }) ?? orchestration;
    return result(updated, "Adjudication blocked on one or more subtasks; paused for user input.", []);
  }
  if (turn.projectComplete) {
    const updated = store.updateOrchestration(orchestration.id, { status: "reporting" }) ?? orchestration;
    return result(updated, `${actor} marked the project complete; ready for reporting.`, []);
  }
  // Nothing decided and not complete: execution already reported no
  // dispatchable work, so bumping the cycle would just spawn the same empty
  // adjudicate turn until max_cycles. Stop and ask the user instead.
  if (!turn.decisions.length) {
    createQuestion(store, orchestration, {
      question:
        "Leader adjudicated with no decisions and did not mark the project complete, and there is no dispatchable work left. It needs direction on what remains.",
      options: [],
    });
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: "Leader returned no decisions and did not mark the project complete.",
    }) ?? orchestration;
    return result(updated, "Leader had nothing to decide and would not finish; paused for user input.", []);
  }
  const updated = store.updateOrchestration(orchestration.id, {
    status: "executing",
    cycle: orchestration.cycle + 1,
  }) ?? orchestration;
  return result(updated, "Applied adjudication decisions; resuming execution.", []);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type SubtaskPlanMeta = {
  type: "subtask";
  key: string;
  subtaskId: string;
  role?: string;
  parallelSafe?: boolean;
  files: string[];
  agentPreference?: LeaderAgentPreference;
};

type ReviewerPlanMeta = {
  type: "reviewer";
  reviewerKey: string;
  scope: Array<{ key: string; subtaskId: string }>;
  role?: string;
  agentPreference?: LeaderAgentPreference;
};

function recordSubtaskMeta(store: MemoryStore, orchestration: Orchestration, meta: SubtaskPlanMeta): void {
  store.recordOrchestrationEvent({
    orchestrationId: orchestration.id,
    cycle: orchestration.cycle,
    phase: "plan",
    kind: "leader_turn",
    summary: `subtask-meta:${meta.key}`,
    payload: JSON.stringify(meta),
  });
}

function recordReviewerMeta(store: MemoryStore, orchestration: Orchestration, meta: ReviewerPlanMeta): void {
  store.recordOrchestrationEvent({
    orchestrationId: orchestration.id,
    cycle: orchestration.cycle,
    phase: "plan",
    kind: "leader_turn",
    summary: `reviewer-meta:${meta.reviewerKey}`,
    payload: JSON.stringify(meta),
  });
}

function getSubtaskMeta(store: MemoryStore, orchestrationId: string, subtaskId: string): SubtaskPlanMeta | undefined {
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "leader_turn" || !event.payload) continue;
    const parsed = safeParse<SubtaskPlanMeta>(event.payload);
    if (parsed?.type === "subtask" && parsed.subtaskId === subtaskId) return parsed;
  }
  return undefined;
}

function findSubtaskMetaByKey(
  store: MemoryStore,
  orchestrationId: string,
  key: string,
): SubtaskPlanMeta | undefined {
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "leader_turn" || !event.payload) continue;
    const parsed = safeParse<SubtaskPlanMeta>(event.payload);
    if (parsed?.type === "subtask" && parsed.key === key) return parsed;
  }
  return undefined;
}

function findSubtaskKey(store: MemoryStore, orchestrationId: string, subtaskId: string | undefined): string | undefined {
  if (!subtaskId) return undefined;
  return getSubtaskMeta(store, orchestrationId, subtaskId)?.key;
}

function listReviewerMetas(store: MemoryStore, orchestrationId: string): ReviewerPlanMeta[] {
  const seen = new Set<string>();
  const metas: ReviewerPlanMeta[] = [];
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "leader_turn" || !event.payload) continue;
    const parsed = safeParse<ReviewerPlanMeta>(event.payload);
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
  const events = store.listOrchestrationEvents({ orchestrationId, limit: 1000 });
  const keyForRun = (runId: string): string | undefined =>
    events
      .find((event) => event.kind === "spawn" && event.phase === "review" && event.summary?.includes(`(${runId})`))
      ?.summary?.match(/Spawned reviewer (\S+) for/)?.[1];

  let key = keyForRun(run.id);
  // A retry turn has no reviewer spawn event of its own, so it used to resolve
  // to no reviewer at all: it never counted as an active reviewer, and the same
  // step that started it also started a duplicate reviewer for the very same
  // scope. It does inherit the assignment of the run it replaces, which does
  // have the event.
  if (!key && run.assignmentId) {
    for (const sibling of store.listAgentRuns({ orchestrationId, limit: 500 })) {
      if (sibling.id === run.id || sibling.assignmentId !== run.assignmentId) continue;
      key = keyForRun(sibling.id);
      if (key) break;
    }
  }
  return key ? metas.find((meta) => meta.reviewerKey === key) : undefined;
}

function isRunConsumed(store: MemoryStore, orchestrationId: string, runId: string): boolean {
  return store
    .listOrchestrationEvents({ orchestrationId, limit: 1000 })
    .some((event) => event.kind === "run_ended" && event.summary?.includes(runId));
}

function handleLeaderParseFailure(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  phase: "plan" | "adjudicate",
  error: string,
  buildOriginalPrompt: () => string,
  failedRun?: AgentRun,
): OrchestrationStepResult {
  recordEvent(store, orchestration, phase, "error", `Leader ${phase} output could not be parsed: ${error}`);
  // Consume the run that failed to parse. Without this it stays the newest
  // unconsumed terminal run forever, so the very next step re-parses it, fails
  // again, and spawns yet another retry — the orchestration burns agents while
  // standing still.
  if (failedRun) consumeRun(store, orchestration, phase, failedRun, `could not be parsed (${error})`);
  const priorAttempts = store
    .listAgentRuns({ orchestrationId: orchestration.id, limit: 100 })
    .filter((run) => run.phase === phase && TERMINAL_RUN_STATUSES.has(run.status));
  if (priorAttempts.length >= 2) {
    createQuestion(store, orchestration, { question: `Leader ${phase} output could not be parsed after retrying: ${error}`, options: [] });
    const updated = store.updateOrchestration(orchestration.id, { status: "paused", lastError: error }) ?? orchestration;
    return result(updated, `Leader ${phase} parsing failed twice; paused for user input.`, []);
  }
  const leaderAgent = mustGetAgent(store, orchestration.leaderAgentId);
  const prompt = `${buildOriginalPrompt()}\n\n${buildRetryPrompt(error)}`;
  const run = spawnTurn(deps, store, orchestration, leaderAgent, prompt, phase);
  return result(orchestration, `Retrying leader ${phase} turn after a parse failure.`, [run.id]);
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
  recordEvent(
    store,
    orchestration,
    "review",
    "error",
    `Reviewer output could not be parsed${assignmentId ? ` (assignment ${assignmentId})` : ""}: ${error}`,
  );
  // Always consume the failed run, on every path out of here: an unconsumed
  // terminal run is re-processed by the next step, which is what turned one bad
  // reviewer reply into an unbounded retry loop.
  consumeRun(store, orchestration, "review", run, `could not be parsed (${error})`);

  const priorAttempts = assignmentId
    ? store
        .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 500 })
        .filter((event) => event.kind === "error" && event.phase === "review" && event.summary?.includes(assignmentId))
    : [];
  // The event above is already in the list, so >= 2 means one retry has already
  // been spent on this assignment.
  const original = assignmentId
    ? store.listAssignments({ taskId: orchestration.taskId, limit: 500 }).find((item) => item.id === assignmentId)
    : undefined;
  if (priorAttempts.length >= 2 || !original || !run.roleId) {
    const reason = original && run.roleId ? `after retrying: ${error}` : `and could not be retried (missing context): ${error}`;
    createQuestion(store, orchestration, { question: `Reviewer output could not be parsed ${reason}`, options: [] });
    if (assignmentId) store.updateAssignment(assignmentId, { status: "failed", resultSummary: error });
    // Pausing is the point: leaving it "executing" means auto-run keeps
    // stepping, and with the review still missing it would just spawn a fresh
    // reviewer for the same scope on the next tick.
    const updated = store.updateOrchestration(orchestration.id, { status: "paused", lastError: error }) ?? orchestration;
    return result(updated, "Reviewer parsing failed; paused for user input.", []);
  }
  const agent = mustGetAgent(store, run.agentId);
  // The original prompt has to be replayed. Every turn is a fresh CLI process
  // with no memory of the last one, so a bare "your previous reply did not
  // parse" retry asked the agent to fix something it had never seen — observed
  // live, it answered "I don't have a prior reply or schema in this
  // conversation", which of course failed to parse too.
  const retryPrompt = `${original.prompt}\n\n${renderReviewRetryPrompt(error)}`;
  const retryRun = spawnTurn(deps, store, orchestration, agent, retryPrompt, "review", {
    assignmentId,
    roleId: run.roleId,
  });
  void reviewerMeta;
  return result(orchestration, "Retrying reviewer turn after a parse failure.", [retryRun.id]);
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
  recordEvent(store, orchestration, phase, "run_ended", `Run ${run.id} ${outcome}.`);
}

function spawnTurn(
  deps: OrchestratorDeps,
  store: MemoryStore,
  orchestration: Orchestration,
  agent: RegisteredAgent,
  prompt: string,
  phase: AgentRunPhase,
  extra: { subtaskId?: string; assignmentId?: string; roleId?: string } = {},
): AgentRun {
  void store;
  return deps.spawn({
    agent,
    prompt,
    taskId: orchestration.taskId,
    orchestrationId: orchestration.id,
    cycle: orchestration.cycle,
    phase,
    workforceId: orchestration.workforceId,
    ...extra,
  });
}

function renderImplementerPrompt(subtask: Subtask, files: string[]): string {
  const lines = [`Subtask: ${subtask.title}`];
  if (subtask.goal) lines.push(`Goal: ${subtask.goal}`);
  if (subtask.acceptanceCriteria.length) {
    lines.push("Acceptance criteria:");
    for (const criterion of subtask.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  if (files.length) {
    lines.push("Likely files:");
    for (const file of files) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}

function mustGetTask(store: MemoryStore, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function mustGetAgent(store: MemoryStore, agentId: string): RegisteredAgent {
  const agent = store.getRegisteredAgent(agentId);
  if (!agent) throw new Error(`Registered agent not found: ${agentId}`);
  return agent;
}

function mustGetRole(store: MemoryStore, roleName: string) {
  const role = store.listWorkforceRoles().find((candidate) => candidate.name === roleName);
  if (!role) throw new Error(`Workforce role not found: ${roleName}. Run ensureDefaultWorkforceRoles first.`);
  return role;
}

// Resolution can legitimately fail while building an approval prompt (no
// provider left to staff): the gate must still be able to ask the question —
// with the user free to answer it by naming an agent themselves — and the spawn
// itself reports the real error.
function tryResolveAgent(resolve: () => RegisteredAgent): RegisteredAgent | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

function describeAgent(agent: RegisteredAgent | undefined): string {
  return agent
    ? `${agent.name} (${agent.provider}${agent.model ? `/${agent.model}` : ""})`
    : "an agent that still has to be staffed";
}

function findDefaultAgent(
  store: MemoryStore,
  capability: string,
  allowedProviders?: string[],
): RegisteredAgent | undefined {
  const allowed = allowedProviders?.length ? new Set(allowedProviders) : undefined;
  return store
    .listRegisteredAgents({ enabled: true, limit: 500 })
    .find((candidate) => (!allowed || allowed.has(candidate.provider)) && agentSupportsCapabilities(candidate, [capability]));
}

// The single door every implementer/reviewer spawn goes through.
//
// The roster stays the first and preferred answer: an agent the user registered
// and enabled in the Agents tab. But an empty (or capability-short) roster used
// to be a hard stop — the leader planned, then every spawn threw "No enabled
// registered agent available", and the orchestration died with nothing to show.
// Rather than fail, register the agent the plan calls for and say so in the
// timeline; it lands in the Agents tab where the user can retune or disable it.
// teamProviders still bounds what may be created, so an explicit allowlist is
// never widened behind the user's back.
function resolveStaffAgent(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  capability: "implement" | "review",
  preference?: LeaderAgentPreference,
): RegisteredAgent {
  if (preference) {
    try {
      return resolveAgentForPreference(store, preference, {
        allowCreate: false,
        requiredCapabilities: [capability],
      });
    } catch (error) {
      const created = autoStaffAgent(store, orchestration, deps, capability, preference);
      if (!created) throw error;
      return created;
    }
  }
  const existing = findDefaultAgent(store, capability, orchestration.teamProviders);
  if (existing) return existing;
  const created = autoStaffAgent(store, orchestration, deps, capability);
  if (created) return created;
  throw new Error(
    `No enabled registered agent available for ${capability} work, and none could be registered automatically. ` +
      `Add an agent with the "${capability}" capability in the Agents tab.`,
  );
}

// Registers one CLI agent for the best provider the plan/allowlist/machine can
// agree on. Returns undefined when there is no provider left to try, so the
// caller can surface the original, more specific error.
function autoStaffAgent(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  capability: "implement" | "review",
  preference?: LeaderAgentPreference,
): RegisteredAgent | undefined {
  const allowed = orchestration.teamProviders?.length ? new Set<string>(orchestration.teamProviders) : undefined;
  const installed = deps.listProviders?.().map((option) => option.provider) ?? [];
  const leaderProvider = store.getRegisteredAgent(orchestration.leaderAgentId)?.provider;
  const candidates = [preference?.provider, ...(orchestration.teamProviders ?? []), ...installed, leaderProvider]
    .filter((provider): provider is string => Boolean(provider))
    .filter((provider) => !allowed || allowed.has(provider));

  for (const provider of [...new Set(candidates)]) {
    // No known command means nothing to launch; skipping is better than
    // registering an agent whose every spawn dies with ENOENT.
    const command = deps.defaultCommandFor ? deps.defaultCommandFor(provider) : provider;
    if (!command) continue;
    // Model/effort are only carried over when the leader asked for this very
    // provider — pairing another provider's model id with it spawns nothing.
    const forPreference = preference?.provider === provider ? preference : undefined;
    const agent = store.createRegisteredAgent({
      name: uniqueAgentName(
        store,
        [provider, forPreference?.model, forPreference?.reasoningEffort].filter(Boolean).join("-"),
      ),
      provider: provider as RegisteredAgent["provider"],
      // Auto-staffing only ever creates CLI agents: an api-mode agent needs a
      // base URL and a credential this code has no way to invent.
      mode: "cli",
      command,
      model: forPreference?.model,
      reasoningEffort: forPreference?.reasoningEffort,
      // Both capabilities, so one auto-staffed agent can also review later
      // instead of triggering a second round of this.
      capabilities: ["implement", "review"],
    });
    recordEvent(
      store,
      orchestration,
      capability === "implement" ? "implement" : "review",
      "user_action",
      `Auto-registered agent "${agent.name}" (${provider}${agent.model ? `/${agent.model}` : ""}) for ${capability} work; the roster had no enabled agent that could take it.`,
    );
    return agent;
  }
  return undefined;
}

function findCapabilityAgent(
  store: MemoryStore,
  capability: string,
  allowedProviders?: string[],
  excludeAgentId?: string,
): RegisteredAgent | undefined {
  const allowed = allowedProviders?.length ? new Set(allowedProviders) : undefined;
  return store
    .listRegisteredAgents({ enabled: true, limit: 500 })
    .find((candidate) =>
      candidate.id !== excludeAgentId &&
      (!allowed || allowed.has(candidate.provider)) &&
      agentSupportsCapabilities(candidate, [capability]),
    );
}

function assertProviderAllowed(orchestration: Orchestration, provider: string, role: string): void {
  if (!orchestration.teamProviders?.length || orchestration.teamProviders.includes(provider as RegisteredAgent["provider"])) return;
  throw new Error(
    `Provider "${provider}" is not allowed for ${role} staffing. Allowed team providers: ${orchestration.teamProviders.join(", ")}.`,
  );
}

// What the leader is told it can staff from: the enabled agents in the Agents
// tab, narrowed further by the orchestration's teamProviders allowlist when the
// user set one. Installed-but-unregistered CLIs are offered ONLY when that
// roster comes back empty — otherwise the leader would plan around agents the
// user chose not to enable. When it is empty, naming the installed providers is
// the only way to get a usable plan at all, and the spawn path registers
// whichever one the leader picks (see autoStaffAgent).
function resolveProviderOptions(
  store: MemoryStore,
  orchestration: Orchestration,
  _deps: OrchestratorDeps,
): {
  availableProviders: string[];
  providerModels: Record<string, string[]>;
  agentRoster: Array<{ name: string; description?: string; provider: string; model?: string; capabilities: string[] }>;
  autoStaff: boolean;
} {
  const allowed = orchestration.teamProviders?.length ? new Set(orchestration.teamProviders) : undefined;
  const agents = store
    .listRegisteredAgents({ enabled: true, limit: 500 })
    .filter((agent) => agentSupportsCapabilities(agent, ["implement"]) || agentSupportsCapabilities(agent, ["review"]));
  const collect = (filtered: RegisteredAgent[]) => {
    const providerModels: Record<string, string[]> = {};
    const ordered: string[] = [];
    for (const agent of filtered) {
      if (!ordered.includes(agent.provider)) ordered.push(agent.provider);
      const models = providerModels[agent.provider] ?? [];
      if (agent.model && !models.includes(agent.model)) models.push(agent.model);
      providerModels[agent.provider] = models;
    }
    return {
      availableProviders: ordered,
      providerModels,
      agentRoster: filtered.map((agent) => ({
        name: agent.name,
        description: agent.description,
        provider: agent.provider,
        model: agent.model,
        capabilities: agent.capabilities,
      })),
      autoStaff: false,
    };
  };
  // Installed CLIs, used only as the empty-roster fallback. The allowlist still
  // applies: it bounds what auto-staffing is allowed to register.
  const fromInstalled = () => {
    const catalogs = (_deps.listProviders?.() ?? []).filter((option) => !allowed || allowed.has(option.provider as RegisteredAgent["provider"]));
    const providerModels: Record<string, string[]> = {};
    for (const option of catalogs) providerModels[option.provider] = option.models;
    return {
      availableProviders: catalogs.map((option) => option.provider),
      providerModels,
      agentRoster: [],
      autoStaff: catalogs.length > 0,
    };
  };
  const narrowed = allowed ? agents.filter((agent) => allowed.has(agent.provider)) : agents;
  return narrowed.length ? collect(narrowed) : fromInstalled();
}

function createQuestion(store: MemoryStore, orchestration: Orchestration, question: LeaderQuestion): void {
  store.createAgentRequest({
    taskId: orchestration.taskId,
    type: "question",
    title: question.question,
    // Options ride in the payload so the dashboard can offer them as choices
    // instead of a blank box; the title stays the plain question text, which
    // is what the answered/settled bookkeeping matches on.
    payload: question.options.length ? JSON.stringify({ options: question.options }) : undefined,
  });
}

function recordEvent(
  store: MemoryStore,
  orchestration: Orchestration,
  phase: string,
  kind: "leader_turn" | "spawn" | "run_ended" | "verdict" | "rework" | "error" | "user_action",
  summary: string,
): void {
  store.recordOrchestrationEvent({ orchestrationId: orchestration.id, cycle: orchestration.cycle, phase, kind, summary });
}

function latestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  return items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function safeTail(text: string, maxChars = 2000): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

// A run whose process genuinely failed (non-zero exit, spawn error) never
// produced a leader reply worth JSON-parsing — doing so anyway just yields a
// confusing "No JSON found in the reply" error that hides the real cause.
// Surface the run's own log instead so the user sees why the agent process
// itself failed (e.g. a CLI trust check or ENOENT).
function describeRunFailure(
  run: AgentRun,
  log: string,
): { ok: false; error: string } | undefined {
  if (run.status === "done") return undefined;
  const tail = safeTail(log).trim();
  return {
    ok: false,
    error: `Agent process ${run.status} before producing a reply (run ${run.id}).${tail ? ` Last output: ${tail}` : ""}`,
  };
}

// A "detached"/"stopped" run only means the process disappeared without a
// clean exit event reaching us — very often (as with a piped CLI process
// whose exit event lands after this store handle already closed) it still
// wrote out a perfectly valid reply, so give parsing a real try before
// assuming failure. Only "failed" (a real non-zero exit or spawn error)
// skips straight to reporting the process failure, since its log is
// diagnostic text, not a leader reply.
function resolveLeaderReply<T>(
  run: AgentRun,
  deps: OrchestratorDeps,
  parse: (text: string) => { ok: true; turn: T } | { ok: false; error: string },
): { ok: true; turn: T } | { ok: false; error: string } {
  const log = deps.readLog(run);
  if (run.status !== "failed") {
    const parsed = parse(log);
    if (parsed.ok || run.status === "done") return parsed;
  }
  return describeRunFailure(run, log) ?? parse(log);
}

function safeParse<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}

function noop(orchestration: Orchestration, summary: string): OrchestrationStepResult {
  return { orchestration, summary, spawnedRunIds: [] };
}

function result(orchestration: Orchestration, summary: string, spawnedRunIds: string[]): OrchestrationStepResult {
  return { orchestration, summary, spawnedRunIds };
}
