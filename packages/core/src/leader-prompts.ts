// Prompt templates for the two leader turns. Both end with a concrete JSON
// example — for CLI/API models with no native structured-output mode, an
// in-context example is the most reliable way to get consistent, parseable
// JSON back (bare schema descriptions get paraphrased; examples get copied).

import { WORKBOARD_BOUNDARY_LINES } from "./context-store.js";

export type ReviewSummaryInput = {
  subtaskKey: string;
  subtaskTitle: string;
  verdict: string;
  score?: number;
  summary: string;
  findings?: string;
  // Reviews written against the earlier attempts this one replaces. The
  // decision log records what the leader ruled, but not what the reviewer
  // said — so without this a finding raised for the third time is
  // indistinguishable from a fresh one, and gets the same rework again.
  priorReviews?: Array<{ subtaskTitle: string; verdict: string; summary: string; findings?: string }>;
  // Where this piece of work's context lives, when the orchestration has a
  // context store. Findings and earlier rounds are pointed at rather than
  // inlined: a findings blob is the largest thing in this prompt and it is
  // replayed on every cycle, while the file it came from is read only by the
  // decisions that actually need it.
  context?: ReviewContextPathsInput;
};

export type ReviewContextPathsInput = {
  brief: string;
  // This round's review document.
  review: string;
  // Earlier rounds: their reports, reviews and adjudications.
  prior: string[];
  // The one file this adjudication turn must write for this subtask.
  write: string;
  // Where an accepted subtask's hand-off summary goes. It is the only file
  // downstream subtasks are allowed to read from this one, so anything a later
  // task needs has to survive into it.
  summary: string;
};

// The leader's own previous planning turn, replayed to it. Without this the
// turn after a question round starts from the goal again and re-derives the
// same open points in new words — which is exactly what makes the plan/answer
// cycle loop.
export type PlanLedgerInput = {
  previousPlanMarkdown?: string;
  previousComplexity?: string;
  previousSubtaskTitles: string[];
  askedQuestions: string[];
  rounds: number;
};

export type AdjudicationLedgerInput = Array<{
  cycle: number;
  actor: string;
  decisions: Array<{ subtaskKey: string; verdict: string; reworkTitle?: string; reworkGoal?: string }>;
  projectComplete: boolean;
}>;

export type SubtaskStatusInput = {
  key: string;
  title: string;
  status: string;
  acceptanceCriteria: string[];
  // Keys of dependencies that will never complete. Set only on subtasks the
  // orchestrator can no longer dispatch — they produce no review, so this is
  // the only way the leader ever hears about them.
  strandedBy?: string[];
  // Why a `blocked` subtask is blocked: the reviewer's block verdict, or the
  // implementer's failure. A blocked subtask is undispatchable and reviewless
  // exactly like a stranded one, and the reason lives on a consumed review or
  // a failed assignment — neither of which reaches this prompt otherwise.
  blockedReason?: string;
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
  agentRoster?: Array<{ name: string; description?: string; provider: string; model?: string; capabilities: string[] }>;
  // True when the providers above are installed CLIs with no registered agent
  // yet: the orchestrator registers one on first use, so the roster is not the
  // hard boundary it normally is.
  autoStaff?: boolean;
  revision?: PlanRevisionInput;
  // Your own previous draft and questions, when this is not the first round.
  ledger?: PlanLedgerInput;
  answers?: Array<{ question: string; answer: string }>;
  // Free text the user attached to an approval. Same standing as an answer:
  // they typed it at the moment they authorised the work.
  approvalNotes?: Array<{ approved: string; note: string }>;
  // Rounds of questions still available. Told to the leader so it spends them
  // on what actually blocks the plan rather than discovering the ceiling only
  // when it hits it.
  questionRoundsLeft?: number;
  // Set once the budget is spent: asking again only restarts the
  // plan/answer cycle, so the leader must decide the rest itself.
  noMoreQuestions?: boolean;
  // Where the orchestrator will file this plan, when the orchestration has a
  // context store. Said so the leader writes a document meant to be re-read by
  // implementers rather than a one-off reply — and so it knows it must not
  // write the file itself on a question round.
  contextRoot?: { root: string; plan: string };
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
    ...renderStaffingRules(input.availableProviders, input.autoStaff),
  );
  if (input.contextRoot) {
    lines.push(
      "",
      "## Where This Plan Lives",
      "",
      `The orchestrator files your \`planMarkdown\` at \`${input.contextRoot.plan}\` and keeps this`,
      `orchestration's context under \`${input.contextRoot.root}\`. Do not write either yourself.`,
      "Implementers, reviewers and later planning turns read the plan file, so write it",
      "as a document that stands on its own — open it with a `## Summary` section of at",
      "most ten lines, then the detail.",
      "It is written only once you stop asking questions and return subtasks: a turn",
      "that asks questions files nothing, so ask everything you need in one round.",
      "",
      ...WORKBOARD_BOUNDARY_LINES,
    );
  }
  if (input.contextHint) lines.push("", "## Context", "", input.contextHint);
  if (input.revision) lines.push(...renderRevisionSection(input.revision));
  if (input.ledger) lines.push(...renderPlanLedgerSection(input.ledger));
  if (input.answers?.length) lines.push(...renderAnswersSection(input.answers));
  if (input.approvalNotes?.length) lines.push(...renderApprovalNotesSection(input.approvalNotes));
  lines.push(
    "",
    "## Your Job",
    ...(input.answers?.length
      ? ["- The answers above are settled; do not re-ask them, and reflect them in the subtasks and acceptance criteria."]
      : []),
    ...(input.approvalNotes?.length
      ? ["- The instructions given when approving are settled too: apply them to this plan, and do not ask the user to repeat them."]
      : []),
    ...(input.ledger?.previousPlanMarkdown
      ? [
          "- You already drafted the plan above. REVISE it: keep the parts the answers did not touch, change only what they affect, and re-emit the full plan. Do not start over from the goal.",
        ]
      : []),
    ...(input.ledger?.askedQuestions.length
      ? [
          "- Every question under \"Questions You Already Asked\" is closed. Do not ask any of them again, in any wording, at any level of detail.",
        ]
      : []),
    ...(input.noMoreQuestions
      ? [
          "- You have used up your question rounds. Do NOT ask anything else: return an empty `questions` array.",
          "- Decide every remaining open point yourself, and list each decision in `planMarkdown` under an \"Assumptions\" heading.",
        ]
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
    ...(input.noMoreQuestions
      ? []
      : [
          "- If anything about the request is ambiguous or risky, add it to `questions` instead of guessing.",
          "- Ask only what you cannot decide yourself, and ask it once: a question you have already had answered — in any wording — must not come back.",
          ...(input.questionRoundsLeft !== undefined
            ? [
                // Stated as a ceiling on purpose: a leader told it "has N
                // rounds" reads that as a budget to spend and invents
                // questions to fill it, which is the loop this limit exists
                // to prevent.
                `- Question rounds are capped at ${input.questionRoundsLeft} more (this turn included). This is a HARD CEILING, not a target: asking nothing and planning now is the best outcome, and returning an empty \`questions\` array is always allowed.`,
                "- Do not save questions for a later round or ask them one at a time to \"use up\" the budget. Anything you genuinely cannot decide goes in THIS turn's `questions`; everything else you decide yourself.",
              ]
            : []),
          "- Write each question as {\"question\": \"...\", \"options\": [\"...\"]}. Whenever the answer is a choice between concrete alternatives, LIST them in `options` so the user can just pick one; use an empty `options` array only for genuinely open-ended questions.",
        ]),
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
  roster?: Array<{ name: string; description?: string; provider: string; model?: string; capabilities: string[] }>,
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
        `- ${agent.name}: ${agent.provider}${agent.model ? `/${agent.model}` : ""} — capabilities: ${agent.capabilities.join(", ") || "none"}${agent.description ? ` — expertise: ${agent.description}` : ""}`,
      );
    }
  }
  return lines;
}

function renderStaffingRules(providers: string[], autoStaff = false): string[] {
  const lines = autoStaff
    ? [
        "",
        "## Staffing Rules",
        // No agent is registered yet, so the providers above are installed CLIs
        // the orchestrator will register on first use. Telling the leader it may
        // only use "the roster" here would leave it with nothing to staff at all.
        "- The providers above are installed on this machine but have no registered agent yet. The orchestrator registers one automatically the first time you staff them, so you may use any of them.",
        "- Stay within that provider list. A provider outside it cannot be launched and is rejected when the subtask is spawned.",
        "- Every subtask agentPreference is staffed for `implement`; every reviewer agentPreference for `review`.",
      ]
    : [
        "",
        "## Staffing Rules",
        // This is enforced, not advisory: the orchestrator resolves every
        // agentPreference against the user's registered, enabled agents first.
        // Saying so up front is cheaper than a plan that gets silently re-staffed.
        "- Staff from the roster above. It is the list of agents the user has enabled, and it is what the orchestrator resolves every agentPreference against.",
        "- Every subtask agentPreference MUST resolve to an agent whose capabilities include `implement`.",
        "- Every reviewer agentPreference MUST resolve to an agent whose capabilities include `review`.",
        "- Capabilities are enforced at spawn time. Never assign implement or review work to an agent missing that exact capability.",
        "- Do not invent a provider that is not listed: the list is the user's allowlist, and anything outside it is rejected at spawn time.",
      ];
  if (providers.length > 1) {
    lines.push(
      "- You are NOT limited to your own provider. Your own provider has no staffing preference or tie-break advantage.",
      "- Choose the best eligible agent for each job from its capabilities and expertise description; then use provider/model fit and quota diversity as secondary considerations.",
      "- In each `reason`, cite the selected agent's relevant expertise. If its expertise is not specified, do not invent strengths or default to your own provider.",
      "- Mix providers deliberately across subtasks and reviewers when their expertise fits.",
      "- Spread the load so no single provider's quota carries the whole project; if one provider does every subtask, that is a planning mistake.",
      "- Have a reviewer come from a different provider than the implementer whose work it reviews — a second vendor catches what the first one is blind to.",
      "- Still match the agent to the job: say in `reason` why that provider/model fits this subtask, not just that it was next in the rotation.",
    );
  }
  return lines;
}

// Replays the leader's own last planning turn. Framed as "yours" on purpose:
// a leader shown an unattributed plan treats it as someone else's proposal to
// audit and rewrites it wholesale, which costs the same tokens as planning
// from scratch and loses the reasoning that produced it.
function renderPlanLedgerSection(ledger: PlanLedgerInput): string[] {
  if (!ledger.previousPlanMarkdown && !ledger.askedQuestions.length) return [];
  const lines: string[] = [];
  if (ledger.previousPlanMarkdown) {
    lines.push(
      "",
      "## Your Previous Planning Draft",
      "",
      `This is YOUR OWN draft from planning round ${ledger.rounds}. It is the state of your thinking, not a proposal to audit — continue from it.`,
      "",
      ledger.previousPlanMarkdown,
    );
    if (ledger.previousComplexity) lines.push("", `You assessed complexity as: ${ledger.previousComplexity}.`);
    if (ledger.previousSubtaskTitles.length) {
      lines.push("", "Subtasks you had drafted:");
      for (const title of ledger.previousSubtaskTitles) lines.push(`- ${title}`);
    }
  }
  if (ledger.askedQuestions.length) {
    lines.push(
      "",
      "## Questions You Already Asked",
      "",
      "You raised these in earlier rounds. They are settled — answered above, or dismissed by the user. Asking any of them again, however reworded, restarts this cycle for nothing:",
    );
    for (const question of ledger.askedQuestions) lines.push(`- ${question}`);
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

// Every ruling this orchestration has already made, oldest first. Adjudication
// is otherwise stateless — each cycle sees only the reviews still pending — so
// a subtask that keeps failing the same way gets the same rework ordered again
// and again, and the cycle budget drains with nothing changing.
function renderDecisionLogSection(log: AdjudicationLedgerInput): string[] {
  const lines = ["", "## Decision Log (previous cycles)", "", "Rulings already made on this project:"];
  for (const entry of log) {
    lines.push(`- Cycle ${entry.cycle} (${entry.actor})${entry.projectComplete ? " — called the project complete" : ""}:`);
    if (!entry.decisions.length) lines.push("    (no decisions)");
    for (const decision of entry.decisions) {
      lines.push(`    - ${decision.subtaskKey}: ${decision.verdict}`);
      if (decision.reworkTitle) lines.push(`        rework ordered: ${decision.reworkTitle}`);
      if (decision.reworkGoal) lines.push(`        rework goal: ${decision.reworkGoal}`);
    }
  }
  return lines;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

// Questions this leader asked on an earlier turn and the user answered. They
// are decisions, not suggestions — the turn that asked stopped precisely to
// get them, so the turn that resumes has to act on them.
function renderAnswersSection(answers: Array<{ question: string; answer: string }>): string[] {
  const lines = ["", "## Answers To Your Questions", "", "Treat these as settled requirements:"];
  for (const entry of answers) lines.push(`- Q: ${entry.question}`, `  A: ${entry.answer}`);
  return lines;
}

// What the user typed when they approved a spawn. Not commentary: it is the
// condition they attached to their yes, and it applies from that point on.
function renderApprovalNotesSection(notes: Array<{ approved: string; note: string }>): string[] {
  const lines = [
    "",
    "## Instructions You Were Given When Approving",
    "",
    "The user wrote these while authorising the work, oldest first. They carry the same weight as an answer:",
  ];
  for (const entry of notes) lines.push(`- on "${entry.approved}": ${entry.note}`);
  return lines;
}

export function renderAdjudicatePrompt(input: {
  taskTitle: string;
  reviews: ReviewSummaryInput[];
  subtasks: SubtaskStatusInput[];
  cycle: number;
  maxCycles: number;
  availableProviders?: string[];
  providerModels?: Record<string, string[]>;
  autoStaff?: boolean;
  actor?: "leader" | "adjudicator";
  adjudicatorProposal?: string;
  // Decisions from earlier cycles, so this turn does not re-issue a rework it
  // already ordered.
  decisionLog?: AdjudicationLedgerInput;
  // Everything the user has answered, planning rounds included. An adjudicate
  // turn that blocked on a question used to never see the reply: the answer
  // only reached the plan prompt, so the leader came back here and re-decided
  // as if it had never asked.
  answers?: Array<{ question: string; answer: string }>;
  approvalNotes?: Array<{ approved: string; note: string }>;
}): string {
  const actor = input.actor ?? "leader";
  const lines = [
    actor === "leader" ? "# Leader Adjudication Turn" : "# Adjudicator Turn",
    "",
    `Task: ${input.taskTitle}`,
    // Counts rework rounds, not adjudications: an accept-only turn costs
    // nothing. Said plainly so the leader does not ration its decisions
    // against a budget it is not actually spending.
    `Rework cycle ${input.cycle} of at most ${input.maxCycles}. Only a rework decision advances this counter — accepting work costs nothing.`,
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
      ...renderStaffingRules(input.availableProviders, input.autoStaff),
    );
  }
  if (input.answers?.length) lines.push(...renderAnswersSection(input.answers));
  if (input.approvalNotes?.length) lines.push(...renderApprovalNotesSection(input.approvalNotes));
  if (input.decisionLog?.length) lines.push(...renderDecisionLogSection(input.decisionLog));
  lines.push("", "## Subtask Status");
  for (const subtask of input.subtasks) {
    const superseded = subtask.status === "cancelled";
    const stranded = subtask.strandedBy?.length
      ? ` (STRANDED — depends on ${subtask.strandedBy.join(", ")}, which will never complete; it can never be dispatched as it stands)`
      : "";
    const blocked =
      subtask.status === "blocked"
        ? " (BLOCKED — it produces no review and cannot be dispatched as it stands; only you can clear it)"
        : "";
    lines.push(`- [${subtask.status}] ${subtask.key}: ${subtask.title}${superseded ? " (superseded — no longer outstanding)" : ""}${stranded}${blocked}`);
    if (subtask.blockedReason) lines.push(`    blocked because: ${subtask.blockedReason}`);
    // A superseded subtask's criteria were re-issued on its replacement.
    // Repeating them here reads as a pile of unmet requirements and is enough
    // on its own to make the leader refuse to mark the project complete.
    if (superseded) continue;
    for (const criterion of subtask.acceptanceCriteria) lines.push(`    - criterion: ${criterion}`);
  }
  // Stranded and blocked subtasks are the same problem wearing two labels:
  // undispatchable, reviewless work that only an adjudication decision can
  // clear. Left out of this list the leader has nothing it is permitted to
  // decide on, returns an empty decisions array, and the run deadlocks.
  const stuck = input.subtasks.filter(
    (subtask) => subtask.strandedBy?.length || subtask.status === "blocked",
  );
  lines.push("", "## Reviews Awaiting Your Decision");
  if (!input.reviews.length) {
    // Without this the section is simply empty, and the leader reads that as
    // "something is missing" and refuses to finish. Say plainly that execution
    // is drained and the only question left is whether the work is done.
    lines.push(
      "None. Every review has already been adjudicated and there is no dispatchable work left.",
      ...(stuck.length
        ? [
            // Telling it to return nothing here is what deadlocks the run: the
            // stuck subtasks are precisely the work it must act on, and an
            // empty decisions array with projectComplete=false pauses the
            // orchestration with nothing for the user to act on either.
            `${stuck.length} subtask(s) above are STRANDED or BLOCKED. They are the outstanding work, and only you can clear them — decide each one below.`,
          ]
        : ["Return an empty `decisions` array and decide `projectComplete` on the subtask statuses above."]),
    );
  }
  for (const review of input.reviews) {
    lines.push(
      `- ${review.subtaskKey} (${review.subtaskTitle}): verdict=${review.verdict}${review.score != null ? ` score=${review.score}` : ""}`,
      `  summary: ${review.summary}`,
    );
    if (review.context) {
      lines.push(
        `  brief: \`${review.context.brief}\``,
        `  full review: \`${review.context.review}\``,
      );
      for (const prior of review.context.prior) lines.push(`  earlier round: \`${prior}\``);
      lines.push(`  write your decision to: \`${review.context.write}\``);
    } else {
      if (review.findings) lines.push(`  findings: ${review.findings}`);
      for (const prior of review.priorReviews ?? []) {
        lines.push(
          `  earlier review of this work — [${prior.verdict}] ${prior.subtaskTitle}: ${prior.summary}`,
        );
        if (prior.findings) lines.push(`      findings: ${prior.findings}`);
      }
    }
  }
  const contextual = input.reviews.filter((review) => review.context);
  if (contextual.length) {
    lines.push(
      "",
      "## Context Files",
      "Each file opens with `## Summary`; read that first and go on to `## Detail`",
      "only when the summary leaves the decision unclear. An `earlier round` file is",
      "how you tell a defect being reported for the third time from a fresh one —",
      "open them before you re-issue a rework.",
      "",
      "For every subtask you decide, write the decision file named above:",
      "",
      "```markdown",
      "# Adjudication — <subtask key> round <n>",
      "",
      "## Summary",
      "<verdict, and in one line why>",
      "",
      "## Detail",
      "<for a rework: exactly what must change, and what must be left alone>",
      "```",
      "",
      "An accepted subtask also needs its `summary.md` — see Your Job below.",
      "",
      ...WORKBOARD_BOUNDARY_LINES,
    );
  }
  const repeated = input.reviews.filter(
    (review) => review.priorReviews?.length || review.context?.prior.length,
  );
  // Anything not done and not cancelled blocks completion, whether or not it
  // ever produced a review. Naming these is what turns "projectComplete was
  // rejected" into something the leader can actually act on.
  const open = input.subtasks.filter((subtask) => !["done", "cancelled"].includes(subtask.status));
  lines.push(
    "",
    "## Your Job",
    ...(input.answers?.length || input.approvalNotes?.length
      ? [
          "- The user instructions above are their own words and they outrank your reading of the reviews. Carry them out in THIS turn's decisions, and never re-ask them.",
          "- If they tell you to stop, cut scope, or finish now regardless of outstanding defects, that is a decision you must execute here: accept or cancel whatever is left, name every unresolved defect in your decision files so the report carries it, and set `projectComplete` to true. Do not order more rework the user has ruled out, and do not park the run on another question to confirm what they already said.",
        ]
      : []),
    "- For each subtask with a pending review, decide accept, rework, or block.",
    "- Use rework when the acceptance criteria are not fully met yet; give the rework subtask a tight, specific goal so the next implementer doesn't redo finished work.",
    ...(contextual.length
      ? [
          `- Write the decision file for every subtask you decide. A decision whose file is missing or has an empty \`## Summary\` is rejected and the turn is retried.`,
          `- For every subtask you ACCEPT, also write its \`summary.md\` (${contextual.map((review) => `${review.subtaskKey} → \`${review.context!.summary}\``).join(", ")}): what changed, which files, decisions worth keeping, and the traps the next subtask should know about. Later subtasks read this file and nothing else from this one, so what you leave out is lost to them.`,
        ]
      : []),
    // The rework goal is not the implementer's whole brief — the reviewer's
    // findings are replayed to it verbatim. Telling the leader that stops it
    // trying to restate a review it can simply point at.
    "- A rework goal must name the specific defect to fix, not restate the subtask. The reviewer's findings are passed to the implementer verbatim, so point at them rather than re-summarising them.",
    ...(repeated.length
      ? [
          `- ${repeated.map((review) => review.subtaskKey).join(", ")} carries earlier reviews above. Compare them to the current one before deciding: if the same defect is still being reported, the previous rework instruction failed and repeating it will fail again.`,
          "- When a finding repeats, either write a materially different instruction that says exactly what to change (file, function, expected behaviour), or block it and ask the user. Do not re-issue the same rework in new words.",
        ]
      : []),
    "- Use block only when the subtask cannot proceed without user input; explain why in `questions`.",
    "- Use `drop` to cancel a subtask outright: the work is no longer wanted, or the user has told you to stop. A dropped subtask is closed for good and needs no review, no rework and no question — say in your decision file what is being left undone so the report carries it.",
    ...(open.length
      ? [
          `- \`projectComplete: true\` is REJECTED while any subtask is still open, and the turn comes straight back to you. ${open.length} are open now: ${open.map((subtask) => subtask.key).join(", ")}. To finish, give EVERY one of them a decision in this same turn — \`accept\` if its criteria are in fact met, \`rework\` if it must still be done, or \`drop\` if it will not be. Marking the project complete without deciding them is what loops the run.`,
        ]
      : []),
    "- Ignore [cancelled] subtasks: they were superseded by a later subtask and are not outstanding work.",
    "- Set projectComplete to true only when every subtask is accepted or cancelled and nothing more is needed.",
    ...(stuck.length
      ? [
          `- MANDATORY: give a decision for every STRANDED or BLOCKED subtask this turn (${stuck.map((subtask) => subtask.key).join(", ")}). They produce no review and cannot be dispatched, so they will never come back to you on their own — leaving them out deadlocks the project.`,
          "- For a stranded subtask, `rework` it into a self-contained replacement that does not need the dead dependency (state the whole job in the rework goal, since nothing upstream will have run), or `block` it and say in `questions` what you need from the user.",
          // "Block it again" is the one answer that changes nothing: the
          // subtask is already blocked, so a bare re-block returns the run to
          // this exact prompt. The question is what makes it a real handoff.
          "- For a blocked subtask, use the reason above: `rework` it into a version that avoids whatever stopped it (a smaller scope, a different approach, or a re-staffed agent via `agentPreference`), `accept` it if the criteria are in fact met, or `block` it — but a `block` MUST come with a specific question in `questions` naming what you need from the user. Re-blocking without a question leaves the project exactly where it is.",
          "- Do not leave a stranded or blocked subtask out because it looks unfixable. Saying so in `questions` is a decision; silence is not.",
        ]
      : []),
    ...(input.decisionLog?.length
      ? [
          "- The decision log above is yours. Do not re-issue a rework you already ordered: if the same subtask comes back with the same complaint, the rework instruction was not specific enough — either write a sharper one or block it for the user.",
          "- A subtask you have already sent back twice must not go round a third time. Accept it if the criteria are met, or block it and say what you need.",
        ]
      : []),
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
