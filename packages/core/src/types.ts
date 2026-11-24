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
  memoryReuse?: { scope: string[]; revision: string; timestamp?: number };
  taskId: string;
  agent: AgentKind;
  tokenBudget: number;
  currentRequest?: string;
  countTokens?: (text: string) => number;
  includeFiles?: boolean;
  graphEnabled?: boolean;
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
  // Deprecated; accepted for compatibility and never injected.
  repoMap?: string;
  // Optional explicit assignment to inject. When omitted, the compiler picks the
  // first active assignment matching the target agent provider/name.
  assignmentId?: string;
  // Optional budget for the distilled shared-memory layer. This is separate
  // from raw current-state memory so the next agent gets a compact operating
  // brief before historical notes.
  sharedMemoryTokenBudget?: number;
  // The publication layer owns this sidecar and writes the selected sources.
  detailsPath?: string;
};

// Per-section count of entries dropped by the token budgets. Rendered into the
// markdown so an agent reading the pack can tell truncated sections from
// genuinely empty ones.
export type OmittedCounts = {
  testResults?: number;
  currentState: number;
  sharedMemory: number;
  relevantFiles: number;
  repoMap: number;
  handoff: number;
  handoffDone?: number;
  handoffFilesChanged?: number;
  constraints: number;
  knownDecisions: number;
};

export type PromptPack = {
  tokenBudget?: number;
  tokenCounter?: "configured counter" | "script-aware estimate";
  detailsPath?: string;
  budgetDiagnostics?: Array<{ code: string; requiredTokens: number; budget: number }>;
  testResults?: string[];
  agent: AgentKind;
  task: Pick<Task, "id" | "title" | "goal" | "status">;
  currentRequest?: string;
  sectionTokens?: Record<string, number>;
  graphEnabled?: boolean;
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
