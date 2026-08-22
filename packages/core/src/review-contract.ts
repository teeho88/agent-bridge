import { WORKBOARD_BOUNDARY_LINES } from "./context-store.js";
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

// What this reviewer scope was told last time round. A rework subtask replaces
// the one it fixes, so without this the reviewer of attempt two has no idea
// what attempt one was sent back for and re-reviews the whole scope from
// scratch — paying full price to re-derive findings it already wrote.
export type PriorReviewInput = {
  // The subtask the review was written against; for a rework this is the
  // superseded original, so name it rather than implying it is this one.
  subtaskTitle: string;
  verdict: string;
  summary: string;
  findings?: string;
};

// Where this subtask's context lives on disk, when the orchestration has a
// context store. Passing paths instead of payloads is the point: the reviewer
// reads the implementer's own report in full rather than the 800-character tail
// of its log, and the cost of doing so does not grow with the round number.
export type ReviewContextPaths = {
  brief: string;
  report: string;
  // Earlier rounds' reviews and adjudications for this same piece of work.
  prior: string[];
  // The one file this reviewer is allowed to write.
  write: string;
};

export function renderReviewerPrompt(input: {
  taskTitle: string;
  subtasks: Array<{
    key: string;
    title: string;
    goal?: string;
    acceptanceCriteria: string[];
    resultSummary?: string;
    priorReviews?: PriorReviewInput[];
    context?: ReviewContextPaths;
  }>;
}): string {
  const lines = ["# Reviewer Turn", "", `Task: ${input.taskTitle}`, "", "## Subtasks To Review"];
  let anyPrior = false;
  let anyContext = false;
  for (const subtask of input.subtasks) {
    lines.push(`### ${subtask.key}: ${subtask.title}`);
    if (subtask.goal) lines.push(`Goal: ${subtask.goal}`);
    if (subtask.acceptanceCriteria.length) {
      lines.push("Acceptance criteria:");
      for (const criterion of subtask.acceptanceCriteria) lines.push(`- ${criterion}`);
    }
    if (subtask.context) {
      anyContext = true;
      lines.push("Read for context:");
      lines.push(`- assignment brief: \`${subtask.context.brief}\``);
      lines.push(`- implementer's report: \`${subtask.context.report}\``);
      for (const prior of subtask.context.prior) lines.push(`- earlier round: \`${prior}\``);
      lines.push(`Write your review to: \`${subtask.context.write}\``);
      if (subtask.context.prior.length) anyPrior = true;
    } else {
      lines.push(`Implementer result: ${subtask.resultSummary || "(no summary captured)"}`);
    }
    if (subtask.priorReviews?.length) {
      anyPrior = true;
      lines.push("", "Your earlier reviews in this scope:");
      for (const prior of subtask.priorReviews) {
        lines.push(`- [${prior.verdict}] ${prior.subtaskTitle}: ${prior.summary}`);
        if (prior.findings) lines.push(`    findings: ${prior.findings}`);
      }
    }
    lines.push("");
  }
  if (anyContext) {
    lines.push(
      "## Context Files",
      "Each listed file opens with a `## Summary` section. Read that first and go on",
      "to `## Detail` only when the summary leaves you unable to judge something.",
      "Do not read other subtasks' folders — a dependency's `summary.md` is the only",
      "file of theirs that concerns you.",
      "",
      "Before you reply, write your review to the file named above, in this shape:",
      "",
      "```markdown",
      "# Review — <subtask key> round <n>",
      "",
      "## Summary",
      "<up to 10 lines: verdict, and the criteria that are not met>",
      "",
      "## Detail",
      "<every finding: file, line, what is wrong, the concrete fix>",
      "```",
      "",
      ...["", ...WORKBOARD_BOUNDARY_LINES],
      "",
      "The turn is rejected if that file is missing or has an empty `## Summary`.",
      "The JSON below is still required — the file is the record the next attempt",
      "and the adjudicator read, the JSON is what the orchestrator acts on.",
      "",
    );
  }
  lines.push(
    "## Your Job",
    "- Check each subtask against its acceptance criteria.",
    // The implementer summary is the tail of its own log — its own account of
    // its own work. Reviews written from it alone pass work that was never
    // done, and the gap only surfaces cycles later as another rework.
    "- The implementer result above is a claim, not evidence. Open the actual files in the repo and verify the work against the working tree before you judge it.",
    ...(anyPrior
      ? [
          "- Where earlier reviews are listed, this is a re-review: verify each earlier finding is actually fixed, then check what changed since. Do not re-derive the parts you already passed.",
          "- Do not repeat a finding you already raised unless it is still unfixed — and if it is, say so explicitly and raise the severity.",
        ]
      : []),
    "- Use `rework` when something is missing or wrong; be specific in findings so the next attempt doesn't have to guess.",
    // Your findings are the only description of the defect that reaches the
    // next implementer, and it starts from a blank process. A finding it
    // cannot act on without your reasoning costs a whole rework cycle.
    "- In `summary`, name every acceptance criterion that is NOT met, quoting it. If all are met, say that explicitly.",
    "- Every finding must stand alone: `file` (and `line` where you can), what is wrong, and the concrete change that fixes it. Never write a finding whose fix is only implied.",
    "- Findings are the whole brief for the next attempt. Anything you leave out will not be fixed.",
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
