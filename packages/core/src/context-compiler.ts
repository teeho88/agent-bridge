import {
  orderByRelevance,
  reusableMemoryIsCurrent,
  type Handoff,
  type MemoryStore,
} from "@agent-bridge/memory";
import {
  dedupeStrings,
  estimateTokens,
  trimToTokenBudgetDetailed,
} from "./token-optimizer.js";
import { allocateContext } from "./context-allocation.js";
import { renderPromptPack } from "./prompt-pack.js";
import type { CompileContextInput, PromptPack } from "./types.js";

export type ContextReadStore = Pick<MemoryStore, "getTask" | "getContextMemories" | "listRepoMemories" | "listMemoriesForTask" | "searchMemories" | "listDecisions" | "listFileSummaries" | "getLatestHandoff" | "listAssignments" | "getRegisteredAgent" | "listWorkforceRoles" | "listSubtasks" | "listWorkforces">;

function exactStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.normalize("NFC").trim()).filter(Boolean))];
}

export function compileContext(
  store: ContextReadStore,
  input: CompileContextInput,
): PromptPack {
  const task = store.getTask(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const taskQuery = [task.title, task.goal ?? "", input.currentRequest ?? ""].filter(Boolean).join(" ");
  const excludedTags = ["secret", "private", "prompt", "task-label-source", "latest-response"];
  const allMemories = store.getContextMemories?.(task.id, taskQuery, excludedTags) ?? [...new Map([
    ...store.listRepoMemories(100000),
    ...store.listMemoriesForTask(task.id, 100000),
  ].map((memory) => [memory.id, memory])).values()];
  const ranked = store.getContextMemories ? allMemories : taskQuery
    ? store.searchMemories(taskQuery, { taskId: task.id, scope: "task-and-repo", excludeTags: excludedTags, limit: 200 })
    : [];
  const rankedIds = new Set(ranked.map((memory) => memory.id));
  const memories = orderByRelevance(allMemories.filter((memory) =>
    reusableMemoryIsCurrent(memory, input.memoryReuse) &&
    !memory.tags.some((tag) => excludedTags.includes(tag)) &&
    (["constraint", "decision"].includes(memory.type) || rankedIds.has(memory.id))
  ), ranked);
  const decisions = store.listDecisions(task.id);
  const allFiles = input.includeFiles === true ? store.listFileSummaries() : [];
  // A handoff belongs to the task, not to one agent: whoever picks the task up
  // next receives the same packet.
  const handoff = store.getLatestHandoff(task.id);
  const queryTerms = (taskQuery.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((term) => !["the", "and", "for", "with", "from", "read", "implement", "existing", "file", "files", "task", "work"].includes(term));
  const files = allFiles.filter((file) => handoff?.filesChanged.includes(file.path) ||
    queryTerms.some((term) => file.path.toLowerCase().includes(term)));

  const currentAssignment = resolveCurrentAssignment(store, task.id, input);

  const memoryBudget =
    Infinity;
  const fileBudget =
    Infinity;

  const currentStateTrim = trimToTokenBudgetDetailed(
    dedupeStrings(
      memories
        .filter(
          (memory) =>
            !memory.tags.includes("prompt") &&
            !(memory.type === "test" && memory.tags.includes("checkpoint")) &&
            !["constraint", "handoff", "decision", "file"].includes(
              memory.type,
            ),
        )
        .map((memory) => memory.stale ? `Stale; verify ${memory.evidence?.source ?? "source"} before acting: ${memory.summary || memory.content}` : memory.summary || memory.content),
    ),
    memoryBudget,
  );
  const currentState = currentStateTrim.items;

  // Constraints and decisions sit in the cache prefix, which made them easy to
  // leave uncapped - but a long-lived task keeps adding rules, and an unbounded
  // prefix silently eats the budget the dynamic sections were sized against.
  const constraints = exactStrings(memories.filter((memory) => memory.type === "constraint")
    .map((memory) => memory.stale ? `Stale constraint; verify ${memory.evidence?.source ?? "source"}: ${memory.content}` : memory.content));

  const knownDecisionsTrim = trimToTokenBudgetDetailed(
    exactStrings([
      ...decisions.map((decision) => `${decision.stale ? `Stale decision evidence; verify ${decision.evidence?.source ?? "source"}: ` : ""}${decision.reason
          ? `${decision.decision} - ${decision.reason}`
          : decision.decision}`,
      ),
      ...memories
        .filter((memory) => memory.type === "decision")
        .map((memory) => memory.summary || memory.content),
    ]),
    Infinity,
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
  ]);
  const risks = dedupeStrings([
    ...(handoff?.risks ?? []),
    ...constraints.filter((item) => /do not|risk|avoid/i.test(item)),
  ]);
  const sharedMemoryBudget =
    Infinity;
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

  const trimmedHandoff = trimHandoff(handoff, Infinity);

  const basePack = {
    tokenBudget: input.tokenBudget,
    tokenCounter: input.countTokens ? "configured counter" as const : "script-aware estimate" as const,
    detailsPath: input.detailsPath,
    testResults: dedupeStrings(memories.filter((memory) => memory.type === "test" && memory.tags.includes("checkpoint"))
      .map((memory) => `${memory.stale ? "Stale; recheck source: " : ""}${memory.summary || memory.content}${memory.evidence ? `; evidence: ${memory.evidence.source}; observed: ${memory.evidence.observedAt}${memory.evidence.commit ? `; commit: ${memory.evidence.commit}` : ""}` : ""}`)
      .concat(handoff?.done.includes("Test evidence: see portable handoff artifact reference")
        ? [`Handoff test evidence: .handoff/evidence/${handoff.id}.json`]
        : [])),
    agent: input.agent,
    graphEnabled: input.graphEnabled,
    currentRequest: input.currentRequest,
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
    repoMap: undefined,
    currentAssignment,
    omitted: {
      testResults: 0,
      currentState: currentStateTrim.omitted,
      sharedMemory: sharedMemoryTrim.omitted,
      relevantFiles: relevantFilesTrim.omitted,
      repoMap: 0,
      handoff: trimmedHandoff.omitted,
      handoffDone: 0,
      handoffFilesChanged: 0,
      constraints: 0,
      knownDecisions: knownDecisionsTrim.omitted,
    },
  };
  const rawCount = input.countTokens ?? estimateTokens;
  const count = (text: string) => {
    const value = rawCount(text);
    if (!Number.isFinite(value) || value < 0) throw new Error("Token counter must return a nonnegative finite number");
    return value;
  };
  if (!Number.isFinite(input.tokenBudget) || input.tokenBudget <= 0) throw new Error("Invalid token budget");
  const allocatedPack = allocateContext(basePack, input, count);
  const renderedMarkdown = renderPromptPack(allocatedPack);
  const sectionTokens: Record<string, number> = {};
  for (const section of renderedMarkdown.split(/(?=^## )/m)) {
    const heading = section.split("\n")[0]; sectionTokens[heading] = count(section);
  }
  const constraintTokens = count(constraints.join("\n"));
  const budgetDiagnostics = input.constraintTokenBudget !== undefined && constraintTokens > input.constraintTokenBudget
    ? [{ code: "constraint_budget_exceeded", requiredTokens: constraintTokens, budget: input.constraintTokenBudget }] : [];
  return { ...allocatedPack, budgetDiagnostics, sectionTokens, tokenEstimate: count(renderedMarkdown), renderedMarkdown };

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
  const next = handoff.next;
  const risks = handoff.risks;
  remaining = Math.max(0, remaining - estimateTokens([...next, ...risks].join("\n")));
  const done = take(handoff.done);
  const filesChanged = take(handoff.filesChanged);
  return {
    handoff: { ...handoff, next, risks, done, filesChanged },
    omitted,
  };
}

function resolveCurrentAssignment(
  store: ContextReadStore,
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
  if (!selected && input.assignmentId)
    throw new Error(`Assignment/task binding mismatch: ${input.assignmentId} is not assigned to task ${taskId}`);
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

