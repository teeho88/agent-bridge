import { CACHE_BREAKPOINT_MARKER } from "./prompt-cache.js";
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
    : "- None recorded.";
  return omitted > 0 ? `${rendered}\n${omissionNote(omitted)}` : rendered;
}

function numbers(items: string[]): string {
  const flattened = items.map(toSingleLine).filter(Boolean);
  return flattened.length
    ? flattened.map((item, index) => `${index + 1}. ${item}`).join("\n")
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
// Layout is ordered for prompt caching: a STABLE prefix comes first, then a
// cache breakpoint marker, then the DYNAMIC suffix. Caching is positional — a
// changed byte invalidates everything after it — so sections are ordered by how
// often they change, cheapest first, and anything that moves per turn stays out
// of the prefix entirely:
//
//   never      # Agent Task Brief, ## Expected Output (both literal)
//   per task   ## Task title, ## Goal
//   sometimes  ## Constraints, ## Known Decisions (a new memory/decision)
//   on rebuild ## Repo Map — last, because it is the largest block and must not
//              sit behind anything more volatile than itself
//
// Two sections look stable but are not, and belong below the marker. Task
// STATUS flips todo -> in_progress on the first recorded edit. Shared Memory is
// distilled from the handoff summary, done list, files changed, and current
// state (see context-compiler), so it is rewritten on every handoff; parking it
// above Repo Map would drop ~1.6k cached tokens each time. See prompt-cache.ts.
export function renderPromptPack(
  pack: Omit<PromptPack, "renderedMarkdown" | "tokenEstimate">,
): string {
  const prefix = [
    "# Agent Task Brief",
    "",
    "## Task",
    `- Title: ${toSingleLine(pack.task.title)}`,
    "",
    "## Goal",
    toSingleLine(pack.task.goal ?? "") || "No explicit goal recorded.",
    "",
    "## Expected Output",
    "- Minimal diff.",
    "- Test result summary.",
    "- Updated handoff note.",
    "",
    "## Constraints",
    bullets(pack.constraints, pack.omitted.constraints),
    "",
    "## Known Decisions",
    bullets(pack.knownDecisions, pack.omitted.knownDecisions),
  ];

  if (pack.repoMap) {
    prefix.push("", "## Repo Map", pack.repoMap);
    if (pack.omitted.repoMap > 0) {
      prefix.push(omissionNote(pack.omitted.repoMap));
    }
  }

  const suffix = [
    "## Status",
    `- Task: ${pack.task.status}`,
    "",
    "## Current Assignment",
    bullets(assignmentBullets(pack)),
    "",
    "## Shared Memory",
    bullets(pack.sharedMemory, pack.omitted.sharedMemory),
    "",
    "## Current State",
    bullets(pack.currentState, pack.omitted.currentState),
    "",
    "## Relevant Files",
    bullets(pack.relevantFiles, pack.omitted.relevantFiles),
  ];

  if (pack.handoff) {
    suffix.push(
      "",
      "## Latest Handoff",
      `- From: ${pack.handoff.fromAgent ?? "unknown"}`,
      `- To: ${pack.handoff.toAgent ?? "unknown"}`,
      `- Summary: ${toSingleLine(pack.handoff.summary)}`,
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
    if (pack.omitted.handoff > 0) {
      suffix.push(omissionNote(pack.omitted.handoff));
    }
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

