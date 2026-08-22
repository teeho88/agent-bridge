import type {
  AgentRequest,
  AgentRun,
  AgentKind,
  RegisteredAgent,
  SessionEvent,
  Subtask,
  Task,
} from "@agent-bridge/memory";
import { resumeStatusFor } from "@agent-bridge/core";
import { openStore } from "../../workspace.js";
import { renderDashboardHtml } from "../../ui-page.js";

// Store lookups that turn an id from a request body into the record a route
// needs, throwing the message the dashboard shows when it is missing.

export function mustGetOrchestrationForUi(store: ReturnType<typeof openStore>, taskId: string) {
  const orchestration = store.getOrchestrationByTask(taskId);
  if (!orchestration) throw new Error(`No orchestration found for task: ${taskId}`);
  return orchestration;
}

export function mustFindAgentForUi(store: ReturnType<typeof openStore>, agentId: string): RegisteredAgent {
  const found = store.getRegisteredAgent(agentId);
  if (!found) throw new Error(`Agent not found: ${agentId}`);
  return found;
}

export function mustFindSubtaskForUi(store: ReturnType<typeof openStore>, taskId: string, subtaskId: string): Subtask {
  const found = store.listSubtasks({ parentTaskId: taskId, limit: 500 }).find((candidate) => candidate.id === subtaskId);
  if (!found) throw new Error(`Subtask not found: ${subtaskId}`);
  return found;
}

export function resolveRegisteredAgent(
  agents: RegisteredAgent[],
  value: string,
): RegisteredAgent | undefined {
  return agents.find((agent) => agent.id === value || agent.name === value);
}

export function resolveSubtask(subtasks: Subtask[], value: string): Subtask | undefined {
  return subtasks.find((subtask) => subtask.id === value || subtask.title === value);
}

export function visibleAgentRequests(requests: AgentRequest[]): AgentRequest[] {
  return requests.filter((request) => !isIgnoredClaudeIdlePrompt(request));
}

export function isIgnoredClaudeIdlePrompt(request: AgentRequest): boolean {
  return request.agent === "claude" &&
    request.status === "pending" &&
    /(^|\n)Notification type:\s*\n?\s*idle_prompt(\n|$)/i.test(request.payload ?? "");
}

// Where an answered batch of leader questions belongs, and which leader turn
// the answers invalidate.
//
// Everything used to be stamped "plan" and the orchestration was forced back
// to "planning" whatever it had been doing. Answering a question the adjudicate
// turn had raised therefore rewrote the run's last phase, consumed every plan
// run, and sent the leader off to draw up a fresh plan instead of acting on the
// answer — the user's instruction arrived in a prompt whose only permitted
// output is subtasks. The newest event's phase is the same marker
// `resumeStatusFor` reads, so recording against it keeps the two in agreement.
export function answeredQuestionRouting(
  store: ReturnType<typeof openStore>,
  orchestrationId: string,
): { phase: string; resumeStatus: ReturnType<typeof resumeStatusFor>; stalePhase?: "plan" | "adjudicate" } {
  const [newestEvent] = store.listOrchestrationEvents({ orchestrationId, limit: 1 });
  const resumeStatus = resumeStatusFor(store, orchestrationId);
  // Answers change the requirements, so the leader turn that prompted them is
  // stale: consume it and let that same turn run again knowing the answers.
  // Only the phase that asked is invalidated — a plan run is not stale because
  // an adjudicate turn asked something. An "executing" run has no leader turn
  // of its own to redo, so nothing is consumed there.
  const stalePhase =
    resumeStatus === "adjudicating" ? "adjudicate" : resumeStatus === "planning" ? "plan" : undefined;
  return { phase: newestEvent?.phase ?? "plan", resumeStatus, stalePhase };
}

export function filterWorkBoardSessionEvents(
  events: SessionEvent[],
  orchestratedTaskIds: ReadonlySet<string>,
): SessionEvent[] {
  return events.filter((event) => !event.taskId || !orchestratedTaskIds.has(event.taskId));
}

export function inferContextAgent(
  task: Pick<Task, "id" | "ownerAgent"> | undefined,
  activeSessions: SessionEvent[],
  defaultAgent: AgentKind,
): AgentKind {
  return (
    activeSessions.find((event) => event.taskId === task?.id && event.agent)?.agent ??
    task?.ownerAgent ??
    defaultAgent
  );
}

export function recordDirectSubtaskRunOutcome(store: ReturnType<typeof openStore>, run: AgentRun): void {
  const succeeded = run.status === "done";
  if (run.assignmentId) {
    store.updateAssignment(run.assignmentId, {
      status: succeeded ? "done" : "failed",
      resultSummary: succeeded
        ? "Agent process completed successfully; subtask is awaiting review."
        : `Agent process failed${run.exitCode == null ? "" : ` with exit code ${run.exitCode}`}.`,
    });
  }
  if (run.subtaskId) {
    store.updateSubtask(run.subtaskId, {
      status: succeeded ? "review" : "blocked",
      statusReason: succeeded
        ? undefined
        : `Agent process failed${run.exitCode == null ? "" : ` with exit code ${run.exitCode}`}.`,
    });
  }
  if (run.orchestrationId) {
    store.recordOrchestrationEvent({
      orchestrationId: run.orchestrationId,
      cycle: run.cycle ?? 0,
      phase: run.phase ?? "implement",
      kind: succeeded ? "run_ended" : "error",
      summary: succeeded
        ? `Agent run ${run.id} completed successfully; subtask is awaiting review.`
        : `Agent run ${run.id} failed${run.exitCode == null ? "" : ` with exit code ${run.exitCode}`}.`,
    });
  }
}

export function renderUiHtml(cwd: string): string {
  return renderDashboardHtml(cwd);
}
