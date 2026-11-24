import { CACHE_BREAKPOINT_MARKER, SHARED_PROMPT_INSTRUCTIONS } from "./prompt-cache.js";
import { toSingleLine } from "./token-optimizer.js";
import type { PromptPack } from "./types.js";

// Truncation has to be visible: without a marker an agent cannot tell a
// budget-trimmed section from a genuinely empty one, and silently acts on a
// partial picture. The note names the knob that widens the section.
function omissionNote(omitted: number): string {
  return `- ...[${omitted} more omitted by the token budget - raise it in .agent-memory/token-policy.yaml]`;
}

function bullets(items: string[], omitted = 0): string {
  const flattened = items.map(toSingleLine).filter(Boolean);
  const rendered = flattened.length
    ? flattened.map((item) => `- ${item}`).join("\n")
    : omitted > 0 ? "" : "- None recorded.";
  return omitted > 0 ? [rendered, omissionNote(omitted)].filter(Boolean).join("\n") : rendered;
}

function assignmentBullets(pack: Omit<PromptPack, "renderedMarkdown" | "tokenEstimate">): string[] {
  const current = pack.currentAssignment;
  if (!current) return [];
  const items = [
    `Assignment: ${current.assignment.id}`,
    `Status: ${current.assignment.status}`,
    `Agent: ${current.agent?.name ?? current.assignment.agentId}`,
    `Role: ${current.role?.name ?? current.assignment.roleId}`,
  ];
  if (current.workforce) items.push(`Workforce: ${current.workforce.name}`);
  if (current.subtask) {
    items.push(`Subtask: ${current.subtask.title}`);
    if (current.subtask.goal) items.push(`Subtask goal: ${current.subtask.goal}`);
    for (const criterion of current.subtask.acceptanceCriteria) {
      items.push(`Acceptance: ${criterion}`);
    }
  }
  items.push(`Prompt: ${current.assignment.prompt}`);
  if (current.assignment.resultSummary) items.push(`Result: ${current.assignment.resultSummary}`);
  if (current.assignment.testSummary) items.push(`Tests: ${current.assignment.testSummary}`);
  if (current.assignment.riskSummary) items.push(`Risks: ${current.assignment.riskSummary}`);
  return items;
}
// Stable task instructions precede the cache breakpoint; runtime state follows it.
export function renderPromptPack(
  pack: Omit<PromptPack, "renderedMarkdown" | "tokenEstimate">,
): string {
  const seen = new Set<string>();
  const unique = (items: string[]) => items.map(toSingleLine).filter((item) => {
    const key = item.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lines = ["# Agent Task Brief", "", SHARED_PROMPT_INSTRUCTIONS, "", "## Task", `- ID: ${pack.task.id}`, `- Title: ${toSingleLine(pack.task.title)}`];
  const normalize = (text: string) => toSingleLine(text).toLowerCase().replace(/\s+/g, " ");
  const request = pack.currentRequest?.trim();
  if (pack.task.goal && (!request || normalize(pack.task.goal) !== normalize(request))) {
    lines.push("", "## Goal", toSingleLine(pack.task.goal));
    seen.add(normalize(pack.task.goal));
  }
  seen.add(normalize(pack.task.title));
  const section = (title: string, items: string[], omitted = 0, protectedContent = false) => {
    const values = protectedContent ? [...new Set(items.map(toSingleLine).filter(Boolean))] : unique(items);
    if (protectedContent) for (const value of values) seen.add(normalize(value));
    if (values.length || omitted) lines.push("", title, bullets(values, omitted));
  };
  section("## Graph Navigation", [pack.graphEnabled === false
    ? "Graph navigation is disabled for this repository (graph.enabled=false). Use scoped rg searches to find files to read or edit."
    : "When you need to locate files to read or edit, query `agent-bridge graph search <query> --limit 10`; inspect `graph neighbors <path>` for imports/callers and `graph symbols <path>` for definitions. Use `graph map --focus <path> --limit 10` only when a local overview helps. Read only relevant source ranges and direct dependencies; verify graph hints against source before editing. If the index is empty, missing or stale, fall back to scoped rg searches. Do not load the global graph or all briefs into context."], 0, true);
  section("## Constraints", pack.constraints, 0, true);
  section("## Known Decisions", pack.knownDecisions, pack.omitted.knownDecisions, true);
  lines.push("", CACHE_BREAKPOINT_MARKER, "", "## Status", `- Task: ${pack.task.status}`);
  if (request) {
    lines.push("", "## Current Request", toSingleLine(request));
    seen.add(normalize(request));
  }
  if (pack.tokenBudget !== undefined) {
    lines.push("", "## Context Budget", `- Limit: ${pack.tokenBudget} tokens; counting: ${pack.tokenCounter ?? "script-aware estimate"}`);
    if (pack.detailsPath && Object.values(pack.omitted).some((total) => total > 0))
      lines.push(`- Full selected source snapshot: ${pack.detailsPath}`);
  }
  section("## Current Assignment", assignmentBullets(pack));
  section("## Test Evidence", pack.testResults ?? [], pack.omitted.testResults ?? 0);
  if (pack.handoff) {
    section("## Latest Handoff", [pack.handoff.summary]);
    section("### Next", pack.handoff.next);
    section("### Risks", pack.handoff.risks);
    section("### Done", pack.handoff.done, pack.omitted.handoffDone ?? 0);
    section("### Files Changed", pack.handoff.filesChanged,
      pack.omitted.handoffFilesChanged ?? (pack.omitted.handoffDone === undefined ? pack.omitted.handoff : 0));
  }
  section("## Current State", pack.currentState, pack.omitted.currentState);
  section("## Relevant Files", pack.relevantFiles, pack.omitted.relevantFiles);
  section("## Next Actions", pack.nextActions);
  section("## Risks / Do Not Touch", pack.risks);
  section("## Shared Memory", pack.sharedMemory.map((item) => item.replace(/^(Objective|Invariant|Decision|Latest handoff|Current fact|Next|Risk|Done|Touched file|Current assignment):\s*/i, "")), pack.omitted.sharedMemory);
  return lines.join("\n");
}
