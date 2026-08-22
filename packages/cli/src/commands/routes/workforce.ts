import type { RouteContext } from "./types.js";
import {
  addCustomDefaultAgentPreset,
  ensureDefaultAgentPresetStates,
  removeDefaultAgentPreset,
  restoreBuiltInDefaultAgentPresets,
  setDefaultAgentPresetSelection,
} from "../../default-agent-presets.js";
import {
  loadRuntimeProviderCatalogs,
} from "../../provider-catalog.js";
import {
  openStore,
  paths,
} from "../../workspace.js";
import {
  listAdoptableSessions,
  respawnRun,
} from "../run.js";
import {
  ACTIVE_RUN_STATUSES,
  isAutoRunning,
} from "./auto-run.js";
import {
  readLogTail,
} from "./files.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  mustFindAgentForUi,
  mustFindSubtaskForUi,
  mustGetOrchestrationForUi,
  recordDirectSubtaskRunOutcome,
  resolveRegisteredAgent,
} from "./lookups.js";
import {
  optionalString,
  parseAgentProvider,
  parseAgentRunMode,
  parseItems,
  requiredString,
} from "./validation.js";
import {
  buildSpawnPreview,
  defaultCommandForProvider,
  listInstalledProviderCatalogs,
  listStaffableProviderCatalogs,
  providerDefaultCommands,
  reapAgentRuns,
  spawnAgentRun,
  stopAgentRun,
} from "@agent-bridge/adapters";
import {
  describeRunPlanLabels,
  ensureAgentsForProviders,
  resolveAgentForPreference,
} from "@agent-bridge/core";
import {
  type Subtask,
} from "@agent-bridge/memory";
import {
  type Command,
} from "commander";
import {
  spawn,
} from "node:child_process";
import {
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

// Team Board: the agent roster, default-agent presets, the board payload and
// the run cards.

export async function routePostWorkforceAgent(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const agent = store.createRegisteredAgent({
      name: requiredString(body.name, "name"),
      description: optionalString(body.description),
      provider: parseAgentProvider(requiredString(body.provider, "provider")),
      mode: parseAgentRunMode(requiredString(body.mode, "mode")),
      command: optionalString(body.command),
      baseUrl: optionalString(body.baseUrl),
        model: optionalString(body.model),
        reasoningEffort: optionalString(body.reasoningEffort),
      credentialRef: optionalString(body.credentialRef),
      capabilities: parseItems(body.capabilities),
    });
    sendJson(res, 200, { agent });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceAgentToggle(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const agent = resolveRegisteredAgent(
      store.listRegisteredAgents({ limit: 500 }),
      requiredString(body.agentId, "agentId"),
    );
    if (!agent) throw new Error("Agent not found.");
    const enabledValue = optionalString(body.enabled);
    const enabled = enabledValue === "true" || body.enabled === true;
    const updated = store.updateRegisteredAgent(agent.id, { enabled });
    sendJson(res, 200, { agent: updated });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceDefaultAgentToggle(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const selectedValue = optionalString(body.selected);
    const selected = selectedValue === "true" || body.selected === true;
    const agent = setDefaultAgentPresetSelection(
      store,
      requiredString(body.presetKey, "presetKey"),
      selected,
    );
    sendJson(res, 200, { agent, selected });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceDefaultAgentCreate(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const agent = addCustomDefaultAgentPreset(store, {
      label: requiredString(body.label ?? body.name, "label"),
      description: optionalString(body.description),
      provider: parseAgentProvider(requiredString(body.provider, "provider")),
      mode: parseAgentRunMode(optionalString(body.mode) ?? "cli"),
      command: optionalString(body.command),
      model: optionalString(body.model),
      reasoningEffort: optionalString(body.reasoningEffort),
      capabilities: parseItems(body.capabilities),
    });
    sendJson(res, 200, { agent, presets: ensureDefaultAgentPresetStates(store) });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceDefaultAgentDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const removed = removeDefaultAgentPreset(store, requiredString(body.presetKey, "presetKey"));
    sendJson(res, 200, { removed });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceDefaultAgentRestore(ctx: RouteContext): Promise<void> {
  const { res, cwd } = ctx;
  const store = openStore(cwd);
  try {
    sendJson(res, 200, { presets: restoreBuiltInDefaultAgentPresets(store) });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceAgentUpdate(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const agent = resolveRegisteredAgent(
      store.listRegisteredAgents({ limit: 500 }),
      requiredString(body.agentId, "agentId"),
    );
    if (!agent) throw new Error("Agent not found.");
    const updated = store.updateRegisteredAgent(agent.id, {
      name: optionalString(body.name),
      description: optionalString(body.description),
      provider: body.provider ? parseAgentProvider(requiredString(body.provider, "provider")) : undefined,
      mode: body.mode ? parseAgentRunMode(requiredString(body.mode, "mode")) : undefined,
      command: optionalString(body.command),
      baseUrl: optionalString(body.baseUrl),
      model: optionalString(body.model),
      // The dashboard always sends this field, so an empty value is the user
      // picking "default" — store it as such instead of letting the update's
      // keep-current fallback pin the agent to its old effort level forever.
      reasoningEffort:
        body.reasoningEffort === undefined
          ? undefined
          : (optionalString(body.reasoningEffort) ?? ""),
      credentialRef: optionalString(body.credentialRef),
      capabilities: body.capabilities !== undefined ? parseItems(body.capabilities) : undefined,
    });
    sendJson(res, 200, { agent: updated });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceAgentDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const agent = resolveRegisteredAgent(
      store.listRegisteredAgents({ limit: 500 }),
      requiredString(body.agentId, "agentId"),
    );
    if (!agent) throw new Error("Agent not found.");
    if (agent.presetKey) {
      setDefaultAgentPresetSelection(store, agent.presetKey, false);
      sendJson(res, 200, { deleted: false, presetDeselected: true });
    } else {
      const deleted = store.deleteRegisteredAgent(agent.id);
      sendJson(res, 200, { deleted });
    }
  } finally {
    store.close();
  }
  return;
}

export async function routeGetWorkforceCatalog(ctx: RouteContext): Promise<void> {
  const { res, url } = ctx;
  // `installed` is the subset whose CLI is on PATH, each flagged with whether
  // it can answer headlessly. The Start Orchestration form offers only the
  // headless ones as team providers — anything else would either fail at
  // spawn time or (Antigravity) open a GUI and return an empty log.
  const staffable = new Set(listStaffableProviderCatalogs().map((catalog) => catalog.provider));
  const provider = String(url.query.provider ?? "").trim();
  const runtimeCatalog = await loadRuntimeProviderCatalogs({ provider: provider || undefined });
  sendJson(res, 200, {
    catalogs: runtimeCatalog.catalogs,
    installed: listInstalledProviderCatalogs().map((catalog) => ({
      provider: catalog.provider,
      staffable: staffable.has(catalog.provider),
    })),
    // provider -> cli command, so the agent form can prefill Command the
    // moment a provider is picked (antigravity -> agy, and so on). Covers
    // providers with no model catalog too, which `catalogs` does not.
    defaultCommands: providerDefaultCommands(),
    catalogWarnings: runtimeCatalog.errors,
  });
  return;
}

export async function routeGetWorkforceBoard(ctx: RouteContext): Promise<void> {
  const { res, url, cwd } = ctx;
  const requestedTaskId = String(url.query.task ?? "");
  const store = openStore(cwd);
  try {
    // Always report every orchestration so the UI can offer a picker.
    const allOrchestrations = store.listOrchestrations({ limit: 100 });
    const tasksById = new Map(store.listTasks(500).map((task) => [task.id, task]));
    const orchestrations = allOrchestrations.map((item) => ({
      id: item.id,
      taskId: item.taskId,
      status: item.status,
      updatedAt: item.updatedAt,
      taskTitle: tasksById.get(item.taskId)?.title ?? item.taskId,
    }));

    // The active task is only a *default*, not a hard filter: a spawned
    // sub-agent (or simply working on something else) can leave the active
    // task pointing at something with no orchestration, and silently
    // rendering an empty board makes a running fleet look dead. Fall back
    // to the most recently updated orchestration instead.
    const orchestration =
      (requestedTaskId ? store.getOrchestrationByTask(requestedTaskId) : undefined) ??
      (allOrchestrations.length ? allOrchestrations[0] : undefined);
    if (!orchestration) {
      sendJson(res, 200, { orchestration: null, orchestrations });
      return;
    }
    const taskId = orchestration.taskId;
    reapAgentRuns(store, { taskId });

    const wantsAllRuns = String(url.query.runs ?? "") === "all";
    const allRuns = store.listAgentRuns({ taskId, limit: 200 });
    // Runs with no cycle (adopted, manual, or spawned before the column
    // existed) only surface under "all" — guessing a cycle for them would
    // put stale rows on a board that is meant to show the current round.
    const scopedRuns = allRuns.filter(
      (run) => run.cycle === orchestration.cycle || ACTIVE_RUN_STATUSES.has(run.status),
    );
    // An idle orchestration, or one whose runs all predate the cycle column,
    // would otherwise get a completely empty board. The client cannot fall
    // back to rows it was never sent, so seed a few here.
    const boardRuns = wantsAllRuns ? allRuns : scopedRuns.length ? scopedRuns : allRuns.slice(0, 3);
    const boardSubtasks = store.listSubtasks({ parentTaskId: taskId, limit: 500 });
    const runPlanLabels = describeRunPlanLabels(store, orchestration.id, boardRuns, boardSubtasks);
    sendJson(res, 200, {
      orchestration,
      orchestrations,
      // Tells the UI it is showing something other than what was asked for,
      // so it can say so instead of looking like the active task's board.
      // So the toggle survives a page reload: auto-run lives in the server
      // process, not in the browser.
      autoRun: isAutoRunning(orchestration.id),
      // The Orchestrator tab answers these inline; without them on the board
      // a paused-for-questions orchestration looks simply stuck.
      questions: store
        .listAgentRequests({ taskId, status: "pending", limit: 100 })
        .filter((request) => request.type === "question"),
      // approve-each parks the orchestration on these; the Orchestrator tab
      // approves or rejects them inline.
      approvals: store
        .listAgentRequests({ taskId, status: "pending", limit: 100 })
        .filter((request) => request.type === "approval"),
      fellBackFromTaskId: requestedTaskId && requestedTaskId !== taskId ? requestedTaskId : undefined,
      taskTitle: tasksById.get(taskId)?.title ?? taskId,
      subtasks: boardSubtasks,
      // Scoped to the current cycle by default. A project that went through
      // a few change requests accumulates dozens of finished runs, and
      // shipping all of them every 3s is pure waste when the board only
      // shows the current round. `?runs=all` opts back in.
      runs: boardRuns.map((run) => ({
        ...run,
        // "s1: Build the parser" / "r1: review …" — the leader's plan key and
        // what the run is actually about, so a board of cards is readable
        // without opening each log.
        planKey: runPlanLabels[run.id]?.key || undefined,
        planTitle: runPlanLabels[run.id]?.title || undefined,
        // logTail only for runs that are still going: a finished run's tail
        // never changes, and re-sending all of them was ~19KB per poll.
        // Finished cards link to the full log instead.
        logTail: ACTIVE_RUN_STATUSES.has(run.status) ? readLogTail(run.logPath) : undefined,
      })),
      // So the board can say "3 of 37" even when it was only sent 3.
      runsTotal: allRuns.length,
      runsScope: wantsAllRuns ? "all" : "cycle",
      reviews: store.listReviews({ taskId, limit: 200 }),
      // Without the payloads: the Activity panel renders only time/kind/phase
      // /summary, while payload carries subtask+reviewer plan meta and — for
      // a change request — the entire previous plan and report. That was
      // ~71KB of the board response, re-sent every 3 seconds, for data the
      // dashboard never reads.
      events: store
        .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 100 })
        .map(({ payload, ...event }) => event),
      registeredAgents: store.listRegisteredAgents({ limit: 500 }),
      // The leader is not in the Agents tab (leader rows are plumbing, not
      // staff), so the Orchestration panel is the only place it is visible —
      // and `undefined` here is what tells the panel the leader row is gone
      // and the run needs a new one before it can step again.
      leaderAgent: store.getRegisteredAgent(orchestration.leaderAgentId),
      adoptable: listAdoptableSessions(store),
    });
  } finally {
    store.close();
  }
  return;
}

export async function routeGetWorkforceRunLog(ctx: RouteContext): Promise<void> {
  const { res, url, cwd } = ctx;
  const runId = String(url.query.run ?? "");
  const tail = Number(url.query.tail ?? 200);
  const store = openStore(cwd);
  try {
    const run = store.getAgentRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "Run not found" });
      return;
    }
    const log =
      run.logPath && existsSync(run.logPath)
        ? readFileSync(run.logPath, "utf8").split(/\r?\n/).slice(-tail).join("\n")
        : "";
    sendJson(res, 200, { run, log });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceAgentsProviderEnabled(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const provider = parseAgentProvider(requiredString(body.provider, "provider").trim());
    const enabled = body.enabled !== false;
    const agents = store.listRegisteredAgents({ provider, limit: 500 });
    // Enabling a provider with nothing registered yet still has to leave the
    // user with something staffable, otherwise the toggle silently does
    // nothing on a fresh install.
    if (enabled && !agents.length) {
      ensureAgentsForProviders(store, [provider], defaultCommandForProvider);
    }
    for (const agent of store.listRegisteredAgents({ provider, limit: 500 })) {
      if (agent.enabled !== enabled) store.updateRegisteredAgent(agent.id, { enabled });
    }
    sendJson(res, 200, { provider, enabled, agents: store.listRegisteredAgents({ provider, limit: 500 }) });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceSubtaskAddAndSpawn(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const taskId = requiredString(body.taskId, "taskId");
    const orchestration = mustGetOrchestrationForUi(store, taskId);
    const title = requiredString(body.title, "title");
    const roles = store.ensureDefaultWorkforceRoles();
    const role = roles.find((candidate) => candidate.name === "implementer");
    if (!role) throw new Error("Implementer role not found.");

    const subtask = store.createSubtask({
      parentTaskId: taskId,
      title,
      goal: optionalString(body.goal),
      acceptanceCriteria: parseItems(body.criteria),
    });
    const provider = requiredString(body.provider, "provider");
    const agent = resolveAgentForPreference(store, {
      provider,
      mode: optionalString(body.mode) as "cli" | "api" | "manual" | undefined,
      model: optionalString(body.model),
      reasoningEffort: optionalString(body.reasoningEffort),
    }, {
      requiredCapabilities: ["implement"],
    });
    const promptLines = [`Subtask: ${title}`];
    if (subtask.goal) promptLines.push(`Goal: ${subtask.goal}`);
    if (subtask.acceptanceCriteria.length) {
      promptLines.push("Acceptance criteria:", ...subtask.acceptanceCriteria.map((item) => `- ${item}`));
    }
    const prompt = promptLines.join("\n");

    const assignment = store.createAssignment({
      taskId,
      subtaskId: subtask.id,
      agentId: agent.id,
      roleId: role.id,
      status: "running",
      prompt,
    });
    store.updateSubtask(subtask.id, { status: "in_progress" });

    const runsDir = join(paths(cwd).artifacts, "runs");
    mkdirSync(runsDir, { recursive: true });
    const promptPath = join(runsDir, `${randomUUID()}-prompt.md`);
    writeFileSync(promptPath, prompt, "utf8");
    const preview = buildSpawnPreview(agent, promptPath, cwd);
    if (preview.mode !== "cli" || !preview.executable) {
      throw new Error(`Agent ${agent.name} is not CLI-spawnable (mode: ${preview.mode}).`);
    }
    const run = spawnAgentRun(store, {
      orchestrationId: orchestration.id,
      taskId,
      subtaskId: subtask.id,
      assignmentId: assignment.id,
      agentId: agent.id,
      roleId: role.id,
      cycle: orchestration.cycle,
      phase: "implement",
      runsDir,
      preview,
    }, {
      // This handler closes its store as soon as it replies, long before the
      // agent finishes; without this the exit code is lost and the run is
      // later reaped as "detached" no matter how it actually ended.
      reopenStore: () => openStore(cwd),
      onExit: (finished) => {
        let completionStore: ReturnType<typeof openStore> | undefined;
        try {
          completionStore = openStore(cwd);
          recordDirectSubtaskRunOutcome(completionStore, finished);
        } catch (error) {
          console.error(`Failed to record completion for agent run ${finished.id}:`, error);
        } finally {
          completionStore?.close();
        }
      },
    });
    sendJson(res, 200, { subtask, assignment, run });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceRunStop(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const runId = requiredString(body.runId, "runId");
    const before = store.getAgentRun(runId);
    if (!before) throw new Error(`Run not found: ${runId}`);
    const stopped = await stopAgentRun(store, runId);
    if (before.assignmentId) {
      store.updateAssignment(before.assignmentId, {
        status: "cancelled",
        resultSummary: optionalString(body.reason) ?? "Stopped from the UI.",
      });
    }
    if (body.cancelSubtask && before.subtaskId) {
      store.updateSubtask(before.subtaskId, {
        status: "cancelled",
        statusReason: optionalString(body.reason) ?? "Stopped from the UI.",
      });
    }
    sendJson(res, 200, { run: stopped });
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceRunSetModel(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const result = await respawnRun(store, requiredString(body.runId, "runId"), {
      model: optionalString(body.model),
      reasoningEffort: optionalString(body.reasoningEffort),
    });
    sendJson(res, 200, result);
  } finally {
    store.close();
  }
  return;
}

export async function routePostWorkforceRunAdopt(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const store = openStore(cwd);
  try {
    const sessionId = requiredString(body.sessionId, "sessionId");
    const roleName = requiredString(body.role, "role");
    const events = store.listSessionEvents({ sessionId, limit: 50 });
    if (!events.length) throw new Error(`No session events found for session: ${sessionId}`);
    const latest = events[0]!;
    const taskId = optionalString(body.taskId) ?? latest.taskId;
    if (!taskId) throw new Error("Could not determine a task id for this session.");

    const roles = store.ensureDefaultWorkforceRoles();
    const role = roles.find((candidate) => candidate.name === roleName);
    if (!role) throw new Error(`Role not found: ${roleName}`);

    const existingAgentId = optionalString(body.agentId);
    const agent = existingAgentId
      ? mustFindAgentForUi(store, existingAgentId)
      : store.createRegisteredAgent({
          name: `adopted-${sessionId.slice(0, 8)}`,
          provider: latest.agent ?? "generic",
          mode: "manual",
          capabilities: ["adopted"],
        });

    const subtaskId = optionalString(body.subtaskId);
    const subtask = subtaskId
      ? mustFindSubtaskForUi(store, taskId, subtaskId)
      : store.createSubtask({
          parentTaskId: taskId,
          title: `External work: ${latest.summary ?? sessionId}`,
          status: "in_progress",
        });

    const assignment = store.createAssignment({
      taskId,
      subtaskId: subtask.id,
      agentId: agent.id,
      roleId: role.id,
      status: "running",
      prompt:
        "Adopted from an externally-running session; this agent is working independently outside orchestrator control.",
    });

    const run = store.createAgentRun({
      taskId,
      subtaskId: subtask.id,
      assignmentId: assignment.id,
      agentId: agent.id,
      roleId: role.id,
      origin: "adopted",
      sessionId,
      status: "detached",
      phase: "implement",
    });

    sendJson(res, 200, { agent, subtask, assignment, run });
  } finally {
    store.close();
  }
  return;
}
