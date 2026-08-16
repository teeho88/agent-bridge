import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_HOOK_VERSION,
  getAntigravityHookStatus,
  handleAntigravityHook,
  installAntigravityHooks,
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
      const stopCommand = hooks["agent-bridge"].Stop[0].command;
      expect(preCommand).toContain("-EncodedCommand");
      expect(stopCommand).toContain("-EncodedCommand");
      expect(decodePowerShellCommand(preCommand)).toContain("agent-bridge-antigravity-hook.ps1' 'PreInvocation'");
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
});

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}
