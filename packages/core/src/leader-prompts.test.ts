import { describe, expect, it } from "vitest";
import { renderAdjudicatePrompt, renderPlanPrompt } from "./leader-prompts.js";

describe("renderAdjudicatePrompt", () => {
  const base = {
    taskTitle: "Ship the game",
    cycle: 2,
    maxCycles: 8,
    reviews: [],
    subtasks: [
      {
        key: "s1",
        title: "Build the game",
        status: "cancelled",
        acceptanceCriteria: ["renders in 3D", "score increments"],
      },
      { key: "s2", title: "Add high score", status: "done", acceptanceCriteria: ["persists"] },
    ],
  };

  it("marks a superseded subtask and drops its criteria", () => {
    // Observed live: the leader saw a [cancelled] subtask followed by eight
    // unmet-looking criteria and returned projectComplete=false forever.
    const prompt = renderAdjudicatePrompt(base);

    expect(prompt).toContain("[cancelled] s1: Build the game (superseded — no longer outstanding)");
    expect(prompt).not.toContain("renders in 3D");
    expect(prompt).toContain("criterion: persists");
    expect(prompt).toContain("Ignore [cancelled] subtasks");
  });

  it("says so explicitly when no reviews are pending", () => {
    const prompt = renderAdjudicatePrompt(base);

    expect(prompt).toContain("None. Every review has already been adjudicated");
    expect(prompt).toContain("Return an empty `decisions` array");
  });

  it("demands a decision on stranded subtasks instead of telling the leader to return nothing", () => {
    // A subtask whose dependency was cancelled produces no review and can
    // never be dispatched, so it never reaches the leader on its own. Left
    // invisible it deadlocks the run: nothing to decide, and not complete
    // either.
    const prompt = renderAdjudicatePrompt({
      ...base,
      subtasks: [
        ...base.subtasks,
        { key: "s3", title: "Wire the UI", status: "todo", acceptanceCriteria: ["renders"], strandedBy: ["s1"] },
      ],
    });

    expect(prompt).toContain("[todo] s3: Wire the UI (STRANDED — depends on s1");
    expect(prompt).toContain("1 subtask(s) above are STRANDED or BLOCKED");
    // The empty-reviews shortcut is exactly what must NOT fire here.
    expect(prompt).not.toContain("Return an empty `decisions` array");
    expect(prompt).toContain("MANDATORY: give a decision for every STRANDED or BLOCKED subtask this turn (s3)");
  });

  it("demands a decision on a blocked subtask and says why it is blocked", () => {
    // A blocked subtask is undispatchable and reviewless exactly like a
    // stranded one, but nothing depends on it and nothing it depends on died —
    // so the stranding pass never sees it. Left out, the leader has nothing it
    // is allowed to decide and the run pauses on "should these be dropped?".
    const prompt = renderAdjudicatePrompt({
      ...base,
      subtasks: [
        ...base.subtasks,
        {
          key: "s3",
          title: "Make the router use its budget",
          status: "blocked",
          acceptanceCriteria: ["retries failed nets"],
          blockedReason: "reviewer blocked it — needs a decision on the rip-up strategy",
        },
      ],
    });

    expect(prompt).toContain("[blocked] s3: Make the router use its budget (BLOCKED");
    expect(prompt).toContain("blocked because: reviewer blocked it — needs a decision on the rip-up strategy");
    expect(prompt).toContain("1 subtask(s) above are STRANDED or BLOCKED");
    expect(prompt).not.toContain("Return an empty `decisions` array");
    expect(prompt).toContain("MANDATORY: give a decision for every STRANDED or BLOCKED subtask this turn (s3)");
    // Re-blocking with no question returns the run to this same prompt.
    expect(prompt).toContain("a `block` MUST come with a specific question");
  });

  it("still lists pending reviews normally", () => {
    const prompt = renderAdjudicatePrompt({
      ...base,
      reviews: [{ subtaskKey: "s2", subtaskTitle: "Add high score", verdict: "pass", score: 100, summary: "Good." }],
    });

    expect(prompt).not.toContain("None. Every review has already been adjudicated");
    expect(prompt).toContain("s2 (Add high score): verdict=pass score=100");
  });

  it("explains first-pass adjudication and includes an escalated proposal for the leader", () => {
    const firstPass = renderAdjudicatePrompt({ ...base, actor: "adjudicator" });
    expect(firstPass).toContain("# Adjudicator Turn");
    expect(firstPass).toContain("automatically escalated to the Leader");

    const leader = renderAdjudicatePrompt({
      ...base,
      actor: "leader",
      adjudicatorProposal: '```json\n{"projectComplete":true}\n```',
    });
    expect(leader).toContain("# First-pass Adjudicator Proposal");
    expect(leader).toContain('"projectComplete":true');
    expect(leader).toContain("you own the final decision");
  });
});

describe("renderPlanPrompt", () => {
  const base = { taskTitle: "Ship the game", maxParallel: 3, availableProviders: ["codex"] };

  it("renders a first-round plan prompt without revision context", () => {
    const prompt = renderPlanPrompt(base);

    expect(prompt).toContain("# Leader Planning Turn");
    expect(prompt).not.toContain("Change Request");
    expect(prompt).toContain('`complexity` must be exactly one of: "small", "medium", "large"');
  });

  it("renders a change request with what already exists", () => {
    const prompt = renderPlanPrompt({
      ...base,
      revision: {
        request: "Add sound effects.",
        previousPlan: "# Plan\n\n1. Build it.",
        previousReport: "# Report\n\nShipped.",
        previousSubtasks: [{ title: "Build it", status: "done" }],
        previousReviews: [{ subtaskTitle: "Build it", verdict: "pass", summary: "Solid." }],
      },
    });

    expect(prompt).toContain("# Leader Re-planning Turn (change request)");
    expect(prompt).toContain("Add sound effects.");
    expect(prompt).toContain("- [done] Build it");
    expect(prompt).toContain("Build it: pass — Solid.");
    expect(prompt).toContain("Shipped.");
    expect(prompt).toContain("Plan ONLY the work the change request needs.");
  });

  it("lists every offered provider with its models and tells the leader to mix them", () => {
    const prompt = renderPlanPrompt({
      ...base,
      availableProviders: ["codex", "claude"],
      providerModels: { codex: ["gpt-5.6-sol"], claude: ["claude-opus-5", "claude-sonnet-5"] },
      agentRoster: [
        { name: "builder", description: "Strong at TypeScript architecture and repository-scale refactors", provider: "codex", model: "gpt-5.6-sol", capabilities: ["implement"] },
        { name: "reviewer", provider: "claude", model: "claude-opus-5", capabilities: ["review"] },
      ],
    });

    expect(prompt).toContain("Available agent providers for this team: codex, claude.");
    expect(prompt).toContain("- codex — models: gpt-5.6-sol");
    expect(prompt).toContain("- claude — models: claude-opus-5, claude-sonnet-5");
    expect(prompt).toContain("builder: codex/gpt-5.6-sol — capabilities: implement");
    expect(prompt).toContain("expertise: Strong at TypeScript architecture and repository-scale refactors");
    expect(prompt).toContain("reviewer: claude/claude-opus-5 — capabilities: review");
    expect(prompt).toContain("subtask agentPreference MUST resolve to an agent whose capabilities include `implement`");
    expect(prompt).toContain("reviewer agentPreference MUST resolve to an agent whose capabilities include `review`");
    expect(prompt).toContain("You are NOT limited to your own provider.");
    expect(prompt).toContain("Your own provider has no staffing preference or tie-break advantage.");
    expect(prompt).toContain("Choose the best eligible agent for each job from its capabilities and expertise description");
    expect(prompt).toContain("If its expertise is not specified, do not invent strengths or default to your own provider.");
    expect(prompt).toContain("Have a reviewer come from a different provider");
  });

  it("keeps the roster-only rule but drops the mixing advice for a single provider", () => {
    const prompt = renderPlanPrompt({ ...base, availableProviders: ["codex"] });

    expect(prompt).toContain("Available agent providers for this team: codex.");
    // The roster is the allowlist, so its rule holds even when there is
    // nothing to mix; only the spread-the-load advice is pointless here.
    expect(prompt).toContain("Staff from the roster above.");
    expect(prompt).not.toContain("You are NOT limited to your own provider.");
  });

  it("tells the leader it may staff unregistered providers when auto-staffing is on", () => {
    const prompt = renderPlanPrompt({ ...base, agentRoster: [], autoStaff: true });

    expect(prompt).toContain("no registered agent yet");
    expect(prompt).toContain("registers one automatically the first time you staff them");
    // The roster rule would leave it with nothing to staff at all here.
    expect(prompt).not.toContain("Staff from the roster above.");
    // The provider list is still a boundary, even when the roster is empty.
    expect(prompt).toContain("Stay within that provider list.");
  });
});

describe("user directives in the adjudicate prompt", () => {
  const base = {
    taskTitle: "Ship the game",
    cycle: 2,
    maxCycles: 8,
    reviews: [],
    subtasks: [{ key: "s1", title: "Build the game", status: "review", acceptanceCriteria: ["renders"] }],
  };

  it("carries the user's answers into the turn that asked them", () => {
    // The answers only ever reached the plan prompt, so a leader that stopped
    // adjudication to ask something came back here having never been told.
    const prompt = renderAdjudicatePrompt({
      ...base,
      answers: [{ question: "Three defects survived two reworks — what now?", answer: "finish now, record them in the report" }],
    });

    expect(prompt).toContain("## Answers To Your Questions");
    expect(prompt).toContain("A: finish now, record them in the report");
    expect(prompt).toContain("outrank your reading of the reviews");
    expect(prompt).toContain("set `projectComplete` to true");
  });

  it("carries the note the user attached to an approval", () => {
    const prompt = renderAdjudicatePrompt({
      ...base,
      approvalNotes: [{ approved: "Escalate adjudication to the Leader", note: "accept what is left and stop" }],
    });

    expect(prompt).toContain("## Instructions You Were Given When Approving");
    expect(prompt).toContain('on "Escalate adjudication to the Leader": accept what is left and stop');
    expect(prompt).toContain("outrank your reading of the reviews");
  });

  it("says nothing about user instructions when there are none", () => {
    const prompt = renderAdjudicatePrompt(base);

    expect(prompt).not.toContain("## Answers To Your Questions");
    expect(prompt).not.toContain("## Instructions You Were Given When Approving");
    expect(prompt).not.toContain("outrank your reading of the reviews");
  });
});
