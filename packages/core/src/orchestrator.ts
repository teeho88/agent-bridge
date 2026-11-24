import { createAdjudication } from "./orchestrator-adjudication.js";
import { createApprovals } from "./orchestrator-approvals.js";
import { createContext } from "./orchestrator-context.js";
import { createExecution } from "./orchestrator-execution.js";
import { createMetadata } from "./orchestrator-metadata.js";
import { createPlanning } from "./orchestrator-planning.js";
import { createReporting } from "./orchestrator-reporting.js";
import { createReview } from "./orchestrator-review.js";
import { createStaffing } from "./orchestrator-staffing.js";
import { createTurns } from "./orchestrator-turns.js";
export {
  CHANGE_REQUEST_EVENT_PREFIX,
  OPEN_SUBTASKS_QUESTION_KIND,
  DROP_OPEN_SUBTASKS_OPTION,
  SEND_OPEN_SUBTASKS_BACK_OPTION,
} from "./orchestrator-constants.js";

import type { MemoryStore, Orchestration } from "@agent-bridge/memory";

import {
  type OrchestratorDeps,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";

export function isFinalizationCycle(
  orchestration: Pick<Orchestration, "cycle" | "maxCycles">,
): boolean {
  return orchestration.cycle >= orchestration.maxCycles;
}

// Advances an orchestration by exactly one step. Callers (CLI `workforce
// step`/`watch`) are expected to have already called reapAgentRuns for this
// task so run statuses reflect reality before this is called.
export function stepOrchestration(
  store: MemoryStore,
  orchestrationId: string,
  deps: OrchestratorDeps,
): OrchestrationStepResult {
  const orchestration = store.getOrchestration(orchestrationId);
  if (!orchestration)
    throw new Error(`Orchestration not found: ${orchestrationId}`);

  if (["done", "failed", "paused"].includes(orchestration.status)) {
    return noop(
      orchestration,
      `Orchestration is ${orchestration.status}; nothing to do.`,
    );
  }

  if (orchestration.cycle > orchestration.maxCycles) {
    const updated =
      store.updateOrchestration(orchestration.id, {
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
    return noop(
      updated,
      "Exceeded max cycles; marked failed and raised a question for the user.",
    );
  }

  switch (orchestration.status) {
    case "planning":
      return stepPlanning(store, orchestration, deps);
    case "executing":
      return stepExecuting(store, orchestration, deps);
    case "adjudicating":
      return stepAdjudicating(store, orchestration, deps);
    case "reporting":
      return noop(
        orchestration,
        "Awaiting `report generate` to finish this orchestration.",
      );
    default:
      return noop(
        orchestration,
        `Unhandled orchestration status: ${orchestration.status}.`,
      );
  }
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
const adjudicationOperations = createAdjudication({
  get applyOpenSubtaskDrop() {
    return applyOpenSubtaskDrop;
  },
  get noop() {
    return noop;
  },
  get recordEvent() {
    return recordEvent;
  },
  get result() {
    return result;
  },
  get latestByCreatedAt() {
    return latestByCreatedAt;
  },
  get isRunConsumed() {
    return isRunConsumed;
  },
  get consumeRun() {
    return consumeRun;
  },
  get refreshContextIndex() {
    return refreshContextIndex;
  },
  get retryForMissingContext() {
    return retryForMissingContext;
  },
  get contextTargetFor() {
    return contextTargetFor;
  },
  get priorRoundPaths() {
    return priorRoundPaths;
  },
  get findCapabilityAgent() {
    return findCapabilityAgent;
  },
  get mustGetAgent() {
    return mustGetAgent;
  },
  get describeAgent() {
    return describeAgent;
  },
  get mustGetTask() {
    return mustGetTask;
  },
  get resolveProviderOptions() {
    return resolveProviderOptions;
  },
  get agentForKey() {
    return agentForKey;
  },
  get gateSpawn() {
    return gateSpawn;
  },
  get allApprovalNotes() {
    return allApprovalNotes;
  },
  get spawnTurn() {
    return spawnTurn;
  },
  get resolveLeaderReply() {
    return resolveLeaderReply;
  },
  get handleLeaderParseFailure() {
    return handleLeaderParseFailure;
  },
  get allQuestionAnswers() {
    return allQuestionAnswers;
  },
  get createQuestion() {
    return createQuestion;
  },
  get findSubtaskMetaByKey() {
    return findSubtaskMetaByKey;
  },
  get findSubtaskKey() {
    return findSubtaskKey;
  },
  get recordSubtaskMeta() {
    return recordSubtaskMeta;
  },
  get listReviewerMetas() {
    return listReviewerMetas;
  },
  get recordReviewerMeta() {
    return recordReviewerMeta;
  },
  get isFinalizationCycle() {
    return isFinalizationCycle;
  },
  get priorReviewsForSubtask() {
    return priorReviewsForSubtask;
  },
});
const {
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
} = adjudicationOperations;
const approvalsOperations = createApprovals({
  get recordEvent() {
    return recordEvent;
  },
  get safeParse() {
    return safeParse;
  },
  get noop() {
    return noop;
  },
  get result() {
    return result;
  },
  get describeAgent() {
    return describeAgent;
  },
});
export const {
  changeOrchestrationLeader,
  allApprovalNotes,
  approvedAgentOverride,
} = approvalsOperations;
const { approvalFor, agentForKey, gateSpawnDetailed, gateSpawn } =
  approvalsOperations;
const contextOperations = createContext({
  get findSubtaskKey() {
    return findSubtaskKey;
  },
  get findSubtaskMetaByKey() {
    return findSubtaskMetaByKey;
  },
  get getSubtaskMeta() {
    return getSubtaskMeta;
  },
  get latestByCreatedAt() {
    return latestByCreatedAt;
  },
  get recordEvent() {
    return recordEvent;
  },
  get consumeRun() {
    return consumeRun;
  },
  get result() {
    return result;
  },
  get gateSpawn() {
    return gateSpawn;
  },
  get describeAgent() {
    return describeAgent;
  },
  get spawnTurn() {
    return spawnTurn;
  },
});
const {
  renderImplementerPrompt,
  reworkContextFor,
  contextTargetFor,
  priorRoundPaths,
  writeAssignmentBrief,
  refreshContextIndex,
  supersedesForIndex,
  retryForMissingContext,
  nextPlanContextCycle,
  writePlanDocument,
} = contextOperations;
const executionOperations = createExecution({
  get result() {
    return result;
  },
  get recordEvent() {
    return recordEvent;
  },
  get noop() {
    return noop;
  },
  get isRunConsumed() {
    return isRunConsumed;
  },
  get safeTail() {
    return safeTail;
  },
  get consumeRun() {
    return consumeRun;
  },
  get safeParse() {
    return safeParse;
  },
  get tryResolveAgent() {
    return tryResolveAgent;
  },
  get describeAgent() {
    return describeAgent;
  },
  get mustGetRole() {
    return mustGetRole;
  },
  get resolveStaffAgent() {
    return resolveStaffAgent;
  },
  get gateSpawnDetailed() {
    return gateSpawnDetailed;
  },
  get gateSpawn() {
    return gateSpawn;
  },
  get approvedAgentOverride() {
    return approvedAgentOverride;
  },
  get contextTargetFor() {
    return contextTargetFor;
  },
  get retryForMissingContext() {
    return retryForMissingContext;
  },
  get writeAssignmentBrief() {
    return writeAssignmentBrief;
  },
  get priorRoundPaths() {
    return priorRoundPaths;
  },
  get renderImplementerPrompt() {
    return renderImplementerPrompt;
  },
  get reworkContextFor() {
    return reworkContextFor;
  },
  get createQuestion() {
    return createQuestion;
  },
  get listReviewerMetas() {
    return listReviewerMetas;
  },
  get findReviewerMetaForRun() {
    return findReviewerMetaForRun;
  },
  get getSubtaskMeta() {
    return getSubtaskMeta;
  },
  get handleReviewParseFailure() {
    return handleReviewParseFailure;
  },
  get missingReviewDocuments() {
    return missingReviewDocuments;
  },
  get applyReviewTurn() {
    return applyReviewTurn;
  },
  get resolveReviewerAgent() {
    return resolveReviewerAgent;
  },
  get spawnReviewer() {
    return spawnReviewer;
  },
  get spawnTurn() {
    return spawnTurn;
  },
});
const {
  stepExecuting,
  spawnImplementer,
  resolveImplementerAgent,
  applyOpenSubtaskDrop,
} = executionOperations;
const metadataOperations = createMetadata({
  get safeParse() {
    return safeParse;
  },
});
const {
  recordSubtaskMeta,
  recordReviewerMeta,
  listPlanMetaEvents,
  getSubtaskMeta,
  findSubtaskMetaByKey,
  findSubtaskKey,
  listReviewerMetas,
  findReviewerMetaForRun,
} = metadataOperations;
const planningOperations = createPlanning({
  get noop() {
    return noop;
  },
  get latestByCreatedAt() {
    return latestByCreatedAt;
  },
  get isRunConsumed() {
    return isRunConsumed;
  },
  get result() {
    return result;
  },
  get safeParse() {
    return safeParse;
  },
  get recordEvent() {
    return recordEvent;
  },
  get safeTail() {
    return safeTail;
  },
  get mustGetTask() {
    return mustGetTask;
  },
  get resolveProviderOptions() {
    return resolveProviderOptions;
  },
  get mustGetAgent() {
    return mustGetAgent;
  },
  get describeAgent() {
    return describeAgent;
  },
  get allApprovalNotes() {
    return allApprovalNotes;
  },
  get agentForKey() {
    return agentForKey;
  },
  get gateSpawn() {
    return gateSpawn;
  },
  get spawnTurn() {
    return spawnTurn;
  },
  get resolveLeaderReply() {
    return resolveLeaderReply;
  },
  get handleLeaderParseFailure() {
    return handleLeaderParseFailure;
  },
  get writePlanDocument() {
    return writePlanDocument;
  },
  get nextPlanContextCycle() {
    return nextPlanContextCycle;
  },
  get refreshContextIndex() {
    return refreshContextIndex;
  },
  get recordSubtaskMeta() {
    return recordSubtaskMeta;
  },
  get recordReviewerMeta() {
    return recordReviewerMeta;
  },
});
const {
  stepPlanning,
  pendingQuestionsFor,
  allQuestionAnswers,
  planQuestionRoundLimit,
  renderQuestionBudget,
  planQuestionRounds,
  buildPlanRevision,
  applyPlanTurn,
  createQuestion,
} = planningOperations;
const reportingOperations = createReporting({
  get listPlanMetaEvents() {
    return listPlanMetaEvents;
  },
});
export const { describeRunPlanLabels } = reportingOperations;
const {
  folderRoundLabel,
  isRunConsumed,
  consumeRun,
  recordEvent,
  latestByCreatedAt,
  safeTail,
  safeParse,
  noop,
  result,
} = reportingOperations;
const reviewOperations = createReview({
  get approvedAgentOverride() {
    return approvedAgentOverride;
  },
  get gateSpawn() {
    return gateSpawn;
  },
  get resolveStaffAgent() {
    return resolveStaffAgent;
  },
  get mustGetRole() {
    return mustGetRole;
  },
  get mustGetTask() {
    return mustGetTask;
  },
  get mustGetAgent() {
    return mustGetAgent;
  },
  get describeAgent() {
    return describeAgent;
  },
  get latestByCreatedAt() {
    return latestByCreatedAt;
  },
  get recordEvent() {
    return recordEvent;
  },
  get consumeRun() {
    return consumeRun;
  },
  get result() {
    return result;
  },
  get contextTargetFor() {
    return contextTargetFor;
  },
  get priorRoundPaths() {
    return priorRoundPaths;
  },
  get spawnTurn() {
    return spawnTurn;
  },
  get findSubtaskMetaByKey() {
    return findSubtaskMetaByKey;
  },
  get findSubtaskKey() {
    return findSubtaskKey;
  },
  get createQuestion() {
    return createQuestion;
  },
});
const {
  resolveReviewerAgent,
  spawnReviewer,
  priorReviewsForScopeEntry,
  missingReviewDocuments,
  applyReviewTurn,
  priorReviewsForSubtask,
  handleReviewParseFailure,
} = reviewOperations;
const staffingOperations = createStaffing({
  get recordEvent() {
    return recordEvent;
  },
});
const {
  mustGetTask,
  mustGetAgent,
  mustGetRole,
  tryResolveAgent,
  describeAgent,
  findDefaultAgent,
  resolveStaffAgent,
  autoStaffAgent,
  findCapabilityAgent,
  resolveProviderOptions,
} = staffingOperations;
const turnsOperations = createTurns({
  get recordEvent() {
    return recordEvent;
  },
  get consumeRun() {
    return consumeRun;
  },
  get result() {
    return result;
  },
  get safeTail() {
    return safeTail;
  },
  get isFinalizationCycle() {
    return isFinalizationCycle;
  },
  get forceFinalization() {
    return forceFinalization;
  },
  get createQuestion() {
    return createQuestion;
  },
  get refreshContextIndex() {
    return refreshContextIndex;
  },
  get mustGetAgent() {
    return mustGetAgent;
  },
  get describeAgent() {
    return describeAgent;
  },
  get gateSpawn() {
    return gateSpawn;
  },
});
const {
  handleLeaderParseFailure,
  spawnTurn,
  describeRunFailure,
  resolveLeaderReply,
} = turnsOperations;

export type {
  SpawnAgentTurnInput,
  OrchestratorDeps,
  ProviderOption,
  OrchestrationStepResult,
  ChangeLeaderResult,
  ChangeRequestPayload,
  SpawnApprovalPayload,
  SpawnApprovalResponse,
  QuestionAnswersPayload,
  RunPlanLabel,
  ReworkContext,
  ImplementerContextPaths,
} from "./orchestrator-contracts.js";
