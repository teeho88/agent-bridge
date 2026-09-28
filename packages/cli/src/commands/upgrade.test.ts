import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAntigravityHookStatus } from "./antigravity.js";
import { getClaudeHookStatus } from "./claude.js";
import { upgradeWorkspace } from "./upgrade.js";

describe("upgradeWorkspace", () => {
  it("refreshes managed files and hooks without resetting repository state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    try {
      mkdirSync(join(cwd, ".agent-memory"), { recursive: true });
      writeFileSync(join(cwd, ".agent-memory", "config.json"), "{\"sentinel\":true}\n", "utf8");
      writeFileSync(join(cwd, ".agent-memory", "current-task.md"), "# Existing task\n", "utf8");
      writeFileSync(
        join(cwd, "AGENTS.md"),
        "Custom AGENTS header\n\n<!-- agent-bridge:start -->\nold codex rules\n<!-- agent-bridge:end -->\n\nCustom AGENTS footer\n",
        "utf8",
      );
      writeFileSync(
        join(cwd, "CLAUDE.md"),
        "Custom CLAUDE header\n\n<!-- agent-bridge:start -->\nold claude rules\n<!-- agent-bridge:end -->\n\nCustom CLAUDE footer\n",
        "utf8",
      );
      mkdirSync(join(cwd, ".agents"), { recursive: true });
      writeFileSync(
        join(cwd, ".agents", "hooks.json"),
        JSON.stringify({ "lint-checker": { PostToolUse: [] } }),
        "utf8",
      );

      const output = upgradeWorkspace(cwd);

      const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
      expect(agents).toContain("Custom AGENTS header");
      expect(agents).toContain("Custom AGENTS footer");
      expect(agents).toContain("# Agent Bridge Context");
      expect(agents).not.toContain("old codex rules");

      const claude = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
      expect(claude).toContain("Custom CLAUDE header");
      expect(claude).toContain("Custom CLAUDE footer");
      expect(claude).toContain("# Claude Efficiency Rules");
      expect(claude).not.toContain("old claude rules");

      expect(readFileSync(join(cwd, ".agent-memory", "config.json"), "utf8")).toBe(
        "{\"sentinel\":true}\n",
      );
      expect(readFileSync(join(cwd, ".agent-memory", "current-task.md"), "utf8")).toBe(
        "# Existing task\n",
      );
      expect(getClaudeHookStatus(cwd).current).toBe(true);
      expect(getAntigravityHookStatus(cwd).current).toBe(true);
      const antigravityHooks = JSON.parse(
        readFileSync(join(cwd, ".agents", "hooks.json"), "utf8"),
      );
      expect(antigravityHooks["lint-checker"]).toBeDefined();
      expect(output[0]).toBe("Upgraded agent-bridge integration.");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not initialize a repository implicitly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    try {
      expect(() => upgradeWorkspace(cwd)).toThrow("Agent Bridge is not initialized");
      expect(existsSync(join(cwd, ".agent-memory"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
