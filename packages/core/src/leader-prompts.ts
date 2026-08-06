// Prompt templates for the two leader turns. Both end with a concrete JSON
// example — for CLI/API models with no native structured-output mode, an
// in-context example is the most reliable way to get consistent, parseable
// JSON back (bare schema descriptions get paraphrased; examples get copied).

export type ReviewSummaryInput = {
  subtaskKey: string;
  subtaskTitle: string;
  verdict: string;
  score?: number;
  summary: string;
  findings?: string;
};

export type SubtaskStatusInput = {
  key: string;
  title: string;
  status: string;
  acceptanceCriteria: string[];
};

// Everything the leader needs to re-plan an already-delivered project instead
// of planning it from scratch: what the user now wants changed, plus what was
// already built and signed off so it does not redo finished work.
export type PlanRevisionInput = {
  request: string;
  previousPlan?: string;
  previousReport?: string;
  previousSubtasks: Array<{ title: string; status: string }>;
  previousReviews: Array<{ subtaskTitle: string; verdict: string; summary: string }>;
};

export function renderPlanPrompt(input: {
  taskTitle: string;
  goal?: string;
  contextHint?: string;
  maxParallel: number;
  availableProviders: string[];
  providerModels?: Record<string, string[]>;
  agentRoster?: Array<{ name: string; provider: string; model?: string; capabilities: string[] }>;
  revision?: PlanRevisionInput;
  answers?: Array<{ question: string; answer: string }>;
}): string {
  const lines = [
    input.revision ? "# Leader Re-planning Turn (change request)" : "# Leader Planning Turn",
    "",
    `You are the leader for: ${input.taskTitle}`,
  ];
  if (input.goal) lines.push(`Goal: ${input.goal}`);
  lines.push(
    "",
    ...renderProviderList(input.availableProviders, input.providerModels, input.agentRoster),
    `The orchestrator will run at most ${input.maxParallel} implementer(s) in parallel.`,
    ...renderStaffingRules(input.availableProviders),
  );
  if (input.contextHint) lines.push("", "## Context", "", input.contextHint);
  if (input.revision) lines.push(...renderRevisionSection(input.revision));
  if (input.answers?.length) {
    // The leader asked these on a previous turn and the user answered. They are
    // decisions, not suggestions — planning around them is the whole point of
    // having stopped to ask.
    lines.push("", "## Answers To Your Questions", "", "Treat these as settled requirements:");
    for (const entry of input.answers) {
      lines.push(`- Q: ${entry.question}`, `  A: ${entry.answer}`);
    }
  }
  lines.push(
    "",
    "## Your Job",
    ...(input.answers?.length
      ? ["- The answers above are settled; do not re-ask them, and reflect them in the subtasks and acceptance criteria."]
      : []),
    ...(input.revision
      ? [
          "- This project was already delivered. Plan ONLY the work the change request needs.",
          "- Do not re-create subtasks whose work is already done and accepted; build on the existing code.",
        ]
      : []),
    "- Break this task into subtasks with clear dependencies and acceptance criteria.",
    "- Pick how many implementers and reviewers this needs based on complexity — do not over- or under-split.",
    "- For each subtask, list which files it will likely touch; do not schedule two subtasks that touch the same files as parallelSafe.",
    "- Propose an agent preference (provider/model/reasoning) for each subtask and reviewer group; explain why in `reason`.",
    "- If anything about the request is ambiguous or risky, add it to `questions` instead of guessing.",
    "- Write each question as {\"question\": \"...\", \"options\": [\"...\"]}. Whenever the answer is a choice between concrete alternatives, LIST them in `options` so the user can just pick one; use an empty `options` array only for genuinely open-ended questions.",
    "",
    "## Required Output",
    "Reply with EXACTLY one fenced ```json block and nothing else outside it.",
    '`complexity` must be exactly one of: "small", "medium", "large" — no other word is accepted.',
    "",
    "```json",
    JSON.stringify(
      {
        version: 1,
        phase: "plan",
        complexity: "medium",
        planMarkdown: "# Plan\n\n1. ...",
        subtasks: [
          {
            key: "s1",
            title: "Add agent_runs schema",
            goal: "Track live agent processes",
            priority: 5,
            dependsOn: [],
            acceptanceCriteria: ["migration applies", "CRUD roundtrip test passes"],
            role: "implementer",
            parallelSafe: true,
            files: ["packages/memory/src/schema.ts"],
            agentPreference: {
              provider: "codex",
              mode: "cli",
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              reason: "schema work needs high reasoning",
            },
          },
        ],
        reviewers: [
          {
            key: "r1",
            scope: ["s1"],
            role: "reviewer",
            agentPreference: { provider: "claude", mode: "cli", model: "claude-opus-5", reasoningEffort: "high" },
          },
        ],
        questions: [
          {
            question: "Should the migration backfill existing rows?",
            options: ["Backfill everything", "Backfill only the last 30 days", "Leave existing rows untouched"],
          },
        ],
      },
      null,
      2,
    ),
    "```",
  );
  return `${lines.join("\n")}\n`;
}

// A leader defaults to staffing everything with its own provider unless it is
// told, explicitly, that the others are real options and that spreading the
// work across them is wanted. Two concrete reasons drive this: each vendor has
// its own quota, and a project that runs entirely on one of them stalls the
// moment that quota is gone; and the providers are genuinely better at
// different things. Listing the usable models per provider matters just as
// much — without it the leader invents model ids that resolve to nothing.
function renderProviderList(
  providers: string[],
  models?: Record<string, string[]>,
  roster?: Array<{ name: string; provider: string; model?: string; capabilities: string[] }>,
): string[] {
  if (!providers.length) return ["Available agent providers in this workspace: none registered yet."];
  const lines = [`Available agent providers for this team: ${providers.join(", ")}.`];
  for (const provider of providers) {
    const available = models?.[provider] ?? [];
    lines.push(available.length ? `- ${provider} — models: ${available.join(", ")}` : `- ${provider}`);
  }
  if (roster?.length) {
    lines.push("", "Registered agents and enforced capabilities:");
    for (const agent of roster) {
      lines.push(
        `- ${agent.name}: ${agent.provider}${agent.model ? `/${agent.model}` : ""} — capabilities: ${agent.capabilities.join(", ") || "none"}`,
      );
    }
  }
  return lines;
}

function renderStaffingRules(providers: string[]): string[] {
  const lines = [
    "",
    "## Staffing Rules",
    // This is enforced, not advisory: the orchestrator resolves every
    // agentPreference against the user's registered, enabled agents and will
    // not create a new one. Saying so up front is cheaper than a plan that
    // fails at spawn time.
    "- Staff ONLY from the roster above. It is the complete list of agents the user has enabled; any other provider or model id is rejected when the subtask is spawned.",
    "- Every subtask agentPreference MUST resolve to an agent whose capabilities include `implement`.",
    "- Every reviewer agentPreference MUST resolve to an agent whose capabilities include `review`.",
    "- Capabilities are enforced at spawn time. Never assign implement or review work to an agent missing that exact capability.",
    "- Do not invent, request, or assume an agent that is not listed, even if you know its CLI exists on this machine.",
  ];
  if (providers.length > 1) {
    lines.push(
      "- You are NOT limited to your own provider. Mix them deliberately across subtasks and reviewers.",
      "- Spread the load so no single provider's quota carries the whole project; if one provider does every subtask, that is a planning mistake.",
      "- Have a reviewer come from a different provider than the implementer whose work it reviews — a second vendor catches what the first one is blind to.",
      "- Still match the agent to the job: say in `reason` why that provider/model fits this subtask, not just that it was next in the rotation.",
    );
  }
  return lines;
}

function renderRevisionSection(revision: PlanRevisionInput): string[] {
  const lines = [
    "",
    "## Change Request",
    "",
    "The project below was already delivered and reported as complete. The user now wants:",
    "",
    revision.request,
    "",
    "## What Already Exists",
  ];
  if (revision.previousSubtasks.length) {
    lines.push("", "Subtasks from the previous round:");
    for (const subtask of revision.previousSubtasks) {
      lines.push(`- [${subtask.status}] ${subtask.title}`);
    }
  }
  if (revision.previousReviews.length) {
    lines.push("", "Review verdicts from the previous round:");
    for (const review of revision.previousReviews) {
      lines.push(`- ${review.subtaskTitle}: ${review.verdict} — ${review.summary}`);
    }
  }
  if (revision.previousPlan) {
    lines.push("", "Previous plan:", "", truncate(revision.previousPlan, 4000));
  }
  if (revision.previousReport) {
    lines.push("", "Previous final report:", "", truncate(revision.previousReport, 4000));
  }
  return lines;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

export function renderAdjudicatePrompt(input: {
  taskTitle: string;
  reviews: ReviewSummaryInput[];
  subtasks: SubtaskStatusInput[];
  cycle: number;
  maxCycles: number;
  availableProviders?: string[];
  providerModels?: Record<string, string[]>;
  actor?: "leader" | "adjudicator";
  adjudicatorProposal?: string;
}): string {
  const actor = input.actor ?? "leader";
  const lines = [
    actor === "leader" ? "# Leader Adjudication Turn" : "# Adjudicator Turn",
    "",
    `Task: ${input.taskTitle}`,
    `Cycle ${input.cycle} of at most ${input.maxCycles}.`,
  ];
  if (actor === "adjudicator") {
    lines.push(
      "",
      "You are the first-pass adjudicator. Resolve routine, unambiguous review outcomes efficiently.",
      "A block, user question, conflicting/risky review, or projectComplete=true is automatically escalated to the Leader for the final decision.",
    );
  }
  if (input.adjudicatorProposal) {
    lines.push(
      "",
      "## First-pass Adjudicator Proposal",
      "The proposal below was escalated. Independently verify it against the reviews; you own the final decision.",
      input.adjudicatorProposal,
    );
  }
  // Rework carries its own agentPreference, so this turn staffs agents too and
  // needs the same provider list the planning turn gets.
  if (input.availableProviders?.length) {
    lines.push(
      "",
      ...renderProviderList(input.availableProviders, input.providerModels),
      ...renderStaffingRules(input.availableProviders),
    );
  }
  lines.push("", "## Subtask Status");
  for (const subtask of input.subtasks) {
    const superseded = subtask.status === "cancelled";
    lines.push(`- [${subtask.status}] ${subtask.key}: ${subtask.title}${superseded ? " (superseded — no longer outstanding)" : ""}`);
    // A superseded subtask's criteria were re-issued on its replacement.
    // Repeating them here reads as a pile of unmet requirements and is enough
    // on its own to make the leader refuse to mark the project complete.
    if (superseded) continue;
    for (const criterion of subtask.acceptanceCriteria) lines.push(`    - criterion: ${criterion}`);
  }
  lines.push("", "## Reviews Awaiting Your Decision");
  if (!input.reviews.length) {
    // Without this the section is simply empty, and the leader reads that as
    // "something is missing" and refuses to finish. Say plainly that execution
    // is drained and the only question left is whether the work is done.
    lines.push(
      "None. Every review has already been adjudicated and there is no dispatchable work left.",
      "Return an empty `decisions` array and decide `projectComplete` on the subtask statuses above.",
    );
  }
  for (const review of input.reviews) {
    lines.push(
      `- ${review.subtaskKey} (${review.subtaskTitle}): verdict=${review.verdict}${review.score != null ? ` score=${review.score}` : ""}`,
      `  summary: ${review.summary}`,
    );
    if (review.findings) lines.push(`  findings: ${review.findings}`);
  }
  lines.push(
    "",
    "## Your Job",
    "- For each subtask with a pending review, decide accept, rework, or block.",
    "- Use rework when the acceptance criteria are not fully met yet; give the rework subtask a tight, specific goal so the next implementer doesn't redo finished work.",
    "- Use block only when the subtask cannot proceed without user input; explain why in `questions`.",
    "- Ignore [cancelled] subtasks: they were superseded by a later subtask and are not outstanding work.",
    "- Set projectComplete to true only when every subtask is accepted or cancelled and nothing more is needed.",
    "",
    "## Required Output",
    "Reply with EXACTLY one fenced ```json block and nothing else outside it:",
    "",
    "```json",
    JSON.stringify(
      {
        version: 1,
        phase: "adjudicate",
        decisions: [
          {
            subtaskKey: "s1",
            verdict: "rework",
            rework: {
              title: "Fix migration ordering",
              goal: "Add the missing index and re-run the roundtrip test",
              acceptanceCriteria: ["idx_agent_runs_task exists", "roundtrip test passes"],
              agentPreference: { provider: "codex", mode: "cli", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
            },
          },
        ],
        projectComplete: false,
        questions: [],
      },
      null,
      2,
    ),
    "```",
  );
  return `${lines.join("\n")}\n`;
}
