import type {
  AgentRun,
  AgentRunPhase,
  MemoryStore,
  Orchestration,
  RegisteredAgent,
  Subtask,
} from "@agent-bridge/memory";

import {
  contextKeyFor,
  roundFor,
  WORKBOARD_BOUNDARY_LINES,
  type ContextStore,
  type TurnKind,
} from "./context-store.js";

import { ensureStructuredSubtaskGoal } from "./leader-contract.js";

import {
  type ReworkContext,
  type ImplementerContextPaths,
  type ContextTarget,
  type IndexTaskRow,
  type OrchestratorDeps,
  type OrchestrationStepResult,
} from "./orchestrator-contracts.js";

import {
  CONTEXT_RETRY_EVENT_PREFIX,
  CONTEXT_FILE_RETRY_BUDGET,
} from "./orchestrator-constants.js";
type Dependencies = {
  findSubtaskKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskKey"];
  findSubtaskMetaByKey: import("./orchestrator-metadata.js").MetadataFunctions["findSubtaskMetaByKey"];
  getSubtaskMeta: import("./orchestrator-metadata.js").MetadataFunctions["getSubtaskMeta"];
  latestByCreatedAt: import("./orchestrator-reporting.js").ReportingFunctions["latestByCreatedAt"];
  recordEvent: import("./orchestrator-reporting.js").ReportingFunctions["recordEvent"];
  consumeRun: import("./orchestrator-reporting.js").ReportingFunctions["consumeRun"];
  result: import("./orchestrator-reporting.js").ReportingFunctions["result"];
  gateSpawn: import("./orchestrator-approvals.js").ApprovalsFunctions["gateSpawn"];
  describeAgent: import("./orchestrator-staffing.js").StaffingFunctions["describeAgent"];
  spawnTurn: import("./orchestrator-turns.js").TurnsFunctions["spawnTurn"];
};
export type ContextFunctions = ReturnType<typeof createContext>;
export function createContext(operations: Dependencies) {
  function renderImplementerPrompt(
    subtask: Subtask,
    files: string[],
    rework?: ReworkContext,
    context?: ImplementerContextPaths,
  ): string {
    const lines = [
      ensureStructuredSubtaskGoal(
        subtask.title,
        subtask.goal,
        subtask.acceptanceCriteria,
      ),
    ];
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
        if (previous.resultSummary)
          lines.push(`What it reported doing: ${previous.resultSummary}`);
        for (const review of previous.reviews) {
          lines.push(
            `- Reviewer verdict: ${review.verdict} — ${review.summary}`,
          );
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
    const key = operations.findSubtaskKey(store, orchestration.id, subtask.id);
    if (!key) return undefined;
    const ancestors: string[] = [];
    let current: string | undefined = key.match(/^(.+)-rework-\d+$/)?.[1];
    while (current) {
      ancestors.unshift(current);
      current = current.match(/^(.+)-rework-\d+$/)?.[1];
    }
    if (!ancestors.length) return undefined;
    const titleById = new Map(
      store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .map((entry) => [entry.id, entry.title]),
    );
    const previous: ReworkContext["previous"] = [];
    for (const ancestorKey of ancestors) {
      const meta = operations.findSubtaskMetaByKey(
        store,
        orchestration.id,
        ancestorKey,
      );
      if (!meta) continue;
      const assignment = operations.latestByCreatedAt(
        store.listAssignments({ subtaskId: meta.subtaskId, limit: 20 }),
      );
      const reviews = store.listReviews({
        subtaskId: meta.subtaskId,
        limit: 20,
      });
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
    return previous.length
      ? { attempt: ancestors.length + 1, previous }
      : undefined;
  }

  // Which folder and which round a subtask's documents belong to. Both come from
  // the plan key rather than the subtask id, so a rework lands as round 2 inside
  // the original's folder instead of opening a fresh folder that knows nothing.
  function contextTargetFor(
    store: MemoryStore,
    orchestration: Orchestration,
    subtask: Subtask,
  ): ContextTarget {
    const meta = operations.getSubtaskMeta(store, orchestration.id, subtask.id);
    return {
      contextKey: contextKeyFor(meta?.key, subtask.id, meta?.planCycle),
      round: roundFor(meta?.key),
    };
  }

  // Documents from earlier attempts at this same work — the chain that used to be
  // rebuilt and truncated into every prompt.
  function priorRoundPaths(
    ctx: ContextStore,
    target: ContextTarget,
    kinds: TurnKind[],
  ): string[] {
    const paths: string[] = [];
    for (let round = 1; round < target.round; round += 1) {
      for (const kind of kinds)
        paths.push(ctx.turnPath(kind, target.contextKey, round));
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
      store
        .listSubtasks({ parentTaskId: orchestration.taskId, limit: 500 })
        .map((entry) => [entry.id, entry]),
    );
    // A dependency is handed over as its summary and nothing else. Widening this
    // to its reports and reviews is what would make reading cost grow with
    // rounds × tasks instead of with tasks.
    const dependencies = subtask.dependsOn
      .map((depId) => byId.get(depId))
      .filter((dep): dep is Subtask => Boolean(dep))
      .map((dep) => ({
        title: dep.title,
        summaryPath: ctx.summaryPath(
          contextTargetFor(store, orchestration, dep).contextKey,
        ),
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
  function refreshContextIndex(
    store: MemoryStore,
    orchestration: Orchestration,
    ctx: ContextStore,
  ): void {
    const task = store.getTask(orchestration.taskId);
    const tasks: IndexTaskRow[] = [];
    // Attempts share a folder, so one row per folder — and the row to show is
    // the *latest* attempt. Picking it explicitly rather than letting the query
    // order decide: `listSubtasks` sorts by priority then updated_at, which puts
    // a long-finished attempt after the one running right now, so the index used
    // to advertise stale work as the current state of every folder.
    const byKey = new Map<string, { subtask: Subtask; index: number }>();
    for (const subtask of store.listSubtasks({
      parentTaskId: orchestration.taskId,
      limit: 500,
    })) {
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
      .listOrchestrationEvents({
        orchestrationId: orchestration.id,
        limit: 1000,
      })
      .filter((event) =>
        event.summary?.startsWith(`${CONTEXT_RETRY_EVENT_PREFIX}${input.tag}`),
      ).length;
    if (spent >= CONTEXT_FILE_RETRY_BUDGET) {
      operations.recordEvent(
        store,
        orchestration,
        input.phase,
        "error",
        `Gave up asking for ${input.missing.map((entry) => entry.path).join(", ")}; continuing without it. The next turn on this work will have less context than it should.`,
      );
      return undefined;
    }
    const gated = operations.gateSpawn(
      store,
      orchestration,
      `context-retry:${input.tag}:${spent}`,
      `Ask ${operations.describeAgent(input.agent)} to repair missing ${input.phase} context documents`,
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
    const run = operations.spawnTurn(
      deps,
      store,
      orchestration,
      input.agent,
      prompt,
      input.phase,
      input.extra ?? {},
    );
    operations.recordEvent(
      store,
      orchestration,
      input.phase,
      "spawn",
      `${CONTEXT_RETRY_EVENT_PREFIX}${input.tag} asked ${operations.describeAgent(input.agent)} to write ${input.missing.map((entry) => entry.path).join(", ")} (${run.id}).`,
    );
    // Consumed the moment it is spawned. It shares a phase with the turn it is
    // repairing, and its reply is prose — parsing it as a leader or reviewer turn
    // would fail and drag the orchestration into the parse-failure path. The
    // file it writes is the entire product of this run.
    operations.consumeRun(
      store,
      orchestration,
      input.phase,
      run,
      "was a context-document retry; its log is never parsed",
    );
    return operations.result(
      orchestration,
      `Asked for the missing context document(s) before continuing.`,
      [run.id],
    );
  }

  function nextPlanContextCycle(
    store: MemoryStore,
    orchestrationId: string,
  ): number {
    const appliedPlans = store
      .listOrchestrationEvents({
        orchestrationId,
        kind: "leader_turn",
        limit: 1000,
      })
      .filter(
        (event) =>
          event.phase === "plan" &&
          event.summary?.startsWith("Leader produced "),
      );
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
    return ctx.writePlan(
      markdown,
      orchestration.planPath ? revision : undefined,
    );
  }
  return {
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
  };
}
