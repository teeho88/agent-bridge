import type {
  AgentKind,
  Assignment,
  Handoff,
  RegisteredAgent,
  Subtask,
  Task,
  Workforce,
  WorkforceRole,
} from "@agent-bridge/memory";

export type CurrentAssignmentContext = {
  assignment: Assignment;
  agent?: RegisteredAgent;
  role?: WorkforceRole;
  subtask?: Subtask;
  workforce?: Workforce;
};

export type CompileContextInput = {
  taskId: string;
  agent: AgentKind;
  tokenBudget: number;
  includeFiles?: boolean;
  includeGit?: boolean;
  // Per-section token budgets, typically sourced from token-policy.yaml. When
  // omitted, the compiler falls back to fractions of tokenBudget.
  memoryTokenBudget?: number;
  fileTokenBudget?: number;
  // Caps the rendered handoff (its list fields; the summary is always kept) and
  // the injected repo map, so neither can crowd out the task-specific sections.
  handoffTokenBudget?: number;
  repoMapTokenBudget?: number;
  // The stable cache prefix (constraints + known decisions) also grows without
  // bound as a task accumulates rules, so it gets its own caps.
  constraintTokenBudget?: number;
  decisionTokenBudget?: number;
  // Pre-rendered repository knowledge graph map (from the graph index). When
  // present it is injected as a compact "## Repo Map" section so the agent can
  // navigate the repo without reading every file. Supplied by the CLI, which
  // owns graph access; the compiler stays decoupled from the graph store.
  repoMap?: string;
  // Optional explicit assignment to inject. When omitted, the compiler picks the
  // first active assignment matching the target agent provider/name.
  assignmentId?: string;
  // Optional budget for the distilled shared-memory layer. This is separate
  // from raw current-state memory so the next agent gets a compact operating
  // brief before historical notes.
  sharedMemoryTokenBudget?: number;
};

// Per-section count of entries dropped by the token budgets. Rendered into the
// markdown so an agent reading the pack can tell truncated sections from
// genuinely empty ones.
export type OmittedCounts = {
  currentState: number;
  sharedMemory: number;
  relevantFiles: number;
  repoMap: number;
  handoff: number;
  constraints: number;
  knownDecisions: number;
};

export type PromptPack = {
  agent: AgentKind;
  task: Pick<Task, "id" | "title" | "goal" | "status">;
  currentState: string[];
  sharedMemory: string[];
  relevantFiles: string[];
  knownDecisions: string[];
  constraints: string[];
  nextActions: string[];
  risks: string[];
  handoff?: Handoff;
  repoMap?: string;
  currentAssignment?: CurrentAssignmentContext;
  omitted: OmittedCounts;
  tokenEstimate: number;
  renderedMarkdown: string;
};
