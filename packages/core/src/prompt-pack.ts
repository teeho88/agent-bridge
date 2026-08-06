import { CACHE_BREAKPOINT_MARKER } from "./prompt-cache.js";
import type { PromptPack } from "./types.js";

function bullets(items: string[]): string {
  return items.length
    ? items.map((item) => `- ${item}`).join("\n")
    : "- None recorded.";
}

function numbers(items: string[]): string {
  return items.length
    ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Continue from current task state.";
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
// Layout is ordered for prompt caching: a STABLE prefix (rules, expected output,
// constraints, known decisions) comes first, then a cache breakpoint marker,
// then the DYNAMIC suffix (goal, current state, files, handoff, next actions,
// risks). Anthropic caches by prefix, so keeping the rarely-changing content at
// the top lets it be reused across turns. See prompt-cache.ts / docs.
export function renderPromptPack(
  pack: Omit<PromptPack, "renderedMarkdown" | "tokenEstimate">,
): string {
  const prefix = [
    "# Agent Task Brief",
    "",
    "## Expected Output",
    "- Minimal diff.",
    "- Test result summary.",
    "- Updated handoff note.",
    "",
    "## Constraints",
    bullets(pack.constraints),
    "",
    "## Known Decisions",
    bullets(pack.knownDecisions),
  ];

  const suffix = [
    "## Task",
    `- Title: ${pack.task.title}`,
    `- Status: ${pack.task.status}`,
    "",
    "## Goal",
    pack.task.goal || "No explicit goal recorded.",
    "",
    "## Current Assignment",
    bullets(assignmentBullets(pack)),
    "",
    "## Shared Memory",
    bullets(pack.sharedMemory),
    "",
    "## Current State",
    bullets(pack.currentState),
    "",
    "## Relevant Files",
    bullets(pack.relevantFiles),
  ];

  if (pack.repoMap) {
    suffix.push("", "## Repo Map", pack.repoMap);
  }

  if (pack.handoff) {
    suffix.push(
      "",
      "## Latest Handoff",
      `- From: ${pack.handoff.fromAgent ?? "unknown"}`,
      `- To: ${pack.handoff.toAgent ?? "unknown"}`,
      `- Summary: ${pack.handoff.summary}`,
      "",
      "### Done",
      bullets(pack.handoff.done),
      "",
      "### Next",
      bullets(pack.handoff.next),
      "",
      "### Risks",
      bullets(pack.handoff.risks),
      "",
      "### Files Changed",
      bullets(pack.handoff.filesChanged),
    );
  }

  const risksOutsideHandoff = pack.handoff
    ? pack.risks.filter((risk) => !pack.handoff?.risks.includes(risk))
    : pack.risks;

  suffix.push(
    "",
    "## Next Actions",
    numbers(pack.nextActions),
    "",
    "## Risks / Do Not Touch",
    bullets(risksOutsideHandoff),
  );

  return [...prefix, "", CACHE_BREAKPOINT_MARKER, "", ...suffix].join("\n");
}

