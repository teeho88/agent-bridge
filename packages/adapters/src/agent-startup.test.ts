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

  it("tells Antigravity to start and compile task context", () => {
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
      tokenEstimate: 10,
      renderedMarkdown: "# Brief",
    });

    expect(JSON.stringify(artifact)).toContain("--agent antigravity");
    expect(JSON.stringify(artifact)).toContain(
      "context compile --agent antigravity",
    );
    expect(JSON.stringify(artifact)).toContain(
      "session start --agent antigravity",
    );
    expect(JSON.stringify(artifact)).toContain("agent-bridge file lease");
    expect(JSON.stringify(artifact)).toContain("acquired=true");
  });
});


