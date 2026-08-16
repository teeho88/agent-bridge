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


