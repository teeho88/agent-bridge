import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../workspace.js";
import { resolveWorkBoardTerminalBinding } from "./session.js";

describe("session start Work Board binding", () => {
  it("reuses the stable Codex terminal session instead of creating an alias", () => {
    const previous = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    try {
      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = "codex-terminal-1";
      const config = {
        activeSessions: { "codex-terminal-1": "codex" },
        sessionTasks: { "codex-terminal-1": "task-1" },
      } as unknown as BridgeConfig;
      expect(resolveWorkBoardTerminalBinding(config, "codex")).toEqual({
        sessionId: "codex-terminal-1",
        taskId: "task-1",
      });
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
      else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = previous;
    }
  });
});
