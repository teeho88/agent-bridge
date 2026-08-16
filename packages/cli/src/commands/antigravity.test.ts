import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_HOOK_VERSION,
  getAntigravityHookStatus,
  handleAntigravityHook,
  installAntigravityHooks,
  neutralizeHookOutput,
  runManagedAntigravity,
} from "./antigravity.js";
import { openStore, readConfig, startAgentSession } from "../workspace.js";

function writeTranscript(cwd: string, steps: Record<string, unknown>[]): string {
  const dir = join(cwd, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`, "utf8");
  return path;
}

function userInput(text: string): Record<string, unknown> {
  return {
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-09T22:30:41+07:00.\n</ADDITIONAL_METADATA>`,
  };
}

function plannerResponse(text: string): Record<string, unknown> {
  return { source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: text };
}

describe("Antigravity hooks", () => {
  beforeEach(() => {
    delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    delete process.env.AGENT_BRIDGE_SPAWNED_RUN;
    delete process.env.AGENT_BRIDGE_HOOK_JSON_B64;
  });

  afterEach(() => {
    delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    delete process.env.AGENT_BRIDGE_SPAWNED_RUN;
    delete process.env.AGENT_BRIDGE_HOOK_JSON_B64;
  });

  it("installs agy lifecycle hooks without dropping other named hooks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-"));
    try {
      mkdirSync(join(cwd, ".agents"), { recursive: true });
      writeFileSync(
        join(cwd, ".agents", "hooks.json"),
        JSON.stringify({ "lint-checker": { PostToolUse: [] } }),
        "utf8",
      );

      const output = installAntigravityHooks(cwd);

      const hooks = JSON.parse(readFileSync(join(cwd, ".agents", "hooks.json"), "utf8"));
      expect(hooks["lint-checker"]).toBeDefined();
      const preCommand = hooks["agent-bridge"].PreInvocation[0].command;
      const preToolCommand = hooks["agent-bridge"].PreToolUse[0].hooks[0].command;
      const postToolCommand = hooks["agent-bridge"].PostToolUse[0].hooks[0].command;
      const stopCommand = hooks["agent-bridge"].Stop[0].command;
      expect(preCommand).toContain("-EncodedCommand");
      expect(preToolCommand).toContain("-EncodedCommand");
      expect(postToolCommand).toContain("-EncodedCommand");
      expect(stopCommand).toContain("-EncodedCommand");
      expect(decodePowerShellCommand(preCommand)).toContain("agent-bridge-antigravity-hook.ps1' 'PreInvocation'");
      expect(decodePowerShellCommand(preToolCommand)).toContain("agent-bridge-antigravity-hook.ps1' 'PreToolUse'");
      expect(decodePowerShellCommand(postToolCommand)).toContain("agent-bridge-antigravity-hook.ps1' 'PostToolUse'");
      expect(decodePowerShellCommand(stopCommand)).toContain("agent-bridge-antigravity-hook.ps1' 'Stop'");
      expect(
        readFileSync(join(cwd, ".agents", "agent-bridge-antigravity-hook.ps1"), "utf8"),
      ).toContain("antigravity hook --event $args[0]");
      expect(getAntigravityHookStatus(cwd)).toMatchObject({
        installed: true,
        current: true,
        expectedVersion: ANTIGRAVITY_HOOK_VERSION,
      });
      expect(output.join("\n")).toContain("agent-bridge antigravity run");

      // Without this file agy follows the codex-facing AGENTS.md and registers
      // its work as codex, which is what broke the Work Board actions.
      const rules = readFileSync(join(cwd, ".agents", "rules", "agent-bridge.md"), "utf8");
      expect(rules).toMatch(/^---\r?\ntrigger: always_on\r?\ndescription:/);
      expect(rules).toContain("agent-bridge memory add \"<important fact or decision>\" --type note --agent antigravity");
      expect(rules).toContain("not codex");
      // The hooks own the lifecycle; a second, self-started session would show
      // up as a duplicate live task on the Work Board.
      expect(rules).toContain("Do **not** run `agent-bridge session start`");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports a stale hooks.json version as outdated", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-"));
    try {
      installAntigravityHooks(cwd);
      const hooksPath = join(cwd, ".agents", "hooks.json");
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
      hooks["agent-bridge"].version = "1999-01-01.old.v0";
      writeFileSync(hooksPath, JSON.stringify(hooks), "utf8");

      const status = getAntigravityHookStatus(cwd);
      expect(status.installed).toBe(true);
      expect(status.current).toBe(false);
      expect(status.installedVersion).toBe("1999-01-01.old.v0");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("puts a manually started agy conversation on the Work Board", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Wire agy into the work board")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-a", transcriptPath, invocationNum: 1 },
        "PreInvocation",
      );

      writeTranscript(cwd, [
        userInput("Wire agy into the work board"),
        plannerResponse("Installed the hooks and verified the session events."),
      ]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-a", transcriptPath, executionNum: 1 },
        "Stop",
      );

      const store = openStore(cwd);
      try {
        const active = store.listActiveSessionEvents();
        expect(active).toHaveLength(1);
        expect(active[0]?.agent).toBe("antigravity");

        const tasks = store.listTasks(10);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.title).toBe("Wire agy into the work board");
        expect(tasks[0]?.status).toBe("in_progress");

        const latest = store
          .listMemoriesForTask(tasks[0]!.id, 20)
          .filter((memory) => memory.tags.includes("latest-response"));
        expect(latest).toHaveLength(1);
        expect(latest[0]?.content).toContain("Installed the hooks and verified the session events.");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps one task per conversation and closes the previous one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("First conversation")]);
      handleAntigravityHook({ workspacePaths: [cwd], conversationId: "conv-a", transcriptPath }, "PreInvocation");
      handleAntigravityHook({ workspacePaths: [cwd], conversationId: "conv-a", transcriptPath }, "PreInvocation");
      handleAntigravityHook({ workspacePaths: [cwd], conversationId: "conv-a", transcriptPath }, "Stop");

      writeTranscript(cwd, [userInput("Second conversation")]);
      handleAntigravityHook({ workspacePaths: [cwd], conversationId: "conv-b", transcriptPath }, "PreInvocation");

      const store = openStore(cwd);
      try {
        expect(store.listTasks(10)).toHaveLength(2);
        const active = store.listActiveSessionEvents();
        expect(active).toHaveLength(1);
        expect(active[0]?.sessionId).toBe("conv-b");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes launcher terminal hook updates into the launcher task and session", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-launcher-"));
    const previous = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    try {
      const store = openStore(cwd);
      const task = store.createTask({ title: "Antigravity terminal", ownerAgent: "antigravity" });
      store.recordSessionEvent({
        sessionId: "antigravity-terminal-1",
        taskId: task.id,
        agent: "antigravity",
        kind: "session_started",
      });
      store.close();
      startAgentSession("antigravity-terminal-1", task.id, cwd, "antigravity");
      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = "antigravity-terminal-1";
      const transcriptPath = writeTranscript(cwd, [
        userInput("Show this on the launcher card"),
        plannerResponse("Launcher card received the Antigravity response."),
      ]);

      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "native-conversation", transcriptPath },
        "PreInvocation",
      );
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "native-conversation", transcriptPath },
        "Stop",
      );

      const finalStore = openStore(cwd);
      try {
        expect(finalStore.listTasks(10)).toHaveLength(1);
        expect(finalStore.listSessionEvents({ taskId: task.id, limit: 10 }).every(
          (event) => event.sessionId === "antigravity-terminal-1",
        )).toBe(true);
        expect(finalStore.listMemoriesForTask(task.id, 10).find(
          (memory) => memory.tags.includes("latest-response"),
        )?.content).toContain("Launcher card received the Antigravity response.");
      } finally {
        finalStore.close();
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
      else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a launcher terminal on its own card instead of adopting another agent's task", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-adopt-"));
    const previous = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    try {
      const store = openStore(cwd);
      const claudeTask = store.createTask({
        title: "Refactor the workboard session adapter",
        goal: "Refactor the workboard session adapter registry",
        ownerAgent: "claude",
      });
      store.createHandoff({
        taskId: claudeTask.id,
        fromAgent: "claude",
        summary: "Refactor the workboard session adapter registry so far.",
        next: ["Finish the workboard adapter registry refactor"],
      });
      const terminalTask = store.createTask({
        title: "Antigravity terminal",
        ownerAgent: "antigravity",
      });
      store.close();
      startAgentSession("antigravity-terminal-2", terminalTask.id, cwd, "antigravity");
      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = "antigravity-terminal-2";
      const transcriptPath = writeTranscript(cwd, [
        userInput("tiep tuc refactor the workboard session adapter registry"),
      ]);

      handleAntigravityHook({ workspacePaths: [cwd], transcriptPath }, "PreInvocation");

      const finalStore = openStore(cwd);
      try {
        expect(readConfig(cwd).sessionTasks?.["antigravity-terminal-2"]).toBe(terminalTask.id);
        expect(readConfig(cwd).currentTasks?.antigravity).toBe(terminalTask.id);
        expect(
          finalStore.listSessionEvents({ taskId: claudeTask.id, limit: 10 }),
        ).toHaveLength(0);
      } finally {
        finalStore.close();
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
      else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tracks a managed agy process on the Work Board for its lifetime", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-managed-"));
    try {
      let observedActiveSession = false;
      const exitCode = runManagedAntigravity(cwd, ["--version"], (args, processCwd) => {
        expect(args).toEqual(["--version"]);
        expect(processCwd).toBe(cwd);
        const store = openStore(cwd);
        try {
          const active = store.listActiveSessionEvents();
          expect(active).toHaveLength(1);
          expect(active[0]?.agent).toBe("antigravity");
          observedActiveSession = true;
        } finally {
          store.close();
        }
        return 7;
      });

      expect(exitCode).toBe(7);
      expect(observedActiveSession).toBe(true);
      const store = openStore(cwd);
      try {
        expect(store.listActiveSessionEvents()).toHaveLength(0);
        expect(store.listTasks(10)[0]?.status).toBe("in_progress");
      } finally {
        store.close();
      }
      expect(readConfig(cwd).currentTaskId).toBeNull();
      expect(readConfig(cwd).currentTasks?.antigravity).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates a question request when ask_question tool is called", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-question-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Help me set up database")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-q", transcriptPath },
        "PreInvocation",
      );

      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-q",
          transcriptPath,
          toolCall: {
            name: "ask_question",
            args: {
              questions: [
                {
                  question: "Which database would you like to use?",
                  options: ["PostgreSQL", "SQLite", "MySQL"],
                },
              ],
            },
          },
        },
        "PreToolUse",
      );

      const store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending", limit: 10 });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agent).toBe("antigravity");
        expect(requests[0]?.type).toBe("question");
        expect(requests[0]?.title).toContain("Which database would you like to use?");
        expect(requests[0]?.payload).toContain("Tool:\nask_question");
        expect(requests[0]?.payload).toContain("PostgreSQL, SQLite, MySQL");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("answers every PreToolUse call with a decision agy accepts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-decision-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Run the test suite")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-dec", transcriptPath },
        "PreInvocation",
      );

      const command = handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-dec",
          transcriptPath,
          toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
        },
        "PreToolUse",
      );
      const question = handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-dec",
          transcriptPath,
          toolCall: { name: "ask_question", args: { question: "Which database?" } },
        },
        "PreToolUse",
      );

      // A gated tool goes through agy's own confirmation; asking the user a
      // question was never gated, so it stays unprompted.
      expect(command?.decision).toBe("ask");
      expect(command?.reason).toContain("npm test");
      expect(question?.decision).toBe("allow");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never leaves a PreToolUse reply without a decision", () => {
    // The hook stays read-only for orchestrator-spawned runs, and a body with
    // no decision is how agy is told to refuse the tool call.
    process.env.AGENT_BRIDGE_SPAWNED_RUN = "1";
    expect(neutralizeHookOutput(undefined, "PreToolUse")).toEqual({ decision: "allow" });
    expect(neutralizeHookOutput(undefined, "Stop")).toEqual({});
    expect(neutralizeHookOutput({ decision: "ask" }, "PreToolUse")).toEqual({ decision: "ask" });
  });

  it("creates an approval request when ask_question contains permission keywords", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-approval-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Apply database migrations")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-app", transcriptPath },
        "PreInvocation",
      );

      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-app",
          transcriptPath,
          toolCall: {
            name: "ask_question",
            args: {
              questions: [
                {
                  question: "Please confirm and approve running migration against production db?",
                  options: ["Approve", "Deny"],
                },
              ],
            },
          },
        },
        "PreToolUse",
      );

      const store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending", limit: 10 });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agent).toBe("antigravity");
        expect(requests[0]?.type).toBe("approval");
        expect(requests[0]?.title).toContain("Please confirm and approve running");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates a command request when run_command tool is called and resolves it on PostToolUse", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-cmd-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Run test suite")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-cmd", transcriptPath },
        "PreInvocation",
      );

      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-cmd",
          transcriptPath,
          toolCall: {
            name: "run_command",
            args: {
              CommandLine: "npm test",
              Cwd: cwd,
            },
          },
        },
        "PreToolUse",
      );

      const store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending", limit: 10 });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agent).toBe("antigravity");
        expect(requests[0]?.type).toBe("command");
        expect(requests[0]?.title).toContain("npm test");
        expect(requests[0]?.payload).toContain("Tool:\nrun_command");
        expect(requests[0]?.payload).toContain("npm test");
      } finally {
        store.close();
      }

      // Simulate successful tool execution
      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-cmd",
          transcriptPath,
          toolCall: {
            name: "run_command",
          },
        },
        "PostToolUse",
      );

      const storeAfter = openStore(cwd);
      try {
        const pending = storeAfter.listAgentRequests({ status: "pending", limit: 10 });
        expect(pending).toHaveLength(0);
        const resolved = storeAfter.listAgentRequests({ status: "accepted", limit: 10 });
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.status).toBe("accepted");
        expect(resolved[0]?.response).toContain("run_command completed");
      } finally {
        storeAfter.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolves tool request as rejected when PostToolUse receives error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-agy-err-"));
    try {
      const transcriptPath = writeTranscript(cwd, [userInput("Run failing script")]);
      handleAntigravityHook(
        { workspacePaths: [cwd], conversationId: "conv-err", transcriptPath },
        "PreInvocation",
      );

      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-err",
          transcriptPath,
          toolCall: {
            name: "run_command",
            args: { CommandLine: "exit 1" },
          },
        },
        "PreToolUse",
      );

      handleAntigravityHook(
        {
          workspacePaths: [cwd],
          conversationId: "conv-err",
          transcriptPath,
          toolCall: { name: "run_command" },
          error: "Permission denied by user",
        },
        "PostToolUse",
      );

      const store = openStore(cwd);
      try {
        const resolved = store.listAgentRequests({ status: "rejected", limit: 10 });
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.status).toBe("rejected");
        expect(resolved[0]?.response).toContain("Permission denied by user");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}
