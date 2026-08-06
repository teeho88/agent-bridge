import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCodexHook, installCodexHooks } from "./codex.js";
import { openStore } from "../workspace.js";

describe("Codex hooks", () => {
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

