import type { AgentKind, TaskContract } from "./types.js";

export type TaskDecomposition = {
  parentTaskId: string;
  parentVersion: number;
  rationale: string;
  integrationChecks: string[];
  children: { taskId: string; covers: string[] }[];
};

export function validateDecomposition(
  plan: TaskDecomposition,
  parent: TaskContract,
  children: { taskId: string; ownerAgent?: AgentKind; contract?: TaskContract }[],
): void {
  if (plan.parentTaskId !== parent.taskId || plan.parentVersion !== parent.version)
    throw new Error("Decomposition parent revision mismatch");
  if (!plan.rationale?.trim() || !plan.children?.length || !plan.integrationChecks?.length)
    throw new Error("Decomposition requires rationale, outputs and integration checks");
  if (new Set(plan.children.map(child => child.taskId)).size !== plan.children.length)
    throw new Error("Duplicate decomposition child");
  if (plan.integrationChecks.some(check => !parent.checks.includes(check)))
    throw new Error("Integration checks must be required parent checks");
  const covered = new Set<string>();
  for (const child of plan.children) {
    const task = children.find(task => task.taskId === child.taskId);
    if (child.taskId === parent.taskId || !task?.ownerAgent || !task.contract?.scope.length ||
        !task.contract.acceptance.length || !task.contract.checks.length)
      throw new Error("Each child requires owner, scope, acceptance and checks");
    if (!child.covers?.length || child.covers.some(criterion => !parent.acceptance.includes(criterion)))
      throw new Error("Child must cover explicit parent acceptance");
    if (task.contract.acceptance.some(criterion => /^(continue( processing)?|tiếp tục( xử lý)?)\s*[.!]?$/iu.test(criterion.trim())))
      throw new Error("Child acceptance must describe a verifiable output");
    for (const criterion of child.covers) covered.add(criterion);
  }
  if (parent.acceptance.some(criterion => !covered.has(criterion)))
    throw new Error("Child acceptance does not cover parent acceptance");
}

export type LeaseRecoveryInput = {
  taskId: string;
  agent: AgentKind;
  sessionId: string;
  checkpointId: string;
  repositoryRoot: string;
  reason: string;
};
