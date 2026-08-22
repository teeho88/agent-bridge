import {
  orderByRelevance,
  type Handoff,
  type MemoryStore,
} from "@agent-bridge/memory";
import {
  dedupeStrings,
  estimateTokens,
  trimToTokenBudgetDetailed,
} from "./token-optimizer.js";
import { renderPromptPack } from "./prompt-pack.js";
import type { CompileContextInput, PromptPack } from "./types.js";

export function compileContext(
  store: MemoryStore,
  input: CompileContextInput,
): PromptPack {
  const task = store.getTask(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  // Rank the task's memories by relevance to the task using the FTS5/bm25 index
  // (searchMemories), but keep every task memory so always-needed types
  // (constraints, decisions, files) are never dropped just for missing the
  // query terms. Fall back to importance/recency order when there is no query.
  const taskQuery = [task.title, task.goal ?? ""].filter(Boolean).join(" ");
  const allMemories = [
    ...store.listRepoMemories(100),
    ...store.listMemoriesForTask(task.id, 100),
  ];
  const ranked = taskQuery
    ? store.searchMemories(taskQuery, { limit: 200 })
    : [];
  const memories = orderByRelevance(allMemories, ranked);
  const decisions = store.listDecisions(task.id);
  const files = input.includeFiles === false ? [] : store.listFileSummaries();
  // A handoff belongs to the task, not to one agent: whoever picks the task up
  // next receives the same packet.
  const handoff = store.getLatestHandoff(task.id);
  const currentAssignment = resolveCurrentAssignment(store, task.id, input);

  const memoryBudget =
    input.memoryTokenBudget ?? Math.floor(input.tokenBudget * 0.4);
  const fileBudget =
    input.fileTokenBudget ?? Math.floor(input.tokenBudget * 0.2);

  const currentStateTrim = trimToTokenBudgetDetailed(
    dedupeStrings(
      memories
        .filter(
          (memory) =>
            !memory.tags.includes("prompt") &&
            !["constraint", "handoff", "decision", "file"].includes(
              memory.type,
            ),
        )
        .map((memory) => memory.summary || memory.content),
    ),
    memoryBudget,
  );
  const currentState = currentStateTrim.items;

  // Constraints and decisions sit in the cache prefix, which made them easy to
  // leave uncapped - but a long-lived task keeps adding rules, and an unbounded
  // prefix silently eats the budget the dynamic sections were sized against.
  const constraintsTrim = trimToTokenBudgetDetailed(
    dedupeStrings(
      memories
        .filter((memory) => memory.type === "constraint")
        .map((memory) => memory.summary || memory.content),
    ),
    input.constraintTokenBudget ?? Math.floor(input.tokenBudget * 0.1),
  );
  const constraints = constraintsTrim.items;

  const knownDecisionsTrim = trimToTokenBudgetDetailed(
    dedupeStrings([
      ...decisions.map((decision) =>
        decision.reason
          ? `${decision.decision} - ${decision.reason}`
          : decision.decision,
      ),
      ...memories
        .filter((memory) => memory.type === "decision")
        .map((memory) => memory.summary || memory.content),
    ]),
    input.decisionTokenBudget ?? Math.floor(input.tokenBudget * 0.1),
  );
  const knownDecisions = knownDecisionsTrim.items;

  const relevantFilesTrim = trimToTokenBudgetDetailed(
    dedupeStrings([
      ...files.map((file) =>
        file.summary ? `${file.path}: ${file.summary}` : file.path,
      ),
      ...memories
        .filter((memory) => memory.type === "file")
        .map((memory) => memory.summary || memory.content),
    ]),
    fileBudget,
  );
  const relevantFiles = relevantFilesTrim.items;

  const nextActions = dedupeStrings([
    ...(handoff?.next ?? []),
    "Inspect the relevant files before editing.",
    "Run focused tests.",
  ]);
  const risks = dedupeStrings([
    ...(handoff?.risks ?? []),
    ...constraints.filter((item) => /do not|risk|avoid/i.test(item)),
  ]);
  const sharedMemoryBudget =
    input.sharedMemoryTokenBudget ?? Math.floor(input.tokenBudget * 0.15);
  const risksOutsideHandoff = handoff
    ? risks.filter((risk) => !handoff.risks.includes(risk))
    : risks;

  // Distilled shared-memory layer: compact operating state for the next agent,
  // not a transcript. It follows the Karpathy-style handoff habit of pinning
  // objective, invariants, decisions, facts, files, next move, and risks first.
  const sharedMemoryTrim = trimToTokenBudgetDetailed(
    dedupeStrings([
      `Objective: ${task.goal || task.title}`,
      ...constraints.slice(0, 4).map((item) => `Invariant: ${item}`),
      ...knownDecisions.slice(0, 4).map((item) => `Decision: ${item}`),
      ...(handoff ? [`Latest handoff: ${handoff.summary}`] : []),
      ...(currentAssignment
        ? [
            `Current assignment: ${currentAssignment.role?.name ?? currentAssignment.assignment.roleId} / ${currentAssignment.subtask?.title ?? currentAssignment.assignment.id}`,
          ]
        : []),
      ...(handoff?.done ?? []).slice(0, 5).map((item) => `Done: ${item}`),
      ...currentState.slice(0, 5).map((item) => `Current fact: ${item}`),
      ...(handoff?.filesChanged ?? [])
        .slice(0, 8)
        .map((item) => `Touched file: ${item}`),
      ...nextActions.slice(0, 5).map((item) => `Next: ${item}`),
      ...risksOutsideHandoff.slice(0, 5).map((item) => `Risk: ${item}`),
    ]),
    sharedMemoryBudget,
  );
  const sharedMemory = sharedMemoryTrim.items;

  // The handoff and the repo map used to be rendered whole. Both grow without
  // bound (a long-running task accumulates done/files entries; the repo map
  // grows with the graph), which let them outweigh the task-specific sections
  // that were already capped. Give each its own budget.
  const trimmedHandoff = trimHandoff(
    handoff,
    input.handoffTokenBudget ?? Math.floor(input.tokenBudget * 0.15),
  );
  const trimmedRepoMap = trimRepoMap(
    input.repoMap,
    input.repoMapTokenBudget ?? Math.floor(input.tokenBudget * 0.25),
  );

  const basePack = {
    agent: input.agent,
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
    },
    currentState,
    sharedMemory,
    relevantFiles,
    knownDecisions,
    constraints,
    nextActions,
    risks,
    handoff: trimmedHandoff.handoff,
    repoMap: trimmedRepoMap.repoMap,
    currentAssignment,
    omitted: {
      currentState: currentStateTrim.omitted,
      sharedMemory: sharedMemoryTrim.omitted,
      relevantFiles: relevantFilesTrim.omitted,
      repoMap: trimmedRepoMap.omitted,
      handoff: trimmedHandoff.omitted,
      constraints: constraintsTrim.omitted,
      knownDecisions: knownDecisionsTrim.omitted,
    },
  };
  const renderedMarkdown = renderPromptPack(basePack);
  return {
    ...basePack,
    tokenEstimate: estimateTokens(renderedMarkdown),
    renderedMarkdown,
  };
}

// The summary is the one field a handoff cannot lose, so it is charged against
// the budget but never dropped. The lists are filled in priority order: what to
// do next and what to avoid outrank the history of what was already done.
function trimHandoff(
  handoff: Handoff | undefined,
  budget: number,
): { handoff: Handoff | undefined; omitted: number } {
  if (!handoff) return { handoff: undefined, omitted: 0 };
  let remaining = Math.max(0, budget - estimateTokens(handoff.summary));
  let omitted = 0;
  const take = (items: string[]): string[] => {
    const result = trimToTokenBudgetDetailed(items, remaining);
    remaining -= result.used;
    omitted += result.omitted;
    return result.items;
  };
  const next = take(handoff.next);
  const risks = take(handoff.risks);
  const done = take(handoff.done);
  const filesChanged = take(handoff.filesChanged);
  return {
    handoff: { ...handoff, next, risks, done, filesChanged },
    omitted,
  };
}

function trimRepoMap(
  repoMap: string | undefined,
  budget: number,
): { repoMap: string | undefined; omitted: number } {
  if (!repoMap) return { repoMap: undefined, omitted: 0 };
  const trimmed = trimToTokenBudgetDetailed(repoMap.split("\n"), budget);
  return {
    repoMap: trimmed.items.join("\n").trim() || undefined,
    omitted: trimmed.omitted,
  };
}

function resolveCurrentAssignment(
  store: MemoryStore,
  taskId: string,
  input: CompileContextInput,
) {
  const assignments = store.listAssignments({ taskId, limit: 200 });
  const active = assignments.filter((assignment) =>
    ["queued", "approved", "running", "waiting"].includes(assignment.status),
  );
  const selected = input.assignmentId
    ? assignments.find((assignment) => assignment.id === input.assignmentId)
    : active.find((assignment) => {
        const agent = store.getRegisteredAgent(assignment.agentId);
        return agent?.provider === input.agent || agent?.name === input.agent;
      });
  if (!selected) return undefined;

  const agent = store.getRegisteredAgent(selected.agentId);
  const role = store
    .listWorkforceRoles()
    .find((candidate) => candidate.id === selected.roleId);
  const subtask = selected.subtaskId
    ? store
        .listSubtasks({ parentTaskId: taskId, limit: 500 })
        .find((candidate) => candidate.id === selected.subtaskId)
    : undefined;
  const workforce = selected.workforceId
    ? store
        .listWorkforces(500)
        .find((candidate) => candidate.id === selected.workforceId)
    : undefined;

  return { assignment: selected, agent, role, subtask, workforce };
}

