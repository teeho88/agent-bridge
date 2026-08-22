import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCodexHook, installCodexHooks } from "./codex.js";
import { openStore, rememberSessionWindowHandle, startAgentSession } from "../workspace.js";

describe("Codex hooks", () => {
  it("updates the task pre-created by the Work Board terminal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-terminal-"));
    const previous = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    try {
      const store = openStore(cwd);
      let taskId = "";
      try {
        const task = store.createTask({ title: "Codex terminal", ownerAgent: "codex" });
        taskId = task.id;
        startAgentSession("codex-terminal-1", taskId, cwd, "codex");
        store.recordSessionEvent({
          sessionId: "codex-terminal-1",
          taskId,
          agent: "codex",
          kind: "session_started",
          summary: "Codex terminal opened from Work Board.",
        });
      } finally { store.close(); }

      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = "codex-terminal-1";
      await handleCodexHook({ cwd, thread_id: "native-thread" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "native-thread", prompt: "Fix the work board card" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "native-thread" }, "Stop");

      const result = openStore(cwd);
      try {
        expect(result.listTasks(10)).toHaveLength(1);
        expect(result.getTask(taskId)?.title).toBe("Fix the work board card");
        expect(result.listSessionEvents({ taskId, limit: 10 }).some(
          (event) => event.kind === "prompt_submitted" && event.sessionId === "codex-terminal-1",
        )).toBe(true);
        expect(result.listActiveSessionEvents()).toHaveLength(1);
      } finally { result.close(); }
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
      else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the Work Board terminal id but opens a new task after /clear", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-clear-"));
    const previous = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    try {
      const terminalSessionId = "codex-terminal-1";
      const seed = openStore(cwd);
      let firstTaskId = "";
      try {
        const task = seed.createTask({ title: "Codex terminal", ownerAgent: "codex" });
        firstTaskId = task.id;
        startAgentSession(terminalSessionId, task.id, cwd, "codex");
        rememberSessionWindowHandle(terminalSessionId, task.id, "codex", cwd, "12345");
      } finally { seed.close(); }

      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = terminalSessionId;
      await handleCodexHook({ cwd, thread_id: "thread-before-clear" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-before-clear", prompt: "Finish the first task" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-before-clear" }, "Stop");
      await handleCodexHook({ cwd, thread_id: "thread-after-clear" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-after-clear", prompt: "Start the second task" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-after-clear" }, "Stop");

      const result = openStore(cwd);
      try {
        const tasks = result.listTasks(10);
        expect(tasks).toHaveLength(2);
        expect(result.getTask(firstTaskId)?.status).toBe("done");
        const second = tasks.find((task) => task.id !== firstTaskId);
        expect(second?.title).toBe("Start the second task");
        expect(second?.status).toBe("in_progress");
        const config = JSON.parse(readFileSync(join(cwd, ".agent-memory", "config.json"), "utf8")) as {
          sessionTasks?: Record<string, string>;
          sessionWindows?: Record<string, { hwnd?: string; taskId: string }>;
          terminalNativeSessions?: Record<string, string>;
        };
        expect(config.sessionTasks?.[terminalSessionId]).toBe(second?.id);
        expect(config.sessionWindows?.[terminalSessionId]).toEqual(expect.objectContaining({
          hwnd: "12345",
          taskId: second?.id,
        }));
        expect(config.terminalNativeSessions?.[terminalSessionId]).toBe("thread-after-clear");
      } finally { result.close(); }
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
      else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("installs project hooks and records a session lifecycle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      installCodexHooks(cwd);
      const hooks = readFileSync(join(cwd, ".codex", "hooks.json"), "utf8");
      expect(hooks).toContain("UserPromptSubmit");
      expect(hooks).toContain("PermissionRequest");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "Track Codex hooks automatically" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "Stop");
      const store = openStore(cwd);
      try {
        expect(store.listActiveSessionEvents()).toHaveLength(1);
        const task = store.listTasks(1)[0];
        expect(task?.title).toBe("Track Codex hooks automatically");
        expect(task?.goal).toBe("Track Codex hooks automatically");
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });


  it("continues another agent's unfinished task and compiles its handoff", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      const seed = openStore(cwd);
      let taskId = "";
      try {
        const task = seed.createTask({
          title: "Rewrite the invoice export pipeline",
          goal: "Rewrite the invoice export pipeline so exports stream",
          ownerAgent: "claude",
        });
        taskId = task.id;
        seed.upsertTaskHandoff({
          taskId: task.id,
          fromAgent: "claude",
          summary: "Invoice export streaming is half done.",
          next: ["Stream the invoice rows instead of buffering them"],
        });
      } finally { seed.close(); }

      await handleCodexHook({ cwd, thread_id: "thread-continue" }, "SessionStart");
      await handleCodexHook(
        { cwd, thread_id: "thread-continue", prompt: "Tiếp tục rewrite the invoice export pipeline" },
        "UserPromptSubmit",
      );

      const store = openStore(cwd);
      try {
        // The placeholder the session opened is gone; the prompt landed on the
        // existing task instead of forking a second one.
        expect(store.listTasks(10)).toHaveLength(1);
        expect(store.listTasks(10)[0]?.id).toBe(taskId);
      } finally { store.close(); }

      // The task-scoped handoff reaches Codex regardless of which agent worked
      // on the task before it.
      const compiled = readFileSync(join(cwd, ".agent-memory", "compiled-context.md"), "utf8");
      expect(compiled).toContain("Invoice export streaming is half done.");
      expect(compiled).toContain("Stream the invoice rows instead of buffering them");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("reuses the same task when SessionStart repeats for the same Codex thread", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "First prompt" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "Stop");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "Second prompt in same thread" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "Stop");

      const store = openStore(cwd);
      try {
        const tasks = store.listTasks(10);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.title).toBe("First prompt");
        expect(tasks[0]?.goal).toBe("First prompt");
        expect(store.listActiveSessionEvents()).toHaveLength(1);
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("does not create an extra task for an unidentifiable SessionStart before a Codex thread prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      await handleCodexHook({ cwd }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "First prompt" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "Stop");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "Second prompt in same thread" }, "UserPromptSubmit");

      const store = openStore(cwd);
      try {
        const tasks = store.listTasks(10);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.title).toBe("First prompt");
        expect(tasks[0]?.goal).toBe("First prompt");
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("keeps the full prompt as the task goal while shortening the title", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      const prompt = "Fix the Compiled Context Goal so it preserves the complete user request instead of duplicating the shortened task title and losing important details.";
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "Stop");

      const store = openStore(cwd);
      try {
        const task = store.listTasks(1)[0];
        expect(task?.title.length).toBeLessThan(prompt.length);
        expect(task?.goal).toBe(prompt);
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("captures Codex permission requests from tool metadata only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "Run a command" }, "UserPromptSubmit");
      await handleCodexHook({ cwd, thread_id: "thread-a", toolName: "Bash" }, "PermissionRequest");

      let store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.type).toBe("command");
        expect(requests[0]?.payload).toContain("Tool:\nBash");
      } finally { store.close(); }

      await handleCodexHook({ cwd, thread_id: "thread-a", tool: { name: "Bash" } }, "PostToolUse");

      store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
        expect(store.listAgentRequests({ status: "accepted" })).toHaveLength(1);
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("turns Codex permission events into pending requests and resolves them after tool use", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-codex-"));
    try {
      await handleCodexHook({ cwd, thread_id: "thread-a" }, "SessionStart");
      await handleCodexHook({ cwd, thread_id: "thread-a", prompt: "Check the working tree" }, "UserPromptSubmit");
      await handleCodexHook({
        cwd,
        thread_id: "thread-a",
        message: "Codex needs your permission to run Bash.",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      }, "PermissionRequest");

      let store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agent).toBe("codex");
        expect(requests[0]?.type).toBe("command");
        expect(requests[0]?.title).toBe("Codex command request");
        expect(requests[0]?.payload).toContain("Agent:\ncodex");
        expect(requests[0]?.payload).toContain("Tool:\nBash");
        expect(requests[0]?.payload).not.toContain("Codex needs your permission");
        expect(requests[0]?.payload).not.toContain("git status --short");
      } finally { store.close(); }

      await handleCodexHook({ cwd, thread_id: "thread-a", tool_name: "Bash" }, "PostToolUse");

      store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
        expect(store.listAgentRequests({ status: "accepted" })[0]?.response).toContain("Accepted directly in Codex");
      } finally { store.close(); }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

