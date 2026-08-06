import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSpawnPreview, renderInvocationPrompt } from "./invocation.js";
import type { RegisteredAgent } from "@agent-bridge/memory";

// agy takes its prompt as an argv string, so its preview reads the artifact
// off disk instead of just referencing the path.
const promptDir = mkdtempSync(join(tmpdir(), "agent-bridge-prompt-"));
function promptFile(contents: string, name = "assignment.md"): string {
  const path = join(promptDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}
afterAll(() => rmSync(promptDir, { recursive: true, force: true }));

function registeredAgent(input: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: "agent-1",
    name: "codex-cli",
    provider: "codex",
    mode: "cli",
    command: "codex",
    capabilities: [],
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("agent invocation previews", () => {
  it("builds a configured Codex CLI spawn preview without executing it", () => {
    const preview = buildSpawnPreview(registeredAgent(), ".agent-memory/artifacts/assignments/a.md", "C:/repo");

    expect(preview).toMatchObject({
      adapter: "codex",
      mode: "cli",
      executable: "codex",
      args: ["exec", "--sandbox", "workspace-write", "-"],
      stdinFilePath: ".agent-memory/artifacts/assignments/a.md",
      command: "codex exec --sandbox workspace-write -",
    });
    expect(preview.description).toContain("Approval is required");
  });

  it("never grants codex full disk access, only workspace writes", () => {
    // read-only (the codex default) makes every implementer a no-op;
    // danger-full-access would let it write outside the project.
    const preview = buildSpawnPreview(registeredAgent(), "a.md", "C:/repo");
    expect(preview.args).toContain("workspace-write");
    expect(preview.args).not.toContain("danger-full-access");
    expect(preview.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("falls back to the provider's default CLI binary, never the display name, when command is blank", () => {
    const preview = buildSpawnPreview(
      registeredAgent({ name: "leader", provider: "claude", command: undefined }),
      "assignment.md",
      "C:/repo",
    );
    expect(preview.executable).toBe("claude");
  });

  it("passes model and effort to Claude Code, unattended and streaming live progress", () => {
    const preview = buildSpawnPreview(registeredAgent({ provider: "claude", command: "claude", model: "opus", reasoningEffort: "high" }), "assignment.md", "C:/repo");
    expect(preview).toMatchObject({
      args: ["--print", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--model", "opus", "--effort", "high"],
      stdinFilePath: "assignment.md",
    });
  });

  it("builds an unattended agy spawn preview with the prompt inline, not on stdin", () => {
    const artifact = promptFile("# Leader Planning Turn\n\nDo the thing.\n");
    const preview = buildSpawnPreview(
      registeredAgent({ provider: "antigravity", command: "agy", model: "gemini-3.1-pro-high", reasoningEffort: "high" }),
      artifact,
      "C:/repo",
    );
    expect(preview).toMatchObject({
      adapter: "antigravity",
      executable: "agy",
      args: [
        "--dangerously-skip-permissions",
        // The 5-minute --print-timeout default would cut a long implementer
        // turn off mid-edit.
        "--print-timeout",
        "60m",
        "--add-dir",
        "C:/repo",
        "--model",
        "gemini-3.1-pro-high",
        "--effort",
        "high",
        // Without this the log stays at 0 bytes for the whole run: plain --print
        // text is buffered until the process exits.
        "--output-format",
        "stream-json",
        // --print takes the prompt as its VALUE, so it must sit immediately
        // before it: any flag in that slot silently becomes the prompt.
        "--print",
        "# Leader Planning Turn\n\nDo the thing.\n",
      ],
    });
    expect(preview.args?.at(-2)).toBe("--print");
    // `agy --print` ignores stdin: piping the prompt in makes it answer an
    // unrelated default question instead.
    expect(preview.stdinFilePath).toBeUndefined();
    // The preview string stays readable — flags, not the whole turn.
    expect(preview.command).not.toContain("Do the thing");
    expect(preview.command).toContain(artifact);
  });

  it("runs agy even when the agent row still names the IDE launcher", () => {
    // Agents registered before the provider's command was corrected carry
    // command: "antigravity", which is not on PATH at all — every spawn of one
    // failed instantly with "spawn antigravity ENOENT".
    const preview = buildSpawnPreview(
      registeredAgent({ provider: "antigravity", command: "antigravity" }),
      promptFile("do it", "stale.md"),
      "C:/repo",
    );
    expect(preview.executable).toBe("agy");
  });

  it("keeps an explicit path to an antigravity binary instead of second-guessing it", () => {
    const preview = buildSpawnPreview(
      registeredAgent({ provider: "antigravity", command: "C:/tools/antigravity.exe" }),
      promptFile("do it", "explicit.md"),
      "C:/repo",
    );
    expect(preview.executable).toBe("C:/tools/antigravity.exe");
  });

  it("drops a reasoning effort agy would reject rather than failing the whole invocation", () => {
    const preview = buildSpawnPreview(
      registeredAgent({ provider: "antigravity", command: "agy", model: "gemini-3.1-pro-high", reasoningEffort: "xhigh" }),
      promptFile("do it", "xhigh.md"),
      "C:/repo",
    );
    // --effort takes low|medium|high only; codex's xhigh on a retuned agent
    // record would otherwise make the CLI reject the run outright.
    expect(preview.args).not.toContain("--effort");
    expect(preview.args).not.toContain("xhigh");
  });

  it("refuses an agy prompt too long for a Windows command line, naming the real limit", () => {
    expect(() =>
      buildSpawnPreview(
        registeredAgent({ provider: "antigravity", command: "agy" }),
        promptFile("x".repeat(40_000), "huge.md"),
        "C:/repo",
      ),
    ).toThrow(/command-line argument/);
  });

  it("describes API invocations using credential refs, not raw secrets", () => {
    const preview = buildSpawnPreview(
      registeredAgent({
        provider: "deepseek",
        mode: "api",
        model: "deepseek-chat",
        credentialRef: "credential-1",
      }),
      "assignment.md",
      "C:/repo",
    );

    expect(preview.command).toBeUndefined();
    expect(preview.description).toContain("credential-1");
    expect(preview.description).not.toContain("sk-");
  });

  it("renders an assignment prompt with return contract", () => {
    const prompt = renderInvocationPrompt({
      assignmentId: "assignment-1",
      taskTitle: "Build workforce",
      subtaskTitle: "Implement spawn approval",
      roleName: "implementer",
      agentName: "codex-cli",
      prompt: "Wire approval request creation.",
      acceptanceCriteria: ["No command is executed before approval"],
    });

    expect(prompt).toContain("Assignment: assignment-1");
    expect(prompt).toContain("Subtask: Implement spawn approval");
    expect(prompt).toContain("No command is executed before approval");
    expect(prompt).toContain("Do not expose raw API keys");
  });
});
