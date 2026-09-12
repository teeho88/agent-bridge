import { describe, expect, it } from "vitest";
import { antigravityArtifact } from "./antigravity.js";
import { codexManagedSection } from "./codex.js";

describe("agent startup prompts", () => {
  it("tells Codex to start a task only when none exists", () => {
    const prompt = codexManagedSection();
    expect(prompt).toContain("Agent Startup Rules");
    expect(prompt).toContain(
      'agent-bridge task start --agent codex',
    );
    expect(prompt).not.toContain("this session is starting an unrelated user task");
    expect(prompt).toContain(
      "Do not start a new task just because the user sends a new prompt inside an active task/session",
    );
    expect(prompt).toContain("agent-bridge context compile --agent codex");
    expect(prompt).toContain("agent-bridge session start --agent codex");
    expect(prompt).toContain("Runtime Goal Rules");
    expect(prompt).toContain("Create a goal with `create_goal`");
    const taskSection = prompt.indexOf("  TASK\n");
    const goalSection = prompt.indexOf("  GOAL\n", taskSection);
    const constraintsSection = prompt.indexOf("  CONSTRAINTS\n", goalSection);
    const successSection = prompt.indexOf("  SUCCESS CRITERIA\n", constraintsSection);
    expect(taskSection).toBeGreaterThan(-1);
    expect(goalSection).toBeGreaterThan(taskSection);
    expect(constraintsSection).toBeGreaterThan(goalSection);
    expect(successSection).toBeGreaterThan(constraintsSection);
    expect(prompt).toContain("Fill every section with concrete task-specific content");
    expect(prompt).toContain("Objective checks that prove completion");
    expect(prompt).toContain('not vague claims such as\n  "works correctly"');
    expect(prompt).toContain('--goal "<full runtime goal>"');
    expect(prompt).toContain("must not equal or repeat the goal");
    expect(prompt).toContain("Leave the runtime goal as `none`");
    expect(prompt).toContain("questions, explanations, plan-only");
    expect(prompt).toContain("requests, and other response-only work");
    expect(prompt).toContain("--clear-goal");
    expect(prompt).toContain("Handoffs include `task.goal` automatically");
    expect(prompt).toContain("never shorten the goal for a handoff");
    expect(prompt).toContain("Do not set a token budget unless the user explicitly gives one");
    expect(prompt).toContain("agent-bridge graph brief-auto");
    expect(prompt).toContain("agent-bridge file lease");
    expect(prompt).toContain("\"acquired\": true");
  });

  it("tells Antigravity to use its own agent name and leave the lifecycle to the hooks", () => {
    const artifact = antigravityArtifact({
      agent: "antigravity",
      task: { id: "task-1", title: "Fix auth", status: "in_progress" },
      currentState: [],
      sharedMemory: [],
      relevantFiles: [],
      knownDecisions: [],
      constraints: [],
      nextActions: ["Inspect auth"],
      risks: [],
      omitted: {
        currentState: 0,
        sharedMemory: 0,
        relevantFiles: 0,
        repoMap: 0,
        handoff: 0,
        constraints: 0,
        knownDecisions: 0,
      },
      tokenEstimate: 10,
      renderedMarkdown: "# Brief",
    });

    const json = JSON.stringify(artifact);
    expect(json).toContain("--agent antigravity");
    expect(json).toContain("context compile --agent antigravity");
    // AGENTS.md is codex-facing; without this reminder agy copies its
    // `--agent codex` examples and its work lands on the board as codex.
    expect(json).toContain("wherever it says --agent codex, use --agent antigravity");
    // .agents/hooks.json opens the task and the session, so agy starting its
    // own would duplicate both.
    expect(json).toContain("do not run task start, session start, or session end");
    expect(json).toContain("agent-bridge file lease");
    expect(json).toContain("acquired=true");
  });
});


