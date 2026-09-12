import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "./workspace.js";
import {
  DEFAULT_AGENT_PRESETS,
  addCustomDefaultAgentPreset,
  ensureDefaultAgentPresetStates,
  listDefaultAgentPresetStates,
  removeDefaultAgentPreset,
  restoreBuiltInDefaultAgentPresets,
  setDefaultAgentPresetSelection,
  syncDefaultAgentPresetFromAgent,
} from "./default-agent-presets.js";
import { globalDefaultAgentsPath } from "./global-default-agents.js";

describe("default agent presets", () => {
  // The roster is user-level, so every test needs its own fake home instead of
  // reading and rewriting the developer's real ~/.agent-bridge file.
  let home = "";
  const previousHome = process.env.AGENT_BRIDGE_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agent-bridge-preset-home-"));
    process.env.AGENT_BRIDGE_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_BRIDGE_HOME;
    else process.env.AGENT_BRIDGE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("offers the requested seven fully described agents", () => {
    expect(DEFAULT_AGENT_PRESETS).toHaveLength(7);
    expect(DEFAULT_AGENT_PRESETS.map((preset) => preset.model)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gemini-3.7-flash-high",
      "gemini-3.1-pro-high",
    ]);
    expect(DEFAULT_AGENT_PRESETS.every((preset) => preset.description.length > 80)).toBe(true);
  });

  it("selects every preset by default without reselecting one the user turned off", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-preset-defaults-"));
    const store = openStore(root);
    try {
      expect(ensureDefaultAgentPresetStates(store).every((preset) => preset.selected)).toBe(true);
      expect(store.listRegisteredAgents({ limit: 500 })).toHaveLength(DEFAULT_AGENT_PRESETS.length);

      setDefaultAgentPresetSelection(store, "claude-opus-5", false);
      const restored = ensureDefaultAgentPresetStates(store);
      expect(restored.find((preset) => preset.key === "claude-opus-5")?.selected).toBe(false);
      expect(restored.filter((preset) => preset.selected)).toHaveLength(DEFAULT_AGENT_PRESETS.length - 1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides an unchecked preset but restores the user's edits when checked again", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-presets-"));
    const store = openStore(root);
    try {
      const created = setDefaultAgentPresetSelection(store, "codex-gpt-5.6-sol", true)!;
      syncDefaultAgentPresetFromAgent(
        store.updateRegisteredAgent(created.id, {
          name: "My Sol specialist",
          description: "Customized repository architecture specialist",
          reasoningEffort: "xhigh",
        })!,
      );

      setDefaultAgentPresetSelection(store, "codex-gpt-5.6-sol", false);
      expect(store.listRegisteredAgents({ limit: 500 }).some((agent) => agent.id === created.id)).toBe(false);
      expect(listDefaultAgentPresetStates(store).find((preset) => preset.key === "codex-gpt-5.6-sol")).toMatchObject({
        selected: false,
        name: "My Sol specialist",
        description: "Customized repository architecture specialist",
        reasoningEffort: "xhigh",
      });

      const restored = setDefaultAgentPresetSelection(store, "codex-gpt-5.6-sol", true)!;
      expect(restored).toMatchObject({
        id: created.id,
        name: "My Sol specialist",
        description: "Customized repository architecture specialist",
        reasoningEffort: "xhigh",
        presetSelected: true,
      });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds a custom preset to the table and keeps it selectable", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-preset-add-"));
    const store = openStore(root);
    try {
      ensureDefaultAgentPresetStates(store);
      const created = addCustomDefaultAgentPreset(store, {
        label: "My Deepseek",
        description: "Cheap bulk refactors",
        provider: "deepseek",
        mode: "cli",
        command: "deepseek",
        model: "deepseek-v3",
        capabilities: ["implement"],
      });
      expect(created.presetKey).toBe("custom:my-deepseek");

      const presets = ensureDefaultAgentPresetStates(store);
      expect(presets).toHaveLength(DEFAULT_AGENT_PRESETS.length + 1);
      expect(presets.find((preset) => preset.key === "custom:my-deepseek")).toMatchObject({
        selected: true,
        custom: true,
        model: "deepseek-v3",
      });

      setDefaultAgentPresetSelection(store, "custom:my-deepseek", false);
      expect(listDefaultAgentPresetStates(store).find((preset) => preset.custom)?.selected).toBe(false);
      expect(store.listRegisteredAgents({ limit: 500 }).some((agent) => agent.id === created.id)).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes a custom preset outright and only hides a built-in one", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-preset-delete-"));
    const store = openStore(root);
    try {
      ensureDefaultAgentPresetStates(store);
      addCustomDefaultAgentPreset(store, { label: "My Deepseek", provider: "deepseek", mode: "cli" });

      removeDefaultAgentPreset(store, "custom:my-deepseek");
      expect(listDefaultAgentPresetStates(store).some((preset) => preset.custom)).toBe(false);

      removeDefaultAgentPreset(store, "claude-opus-5");
      // Re-seeding must not resurrect a deleted built-in.
      const afterSeed = ensureDefaultAgentPresetStates(store);
      expect(afterSeed.some((preset) => preset.key === "claude-opus-5")).toBe(false);
      expect(store.listRegisteredAgents({ limit: 500 }).some((agent) => agent.presetKey === "claude-opus-5")).toBe(
        false,
      );

      const restored = restoreBuiltInDefaultAgentPresets(store);
      expect(restored.find((preset) => preset.key === "claude-opus-5")).toMatchObject({ selected: false });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preset edits in the global file so other repositories inherit them", () => {
    const first = mkdtempSync(join(tmpdir(), "agent-bridge-preset-repo-a-"));
    const second = mkdtempSync(join(tmpdir(), "agent-bridge-preset-repo-b-"));
    const storeA = openStore(first);
    try {
      const seeded = ensureDefaultAgentPresetStates(storeA).find((preset) => preset.key === "codex-gpt-5.6-luna")!;
      syncDefaultAgentPresetFromAgent(
        storeA.updateRegisteredAgent(seeded.agentId!, { name: "Shared Luna", reasoningEffort: "xhigh" })!,
      );
      setDefaultAgentPresetSelection(storeA, "claude-sonnet-5", false);
      addCustomDefaultAgentPreset(storeA, { label: "My Deepseek", provider: "deepseek", mode: "cli" });
      removeDefaultAgentPreset(storeA, "claude-opus-5");
    } finally {
      storeA.close();
    }

    const storeB = openStore(second);
    try {
      const presets = ensureDefaultAgentPresetStates(storeB);
      expect(presets.find((preset) => preset.key === "codex-gpt-5.6-luna")).toMatchObject({
        name: "Shared Luna",
        reasoningEffort: "xhigh",
      });
      expect(presets.find((preset) => preset.key === "claude-sonnet-5")?.selected).toBe(false);
      expect(presets.find((preset) => preset.key === "custom:my-deepseek")).toMatchObject({ custom: true });
      expect(presets.some((preset) => preset.key === "claude-opus-5")).toBe(false);
      expect(globalDefaultAgentsPath().startsWith(home)).toBe(true);
    } finally {
      storeB.close();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
