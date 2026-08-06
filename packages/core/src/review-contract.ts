import { extractJsonBlock } from "./leader-contract.js";

// A reviewer's scope can span several subtasks (the leader groups related
// subtasks under one reviewer to save a round trip), so its reply is a batch
// of per-subtask verdicts keyed by the same "sN" keys the leader assigned.

export type ReviewFinding = {
  severity?: string;
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
};

export type ReviewVerdictItem = {
  subtaskKey: string;
  verdict: "pass" | "rework" | "block";
  score?: number;
  summary: string;
  findings?: ReviewFinding[];
};

export type ReviewTurn = {
  version: 1;
  phase: "review";
  reviews: ReviewVerdictItem[];
};

export type ParseReviewTurnResult = { ok: true; turn: ReviewTurn } | { ok: false; error: string };

export function parseReviewTurn(text: string): ParseReviewTurnResult {
  const block = extractJsonBlock(text);
  if (!block) {
    return {
      ok: false,
      error: "No JSON found in the reviewer's reply. Reply with a single ```json fenced block.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      error: `The JSON block did not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The JSON block must be an object." };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.phase !== "review") {
    return { ok: false, error: `Expected "phase": "review", got ${JSON.stringify(obj.phase)}.` };
  }
  const errors: string[] = [];
  const reviews: ReviewVerdictItem[] = [];
  if (!Array.isArray(obj.reviews) || obj.reviews.length === 0) {
    errors.push('"reviews" must be a non-empty array.');
  } else {
    obj.reviews.forEach((raw, index) => {
      const result = validateReviewItem(raw, index);
      if (typeof result === "string") errors.push(result);
      else reviews.push(result);
    });
  }
  if (errors.length) return { ok: false, error: errors.join(" ") };
  return { ok: true, turn: { version: 1, phase: "review", reviews } };
}

export function renderReviewRetryPrompt(error: string): string {
  return [
    "Your previous reply could not be parsed as the required JSON contract.",
    `Parse error: ${error}`,
    "Reply again with ONLY a single fenced ```json block matching the schema. Do not include any prose before or after it.",
  ].join("\n");
}

function validateReviewItem(raw: unknown, index: number): ReviewVerdictItem | string {
  if (typeof raw !== "object" || raw === null) return `reviews[${index}] must be an object.`;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.subtaskKey !== "string" || !obj.subtaskKey) {
    return `reviews[${index}].subtaskKey must be a non-empty string.`;
  }
  const verdict = obj.verdict;
  if (verdict !== "pass" && verdict !== "rework" && verdict !== "block") {
    return `reviews[${index}].verdict must be "pass" | "rework" | "block".`;
  }
  if (typeof obj.summary !== "string" || !obj.summary) {
    return `reviews[${index}].summary must be a non-empty string.`;
  }
  return {
    subtaskKey: obj.subtaskKey,
    verdict,
    score: typeof obj.score === "number" ? obj.score : undefined,
    summary: obj.summary,
    findings: Array.isArray(obj.findings) ? (obj.findings as ReviewFinding[]) : undefined,
  };
}

export function renderReviewerPrompt(input: {
  taskTitle: string;
  subtasks: Array<{ key: string; title: string; goal?: string; acceptanceCriteria: string[]; resultSummary?: string }>;
}): string {
  const lines = ["# Reviewer Turn", "", `Task: ${input.taskTitle}`, "", "## Subtasks To Review"];
  for (const subtask of input.subtasks) {
    lines.push(`### ${subtask.key}: ${subtask.title}`);
    if (subtask.goal) lines.push(`Goal: ${subtask.goal}`);
    if (subtask.acceptanceCriteria.length) {
      lines.push("Acceptance criteria:");
      for (const criterion of subtask.acceptanceCriteria) lines.push(`- ${criterion}`);
    }
    lines.push(`Implementer result: ${subtask.resultSummary || "(no summary captured)"}`, "");
  }
  lines.push(
    "## Your Job",
    "- Check each subtask against its acceptance criteria.",
    "- Use `rework` when something is missing or wrong; be specific in findings so the next attempt doesn't have to guess.",
    "- Use `block` only when you cannot judge this without user input.",
    "",
    "## Required Output",
    "Reply with EXACTLY one fenced ```json block and nothing else outside it:",
    "",
    "```json",
    JSON.stringify(
      {
        version: 1,
        phase: "review",
        reviews: input.subtasks.map((subtask) => ({
          subtaskKey: subtask.key,
          verdict: "pass",
          score: 90,
          summary: "Meets the acceptance criteria.",
          findings: [],
        })),
      },
      null,
      2,
    ),
    "```",
  );
  return `${lines.join("\n")}\n`;
}
