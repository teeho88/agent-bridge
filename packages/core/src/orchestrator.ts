import type {
  AgentRun,
  AgentRunPhase,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
  Subtask,
} from "@agent-bridge/memory";
import {
  agentSupportsCapabilities,
  resolveAgentForPreference,
  resolveLeaderAgent,
  uniqueAgentName,
} from "./agent-selector.js";
import {
  contextKeyFor,
  planOriginKey,
  roundFor,
  WORKBOARD_BOUNDARY_LINES,
  type ContextStore,
  type TurnKind,
} from "./context-store.js";
import {
  buildRetryPrompt,
  parseLeaderTurn,
  type LeaderAgentPreference,
  type LeaderAdjudicateTurn,
  type LeaderPlanTurn,
  type LeaderQuestion,
} from "./leader-contract.js";
import { renderAdjudicatePrompt, renderPlanPrompt, type PlanRevisionInput } from "./leader-prompts.js";
import { parseReviewTurn, renderReviewerPrompt, renderReviewRetryPrompt, type PriorReviewInput } from "./review-contract.js";
import { describeInfraFailure, detectInfraFailure } from "./run-health.js";
import {
  readAdjudicationLedger,
  readPlanLedger,
  recordAdjudicationDecisions,
  recordPlanDraft,
} from "./turn-ledger.js";

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
  // Persists the leader's plan markdown and returns its path. Only used when
  // `contextStoreFor` is absent — the context store files the plan itself, in
  // the same folder as everything else the orchestration produced.
  writePlanFile: (markdown: string) => string;
  // Opens the on-disk context store for an orchestration. Injected for the
  // same reason writePlanFile is: core does no filesystem access. When it is
  // absent the orchestrator falls back to inlining context into prompts, which
  // is what it did before the store existed.
  contextStoreFor?: (orchestrationId: string) => ContextStore;
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
    // Name what kept coming back. A bare cycle count tells the user the run
    // gave up but not which subtask was in the loop that spent the budget.
    const churning = store
      .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
      .filter((subtask) => !["done", "cancelled"].includes(subtask.status))
      .slice(0, 8)
      .map((subtask) => `"${subtask.title}" [${subtask.status}]`);
    createQuestion(store, updated, {
      question: churning.length
        ? `Orchestration hit its limit of ${orchestration.maxCycles} rework cycle(s) without completing. Still outstanding: ${churning.join(", ")}. Raise the limit, finish these yourself, or drop them.`
        : `Orchestration exceeded ${orchestration.maxCycles} cycles without completing.`,
      options: [],
    });
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
  const ctx = deps.contextStoreFor?.(orchestration.id);
  const buildPrompt = () => {
    const task = mustGetTask(store, orchestration.taskId);
    return renderPlanPrompt({
      taskTitle: task.title,
      goal: task.goal,
      maxParallel: orchestration.maxParallel,
      contextRoot: ctx ? { root: ctx.root, plan: ctx.planPath } : undefined,
      ...resolveProviderOptions(store, orchestration, deps),
      revision: buildPlanRevision(store, orchestration, deps),
      ledger: readPlanLedger(store, orchestration.id),
      answers: allQuestionAnswers(store, orchestration.id),
      approvalNotes: allApprovalNotes(store, orchestration),
      ...renderQuestionBudget(orchestration, planQuestionRounds(store, orchestration.id)),
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

export type ChangeLeaderResult = {
  orchestration: Orchestration;
  leader: RegisteredAgent;
  previousLeaderId: string;
  changed: boolean;
};

// Moves a running orchestration onto another leader. The only supported repair
// for a run whose leader row was deleted or misconfigured — before this, the
// leader was fixed at creation and every step of such a run died with
// "Registered agent not found".
//
// It always resolves a dedicated lead-only row (find-or-create), never a staff
// agent: leader rows are plumbing and are deliberately kept out of the Agents
// tab, so promoting an agent the user hired there would put the same trap back.
export function changeOrchestrationLeader(
  store: MemoryStore,
  orchestrationId: string,
  preference: LeaderAgentPreference,
  defaults: { command?: string } = {},
): ChangeLeaderResult {
  const orchestration = store.getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Orchestration not found: ${orchestrationId}`);
  const previousLeaderId = orchestration.leaderAgentId;
  const leader = resolveLeaderAgent(store, preference, defaults);
  if (leader.id === previousLeaderId) {
    return { orchestration, leader, previousLeaderId, changed: false };
  }
  // The stored error is almost always the unresolvable leader itself; leaving
  // it would keep the board red after the run is healthy again.
  const updated = store.updateOrchestration(orchestrationId, { leaderAgentId: leader.id, lastError: null });
  if (!updated) throw new Error(`Orchestration not found: ${orchestrationId}`);
  const previous = store.getRegisteredAgent(previousLeaderId);
  recordEvent(
    store,
    updated,
    "plan",
    "user_action",
    `Leader changed from ${previous ? describeAgent(previous) : previousLeaderId} to ${describeAgent(leader)}.`,
  );
  return { orchestration: updated, leader, previousLeaderId, changed: true };
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

// Every note the user typed when approving a spawn, oldest first. A note is an
// instruction attached to a yes ("go ahead, but stop after this one"), and
// nothing read them: only `agentId` was ever pulled out of the response, so the
// text was accepted, stored, and silently dropped. They are standing user
// directives, so they are carried into the leader turns the same way answers
// are, not just into the one turn the approval unblocked.
export function allApprovalNotes(
  store: MemoryStore,
  orchestration: Orchestration,
): Array<{ approved: string; note: string }> | undefined {
  const notes: Array<{ approved: string; note: string }> = [];
  for (const request of store.listAgentRequests({ taskId: orchestration.taskId, limit: 500 })) {
    if (request.type !== "approval" || request.status !== "accepted" || !request.response) continue;
    const payload = safeParse<SpawnApprovalPayload>(request.payload ?? "");
    if (payload?.type !== "spawn-approval" || payload.orchestrationId !== orchestration.id) continue;
    const parsed = safeParse<SpawnApprovalResponse>(request.response);
    const note = parsed?.type === "spawn-approval-response" ? parsed.note : request.response;
    if (note?.trim()) notes.push({ approved: request.title, note: note.trim() });
  }
  if (!notes.length) return undefined;
  return notes.reverse();
}

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
  const events = store.listOrchestrationEvents({ orchestrationId, limit: 1000 });
  for (const event of [...events].reverse()) {
    if (event.kind !== "user_action" || !event.payload) continue;
    const parsed = safeParse<QuestionAnswersPayload>(event.payload);
    if (parsed?.type !== "question-answers") continue;
    for (const entry of parsed.answers) byQuestion.set(entry.question, entry.answer);
  }
  if (!byQuestion.size) return undefined;
  return [...byQuestion].map(([question, answer]) => ({ question, answer }));
}

// The most times the leader may park the run on questions. A ceiling, never a
// quota: a leader that has nothing left to ask should plan on turn one. It
// exists only to stop the plan/answer loop a leader falls into when it re-asks
// settled ground in new words. Set per orchestration at start; the env var is
// the fallback for callers that do not expose the field.
const DEFAULT_PLAN_QUESTION_ROUND_LIMIT = 4;
const PLAN_QUESTION_EVENT_PREFIX = "Leader raised";

function planQuestionRoundLimit(orchestration: Orchestration): number {
  if (orchestration.maxQuestionRounds !== undefined && orchestration.maxQuestionRounds >= 0) {
    return orchestration.maxQuestionRounds;
  }
  const raw = process.env.AGENT_BRIDGE_PLAN_QUESTION_ROUNDS;
  if (raw === undefined) return DEFAULT_PLAN_QUESTION_ROUND_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PLAN_QUESTION_ROUND_LIMIT;
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

function planQuestionRounds(store: MemoryStore, orchestrationId: string): number {
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
  // Record the draft before anything can return early. The question branch
  // below parks the orchestration without ever writing a plan file, so this is
  // the only place the leader's own draft survives to the next round — and its
  // absence is what made that round re-plan from the goal.
  recordPlanDraft(store, orchestration, turn);

  // Questions from a plan turn are gating, not decorative: the leader is
  // saying it had to guess. Applying the plan anyway bakes those guesses into
  // subtasks that implementers then build. Park the orchestration until the
  // user answers (or dismisses) them, then re-plan with the answers in hand.
  const unanswered = pendingQuestionsFor(store, orchestration, turn.questions);
  const rounds = planQuestionRounds(store, orchestration.id);
  if (unanswered.length && rounds < planQuestionRoundLimit(orchestration)) {
    for (const question of unanswered) createQuestion(store, orchestration, question);
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: `Leader asked ${unanswered.length} question(s) before it can plan properly. Answer them to continue.`,
    }) ?? orchestration;
    recordEvent(store, updated, "plan", "user_action", `${PLAN_QUESTION_EVENT_PREFIX} ${unanswered.length} planning question(s); awaiting answers.`);
    return result(updated, `Leader raised ${unanswered.length} question(s); paused for your answers.`, []);
  }
  // Past the limit the questions are no longer gating: parking again is what
  // produced the plan/answer/re-plan loop, since a reworded question never
  // matches an already-settled one. Record them and plan on with whatever the
  // leader assumed — the no-subtask branch below still stops for the user if
  // the turn produced nothing usable.
  if (unanswered.length) {
    recordEvent(
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
    ? { trigger: `change request — ${revision.request}`, change: turn.planMarkdown.split("\n")[0] ?? "re-planned" }
    : { trigger: "re-plan", change: turn.planMarkdown.split("\n")[0] ?? "re-planned" };

  if (!turn.subtasks.length) {
    const planPath = writePlanDocument(orchestration, deps, ctx, turn.planMarkdown, revisionEntry);
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
    const superseded = existing.filter((subtask) => !["done", "cancelled"].includes(subtask.status));
    for (const subtask of superseded) {
      store.updateSubtask(subtask.id, {
        status: "cancelled",
        statusReason: "Superseded when the leader found no work left in the newer plan.",
      });
    }
    const updated = store.updateOrchestration(orchestration.id, {
      status: "reporting",
      complexity: turn.complexity,
      planPath,
    }) ?? orchestration;
    recordEvent(
      store,
      updated,
      "plan",
      "leader_turn",
      `Leader found no work left to do; cancelled ${superseded.length} open subtask(s) from the superseded plan and is going to reporting.`,
    );
    if (finishedRunId) recordEvent(store, updated, "plan", "run_ended", `Consumed plan run ${finishedRunId}.`);
    return result(updated, "Leader found nothing left to build; ready for reporting.", []);
  }

  const roles = store.ensureDefaultWorkforceRoles();
  const subtaskIdByKey = new Map<string, string>();
  // `orchestration.cycle` is a rework budget and is reset to 1 whenever a new
  // plan is applied. It therefore cannot namespace plan keys: two replans that
  // both happen at cycle 1 would overwrite each other's c1-s1 context folder.
  // Use the monotonic plan application number instead.
  const planContextCycle = nextPlanContextCycle(store, orchestration.id);

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
  // the work that is still needed — so every non-terminal subtask it did not
  // carry over is stale. This includes `review`: reviewer scopes are replaced
  // by the new plan, so those rows otherwise wait for a reviewer forever.
  const planned = new Set(subtaskIdByKey.values());
  const superseded = store
    .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
    .filter((subtask) => !["done", "cancelled"].includes(subtask.status) && !planned.has(subtask.id));
  for (const subtask of superseded) {
    store.updateSubtask(subtask.id, {
      status: "cancelled",
      statusReason: "Superseded by a newer leader plan.",
    });
    for (const review of store.listReviews({ subtaskId: subtask.id, consumed: false })) {
      store.markReviewConsumed(review.id);
    }
  }
  if (superseded.length) {
    recordEvent(
      store,
      orchestration,
      "plan",
      "leader_turn",
      `Cancelled ${superseded.length} unstarted subtask(s) left over from the superseded plan.`,
    );
  }

  const planPath = writePlanDocument(orchestration, deps, ctx, turn.planMarkdown, revisionEntry);
  const updated = store.updateOrchestration(orchestration.id, {
    status: "executing",
    complexity: turn.complexity,
    planPath,
    cycle: 1,
  }) ?? orchestration;
  if (ctx) refreshContextIndex(store, updated, ctx);
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
  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const reviewReadyIds = new Set(
    subtasks.filter((subtask) => subtask.status === "review").map((subtask) => subtask.id),
  );
  // Reviews are task-scoped in storage, while an orchestration can be replanned
  // many times. A review left on a superseded/cancelled subtask must not send a
  // fresh plan directly to adjudication before any of its work is dispatched.
  const pendingReviews = store
    .listReviews({ taskId: orchestration.taskId, consumed: false })
    .filter((review) => review.subtaskId && reviewReadyIds.has(review.subtaskId));
  if (pendingReviews.length) {
    const updated = store.updateOrchestration(orchestration.id, { status: "adjudicating" }) ?? orchestration;
    return result(updated, `${pendingReviews.length} review(s) pending; moving to adjudication.`, []);
  }

  const activeRuns = store.listAgentRuns({ orchestrationId: orchestration.id, limit: 500 });
  const ctx = deps.contextStoreFor?.(orchestration.id);

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
        store.updateSubtask(subtask.id, {
          status: "blocked",
          statusReason: "Assignment rejected by the user.",
        });
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
    (run) =>
      run.phase === "implement"
      && TERMINAL_RUN_STATUSES.has(run.status)
      && run.subtaskId
      && !isRunConsumed(store, orchestration.id, run.id),
  );
  for (const run of finishedImplementerRuns) {
    const subtask = subtasks.find((candidate) => candidate.id === run.subtaskId);
    if (!subtask || (subtask.status !== "assigned" && subtask.status !== "in_progress")) continue;
    // A context-document retry for this subtask is still running: reconciling
    // now would spend the gate's budget on the very file that run is writing.
    if (activeRuns.some((other) => other.subtaskId === subtask.id && ACTIVE_STATUSES.has(other.status))) continue;
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
    const treatAsFailure = run.status === "failed" || run.status === "stopped" || Boolean(infra);
    // The report is the only account of this attempt that the reviewer, the
    // adjudicator and any later attempt will ever see, so ask for it before
    // the subtask leaves the implementer's hands. Skipped for a failed run:
    // there is nothing to report and the retry would only waste a spawn.
    if (!treatAsFailure && ctx) {
      const target = contextTargetFor(store, orchestration, subtask);
      const check = ctx.checkTurn("report", target.contextKey, target.round);
      if (!check.ok) {
        const retry = retryForMissingContext(store, orchestration, deps, {
          phase: "implement",
          agent: store.getRegisteredAgent(run.agentId),
          tag: `report:${target.contextKey}:${target.round}`,
          missing: [{ path: check.path, reason: check.reason }],
          sourceRun: run,
          extra: { subtaskId: subtask.id, assignmentId: run.assignmentId, roleId: run.roleId },
        });
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
        resultSummary: infra ? describeInfraFailure(infra) : safeTail(log, ASSIGNMENT_SUMMARY_CHARS),
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
      if (!alreadyRaised) createQuestion(store, orchestration, { question: title, options: [] });
      recordEvent(
        store,
        orchestration,
        "implement",
        "error",
        `Implementer run ${run.id} never executed a command (${infra.kind}, ${infra.occurrences} refusals); blocked "${subtask.title}" instead of sending unrun work to review.`,
      );
      return result(orchestration, `Implementer run ${run.id} hit an environment failure (${infra.kind}); blocked the subtask.`, []);
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
    // Same reason as the implementer branch: wait for a document retry on this
    // assignment before judging whether its document is missing.
    if (activeRuns.some((other) => other.assignmentId === run.assignmentId && ACTIVE_STATUSES.has(other.status))) continue;
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
    // The JSON verdict is what the orchestrator acts on; the review document is
    // what the next attempt and the adjudicator read. Ask for it before the
    // verdicts are recorded, while the reviewer's own turn is still the thing
    // being retried.
    if (ctx) {
      const missing = missingReviewDocuments(store, orchestration, ctx, reviewerMeta, parsed.turn.reviews, subtasks);
      if (missing.length) {
        const retry = retryForMissingContext(store, orchestration, deps, {
          phase: "review",
          agent: store.getRegisteredAgent(run.agentId),
          tag: `review:${run.assignmentId}`,
          missing,
          sourceRun: run,
          extra: { assignmentId: run.assignmentId, roleId: run.roleId },
        });
        if (retry) return retry;
      }
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
    const reviewBaseKey = `review:${reviewerMeta.reviewerKey}:${ready.map((pair) => pair.entry.key).join(",")}`;
    const priorReviewerRuns = activeRuns.filter(
      (run) =>
        run.phase === "review" &&
        findReviewerMetaForRun(store, orchestration.id, run, reviewerMetas)?.reviewerKey === reviewerMeta.reviewerKey,
    ).length;
    // The first attempt keeps the historic key so an approval already pending
    // during an upgrade is still usable. Every later spawn gets a fresh key:
    // one accepted review approval must not authorise infinite failed retries
    // or a later rework round for the same reviewer group.
    const reviewKey = priorReviewerRuns ? `${reviewBaseKey}:attempt-${priorReviewerRuns + 1}` : reviewBaseKey;
    const candidate = tryResolveAgent(() => resolveReviewerAgent(store, orchestration, reviewerMeta, deps, reviewKey));
    const gated = gateSpawn(
      store,
      orchestration,
      reviewKey,
      `Assign review of ${ready.map((pair) => pair.subtask.title).join(", ")} to ${describeAgent(candidate)}`,
      candidate?.id,
    );
    if (gated) return gated;
    const run = spawnReviewer(store, orchestration, reviewerMeta, ready, deps, reviewKey);
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
  const ctx = deps.contextStoreFor?.(orchestration.id);
  const files = meta?.files ?? [];
  let context: ImplementerContextPaths | undefined;
  if (ctx) {
    const target = contextTargetFor(store, orchestration, subtask);
    writeAssignmentBrief(store, orchestration, ctx, subtask, files, target);
    context = {
      brief: ctx.briefPath(target.contextKey),
      // Every document from the attempts this one replaces, in full. This is
      // what the truncated rework blob in the prompt used to stand in for.
      prior: priorRoundPaths(ctx, target, ["report", "review", "adjudication"]),
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
  const prompt = renderImplementerPrompt(
    subtask,
    files,
    // With the documents on disk there is nothing left for the inlined rework
    // blob to add, and it is the larger of the two by an order of magnitude.
    context ? undefined : reworkContextFor(store, orchestration, subtask),
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
  const preference = meta?.agentPreference;
  return resolveStaffAgent(store, orchestration, deps, "implement", preference);
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
  const preference = reviewerMeta.agentPreference;
  return resolveStaffAgent(store, orchestration, deps, "review", preference);
}

function spawnReviewer(
  store: MemoryStore,
  orchestration: Orchestration,
  reviewerMeta: ReviewerPlanMeta,
  scopeSubtasks: Array<{ entry: { key: string; subtaskId: string }; subtask: Subtask }>,
  deps: OrchestratorDeps,
  approvalKey: string,
): AgentRun {
  const role = mustGetRole(store, reviewerMeta.role ?? "reviewer");
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
  const task = mustGetTask(store, orchestration.taskId);
  const assignmentsBySubtask = new Map(
    scopeSubtasks.map((pair) => [
      pair.subtask.id,
      latestByCreatedAt(store.listAssignments({ subtaskId: pair.subtask.id, limit: 20 })),
    ]),
  );
  const titleBySubtaskId = new Map(
    store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 }).map((subtask) => [subtask.id, subtask.title]),
  );
  const ctx = deps.contextStoreFor?.(orchestration.id);
  const prompt = renderReviewerPrompt({
    taskTitle: task.title,
    subtasks: scopeSubtasks.map((pair) => {
      const target = ctx ? contextTargetFor(store, orchestration, pair.subtask) : undefined;
      return {
        key: pair.entry.key,
        title: pair.subtask.title,
        goal: pair.subtask.goal,
        acceptanceCriteria: pair.subtask.acceptanceCriteria,
        // Both of these are replaced by the documents once there is a store:
        // the 800-character log tail by the implementer's own report, and the
        // replayed prior reviews by the files they were summarised from.
        resultSummary: ctx ? undefined : assignmentsBySubtask.get(pair.subtask.id)?.resultSummary,
        priorReviews: ctx
          ? undefined
          : priorReviewsForScopeEntry(store, reviewerMeta, pair.entry.key, titleBySubtaskId),
        context:
          ctx && target
            ? {
                brief: ctx.briefPath(target.contextKey),
                report: ctx.turnPath("report", target.contextKey, target.round),
                prior: priorRoundPaths(ctx, target, ["review", "adjudication"]),
                write: ctx.turnPath("review", target.contextKey, target.round),
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
  const subtaskIdByKey = new Map(reviewerMeta.scope.map((entry) => [entry.key, entry.subtaskId]));
  const chain: string[] = [];
  let current: string | undefined = key;
  while (current) {
    chain.unshift(current);
    const origin: string | undefined = current.match(/^(.+)-rework-\d+$/)?.[1];
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
    const scopeEntry = reviewerMeta?.scope.find((entry) => entry.key === item.subtaskKey);
    const subtaskId = scopeEntry?.subtaskId ?? findSubtaskMetaByKey(store, orchestration.id, item.subtaskKey)?.subtaskId;
    const subtask = subtasks.find((candidate) => candidate.id === subtaskId);
    if (!subtask) continue;
    const target = contextTargetFor(store, orchestration, subtask);
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

// The completion guard asks this when the leader calls the project done with
// subtasks still open. The first option is carried out here, not by the leader:
// answering it in prose only ever produced another leader turn, which marked
// the project complete again and landed straight back on the guard.
export const OPEN_SUBTASKS_QUESTION_KIND = "open-subtasks";
export const DROP_OPEN_SUBTASKS_OPTION = "Drop the open subtasks and finish the orchestration";
export const SEND_OPEN_SUBTASKS_BACK_OPTION = "Send them back to the leader to finish properly";

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
      return safeParse<{ kind?: string }>(request.payload ?? "")?.kind === OPEN_SUBTASKS_QUESTION_KIND;
    });
  if (!guard || guard.status === "pending" || guard.response?.trim() !== DROP_OPEN_SUBTASKS_OPTION) return undefined;
  // Acted on once only. A later cycle that opens new subtasks must not be
  // cleared out by an answer the user gave about a different set of them.
  const applied = store
    .listOrchestrationEvents({ orchestrationId: orchestration.id, kind: "user_action", limit: META_SCAN_LIMIT })
    .some((event) => event.summary?.includes(guard.id));
  if (applied) return undefined;

  const outstanding = store
    .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
    .filter((subtask) => !["done", "cancelled"].includes(subtask.status));
  if (!outstanding.length) return undefined;

  for (const subtask of outstanding) {
    store.updateSubtask(subtask.id, {
      status: "cancelled",
      statusReason: "Dropped at your request so the orchestration could finish.",
    });
  }
  recordEvent(
    store,
    orchestration,
    "adjudicate",
    "user_action",
    `Dropped ${outstanding.length} open subtask(s) at your request (${guard.id}); finishing the orchestration.`,
  );
  const updated = store.updateOrchestration(orchestration.id, { status: "reporting", lastError: null }) ?? orchestration;
  return result(updated, `Dropped ${outstanding.length} open subtask(s); ready for reporting.`, []);
}

function stepAdjudicating(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
): OrchestrationStepResult {
  const dropped = applyOpenSubtaskDrop(store, orchestration);
  if (dropped) return dropped;

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
    const adjudicator = findCapabilityAgent(store, "adjudicate", orchestration.leaderAgentId);
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
        answers: allQuestionAnswers(store, orchestration.id),
        approvalNotes: allApprovalNotes(store, orchestration),
      });
    }, finished);
  }

  const isLeader = finished.agentId === orchestration.leaderAgentId;
  if (!isLeader && requiresLeaderAdjudication(store, orchestration, parsed.turn)) {
    const leader = mustGetAgent(store, orchestration.leaderAgentId);
    const gated = gateSpawn(
      store,
      orchestration,
      `adjudicate:leader-confirm:${finished.id}`,
      `Escalate adjudication to the Leader with ${describeAgent(leader)}`,
      leader.id,
    );
    if (gated) return gated;
    consumeRun(store, orchestration, "adjudicate", finished, "escalated its proposal to the Leader");
    const proposal = `\`\`\`json\n${JSON.stringify(parsed.turn, null, 2)}\n\`\`\``;
    const prompt = buildAdjudicationPrompt(store, orchestration, deps, "leader", proposal);
    const run = spawnTurn(deps, store, orchestration, leader, prompt, "adjudicate");
    recordEvent(store, orchestration, "adjudicate", "spawn", `Escalated adjudication to Leader (${run.id}).`);
    return result(orchestration, "Adjudicator proposal requires Leader confirmation.", [run.id]);
  }

  // The decision documents are gated before anything is applied, and the run is
  // deliberately left unconsumed while the retry runs: the next step re-parses
  // this same turn and applies it then, with its files in place.
  const ctx = deps.contextStoreFor?.(orchestration.id);
  if (ctx) {
    const missing = missingAdjudicationDocuments(store, orchestration, ctx, parsed.turn);
    if (missing.length) {
      const retry = retryForMissingContext(store, orchestration, deps, {
        phase: "adjudicate",
        agent: store.getRegisteredAgent(finished.agentId),
        tag: `adjudication:${finished.id}`,
        missing,
        sourceRun: finished,
      });
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
  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const missing: Array<{ path: string; reason: string }> = [];
  for (const decision of turn.decisions) {
    const meta = findSubtaskMetaByKey(store, orchestration.id, decision.subtaskKey);
    const subtask = subtasks.find((candidate) => candidate.id === meta?.subtaskId);
    if (!subtask) continue;
    const target = contextTargetFor(store, orchestration, subtask);
    const check = ctx.checkTurn("adjudication", target.contextKey, target.round);
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
  const task = mustGetTask(store, orchestration.taskId);
  const pendingReviews = store.listReviews({ taskId: orchestration.taskId, consumed: false });
  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const stranded = strandedSubtaskIds(subtasks);
  const ctx = deps.contextStoreFor?.(orchestration.id);
  const contextFor = (subtaskId: string | undefined) => {
    const subtask = subtasks.find((candidate) => candidate.id === subtaskId);
    if (!ctx || !subtask) return undefined;
    const target = contextTargetFor(store, orchestration, subtask);
    return {
      brief: ctx.briefPath(target.contextKey),
      review: ctx.turnPath("review", target.contextKey, target.round),
      // Earlier rounds in full — this is how a defect reported for the third
      // time stops looking like a fresh one.
      prior: priorRoundPaths(ctx, target, ["report", "review", "adjudication"]),
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
    answers: allQuestionAnswers(store, orchestration.id),
    approvalNotes: allApprovalNotes(store, orchestration),
    ...resolveProviderOptions(store, orchestration, deps),
    reviews: pendingReviews.map((review) => ({
      subtaskKey: findSubtaskKey(store, orchestration.id, review.subtaskId) ?? review.subtaskId ?? "?",
      subtaskTitle: subtasks.find((subtask) => subtask.id === review.subtaskId)?.title ?? "",
      verdict: review.verdict,
      score: review.score,
      summary: review.summary,
      // Both give way to the files once there is a store: a findings blob is
      // the largest thing in this prompt and it is replayed every cycle.
      findings: ctx ? undefined : review.findings,
      priorReviews: ctx ? undefined : priorReviewsForSubtask(store, orchestration, review.subtaskId, subtasks),
      context: contextFor(review.subtaskId),
    })),
    subtasks: subtasks.map((subtask) => ({
      key: findSubtaskKey(store, orchestration.id, subtask.id) ?? subtask.id,
      title: subtask.title,
      status: subtask.status,
      acceptanceCriteria: subtask.acceptanceCriteria,
      strandedBy: stranded
        .get(subtask.id)
        ?.map((depId) => findSubtaskKey(store, orchestration.id, depId) ?? depId),
      blockedReason: subtask.status === "blocked" ? blockedReasonFor(store, subtask) : undefined,
    })),
  });
}

// Why a subtask is sitting in `blocked`. Two things put it there — a reviewer
// or leader block verdict, and an implementer run that failed or was refused by
// the machine — and both records are otherwise invisible at adjudication: the
// review has been consumed, and the assignment summary is only ever replayed to
// reviewers. Without the reason the leader is told to clear a blocked subtask
// while being given no idea what stopped it.
const BLOCK_REASON_CHARS = 600;

function blockedReasonFor(store: MemoryStore, subtask: Subtask): string | undefined {
  if (subtask.statusReason) return truncateReason(subtask.statusReason);
  const review = latestByCreatedAt(store.listReviews({ subtaskId: subtask.id, limit: 20 }));
  if (review?.verdict === "block") {
    const findings = review.findings ? ` findings: ${review.findings}` : "";
    return truncateReason(`reviewer blocked it — ${review.summary}${findings}`);
  }
  const assignment = latestByCreatedAt(store.listAssignments({ subtaskId: subtask.id, limit: 20 }));
  if (assignment?.status === "failed" && assignment.resultSummary) {
    return truncateReason(`the implementer run failed — ${assignment.resultSummary}`);
  }
  if (review) {
    const findings = review.findings ? ` findings: ${review.findings}` : "";
    return truncateReason(`last review [${review.verdict}] — ${review.summary}${findings}`);
  }
  return assignment?.resultSummary ? truncateReason(assignment.resultSummary) : undefined;
}

function truncateReason(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > BLOCK_REASON_CHARS ? `${flat.slice(0, BLOCK_REASON_CHARS)}…` : flat;
}

// Reviews written against the attempts this subtask replaces, so adjudication
// can see a defect being reported for the second or third time instead of
// treating each cycle's review as the first word on the subject.
function priorReviewsForSubtask(
  store: MemoryStore,
  orchestration: Orchestration,
  subtaskId: string | undefined,
  subtasks: Subtask[],
): Array<{ subtaskTitle: string; verdict: string; summary: string; findings?: string }> | undefined {
  const key = subtaskId ? findSubtaskKey(store, orchestration.id, subtaskId) : undefined;
  if (!key) return undefined;
  const priors: Array<{ subtaskTitle: string; verdict: string; summary: string; findings?: string }> = [];
  let ancestorKey: string | undefined = key.match(/^(.+)-rework-\d+$/)?.[1];
  const chain: string[] = [];
  while (ancestorKey) {
    chain.unshift(ancestorKey);
    ancestorKey = ancestorKey.match(/^(.+)-rework-\d+$/)?.[1];
  }
  for (const entryKey of chain) {
    const meta = findSubtaskMetaByKey(store, orchestration.id, entryKey);
    if (!meta) continue;
    const title = subtasks.find((subtask) => subtask.id === meta.subtaskId)?.title ?? entryKey;
    for (const review of store.listReviews({ subtaskId: meta.subtaskId, limit: 20 })) {
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
  input: {
    turn: LeaderAdjudicateTurn;
    finishedRunId: string;
    actor: "Leader" | "Adjudicator";
    contextStore?: ContextStore;
  },
): OrchestrationStepResult {
  const { turn, finishedRunId, actor } = input;
  // Logged before the decisions are applied, so the next cycle sees what was
  // ruled even if applying it ends the orchestration here.
  recordAdjudicationDecisions(store, orchestration, actor, turn);
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
      inheritAndRepointDependencies(store, orchestration, subtaskId, reworkSubtask.id);
      const reworkKey = `${decision.subtaskKey}-rework-${orchestration.cycle}`;
      recordSubtaskMeta(store, orchestration, {
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
    } else if (decision.verdict === "drop") {
      // The subtask is not being done, and that is the decision — not a defect
      // to fix and not a question for the user. Cancelling is what lets the
      // completion guard below pass: an open subtask the leader has no verb for
      // is what kept a run the user asked to finish from ever finishing.
      store.updateSubtask(subtaskId, {
        status: "cancelled",
        statusReason: "Dropped by the leader during adjudication.",
      });
      if (targetAssignment) store.updateAssignment(targetAssignment.id, { status: "cancelled" });
    } else if (decision.verdict === "block") {
      store.updateSubtask(subtaskId, {
        status: "blocked",
        statusReason: truncateReason(
          reviews.map((review) => review.summary).filter(Boolean).join("; ") || "Blocked by the leader during adjudication.",
        ),
      });
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
    if (input.contextStore) refreshContextIndex(store, updated, input.contextStore);
    return result(updated, "Adjudication blocked on one or more subtasks; paused for user input.", []);
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
      const more = outstanding.length > 8 ? `, and ${outstanding.length - 8} more` : "";
      // The old wording ("resolve or explicitly drop them") described an action
      // nothing could carry out: the leader had no verb for dropping a subtask
      // and the answer was only ever replayed to it as prose. A run the user
      // had told to finish came back here every turn. Now the first option is
      // executed by the orchestrator itself.
      createQuestion(
        store,
        orchestration,
        {
          question: `${actor} marked the project complete, but ${outstanding.length} subtask(s) are still open: ${listed}${more}. Drop them and finish, or send them back to the leader?`,
          // The safe answer goes first: the dashboard pre-selects option one,
          // and that must never be the one that cancels work.
          options: [SEND_OPEN_SUBTASKS_BACK_OPTION, DROP_OPEN_SUBTASKS_OPTION],
        },
        OPEN_SUBTASKS_QUESTION_KIND,
      );
      const updated = store.updateOrchestration(orchestration.id, {
        status: "paused",
        lastError: `${actor} marked the project complete while subtasks were still open.`,
      }) ?? orchestration;
      if (input.contextStore) refreshContextIndex(store, updated, input.contextStore);
      return result(updated, `${actor} tried to finish with open subtasks; paused for user input.`, []);
    }
    const updated = store.updateOrchestration(orchestration.id, { status: "reporting" }) ?? orchestration;
    if (input.contextStore) refreshContextIndex(store, updated, input.contextStore);
    return result(updated, `${actor} marked the project complete; ready for reporting.`, []);
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
        const reason = subtask.status === "blocked" ? blockedReasonFor(store, subtask) : undefined;
        return `"${subtask.title}" [${subtask.status}]${reason ? ` — ${reason}` : ""}`;
      })
      .join(", ");
    const more = outstanding.length > 8 ? `, and ${outstanding.length - 8} more` : "";
    createQuestion(store, orchestration, {
      question: outstanding.length
        ? `The leader returned no decisions and would not mark the project complete, but ${outstanding.length} subtask(s) are still open: ${listed}${more}. Nothing can be dispatched — should these be dropped, or do they need something from you?`
        : "The leader returned no decisions and did not mark the project complete, yet every subtask is finished or cancelled. Confirm whether this project is done.",
      options: [],
    });
    const updated = store.updateOrchestration(orchestration.id, {
      status: "paused",
      lastError: "Leader returned no decisions and did not mark the project complete.",
    }) ?? orchestration;
    if (input.contextStore) refreshContextIndex(store, updated, input.contextStore);
    return result(updated, "Leader had nothing to decide and would not finish; paused for user input.", []);
  }
  // A cycle is a round of work that had to be REDONE, which is what max_cycles
  // is there to bound. Charging one for an accept-only adjudication makes the
  // budget a cap on how many reviewer groups a project may have: each group's
  // reviews land separately, each lands its own adjudication, and a five-group
  // plan burned five cycles making perfect forward progress — then failed with
  // "Exceeded max_cycles" having never reworked anything. Accepts strictly
  // reduce outstanding work, so they cannot loop; only rework can.
  const reworked = turn.decisions.some((decision) => decision.verdict === "rework" && decision.rework);
  const updated = store.updateOrchestration(orchestration.id, {
    status: "executing",
    ...(reworked ? { cycle: orchestration.cycle + 1 } : {}),
  }) ?? orchestration;
  if (input.contextStore) refreshContextIndex(store, updated, input.contextStore);
  return result(
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
  const subtasks = store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 });
  const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
  const superseded = byId.get(supersededId);
  // Dead dependencies are dropped rather than inherited: reworking a stranded
  // subtask is how the leader clears the strand, so carrying the dependency
  // that stranded it onto the replacement would strand that one too.
  const inherited = (superseded?.dependsOn ?? []).filter((id) => {
    const dep = byId.get(id);
    return dep && dep.status !== "cancelled" && dep.status !== "blocked";
  });
  if (inherited.length) store.updateSubtask(replacementId, { dependsOn: inherited });
  for (const subtask of subtasks) {
    if (subtask.id === replacementId || !subtask.dependsOn.includes(supersededId)) continue;
    store.updateSubtask(subtask.id, {
      dependsOn: subtask.dependsOn.map((id) => (id === supersededId ? replacementId : id)),
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
    subtasks.filter((subtask) => subtask.status === "cancelled" || subtask.status === "blocked").map((s) => s.id),
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
      const culprits = subtask.dependsOn.filter((id) => unreachable.has(id) || !byId.has(id));
      if (!culprits.length) continue;
      stranded.set(subtask.id, culprits);
      unreachable.add(subtask.id);
      changed = true;
    }
  }
  return stranded;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type SubtaskPlanMeta = {
  type: "subtask";
  key: string;
  subtaskId: string;
  // The cycle this key was planned in — the folder the work owns. A rework
  // inherits its origin's value so every attempt keeps sharing one folder.
  // Absent on metas recorded before context folders were cycle-scoped.
  planCycle?: number;
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

const SUBTASK_META_PREFIX = "subtask-meta:";
const REVIEWER_META_PREFIX = "reviewer-meta:";
// Plan metas are the join between the database and the context folders, so the
// lookup has to be total: an orchestration that ran for cycles accumulates
// thousands of events, and a plain newest-N window silently drops the oldest
// keys, which sends their reworks into a brand-new empty folder.
const META_SCAN_LIMIT = 20000;

function listPlanMetaEvents(store: MemoryStore, orchestrationId: string, prefix: string) {
  return store.listOrchestrationEvents({
    orchestrationId,
    kind: "leader_turn",
    summaryPrefix: prefix,
    limit: META_SCAN_LIMIT,
  });
}

function getSubtaskMeta(store: MemoryStore, orchestrationId: string, subtaskId: string): SubtaskPlanMeta | undefined {
  for (const event of listPlanMetaEvents(store, orchestrationId, SUBTASK_META_PREFIX)) {
    if (!event.payload) continue;
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
  for (const event of listPlanMetaEvents(store, orchestrationId, SUBTASK_META_PREFIX)) {
    if (!event.payload) continue;
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
  for (const event of listPlanMetaEvents(store, orchestrationId, REVIEWER_META_PREFIX)) {
    if (!event.payload) continue;
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
  const events = store.listOrchestrationEvents({ orchestrationId, kind: "spawn", limit: META_SCAN_LIMIT });
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

/** Plan label for a run: the leader's key ("s1", "r1") plus what it is about. */
export type RunPlanLabel = { key: string; title: string };

/**
 * Maps runs to the plan entry they came from so a board card can say
 * "s1: Build the parser" instead of only naming the agent. Reads the plan meta
 * events once for the whole batch — this runs on every dashboard poll.
 */
export function describeRunPlanLabels(
  store: MemoryStore,
  orchestrationId: string,
  runs: AgentRun[],
  subtasks: Subtask[],
): Record<string, RunPlanLabel> {
  const labels: Record<string, RunPlanLabel> = {};
  if (!runs.length) return labels;
  const titleBySubtaskId = new Map(subtasks.map((subtask) => [subtask.id, subtask.title]));

  // Events come newest first, so the first meta for a key is the current plan's.
  const metaBySubtaskId = new Map<string, SubtaskPlanMeta>();
  const scopeByReviewerKey = new Map<string, Array<{ key: string; subtaskId: string }>>();
  for (const event of listPlanMetaEvents(store, orchestrationId, SUBTASK_META_PREFIX)) {
    if (!event.payload) continue;
    const parsed = safeParse<SubtaskPlanMeta>(event.payload);
    if (parsed?.type === "subtask" && !metaBySubtaskId.has(parsed.subtaskId)) {
      metaBySubtaskId.set(parsed.subtaskId, parsed);
    }
  }
  for (const event of listPlanMetaEvents(store, orchestrationId, REVIEWER_META_PREFIX)) {
    if (!event.payload) continue;
    const parsed = safeParse<ReviewerPlanMeta>(event.payload);
    if (parsed?.type === "reviewer" && !scopeByReviewerKey.has(parsed.reviewerKey)) {
      scopeByReviewerKey.set(parsed.reviewerKey, parsed.scope);
    }
  }

  // A reviewer run carries no subtaskId; its key lives in the spawn event.
  const reviewerKeyByRunId = new Map<string, string>();
  for (const event of store.listOrchestrationEvents({ orchestrationId, kind: "spawn", limit: META_SCAN_LIMIT })) {
    if (event.phase !== "review" || !event.summary) continue;
    const key = event.summary.match(/Spawned reviewer (\S+) for/)?.[1];
    const runId = event.summary.match(/\(([^()]+)\)\.?\s*$/)?.[1];
    if (key && runId && !reviewerKeyByRunId.has(runId)) reviewerKeyByRunId.set(runId, key);
  }

  const needsSibling = runs.some(
    (run) => run.phase === "review" && !reviewerKeyByRunId.has(run.id) && run.assignmentId,
  );
  // Retry runs have no spawn event of their own but inherit the assignment of
  // the run they replace, which does.
  if (needsSibling) {
    for (const sibling of store.listAgentRuns({ orchestrationId, limit: 500 })) {
      const key = sibling.assignmentId && reviewerKeyByRunId.get(sibling.id);
      if (!key) continue;
      for (const run of runs) {
        if (run.assignmentId === sibling.assignmentId && !reviewerKeyByRunId.has(run.id)) {
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
        if (!previous || round > previous.round) latest.set(origin, { round, subtaskId: entry.subtaskId });
      }
      const keys: string[] = [];
      const titles: string[] = [];
      for (const [origin, entry] of latest) {
        const meta = metaBySubtaskId.get(entry.subtaskId);
        keys.push(folderRoundLabel(contextKeyFor(meta?.key ?? origin, entry.subtaskId, meta?.planCycle), entry.round));
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
          ? folderRoundLabel(contextKeyFor(meta.key, run.subtaskId, meta.planCycle), roundFor(meta.key))
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

function isRunConsumed(store: MemoryStore, orchestrationId: string, runId: string): boolean {
  return store
    .listOrchestrationEvents({ orchestrationId, kind: "run_ended", limit: META_SCAN_LIMIT })
    .some((event) => event.summary?.includes(runId));
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
  // Retry budget belongs to this phase in this cycle. Counting every historic
  // terminal leader run made the first malformed reply after a successful
  // replan look like a second failure, so the advertised retry never ran.
  const priorParseFailures = store
    .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 1000 })
    .filter((event) =>
      event.cycle === orchestration.cycle
      && event.phase === phase
      && event.kind === "error"
      && event.summary?.startsWith(`Leader ${phase} output could not be parsed:`),
    );
  if (priorParseFailures.length >= 1) {
    recordEvent(store, orchestration, phase, "error", `Leader ${phase} output could not be parsed: ${error}`);
    if (failedRun) consumeRun(store, orchestration, phase, failedRun, `could not be parsed (${error})`);
    createQuestion(store, orchestration, { question: `Leader ${phase} output could not be parsed after retrying: ${error}`, options: [] });
    const updated = store.updateOrchestration(orchestration.id, { status: "paused", lastError: error }) ?? orchestration;
    const ctx = deps.contextStoreFor?.(orchestration.id);
    if (ctx) refreshContextIndex(store, updated, ctx);
    return result(updated, `Leader ${phase} parsing failed twice; paused for user input.`, []);
  }
  const leaderAgent = mustGetAgent(store, orchestration.leaderAgentId);
  const gated = gateSpawn(
    store,
    orchestration,
    `${phase}:parse-retry:${failedRun?.id ?? priorParseFailures.length}`,
    `Retry the leader ${phase} turn with ${describeAgent(leaderAgent)} after an invalid response`,
    leaderAgent.id,
  );
  if (gated) return gated;
  recordEvent(store, orchestration, phase, "error", `Leader ${phase} output could not be parsed: ${error}`);
  // Consume only when the retry is actually authorised. Consuming it while an
  // approval is pending makes the next step forget this was a parse retry and
  // launch an ordinary fresh turn under a different key.
  if (failedRun) consumeRun(store, orchestration, phase, failedRun, `could not be parsed (${error})`);
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
  const priorAttempts = assignmentId
    ? store
        .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 500 })
        .filter((event) => event.kind === "error" && event.phase === "review" && event.summary?.includes(assignmentId))
    : [];
  const original = assignmentId
    ? store.listAssignments({ taskId: orchestration.taskId, limit: 500 }).find((item) => item.id === assignmentId)
    : undefined;
  if (priorAttempts.length >= 1 || !original || !run.roleId) {
    recordEvent(
      store,
      orchestration,
      "review",
      "error",
      `Reviewer output could not be parsed${assignmentId ? ` (assignment ${assignmentId})` : ""}: ${error}`,
    );
    consumeRun(store, orchestration, "review", run, `could not be parsed (${error})`);
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
  const gated = gateSpawn(
    store,
    orchestration,
    `review:parse-retry:${run.id}`,
    `Retry the reviewer turn with ${describeAgent(agent)} after an invalid response`,
    agent.id,
  );
  if (gated) return gated;
  recordEvent(
    store,
    orchestration,
    "review",
    "error",
    `Reviewer output could not be parsed${assignmentId ? ` (assignment ${assignmentId})` : ""}: ${error}`,
  );
  consumeRun(store, orchestration, "review", run, `could not be parsed (${error})`);
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

// What a rework implementer needs that the rework goal alone cannot carry: the
// reviewer's actual findings, and what the previous attempt says it did.
export type ReworkContext = {
  attempt: number;
  previous: Array<{
    title: string;
    resultSummary?: string;
    reviews: Array<{ verdict: string; summary: string; findings?: string }>;
  }>;
};

// Where this implementer reads its context from and writes its own account to,
// when the orchestration has a context store.
export type ImplementerContextPaths = {
  brief: string;
  prior: string[];
  write: string;
  round: number;
};

function renderImplementerPrompt(
  subtask: Subtask,
  files: string[],
  rework?: ReworkContext,
  context?: ImplementerContextPaths,
): string {
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
  if (context) {
    lines.push(
      "",
      "## Context",
      `Assignment brief: \`${context.brief}\` — read it first; it names the dependencies whose`,
      "`summary.md` you may read. Read no other subtask's folder.",
    );
    if (context.prior.length) {
      lines.push(
        "",
        `This is attempt ${context.round}. The earlier attempt(s) and why they were sent back:`,
        ...context.prior.map((path) => `- \`${path}\``),
        "",
        "Read those before you touch anything. Fix exactly what the reviews name; the",
        "earlier attempt's work is still in the tree and most of it is already correct.",
      );
    }
    lines.push(
      "",
      "Every file above opens with `## Summary`. Read that first and go on to",
      "`## Detail` only when you need it.",
      "",
      `## Before you finish, write \`${context.write}\``,
      "",
      "```markdown",
      `# ${subtask.title} — attempt ${context.round}`,
      "",
      "## Summary",
      "<up to 10 lines: what you changed, which files, and anything still open>",
      "",
      "## Detail",
      "<how each acceptance criterion is met; decisions you made and why; what you",
      "deliberately left alone; anything the reviewer would otherwise have to guess>",
      "```",
      "",
      "This file is what the reviewer, the adjudicator and any later attempt read.",
      "Nothing else you say survives this turn. A turn that leaves it unwritten is",
      "sent back for it.",
      "",
      ...WORKBOARD_BOUNDARY_LINES,
    );
  }
  // Adjudication compresses a whole review into one `rework.goal` sentence, and
  // the replacement subtask is a fresh CLI process with no memory of attempt
  // one. Without this the implementer re-derives the defect from a paraphrase,
  // guesses at what was already right, and comes back failing the same finding
  // — which is what turns one rework into a chain of them.
  if (rework?.previous.length) {
    lines.push(
      "",
      `## Rework — attempt ${rework.attempt}`,
      "This subtask replaces an earlier attempt that was sent back. What follows is that attempt and why it was rejected.",
    );
    for (const previous of rework.previous) {
      lines.push("", `### Earlier attempt: ${previous.title}`);
      if (previous.resultSummary) lines.push(`What it reported doing: ${previous.resultSummary}`);
      for (const review of previous.reviews) {
        lines.push(`- Reviewer verdict: ${review.verdict} — ${review.summary}`);
        if (review.findings) lines.push(`  findings: ${review.findings}`);
      }
    }
    lines.push(
      "",
      "Rules for this attempt:",
      "- Fix exactly the findings above. Do not restart the subtask from scratch and do not rewrite parts no finding complains about.",
      "- Read the current state of the files first: the earlier attempt's work is still in the tree, so some of it is already correct.",
      "- Before you finish, walk the findings one by one and state in your closing summary how each was addressed. A finding you cannot fix must be named as still open, not left silent.",
    );
  }
  return lines.join("\n");
}

// Walks the `<origin>-rework-<cycle>` key chain back to the original subtask,
// collecting each earlier attempt's own account and the reviews against it.
function reworkContextFor(
  store: MemoryStore,
  orchestration: Orchestration,
  subtask: Subtask,
): ReworkContext | undefined {
  const key = findSubtaskKey(store, orchestration.id, subtask.id);
  if (!key) return undefined;
  const ancestors: string[] = [];
  let current: string | undefined = key.match(/^(.+)-rework-\d+$/)?.[1];
  while (current) {
    ancestors.unshift(current);
    current = current.match(/^(.+)-rework-\d+$/)?.[1];
  }
  if (!ancestors.length) return undefined;
  const titleById = new Map(
    store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 }).map((entry) => [entry.id, entry.title]),
  );
  const previous: ReworkContext["previous"] = [];
  for (const ancestorKey of ancestors) {
    const meta = findSubtaskMetaByKey(store, orchestration.id, ancestorKey);
    if (!meta) continue;
    const assignment = latestByCreatedAt(store.listAssignments({ subtaskId: meta.subtaskId, limit: 20 }));
    const reviews = store.listReviews({ subtaskId: meta.subtaskId, limit: 20 });
    previous.push({
      title: titleById.get(meta.subtaskId) ?? ancestorKey,
      resultSummary: assignment?.resultSummary ?? undefined,
      reviews: reviews.map((review) => ({
        verdict: review.verdict,
        summary: review.summary,
        findings: review.findings,
      })),
    });
  }
  return previous.length ? { attempt: ancestors.length + 1, previous } : undefined;
}

// ---------------------------------------------------------------------------
// Context store wiring
// ---------------------------------------------------------------------------

// A turn that finished without writing its context document gets exactly one
// short, code-free retry that asks only for the file. Then the orchestration
// moves on regardless: the file is how the *next* turn avoids re-deriving what
// this one learnt, and losing that is a real cost — but stalling the whole run
// on a document is a worse one, and an agent that ignored the instruction twice
// will ignore it a third time.
const CONTEXT_RETRY_EVENT_PREFIX = "context-file-retry:";
const CONTEXT_FILE_RETRY_BUDGET = 1;

type ContextTarget = { contextKey: string; round: number };

// Which folder and which round a subtask's documents belong to. Both come from
// the plan key rather than the subtask id, so a rework lands as round 2 inside
// the original's folder instead of opening a fresh folder that knows nothing.
function contextTargetFor(
  store: MemoryStore,
  orchestration: Orchestration,
  subtask: Subtask,
): ContextTarget {
  const meta = getSubtaskMeta(store, orchestration.id, subtask.id);
  return {
    contextKey: contextKeyFor(meta?.key, subtask.id, meta?.planCycle),
    round: roundFor(meta?.key),
  };
}

// Documents from earlier attempts at this same work — the chain that used to be
// rebuilt and truncated into every prompt.
function priorRoundPaths(ctx: ContextStore, target: ContextTarget, kinds: TurnKind[]): string[] {
  const paths: string[] = [];
  for (let round = 1; round < target.round; round += 1) {
    for (const kind of kinds) paths.push(ctx.turnPath(kind, target.contextKey, round));
  }
  return ctx.existingPaths(paths);
}

function writeAssignmentBrief(
  store: MemoryStore,
  orchestration: Orchestration,
  ctx: ContextStore,
  subtask: Subtask,
  files: string[],
  target: ContextTarget,
): void {
  const byId = new Map(
    store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 }).map((entry) => [entry.id, entry]),
  );
  // A dependency is handed over as its summary and nothing else. Widening this
  // to its reports and reviews is what would make reading cost grow with
  // rounds × tasks instead of with tasks.
  const dependencies = subtask.dependsOn
    .map((depId) => byId.get(depId))
    .filter((dep): dep is Subtask => Boolean(dep))
    .map((dep) => ({
      title: dep.title,
      summaryPath: ctx.summaryPath(contextTargetFor(store, orchestration, dep).contextKey),
    }))
    .filter((dep) => ctx.existingPaths([dep.summaryPath]).length > 0);
  ctx.writeBrief({
    contextKey: target.contextKey,
    title: subtask.title,
    goal: subtask.goal,
    acceptanceCriteria: subtask.acceptanceCriteria,
    files,
    dependencies,
  });
}

// The map from plan keys to folders. Rewritten rather than appended because it
// is derived: the database owns these statuses, this is only a way in for a
// human reading the folder.
function refreshContextIndex(store: MemoryStore, orchestration: Orchestration, ctx: ContextStore): void {
  const task = store.getTask(orchestration.taskId);
  const tasks: IndexTaskRow[] = [];
  // Attempts share a folder, so one row per folder — and the row to show is
  // the *latest* attempt. Picking it explicitly rather than letting the query
  // order decide: `listSubtasks` sorts by priority then updated_at, which puts
  // a long-finished attempt after the one running right now, so the index used
  // to advertise stale work as the current state of every folder.
  const byKey = new Map<string, { subtask: Subtask; index: number }>();
  for (const subtask of store.listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })) {
    const { contextKey } = contextTargetFor(store, orchestration, subtask);
    const previous = byKey.get(contextKey);
    if (previous && !supersedesForIndex(subtask, previous.subtask)) continue;
    const index = previous ? previous.index : tasks.length;
    byKey.set(contextKey, { subtask, index });
    const row = { contextKey, title: subtask.title, status: subtask.status };
    if (previous) tasks[index] = row;
    else tasks.push(row);
  }
  ctx.writeIndex({
    taskTitle: task?.title ?? orchestration.taskId,
    goal: task?.goal,
    status: orchestration.status,
    cycle: orchestration.cycle,
    maxCycles: orchestration.maxCycles,
    tasks,
  });
}

type IndexTaskRow = { contextKey: string; title: string; status: string };

// Which of two attempts at the same folder the index should name. A live
// attempt always beats a cancelled one; otherwise the newest wins.
function supersedesForIndex(candidate: Subtask, current: Subtask): boolean {
  const candidateCancelled = candidate.status === "cancelled";
  const currentCancelled = current.status === "cancelled";
  if (candidateCancelled !== currentCancelled) return currentCancelled;
  return candidate.createdAt > current.createdAt;
}

// Spawns the one file-only retry, or returns undefined to let the caller carry
// on. `tag` identifies what is being retried so the budget is per document, not
// per orchestration.
function retryForMissingContext(
  store: MemoryStore,
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  input: {
    phase: AgentRunPhase;
    agent: RegisteredAgent | undefined;
    tag: string;
    missing: Array<{ path: string; reason: string }>;
    sourceRun?: AgentRun;
    extra?: { subtaskId?: string; assignmentId?: string; roleId?: string };
  },
): OrchestrationStepResult | undefined {
  if (!input.missing.length || !input.agent) return undefined;
  const spent = store
    .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 1000 })
    .filter((event) => event.summary?.startsWith(`${CONTEXT_RETRY_EVENT_PREFIX}${input.tag}`)).length;
  if (spent >= CONTEXT_FILE_RETRY_BUDGET) {
    recordEvent(
      store,
      orchestration,
      input.phase,
      "error",
      `Gave up asking for ${input.missing.map((entry) => entry.path).join(", ")}; continuing without it. The next turn on this work will have less context than it should.`,
    );
    return undefined;
  }
  const gated = gateSpawn(
    store,
    orchestration,
    `context-retry:${input.tag}:${spent}`,
    `Ask ${describeAgent(input.agent)} to repair missing ${input.phase} context documents`,
    input.agent.id,
  );
  if (gated) return gated;
  const prompt = [
    "# Missing context document",
    "",
    "Your previous turn finished without leaving the record the next turn depends on:",
    ...input.missing.map((entry) => `- ${entry.reason}`),
    "",
    ...(input.sourceRun?.logPath
      ? [
          `Read the completed turn transcript at \`${input.sourceRun.logPath}\` before writing.`,
          "Do not reconstruct the report from git status alone or claim work absent from that transcript.",
          "",
        ]
      : []),
    "Write those file(s) now from what you already did. Do not change any code, do not",
    "redo the work, and do not reply with anything else. Each file must be:",
    "",
    "```markdown",
    "# <what this is>",
    "",
    "## Summary",
    "<up to 10 lines — what you did or found, and anything the next turn must know>",
    "",
    "## Detail",
    "<the rest>",
    "```",
  ].join("\n");
  const run = spawnTurn(deps, store, orchestration, input.agent, prompt, input.phase, input.extra ?? {});
  recordEvent(
    store,
    orchestration,
    input.phase,
    "spawn",
    `${CONTEXT_RETRY_EVENT_PREFIX}${input.tag} asked ${describeAgent(input.agent)} to write ${input.missing.map((entry) => entry.path).join(", ")} (${run.id}).`,
  );
  // Consumed the moment it is spawned. It shares a phase with the turn it is
  // repairing, and its reply is prose — parsing it as a leader or reviewer turn
  // would fail and drag the orchestration into the parse-failure path. The
  // file it writes is the entire product of this run.
  consumeRun(store, orchestration, input.phase, run, "was a context-document retry; its log is never parsed");
  return result(orchestration, `Asked for the missing context document(s) before continuing.`, [run.id]);
}

function nextPlanContextCycle(store: MemoryStore, orchestrationId: string): number {
  const appliedPlans = store
    .listOrchestrationEvents({ orchestrationId, kind: "leader_turn", limit: 1000 })
    .filter((event) => event.phase === "plan" && event.summary?.startsWith("Leader produced "));
  return appliedPlans.length + 1;
}

// Files the plan in the context store when there is one, and records why it
// changed. The revision log is the only place the *reason* for a re-plan
// survives; without it the next revision can undo this one and the two take
// turns forever.
function writePlanDocument(
  orchestration: Orchestration,
  deps: OrchestratorDeps,
  ctx: ContextStore | undefined,
  markdown: string,
  revision?: { trigger: string; change: string },
): string {
  if (!ctx) return deps.writePlanFile(markdown);
  return ctx.writePlan(markdown, orchestration.planPath ? revision : undefined);
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

function findDefaultAgent(store: MemoryStore, capability: string): RegisteredAgent | undefined {
  return store
    .listRegisteredAgents({ enabled: true, limit: 500 })
    .find((candidate) => agentSupportsCapabilities(candidate, [capability]));
}

// The single door every implementer/reviewer spawn goes through.
//
// The roster stays the first and preferred answer: an agent the user registered
// and enabled in the Agents tab. But an empty (or capability-short) roster used
// to be a hard stop — the leader planned, then every spawn threw "No enabled
// registered agent available", and the orchestration died with nothing to show.
// Rather than fail, register the agent the plan calls for and say so in the
// timeline; it lands in the Agents tab where the user can retune or disable it.
// Which providers may be staffed is decided in the Agents tab: an agent (or a
// whole provider) the user disabled there is simply not in the roster.
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
  const existing = findDefaultAgent(store, capability);
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
  const installed = deps.listProviders?.().map((option) => option.provider) ?? [];
  const leaderProvider = store.getRegisteredAgent(orchestration.leaderAgentId)?.provider;
  const candidates = [preference?.provider, ...installed, leaderProvider]
    .filter((provider): provider is string => Boolean(provider));

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
  excludeAgentId?: string,
): RegisteredAgent | undefined {
  return store
    .listRegisteredAgents({ enabled: true, limit: 500 })
    .find((candidate) =>
      candidate.id !== excludeAgentId && agentSupportsCapabilities(candidate, [capability]),
    );
}

// What the leader is told it can staff from: the enabled agents in the Agents
// tab. Installed-but-unregistered CLIs are offered ONLY when that
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
  // Installed CLIs, used only as the empty-roster fallback.
  const fromInstalled = () => {
    const catalogs = _deps.listProviders?.() ?? [];
    const providerModels: Record<string, string[]> = {};
    for (const option of catalogs) providerModels[option.provider] = option.models;
    return {
      availableProviders: catalogs.map((option) => option.provider),
      providerModels,
      agentRoster: [],
      autoStaff: catalogs.length > 0,
    };
  };
  return agents.length ? collect(agents) : fromInstalled();
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
    payload: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
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
