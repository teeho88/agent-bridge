import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "@agent-bridge/memory";
import { resolveAgentForPreference } from "./agent-selector.js";

describe("resolveAgentForPreference", () => {
  function withStore(fn: (store: SQLiteMemoryStore) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-selector-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reuses an existing agent that already matches provider/mode/model/reasoning", () => {
    withStore((store) => {
      const existing = store.createRegisteredAgent({
        name: "codex-implementer",
        provider: "codex",
        mode: "cli",
        command: "codex",
        model: "gpt-5.6",
        reasoningEffort: "high",
      });

      const resolved = resolveAgentForPreference(store, {
        provider: "codex",
        mode: "cli",
        model: "gpt-5.6",
        reasoningEffort: "high",
      });

      expect(resolved.id).toBe(existing.id);
      expect(store.listRegisteredAgents({ provider: "codex" })).toHaveLength(1);
    });
  });

  it("creates a new agent when no registered agent matches", () => {
    withStore((store) => {
      const resolved = resolveAgentForPreference(store, {
        provider: "gemini",
        model: "gemini-2.5-pro",
        reasoningEffort: "high",
      });

      expect(resolved.provider).toBe("gemini");
      expect(resolved.mode).toBe("cli");
      expect(resolved.model).toBe("gemini-2.5-pro");
      expect(resolved.name).toContain("gemini");
      expect(store.listRegisteredAgents({ provider: "gemini" })).toHaveLength(1);
    });
  });

  it("does not reuse an agent with a different model, and does not mutate the existing one", () => {
    withStore((store) => {
      const existing = store.createRegisteredAgent({
        name: "codex-cli",
        provider: "codex",
        mode: "cli",
        command: "codex",
        model: "gpt-5.4",
      });

      const resolved = resolveAgentForPreference(store, { provider: "codex", model: "gpt-5.6" });

      expect(resolved.id).not.toBe(existing.id);
      expect(resolved.model).toBe("gpt-5.6");
      expect(store.getRegisteredAgent(existing.id)?.model).toBe("gpt-5.4");
    });
  });

  it("reuses the same created agent across repeated calls for the same preference", () => {
    withStore((store) => {
      const first = resolveAgentForPreference(store, { provider: "claude", model: "opus", reasoningEffort: "high" });
      const second = resolveAgentForPreference(store, { provider: "claude", model: "opus", reasoningEffort: "high" });

      expect(second.id).toBe(first.id);
      expect(store.listRegisteredAgents({ provider: "claude" })).toHaveLength(1);
    });
  });

  it("disambiguates the auto-created name instead of colliding with a same-named agent at a different reasoning effort", () => {
    withStore((store) => {
      const existing = store.createRegisteredAgent({
        name: "claude-opus",
        provider: "claude",
        mode: "cli",
        command: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });

      const resolved = resolveAgentForPreference(store, { provider: "claude", mode: "cli", model: "opus", reasoningEffort: "high" });

      expect(resolved.id).not.toBe(existing.id);
      expect(resolved.reasoningEffort).toBe("high");
      expect(resolved.name).not.toBe("claude-opus");
      expect(store.getRegisteredAgent(existing.id)?.reasoningEffort).toBe("medium");
    });
  });

  it("ignores disabled agents when looking for a match", () => {
    withStore((store) => {
      const disabled = store.createRegisteredAgent({
        name: "codex-disabled",
        provider: "codex",
        mode: "cli",
        command: "codex",
        model: "gpt-5.6",
        enabled: false,
      });

      const resolved = resolveAgentForPreference(store, { provider: "codex", model: "gpt-5.6" });

      expect(resolved.id).not.toBe(disabled.id);
      expect(resolved.enabled).toBe(true);
    });
  });

  it("selects only an exact-match agent carrying every required capability", () => {
    withStore((store) => {
      store.createRegisteredAgent({
        name: "codex-implement-only",
        provider: "codex",
        mode: "cli",
        model: "gpt-5.6",
        capabilities: ["implement"],
      });
      const reviewer = store.createRegisteredAgent({
        name: "codex-review-only",
        provider: "codex",
        mode: "cli",
        model: "gpt-5.6",
        capabilities: ["review"],
      });

      const resolved = resolveAgentForPreference(
        store,
        { provider: "codex", mode: "cli", model: "gpt-5.6" },
        { allowCreate: false, requiredCapabilities: ["review"] },
      );

      expect(resolved.id).toBe(reviewer.id);
    });
  });

  it("rejects a provider whose enabled agents lack the required capability", () => {
    withStore((store) => {
      store.createRegisteredAgent({
        name: "claude-implement-only",
        provider: "claude",
        mode: "cli",
        capabilities: ["implement"],
      });

      expect(() =>
        resolveAgentForPreference(
          store,
          { provider: "claude", mode: "cli" },
          { allowCreate: false, requiredCapabilities: ["review"] },
        ),
      ).toThrow(/capabilities: review/);
    });
  });
});
