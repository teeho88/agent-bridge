import type {
  AgentRun,
  AgentRunPhase,
  Orchestration,
  RegisteredAgent,
} from "@agent-bridge/memory";

import { type ContextStore } from "./context-store.js";
import { type LeaderAgentPreference } from "./leader-contract.js";

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

export type ChangeLeaderResult = {
  orchestration: Orchestration;
  leader: RegisteredAgent;
  previousLeaderId: string;
  changed: boolean;
};

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

export type SpawnGate =
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

export type QuestionAnswersPayload = {
  type: "question-answers";
  answers: Array<{ question: string; answer: string }>;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type SubtaskPlanMeta = {
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

export type ReviewerPlanMeta = {
  type: "reviewer";
  reviewerKey: string;
  scope: Array<{ key: string; subtaskId: string }>;
  role?: string;
  agentPreference?: LeaderAgentPreference;
};

/** Plan label for a run: the leader's key ("s1", "r1") plus what it is about. */
export type RunPlanLabel = { key: string; title: string };

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

export type ContextTarget = { contextKey: string; round: number };

export type IndexTaskRow = {
  contextKey: string;
  title: string;
  status: string;
};
