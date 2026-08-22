// The turn ledger: what each leader/adjudicator turn produced, kept so the
// NEXT turn of the same role can revise its own work instead of re-deriving it.
//
// Every leader, reviewer and adjudicator turn is a fresh CLI process with a
// freshly rendered prompt — there is no session to resume and no transcript of
// what that role decided last time. Without a ledger the plan turn that parked
// on questions loses its own draft entirely (applyPlanTurn returns before the
// plan file is ever written), so the next round starts from the goal again,
// re-derives the same open points in different words, and asks them again.
// That is the plan/answer/re-plan loop the question-round ceiling only papers
// over.
//
// Ledger entries live in orchestration_events payloads, the same way subtask
// and reviewer plan metadata already does — no schema change, and they survive
// a restart because the events table is the orchestration's durable log.

import type { LeaderAdjudicateTurn, LeaderPlanTurn, LeaderQuestion } from "./leader-contract.js";
import type { MemoryStore, Orchestration } from "@agent-bridge/memory";
import { compactText, dedupeStrings } from "./token-optimizer.js";

// Each ledger section gets its own char budget so one runaway draft cannot
// crowd the actual turn instructions out of the prompt.
const PLAN_DRAFT_CHARS = 3000;
const REWORK_GOAL_CHARS = 240;
const MAX_DECISION_CYCLES = 12;

export type PlanDraftPayload = {
  type: "plan-draft";
  cycle: number;
  complexity: string;
  planMarkdown: string;
  subtaskTitles: string[];
  questions: string[];
};

export type AdjudicationDecisionEntry = {
  subtaskKey: string;
  verdict: string;
  reworkTitle?: string;
  reworkGoal?: string;
};

export type AdjudicationLedgerPayload = {
  type: "adjudication-decisions";
  cycle: number;
  actor: string;
  decisions: AdjudicationDecisionEntry[];
  projectComplete: boolean;
};

export type PlanLedger = {
  // The newest draft the leader produced, whether or not it was applied.
  previousPlanMarkdown?: string;
  previousComplexity?: string;
  previousSubtaskTitles: string[];
  // Every question asked across all rounds, oldest first, deduped. Answers are
  // carried separately (allQuestionAnswers); this is what stops a leader from
  // re-asking something the user dismissed rather than answered.
  askedQuestions: string[];
  rounds: number;
};

export type AdjudicationLedger = AdjudicationLedgerPayload[];

export function recordPlanDraft(store: MemoryStore, orchestration: Orchestration, turn: LeaderPlanTurn): void {
  const payload: PlanDraftPayload = {
    type: "plan-draft",
    cycle: orchestration.cycle,
    complexity: turn.complexity,
    planMarkdown: compactText(turn.planMarkdown, PLAN_DRAFT_CHARS),
    subtaskTitles: turn.subtasks.map((subtask) => subtask.title),
    questions: turn.questions.map((question: LeaderQuestion) => question.question),
  };
  store.recordOrchestrationEvent({
    orchestrationId: orchestration.id,
    cycle: orchestration.cycle,
    phase: "plan",
    kind: "leader_turn",
    summary: `plan-draft:${orchestration.cycle}`,
    payload: JSON.stringify(payload),
  });
}

export function readPlanLedger(store: MemoryStore, orchestrationId: string): PlanLedger {
  // Events come back newest-first, so the first draft seen is the current one
  // and the rest only contribute their questions.
  const drafts: PlanDraftPayload[] = [];
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "leader_turn" || !event.payload) continue;
    const parsed = safeParse<PlanDraftPayload>(event.payload);
    if (parsed?.type === "plan-draft") drafts.push(parsed);
  }
  const newest = drafts[0];
  const asked = dedupeStrings([...drafts].reverse().flatMap((draft) => draft.questions ?? []));
  return {
    previousPlanMarkdown: newest?.planMarkdown,
    previousComplexity: newest?.complexity,
    previousSubtaskTitles: newest?.subtaskTitles ?? [],
    askedQuestions: asked,
    rounds: drafts.length,
  };
}

export function recordAdjudicationDecisions(
  store: MemoryStore,
  orchestration: Orchestration,
  actor: string,
  turn: LeaderAdjudicateTurn,
): void {
  const payload: AdjudicationLedgerPayload = {
    type: "adjudication-decisions",
    cycle: orchestration.cycle,
    actor,
    decisions: turn.decisions.map((decision) => ({
      subtaskKey: decision.subtaskKey,
      verdict: decision.verdict,
      reworkTitle: decision.rework?.title,
      reworkGoal: decision.rework?.goal ? compactText(decision.rework.goal, REWORK_GOAL_CHARS) : undefined,
    })),
    projectComplete: turn.projectComplete,
  };
  store.recordOrchestrationEvent({
    orchestrationId: orchestration.id,
    cycle: orchestration.cycle,
    phase: "adjudicate",
    kind: "leader_turn",
    summary: `adjudication-decisions:${orchestration.cycle}`,
    payload: JSON.stringify(payload),
  });
}

// Oldest-first, capped: the point is to show how a subtask has been ruled on
// over time, and the oldest cycles matter least once the log gets long.
export function readAdjudicationLedger(store: MemoryStore, orchestrationId: string): AdjudicationLedger {
  const entries: AdjudicationLedgerPayload[] = [];
  for (const event of store.listOrchestrationEvents({ orchestrationId, limit: 1000 })) {
    if (event.kind !== "leader_turn" || !event.payload) continue;
    const parsed = safeParse<AdjudicationLedgerPayload>(event.payload);
    if (parsed?.type === "adjudication-decisions") entries.push(parsed);
  }
  return entries.reverse().slice(-MAX_DECISION_CYCLES);
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
