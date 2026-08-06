import { describe, expect, it } from "vitest";
import { buildRetryPrompt, extractJsonBlock, parseLeaderTurn } from "./leader-contract.js";

const validPlan = {
  version: 1,
  phase: "plan",
  complexity: "medium",
  planMarkdown: "# Plan\n\n1. Do the thing.",
  subtasks: [
    {
      key: "s1",
      title: "Implement the thing",
      acceptanceCriteria: ["tests pass"],
      agentPreference: { provider: "codex", mode: "cli", model: "gpt-5.6", reasoningEffort: "high" },
    },
  ],
  reviewers: [{ key: "r1", scope: ["s1"], role: "reviewer" }],
  questions: [],
};

function fenced(obj: unknown): string {
  return `Here is my plan:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

describe("extractJsonBlock", () => {
  it("extracts a fenced json block", () => {
    expect(extractJsonBlock(fenced({ a: 1 }))).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("falls back to the outermost braces when there is no fence", () => {
    const text = 'prose before {"a":1} prose after';
    expect(extractJsonBlock(text)).toBe('{"a":1}');
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractJsonBlock("just prose, no json here")).toBeUndefined();
  });

  it("extracts the whole block even when a string value has its own nested ``` fence", () => {
    // A real leader reply legitimately embeds a ```js code sample inside
    // planMarkdown — a lazy first-``` match truncates the JSON right there.
    const obj = { a: 1, note: "before\n```js\nconst x = 1;\n```\nafter" };
    expect(extractJsonBlock(fenced(obj))).toBe(JSON.stringify(obj, null, 2));
  });

  it("prefers the last fenced block when the log also echoes earlier ones", () => {
    // The codex CLI writes the whole prompt to stdout before the answer, and
    // our plan prompt embeds a ```json schema example — so the first fence in
    // a real run log is never the reply.
    const text = `${fenced({ a: "example" })}\ntokens used\n1234\n${fenced({ a: "reply" })}`;
    expect(extractJsonBlock(text)).toBe(JSON.stringify({ a: "reply" }, null, 2));
  });
});

describe("parseLeaderTurn (plan)", () => {
  it("parses a well-formed plan turn", () => {
    const result = parseLeaderTurn(fenced(validPlan), "plan");
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "plan") {
      expect(result.turn.complexity).toBe("medium");
      expect(result.turn.subtasks).toHaveLength(1);
      expect(result.turn.subtasks[0]?.agentPreference?.model).toBe("gpt-5.6");
      expect(result.turn.reviewers[0]?.scope).toEqual(["s1"]);
    }
  });

  it("parses the reply out of a codex log that echoes the prompt and its schema example", () => {
    // Shape of a real codex run log: banner, the echoed prompt (which embeds
    // the ```json schema example), the echoed retry prompt with a second copy
    // of it, then the actual reply last. Anchoring on the first fence used to
    // stall every orchestration at `planning`.
    const schemaExample = { version: 1, phase: "plan", complexity: "medium", planMarkdown: "# Plan\n\n1. ...", subtasks: [{ key: "s1", title: "..." }], reviewers: [], questions: [] };
    const log = [
      "OpenAI Codex v0.145.0\n--------\nmodel: gpt-5.6-sol\n--------",
      "user\n# Leader Planning Turn",
      "Reply with EXACTLY one fenced ```json block and nothing else outside it:",
      fenced(schemaExample),
      "Reply again with ONLY a single fenced ```json block matching the schema.",
      fenced(schemaExample),
      "tokens used\n19,244",
      fenced(validPlan),
    ].join("\n");

    const result = parseLeaderTurn(log, "plan");
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "plan") {
      expect(result.turn.subtasks[0]?.title).toBe("Implement the thing");
      expect(result.turn.reviewers[0]?.scope).toEqual(["s1"]);
    }
  });

  it("fails instead of silently planning from the echoed schema example", () => {
    // If the actual reply is malformed we must retry the leader — falling back
    // to an earlier fence would build the whole project from placeholders.
    const log = `${fenced(validPlan)}\n\`\`\`json\n{ "phase": "plan", broken\n\`\`\``;
    const result = parseLeaderTurn(log, "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not parse");
  });

  it("accepts complexity synonyms the leader actually emits", () => {
    // Observed live: codex answered "low" twice in a row, even after the retry
    // prompt quoted the enum error. complexity is a display label, so a synonym
    // must not throw away an otherwise valid plan.
    for (const [written, expected] of [["low", "small"], ["High", "large"], [" Moderate ", "medium"]]) {
      const result = parseLeaderTurn(fenced({ ...validPlan, complexity: written }), "plan");
      expect(result.ok, `complexity "${written}" should parse`).toBe(true);
      if (result.ok && result.turn.phase === "plan") expect(result.turn.complexity).toBe(expected);
    }
  });

  it("still rejects a complexity it cannot map", () => {
    const result = parseLeaderTurn(fenced({ ...validPlan, complexity: "banana" }), "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"complexity"');
  });

  it("parses questions with options, and plain strings for open-ended ones", () => {
    const result = parseLeaderTurn(fenced({
      ...validPlan,
      questions: [
        { question: "Do destroyed pipes score?", options: ["Yes, one point", "No points"] },
        { question: "Anything else to watch out for?" },
        "How long should the effect last?",
        { options: ["orphan option with no question"] },
      ],
    }), "plan");

    expect(result.ok).toBe(true);
    if (!result.ok || result.turn.phase !== "plan") return;
    expect(result.turn.questions).toEqual([
      { question: "Do destroyed pipes score?", options: ["Yes, one point", "No points"] },
      { question: "Anything else to watch out for?", options: [] },
      { question: "How long should the effect last?", options: [] },
    ]);
  });

  it("rejects text with no JSON block", () => {
    const result = parseLeaderTurn("I looked at the code and here's my plan in prose.", "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No JSON found");
  });

  it("rejects malformed JSON", () => {
    const result = parseLeaderTurn("```json\n{ not valid json\n```", "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not parse");
  });

  it("rejects a mismatched phase", () => {
    const result = parseLeaderTurn(fenced({ ...validPlan, phase: "adjudicate" }), "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Expected "phase": "plan"');
  });

  it("accepts an empty subtasks array and leaves the meaning to the orchestrator", () => {
    // On a re-plan the leader may correctly conclude there is nothing left to
    // build. Whether that is an answer or a failure depends on whether work
    // already exists, which this layer cannot see.
    const result = parseLeaderTurn(fenced({ ...validPlan, subtasks: [], reviewers: [] }), "plan");
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "plan") expect(result.turn.subtasks).toEqual([]);
  });

  it("rejects subtasks that are not an array at all", () => {
    const result = parseLeaderTurn(fenced({ ...validPlan, subtasks: "s1" }), "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("subtasks");
  });

  it("rejects a reviewer scope referencing an unknown subtask key", () => {
    const result = parseLeaderTurn(
      fenced({ ...validPlan, reviewers: [{ key: "r1", scope: ["does-not-exist"] }] }),
      "plan",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown subtask key");
  });

  it("rejects an invalid agentPreference.mode", () => {
    const badPlan = {
      ...validPlan,
      subtasks: [{ ...validPlan.subtasks[0], agentPreference: { provider: "codex", mode: "invalid-mode" } }],
    };
    const result = parseLeaderTurn(fenced(badPlan), "plan");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agentPreference.mode");
  });
});

describe("parseLeaderTurn (adjudicate)", () => {
  const validAdjudicate = {
    version: 1,
    phase: "adjudicate",
    decisions: [{ subtaskKey: "s1", verdict: "accept" }],
    projectComplete: false,
    questions: [],
  };

  it("parses accept/block decisions without a rework block", () => {
    const result = parseLeaderTurn(fenced(validAdjudicate), "adjudicate");
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "adjudicate") {
      expect(result.turn.decisions[0]?.verdict).toBe("accept");
      expect(result.turn.decisions[0]?.rework).toBeUndefined();
    }
  });

  it("requires a rework block when verdict is rework", () => {
    const result = parseLeaderTurn(
      fenced({ ...validAdjudicate, decisions: [{ subtaskKey: "s1", verdict: "rework" }] }),
      "adjudicate",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rework is required");
  });

  it("parses a full rework decision with an agent preference", () => {
    const result = parseLeaderTurn(
      fenced({
        ...validAdjudicate,
        decisions: [
          {
            subtaskKey: "s1",
            verdict: "rework",
            rework: {
              title: "Fix the bug",
              acceptanceCriteria: ["bug is fixed"],
              agentPreference: { provider: "codex", model: "gpt-5.6" },
            },
          },
        ],
      }),
      "adjudicate",
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "adjudicate") {
      expect(result.turn.decisions[0]?.rework?.title).toBe("Fix the bug");
      expect(result.turn.decisions[0]?.rework?.agentPreference?.model).toBe("gpt-5.6");
    }
  });

  it("accepts an empty decisions array when there is nothing pending to decide", () => {
    // The orchestrator also adjudicates when execution simply ran out of work;
    // there are no reviews to rule on then, and projectComplete carries the
    // answer. Observed live: codex returned [] twice and the run was paused.
    const result = parseLeaderTurn(fenced({ ...validAdjudicate, decisions: [], projectComplete: true }), "adjudicate");
    expect(result.ok).toBe(true);
    if (result.ok && result.turn.phase === "adjudicate") {
      expect(result.turn.decisions).toEqual([]);
      expect(result.turn.projectComplete).toBe(true);
    }
  });

  it("rejects a non-boolean projectComplete", () => {
    const result = parseLeaderTurn(fenced({ ...validAdjudicate, projectComplete: "yes" }), "adjudicate");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("projectComplete");
  });
});

describe("buildRetryPrompt", () => {
  it("embeds the parse error and asks for a json-only reply", () => {
    const prompt = buildRetryPrompt('subtasks[0].title must be a non-empty string.');
    expect(prompt).toContain("subtasks[0].title");
    expect(prompt).toContain("ONLY a single fenced");
  });
});
