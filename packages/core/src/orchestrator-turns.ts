import type {
  AgentRun,
  AgentRunPhase,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
} from "@agent-bridge/memory";

import { buildRetryPrompt } from "./leader-contract.js";

import {
  type OrchestratorDeps,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";
type Dependencies = {
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  consumeRun: import("./orchestrator-reporting.js").ReportingFunctions["consumeRun"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  safeTail: import("./orchestrator-reporting.js").ReportingFunctions["safeTail"];
  isFinalizationCycle: typeof import("./orchestrator.js").isFinalizationCycle;
  forceFinalization: import("./orchestrator-adjudication.js").AdjudicationFunctions["forceFinalization"];
  createQuestion: import("./orchestrator-planning.js").PlanningFunctions["createQuestion"];
  refreshContextIndex: import("./orchestrator-context.js").ContextFunctions["refreshContextIndex"];
  mustGetAgent: import("./orchestrator-staffing.js").StaffingFunctions["mustGetAgent"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
};
export type TurnsFunctions = ReturnType<typeof createTurns>;
export function createTurns(operations: Dependencies) {
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
      .listOrchestrationEvents({
        orchestrationId: orchestration.id,
        limit: 1000,
      })
      .filter(
        (event) =>
          event.cycle === orchestration.cycle &&
          event.phase === phase &&
          event.kind === "error" &&
          event.summary?.startsWith(
            `Leader ${phase} output could not be parsed:`,
          ),
      );
    if (priorParseFailures.length >= 1) {
      operations.recordEvent(
        store,
        orchestration,
        phase,
        "error",
        `Leader ${phase} output could not be parsed: ${error}`,
      );
      if (failedRun)
        operations.consumeRun(
          store,
          orchestration,
          phase,
          failedRun,
          `could not be parsed (${error})`,
        );
      if (
        phase === "adjudicate" &&
        failedRun &&
        operations.isFinalizationCycle(orchestration)
      ) {
        return operations.forceFinalization(
          store,
          orchestration,
          failedRun.id,
          error,
          deps.contextStoreFor?.(orchestration.id),
        );
      }
      operations.createQuestion(store, orchestration, {
        question: `Leader ${phase} output could not be parsed after retrying: ${error}`,
        options: [],
      });
      const updated =
        store.updateOrchestration(orchestration.id, {
          status: "paused",
          lastError: error,
        }) ?? orchestration;
      const ctx = deps.contextStoreFor?.(orchestration.id);
      if (ctx) operations.refreshContextIndex(store, updated, ctx);
      return operations.result(
        updated,
        `Leader ${phase} parsing failed twice; paused for user input.`,
        [],
      );
    }
    const leaderAgent = operations.mustGetAgent(
      store,
      orchestration.leaderAgentId,
    );
    const gated = operations.gateSpawn(
      store,
      orchestration,
      `${phase}:parse-retry:${failedRun?.id ?? priorParseFailures.length}`,
      `Retry the leader ${phase} turn with ${operations.describeAgent(leaderAgent)} after an invalid response`,
      leaderAgent.id,
    );
    if (gated) return gated;
    operations.recordEvent(
      store,
      orchestration,
      phase,
      "error",
      `Leader ${phase} output could not be parsed: ${error}`,
    );
    // Consume only when the retry is actually authorised. Consuming it while an
    // approval is pending makes the next step forget this was a parse retry and
    // launch an ordinary fresh turn under a different key.
    if (failedRun)
      operations.consumeRun(
        store,
        orchestration,
        phase,
        failedRun,
        `could not be parsed (${error})`,
      );
    const prompt = `${buildOriginalPrompt()}\n\n${buildRetryPrompt(error)}`;
    const run = spawnTurn(
      deps,
      store,
      orchestration,
      leaderAgent,
      prompt,
      phase,
    );
    return operations.result(
      orchestration,
      `Retrying leader ${phase} turn after a parse failure.`,
      [run.id],
    );
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
    const tail = operations.safeTail(log).trim();
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
    parse: (
      text: string,
    ) => { ok: true; turn: T } | { ok: false; error: string },
  ): { ok: true; turn: T } | { ok: false; error: string } {
    const log = deps.readLog(run);
    if (run.status !== "failed") {
      const parsed = parse(log);
      if (parsed.ok || run.status === "done") return parsed;
    }
    return describeRunFailure(run, log) ?? parse(log);
  }
  return {
    handleLeaderParseFailure,
    spawnTurn,
    describeRunFailure,
    resolveLeaderReply,
  };
}
