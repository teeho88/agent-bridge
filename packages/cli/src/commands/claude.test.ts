import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupStaleAgentSessions, openStore, readConfig } from "../workspace.js";
import { CLAUDE_HOOK_VERSION, getClaudeHookStatus, handleClaudeHook, installClaudeHooks } from "./claude.js";

describe("Claude session lifecycle", () => {
  it("stays read-only for an orchestrator-spawned run instead of hijacking the active task", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    const previous = process.env.AGENT_BRIDGE_SPAWNED_RUN;
    try {
      // A real human session first: this legitimately opens a task.
      handleClaudeHook({ cwd, session_id: "human", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "human", hook_event_name: "UserPromptSubmit", prompt: "Build the report module." });

      let store = openStore(cwd);
      let humanTaskCount = 0;
      try {
        humanTaskCount = store.listTasks(100).length;
        expect(humanTaskCount).toBeGreaterThan(0);
      } finally {
        store.close();
      }

      // Now the orchestrator spawns a sub-agent in the same workspace. Its
      // hooks fire too, but it must not invent a task from the leader prompt
      // nor steal the active-task slot the Orchestrator board reads.
      process.env.AGENT_BRIDGE_SPAWNED_RUN = "run-123";
      handleClaudeHook({ cwd, session_id: "spawned", hook_event_name: "SessionStart" });
      handleClaudeHook({
        cwd,
        session_id: "spawned",
        hook_event_name: "UserPromptSubmit",
        prompt: "# Leader Planning Turn\nYou are the leader for: Build the report module.",
      });

      store = openStore(cwd);
      try {
        expect(store.listTasks(100)).toHaveLength(humanTaskCount);
        expect(store.listTasks(100).some((task) => task.title.includes("Leader Planning Turn"))).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_SPAWNED_RUN;
      else process.env.AGENT_BRIDGE_SPAWNED_RUN = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps concurrent sessions on separate live tasks and ends only the matching one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Implement repository event logging." });
      handleClaudeHook({ cwd, session_id: "session-b", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-b", hook_event_name: "UserPromptSubmit", prompt: "Redesign the memory inbox." });

      let store = openStore(cwd);
      try {
        const active = store.listActiveSessionEvents();
        expect(active).toHaveLength(2);
        expect(new Set(active.map((event) => event.taskId)).size).toBe(2);
      } finally {
        store.close();
      }

      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionEnd" });

      store = openStore(cwd);
      try {
        const active = store.listActiveSessionEvents();
        expect(active).toHaveLength(1);
        expect(active[0]?.sessionId).toBe("session-b");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });


  it("marks a stale Claude session ended when the final hook is missed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Repair stale live agent state." });

      const store = openStore(cwd);
      try {
        expect(store.listActiveSessionEvents()).toHaveLength(1);
        const closed = cleanupStaleAgentSessions(store, cwd, { now: new Date(Date.now() + 2000), staleAfterMs: 1 });
        expect(closed).toBe(1);
        expect(store.listActiveSessionEvents()).toHaveLength(0);
        expect(readConfig(cwd).activeSessions?.["session-a"]).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("turns Claude notifications into pending agent requests", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Update the KiCad schematic." });
      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "Notification",
        message: "Claude needs your permission to run Bash.",
        tool_name: "Bash"
      });

      const store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agent).toBe("claude");
        expect(requests[0]?.type).toBe("command");
        expect(requests[0]?.title).toBe("Claude command request");
        expect(requests[0]?.payload).toContain("Agent:\nclaude");
        expect(requests[0]?.payload).toContain("Tool:\nBash");
        expect(requests[0]?.payload).not.toContain("Claude needs your permission to run Bash.");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores Claude idle prompt notifications", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Check the current request state." });
      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "Notification",
        message: "Claude is waiting for your input.",
        notification_type: "idle_prompt"
      });

      const store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("shows a permission request payload and closes it after Claude accepts the tool", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Check the working tree." });
      const output = handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      });
      expect(output).toBeUndefined();

      let store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.title).toBe("Claude command request");
        expect(requests[0]?.payload).toContain("Agent:\nclaude");
        expect(requests[0]?.payload).toContain("Tool:\nBash");
        expect(requests[0]?.payload).not.toContain("Input:\n{");
        expect(requests[0]?.payload).not.toContain("git status --short");
      } finally {
        store.close();
      }

      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      });

      store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
        expect(store.listAgentRequests({ status: "accepted" })[0]?.response).toContain("Accepted directly in Claude Code");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("closes a Claude request after direct approval even when the request has no Tool section", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Check the working tree." });
      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "Notification",
        message: "Claude needs your permission to run Bash."
      });

      let store = openStore(cwd);
      try {
        const requests = store.listAgentRequests({ status: "pending" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.payload).not.toContain("Tool:");
      } finally {
        store.close();
      }

      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "Bash"
      });

      store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
        expect(store.listAgentRequests({ status: "accepted" })[0]?.response).toContain("Accepted directly in Claude Code");
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("closes paired generic and tool-specific Claude permission requests", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "SessionStart" });
      handleClaudeHook({ cwd, session_id: "session-a", hook_event_name: "UserPromptSubmit", prompt: "Edit a file." });
      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "Notification",
        message: "Claude needs your permission",
        notification_type: "permission_prompt"
      });
      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        tool_input: { file_path: "main.cc" }
      });

      let store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(2);
      } finally {
        store.close();
      }

      handleClaudeHook({
        cwd,
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "main.cc" }
      });

      store = openStore(cwd);
      try {
        expect(store.listAgentRequests({ status: "pending" })).toHaveLength(0);
        expect(store.listAgentRequests({ status: "accepted" })).toHaveLength(2);
      } finally {
        store.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("detects current and outdated installed hook versions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      expect(getClaudeHookStatus(cwd).installed).toBe(false);
      installClaudeHooks(cwd);
      const current = getClaudeHookStatus(cwd);
      expect(current.installed).toBe(true);
      expect(current.current).toBe(true);
      expect(current.installedVersion).toBe(CLAUDE_HOOK_VERSION);

      writeFileSync(current.hookPath, "# agent-bridge-hook-version: old\n", "utf8");
      const outdated = getClaudeHookStatus(cwd);
      expect(outdated.installed).toBe(true);
      expect(outdated.current).toBe(false);
      expect(outdated.installedVersion).toBe("old");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
