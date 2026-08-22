import type { RouteContext } from "./types.js";
import {
  openStore,
  paths,
} from "../../workspace.js";
import {
  generateReport,
} from "../report.js";
import {
  makeOrchestratorDeps,
} from "../workforce.js";
import {
  ACTIVE_RUN_STATUSES,
  AUTO_RUN_HALTED,
  isAutoRunning,
  startAutoRun,
  stopAutoRun,
} from "./auto-run.js";
import {
  readTextIfExists,
} from "./files.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  answeredQuestionRouting,
  mustGetOrchestrationForUi,
} from "./lookups.js";
import {
  optionalCount,
  optionalString,
  requiredString,
} from "./validation.js";
import {
  defaultCommandForProvider,
  reapAgentRuns,
  stopAgentRun,
} from "@agent-bridge/adapters";
import {
  CHANGE_REQUEST_EVENT_PREFIX,
  changeOrchestrationLeader,
  resolveLeaderAgent,
  resumeStatusFor,
  stepOrchestration,
  type ChangeRequestPayload,
  type QuestionAnswersPayload,
  type SpawnApprovalPayload,
  type SpawnApprovalResponse,
} from "@agent-bridge/core";
import {
  type OrchestrationAutonomy,
} from "@agent-bridge/memory";
import {
  spawn,
} from "node:child_process";

// Orchestration lifecycle from the Team Board: start, step, pause, answer
// questions, approve spawns and change the leader.

export async function routePostWorkforceOrchestrationStart(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const prompt = requiredString(body.prompt, "prompt");
    // Only the starting position: the Orchestration panel can move this at
    // any point during the run via /api/workforce/orchestration/autonomy.
    const autonomy = optionalString(body.autonomy) ?? "manual";
    if (!["manual", "approve-each", "auto"].includes(autonomy)) {
      throw new Error(`Invalid autonomy "${autonomy}". Use one of: manual, approve-each, auto.`);
    }
    const leaderProvider = requiredString(body.leaderProvider, "leaderProvider");
    const leaderAgent = resolveLeaderAgent(
      store,
      {
        provider: leaderProvider,
        mode: (optionalString(body.leaderMode) as "cli" | "api" | "manual" | undefined) ?? "cli",
        model: optionalString(body.leaderModel),
        reasoningEffort: optionalString(body.leaderReasoning),
      },
      // Without a command the find-or-create falls back to the provider name,
      // which is only a real binary by coincidence: antigravity's CLI is
      // `agy`, so such a row spawns nothing and every turn dies instantly with
      // "spawn antigravity ENOENT".
      { command: optionalString(body.leaderCommand) ?? defaultCommandForProvider(leaderProvider) },
    );
    const task = store.createTask({ title: prompt, goal: prompt, ownerAgent: "codex" });

    // The leader can only staff registered, enabled agents, so a ticked
    // provider has to exist in the roster before the first planning turn.
    const orchestration = store.createOrchestration({
      taskId: task.id,
      leaderAgentId: leaderAgent.id,
      autonomy: autonomy as OrchestrationAutonomy,
      maxParallel: Number(body.maxParallel ?? 3),
      maxCycles: Number(body.maxCycles ?? 8),
      maxQuestionRounds: optionalCount(body.maxQuestionRounds),
    });

    const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
    // Autonomy is the starting position of the Auto-run switch: picking
    // "auto" here is what makes the orchestration actually run unattended,
    // instead of being a field that only ever got written to the database.
    if (autonomy === "auto") startAutoRun(cwd, orchestration.id);
    sendJson(res, 200, {
      task,
      orchestration: stepResult.orchestration,
      summary: stepResult.summary,
      spawnedRunIds: stepResult.spawnedRunIds,
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationStep(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    reapAgentRuns(store, { taskId });
    const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
    sendJson(res, 200, stepResult);
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationReport(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    mustGetOrchestrationForUi(store, taskId);
    // Reap first: the reporter run usually finished between the click that
    // spawned it and this one, and generateReport reads run.status.
    reapAgentRuns(store, { taskId });
    sendJson(res, 200, generateReport(store, { taskId, cwd, forceFallback: Boolean(body.forceFallback) }));
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationAnswerQuestions(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    const dismiss = body.dismiss === true;

    const pending = store
      .listAgentRequests({ taskId, status: "pending", limit: 200 })
      .filter((request) => request.type === "question");
    if (!pending.length) throw new Error("There are no pending questions to answer.");

    const submitted = new Map<string, string>();
    for (const entry of Array.isArray(body.answers) ? body.answers : []) {
      const id = optionalString((entry as Record<string, unknown>)?.id);
      const answer = optionalString((entry as Record<string, unknown>)?.answer)?.trim();
      if (id && answer) submitted.set(id, answer);
    }
    if (!dismiss && !submitted.size) throw new Error("Answer at least one question, or dismiss them.");

    const answers: Array<{ question: string; answer: string }> = [];
    for (const request of pending) {
      const answer = submitted.get(request.id);
      // Unanswered ones are resolved too — leaving them pending would
      // re-park the orchestration the moment the leader repeats them.
      store.resolveAgentRequest(request.id, "resolved", answer);
      if (answer) answers.push({ question: request.title, answer });
    }

    const { phase, resumeStatus, stalePhase } = answeredQuestionRouting(store, orchestration.id);

    if (answers.length) {
      const payload: QuestionAnswersPayload = { type: "question-answers", answers };
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: orchestration.cycle,
        phase,
        kind: "user_action",
        summary: `Answered ${answers.length} leader question(s).`,
        payload: JSON.stringify(payload),
      });
      if (stalePhase) {
        for (const run of store
          .listAgentRuns({ orchestrationId: orchestration.id, limit: 500 })
          .filter((run) => run.phase === stalePhase)) {
          store.recordOrchestrationEvent({
            orchestrationId: orchestration.id,
            cycle: orchestration.cycle,
            phase: stalePhase,
            kind: "run_ended",
            summary: `Consumed ${stalePhase} run ${run.id} (superseded by answered questions).`,
          });
        }
      }
    }

    store.updateOrchestration(orchestration.id, { status: resumeStatus, lastError: null });
    const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
    sendJson(res, 200, {
      orchestration: stepResult.orchestration,
      summary: stepResult.summary,
      spawnedRunIds: stepResult.spawnedRunIds,
      answered: answers.length,
      dismissed: pending.length - answers.length,
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationApproveSpawn(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const requestId = requiredString(body.requestId, "requestId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    const request = store
      .listAgentRequests({ taskId, limit: 500 })
      .find((candidate) => candidate.id === requestId && candidate.type === "approval");
    if (!request) throw new Error(`Approval not found: ${requestId}`);
    if (request.status !== "pending") throw new Error(`This approval was already ${request.status}.`);
    const approve = body.approve !== false;
    // Approving with a different agent is a third answer, not a variant of
    // yes: the work is authorised but somebody else does it. It is validated
    // here rather than at spawn time so a bad pick is a 400 the user can fix,
    // not a step that throws minutes later.
    const agentId = approve ? optionalString(body.agentId) : undefined;
    if (agentId) {
      const agent = store.getRegisteredAgent(agentId);
      if (!agent) throw new Error(`Registered agent not found: ${agentId}`);
      if (!agent.enabled) throw new Error(`Agent "${agent.name}" is disabled; enable it in the Agents tab first.`);
    }
    const note = optionalString(body.note);
    // Always the JSON shape, even for a plain yes with a note: stored as raw
    // text the note parsed as nothing, so the instruction the user attached
    // to their approval was unreadable to every reader downstream.
    const response = JSON.stringify({
      type: "spawn-approval-response",
      agentId,
      note,
    } satisfies SpawnApprovalResponse);
    store.resolveAgentRequest(requestId, approve ? "accepted" : "rejected", response);

    const approvalPayload = (() => {
      try {
        return JSON.parse(request.payload ?? "") as SpawnApprovalPayload;
      } catch {
        return undefined;
      }
    })();
    if (approvalPayload?.type === "spawn-approval" && approvalPayload.key.startsWith("report:")) {
      const reportResult = approve
        ? generateReport(store, { taskId, cwd })
        : { status: "rejected" as const, requestId, message: "Reporter spawn was rejected." };
      const spawnedRunIds = reportResult.status === "spawned" ? [reportResult.runId] : [];
      sendJson(res, 200, {
        approved: approve,
        reassignedTo: agentId,
        orchestration: store.getOrchestration(orchestration.id) ?? orchestration,
        summary: "message" in reportResult ? reportResult.message : `Report written: ${reportResult.reportPath}`,
        spawnedRunIds,
        report: reportResult,
      });
      return;
    }

    // A rejection is handled by the step itself (it pauses and records why),
    // so both paths just step once and report what happened.
    if (orchestration.status === "paused") {
      store.updateOrchestration(orchestration.id, { status: resumeStatusFor(store, orchestration.id), lastError: null });
    }
    const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
    // Auto-run stops itself when an approval has gone unanswered for a while
    // (see the tick below). Answering one is exactly the signal to pick the
    // loop back up, otherwise the run would sit there approved but stopped.
    if (
      approve &&
      stepResult.orchestration.autonomy !== "manual" &&
      !AUTO_RUN_HALTED.has(stepResult.orchestration.status)
    ) {
      startAutoRun(cwd, orchestration.id);
    }
    sendJson(res, 200, {
      approved: approve,
      reassignedTo: agentId,
      orchestration: stepResult.orchestration,
      summary: stepResult.summary,
      spawnedRunIds: stepResult.spawnedRunIds,
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationAutoRun(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    if (body.enabled === false) {
      stopAutoRun(orchestration.id);
    } else {
      if (AUTO_RUN_HALTED.has(orchestration.status)) {
        throw new Error(`Orchestration is ${orchestration.status}; there is nothing for auto-run to advance.`);
      }
      startAutoRun(cwd, orchestration.id);
    }
    // Keep the stored autonomy in step with the switch, so a restarted
    // server (and the CLI's `workforce watch`) agree with what the UI shows.
    const autoRun = isAutoRunning(orchestration.id);
    // Auto-run and the approval gate are two separate switches. An
    // approve-each orchestration is allowed to keep stepping on the server —
    // it simply stops at every gate until you approve — so arming the timer
    // must not erase the gate, and disarming it must not drop it either.
    const nextAutonomy = autoRun
      ? orchestration.autonomy === "approve-each"
        ? "approve-each"
        : "auto"
      : orchestration.autonomy === "auto"
        ? "manual"
        : orchestration.autonomy;
    const updated = store.updateOrchestration(orchestration.id, { autonomy: nextAutonomy }) ?? orchestration;
    sendJson(res, 200, { autoRun, orchestration: updated });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationAutonomy(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const autonomy = requiredString(body.autonomy, "autonomy");
    if (!["manual", "approve-each", "auto"].includes(autonomy)) {
      throw new Error(`Invalid autonomy "${autonomy}". Use one of: manual, approve-each, auto.`);
    }
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    const updated =
      store.updateOrchestration(orchestration.id, { autonomy: autonomy as OrchestrationAutonomy }) ?? orchestration;
    // Autonomy is now the only switch: "manual" means the user drives, so the
    // stepping timer is off; everything else means the server advances the
    // run. "approve-each" still steps — it just parks at each gate until the
    // user answers, and answering restarts it immediately, which is far less
    // work than approving and then having to press Step as well.
    if (autonomy === "manual") {
      stopAutoRun(orchestration.id);
    } else if (!AUTO_RUN_HALTED.has(updated.status)) {
      startAutoRun(cwd, orchestration.id);
    }
    sendJson(res, 200, {
      orchestration: updated,
      autoRun: isAutoRunning(orchestration.id),
      previousAutonomy: orchestration.autonomy,
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationLeader(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const provider = requiredString(body.leaderProvider, "leaderProvider");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    const result = changeOrchestrationLeader(
      store,
      orchestration.id,
      {
        provider,
        mode: (optionalString(body.leaderMode) as "cli" | "api" | "manual" | undefined) ?? "cli",
        model: optionalString(body.leaderModel),
        reasoningEffort: optionalString(body.leaderReasoning),
      },
      // Same reason as the start endpoint: without an explicit command the
      // find-or-create falls back to the provider name, which spawns nothing
      // for providers whose CLI is named differently.
      { command: optionalString(body.leaderCommand) ?? defaultCommandForProvider(provider) },
    );
    sendJson(res, 200, {
      orchestration: result.orchestration,
      leader: result.leader,
      changed: result.changed,
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationRequestChanges(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const request = requiredString(body.request, "request").trim();
    if (!request) throw new Error("request must not be empty.");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    // Stop anything still running for the old round first, so its output
    // can't land as a result for the new plan.
    const activeRuns = store
      .listAgentRuns({ taskId, limit: 500 })
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
    for (const run of activeRuns) await stopAgentRun(store, run.id);

    // Every prior plan run is marked consumed so stepPlanning spawns a fresh
    // turn instead of re-applying the plan that produced the current build.
    const priorPlanRuns = store
      .listAgentRuns({ orchestrationId: orchestration.id, limit: 500 })
      .filter((run) => run.phase === "plan");
    for (const run of priorPlanRuns) {
      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: orchestration.cycle,
        phase: "plan",
        kind: "run_ended",
        summary: `Consumed plan run ${run.id} (superseded by a change request).`,
      });
    }

    const payload: ChangeRequestPayload = {
      type: "change-request",
      request,
      previousPlan: readTextIfExists(orchestration.planPath, cwd),
      previousReport: readTextIfExists(orchestration.reportPath, cwd),
    };
    store.recordOrchestrationEvent({
      orchestrationId: orchestration.id,
      cycle: orchestration.cycle,
      phase: "plan",
      kind: "user_action",
      summary: `${CHANGE_REQUEST_EVENT_PREFIX} ${request.split(/\r?\n/)[0].slice(0, 160)}`,
      payload: JSON.stringify(payload),
    });

    store.updateOrchestration(orchestration.id, {
      status: "planning",
      // applyPlanTurn resets cycle to 1, so the budget has to cover a whole
      // fresh round rather than whatever was left of the previous one.
      maxCycles: Math.max(orchestration.maxCycles, 8),
      lastError: null,
    });

    // Spawn the re-planning turn right here. Leaving it parked at "planning"
    // means the button appears to do nothing at all until the user happens to
    // press Step — the same immediate-start behaviour `workforce start` has.
    const stepResult = stepOrchestration(store, orchestration.id, makeOrchestratorDeps(store, cwd));
    sendJson(res, 200, {
      orchestration: stepResult.orchestration,
      summary: stepResult.summary,
      spawnedRunIds: stepResult.spawnedRunIds,
      stoppedRuns: activeRuns.map((run) => run.id),
    });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationPause(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const orchestration = mustGetOrchestrationForUi(store, requiredString(body.taskId, "taskId"));
    // Pausing a finished orchestration used to be the only way back in:
    // pause then resume flipped `done` to `executing`. That is a change
    // request, and it has its own endpoint now — this one stays honest.
    if (orchestration.status === "done" || orchestration.status === "failed") {
      throw new Error(
        `Orchestration is already ${orchestration.status}; use Request changes to reopen it.`,
      );
    }
    sendJson(res, 200, { orchestration: store.updateOrchestration(orchestration.id, { status: "paused" }) });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationResume(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const orchestration = mustGetOrchestrationForUi(store, requiredString(body.taskId, "taskId"));
    if (orchestration.status !== "paused") {
      throw new Error(`Orchestration is not paused (status: ${orchestration.status}).`);
    }
    const status = resumeStatusFor(store, orchestration.id);
    sendJson(res, 200, { orchestration: store.updateOrchestration(orchestration.id, { status, lastError: null }) });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceOrchestrationStop(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    // Otherwise the loop keeps stepping the orchestration the user just stopped.
    stopAutoRun(orchestration.id);
    const activeRuns = store
      .listAgentRuns({ taskId, limit: 500 })
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
    for (const run of activeRuns) await stopAgentRun(store, run.id);
    const updated = store.updateOrchestration(orchestration.id, { status: "failed", lastError: "Stopped by user." });
    sendJson(res, 200, { orchestration: updated, stoppedRuns: activeRuns.map((run) => run.id) });
  } finally {
    store.close();
  }
  return;
}
