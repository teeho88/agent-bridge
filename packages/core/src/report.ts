import type {
  Assignment,
  Decision,
  Handoff,
  Orchestration,
  RegisteredAgent,
  Review,
  Subtask,
  Task,
  TaskChange,
} from "@agent-bridge/memory";

export type ReportContext = {
  task: Task;
  orchestration?: Orchestration;
  subtasks: Subtask[];
  reviews: Review[];
  assignments: Assignment[];
  agents: RegisteredAgent[];
  taskChanges: TaskChange[];
  decisions: Decision[];
  handoff?: Handoff;
  planMarkdown?: string;
};

// Asks a reporter agent to produce the final polished report. The exact
// section structure is spelled out so the model has something to fill in
// rather than invent its own shape — makes the output predictable enough to
// hand straight to the user.
export function renderReporterPrompt(context: ReportContext): string {
  const lines = [
    "# Reporter Turn",
    "",
    `Task: ${context.task.title}`,
    context.task.goal ? `Goal: ${context.task.goal}` : undefined,
    context.orchestration ? `Orchestration status: ${context.orchestration.status}` : undefined,
    "",
    "## Original Plan",
    "",
    context.planMarkdown || "(no plan file recorded)",
    "",
    "## Subtasks",
    ...context.subtasks.map((subtask) => renderSubtaskLine(subtask, context)),
    "",
    "## Reviews",
    ...(context.reviews.length
      ? context.reviews.map((review) => renderReviewLine(review, context))
      : ["(no reviews recorded)"]),
    "",
    "## File Changes",
    ...(context.taskChanges.length
      ? context.taskChanges.map((change) => `- ${change.path} (${change.changeType}, ${change.status})`)
      : ["(no file changes recorded)"]),
    "",
    "## Decisions",
    ...(context.decisions.length
      ? context.decisions.map((decision) => `- ${decision.decision}${decision.reason ? ` — ${decision.reason}` : ""}`)
      : ["(no decisions recorded)"]),
    "",
    "## Your Job",
    "Write the final project report as markdown, using exactly these top-level sections in this order:",
    "1. Tóm tắt điều hành (executive summary)",
    "2. Phạm vi & kế hoạch ban đầu",
    "3. Đội thực hiện (agent, model, role, đóng góp)",
    "4. Kết quả theo subtask",
    "5. Tổng hợp review (findings, verdict, điểm số)",
    "6. Thay đổi file",
    "7. Rework & lý do",
    "8. Rủi ro còn lại và việc cần làm tiếp",
    "9. Phụ lục: timeline",
    "",
    "Reply with ONLY the markdown report — no fenced code block, no commentary before or after.",
  ].filter((line): line is string => line !== undefined);
  return `${lines.join("\n")}\n`;
}

// Deterministic, LLM-free report built straight from store data. Used when
// no reporter agent is configured, or the reporter's own run failed/produced
// unusable output — the user should never end up with no report at all.
export function renderFallbackReport(context: ReportContext): string {
  const done = context.subtasks.filter((subtask) => subtask.status === "done").length;
  const blocked = context.subtasks.filter((subtask) => subtask.status === "blocked").length;
  const remaining = context.subtasks.filter((subtask) => !["done", "cancelled"].includes(subtask.status));

  const lines = [
    `# ${context.task.title} — Project Report`,
    "",
    "## Tóm tắt điều hành",
    `${context.subtasks.length} subtask(s) total: ${done} done, ${blocked} blocked/needs rework.` +
      (context.orchestration ? ` Orchestration status: ${context.orchestration.status}.` : ""),
    "",
    "## Phạm vi & kế hoạch ban đầu",
    context.task.goal || context.task.title,
    "",
    context.planMarkdown || "_No plan file recorded for this orchestration._",
    "",
    "## Đội thực hiện",
    renderTeamTable(context),
    "",
    "## Kết quả theo subtask",
    ...context.subtasks.map((subtask) => renderSubtaskSection(subtask, context)),
    "",
    "## Tổng hợp review",
    ...(context.reviews.length ? context.reviews.map((review) => renderReviewSection(review, context)) : ["_No reviews recorded._"]),
    "",
    "## Thay đổi file",
    ...(context.taskChanges.length
      ? context.taskChanges.map((change) => `- \`${change.path}\` — ${change.changeType} (${change.status})`)
      : ["_No file changes recorded._"]),
    "",
    "## Rework & lý do",
    ...renderReworkSection(context),
    "",
    "## Rủi ro còn lại và việc cần làm tiếp",
    ...(remaining.length
      ? remaining.map((subtask) => `- ${subtask.title} (${subtask.status})`)
      : ["_Nothing outstanding._"]),
    ...(context.orchestration?.lastError ? [`- Last orchestration error: ${context.orchestration.lastError}`] : []),
    "",
    "## Phụ lục: timeline",
    ...renderTimeline(context),
  ];
  return `${lines.join("\n")}\n`;
}

function renderSubtaskLine(subtask: Subtask, context: ReportContext): string {
  const assignment = latestAssignmentFor(subtask.id, context.assignments);
  return `- [${subtask.status}] ${subtask.title}${assignment?.resultSummary ? ` — ${assignment.resultSummary}` : ""}`;
}

function renderSubtaskSection(subtask: Subtask, context: ReportContext): string {
  const assignment = latestAssignmentFor(subtask.id, context.assignments);
  const lines = [`### ${subtask.title} (${subtask.status})`];
  if (subtask.goal) lines.push(`Goal: ${subtask.goal}`);
  if (subtask.acceptanceCriteria.length) {
    lines.push("Acceptance criteria:", ...subtask.acceptanceCriteria.map((item) => `- ${item}`));
  }
  lines.push(assignment?.resultSummary ? `Result: ${assignment.resultSummary}` : "Result: (no summary recorded)");
  return lines.join("\n");
}

function renderReviewLine(review: Review, context: ReportContext): string {
  const subtaskTitle = context.subtasks.find((subtask) => subtask.id === review.subtaskId)?.title ?? review.subtaskId ?? "?";
  return `- ${subtaskTitle}: ${review.verdict}${review.score != null ? ` (${review.score})` : ""} — ${review.summary}`;
}

function renderReviewSection(review: Review, context: ReportContext): string {
  const subtaskTitle = context.subtasks.find((subtask) => subtask.id === review.subtaskId)?.title ?? review.subtaskId ?? "?";
  const lines = [`- **${subtaskTitle}** — ${review.verdict}${review.score != null ? `, score ${review.score}` : ""}: ${review.summary}`];
  if (review.findings) lines.push(`  findings: ${review.findings}`);
  return lines.join("\n");
}

function renderTeamTable(context: ReportContext): string {
  const rows = new Map<string, { agent: RegisteredAgent; role: string; contributions: number }>();
  for (const assignment of context.assignments) {
    const agent = context.agents.find((candidate) => candidate.id === assignment.agentId);
    if (!agent) continue;
    const key = `${agent.id}:${assignment.roleId}`;
    const existing = rows.get(key);
    if (existing) existing.contributions += 1;
    else rows.set(key, { agent, role: assignment.roleId, contributions: 1 });
  }
  if (!rows.size) return "_No assignments recorded._";
  const header = "| Agent | Provider | Model | Contributions |\n| --- | --- | --- | --- |";
  const body = [...rows.values()]
    .map((row) => `| ${row.agent.name} | ${row.agent.provider} | ${row.agent.model ?? "default"} | ${row.contributions} |`)
    .join("\n");
  return `${header}\n${body}`;
}

function renderReworkSection(context: ReportContext): string[] {
  const blocked = context.subtasks.filter((subtask) => subtask.status === "blocked");
  if (!blocked.length) return ["_No rework was needed._"];
  return blocked.map((subtask) => {
    const review = context.reviews.find((candidate) => candidate.subtaskId === subtask.id && candidate.verdict === "rework");
    return `- ${subtask.title}${review ? `: ${review.summary}` : " (sent back for rework)"}`;
  });
}

function renderTimeline(context: ReportContext): string[] {
  const entries: Array<{ at: string; text: string }> = [
    ...context.decisions.map((decision) => ({ at: decision.createdAt, text: `Decision: ${decision.decision}` })),
    ...(context.handoff ? [{ at: context.handoff.createdAt, text: `Handoff: ${context.handoff.summary}` }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return entries.length ? entries.map((entry) => `- ${entry.at} — ${entry.text}`) : ["_No decisions or handoffs recorded._"];
}

function latestAssignmentFor(subtaskId: string, assignments: Assignment[]): Assignment | undefined {
  return assignments
    .filter((assignment) => assignment.subtaskId === subtaskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
