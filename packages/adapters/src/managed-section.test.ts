import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { antigravityRulesSection } from "./antigravity.js";
import { claudeManagedSection } from "./claude.js";
import { codexManagedSection } from "./codex.js";
import { patchManagedSection } from "./managed-section.js";

describe("patchManagedSection", () => {
  it("preserves user content while updating managed content", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const file = join(dir, "AGENTS.md");
    try {
      patchManagedSection(file, "first");
      patchManagedSection(file, "second");
      const content = readFileSync(file, "utf8");
      expect(content).toContain("second");
      expect(content).not.toContain("first");
      expect(content).toContain("agent-bridge:start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("orchestratedRunSection", () => {
  // The instruction file is what an agent reads before anything else, so this is
  // the earliest point at which a spawned sub-agent can learn that the task,
  // session and handoff rules right above it are not addressed to it.
  it("rides along in every provider's instruction file", () => {
    for (const section of [claudeManagedSection(), codexManagedSection(), antigravityRulesSection()]) {
      expect(section).toContain("AGENT_BRIDGE_SPAWNED_RUN");
      expect(section).toContain(".agent-memory/context/");
      expect(section).toContain("Temporary Artifact Cleanup");
      expect(section).toContain(".agent-tmp/<agent-or-task>/");
      expect(section).toContain("Never remove pre-existing files");
      expect(section).toContain("Permission Escalation Rules");
      expect(section).toContain("ask the user for the minimum permission needed");
      expect(section).toContain("retry the blocked action after approval");
      expect(section).toContain("finish the task merely because the first attempt was permission-blocked");
      // The block sits inside the managed markers, so `agent-bridge init` keeps
      // it in sync instead of leaving it behind on the next rewrite.
      expect(section.indexOf("AGENT_BRIDGE_SPAWNED_RUN")).toBeLessThan(section.indexOf("agent-bridge:end"));
    }
  });

  it("includes a recoverable Git checkpoint rule for every provider", () => {
    for (const section of [claudeManagedSection(), codexManagedSection(), antigravityRulesSection()]) {
      expect(section).toContain("After completing a meaningful repo change");
      expect(section).toContain("Stage and commit only the files that belong to that change");
    }
  });
});
