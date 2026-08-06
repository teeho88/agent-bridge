import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
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
