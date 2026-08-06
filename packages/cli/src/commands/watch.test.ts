import { describe, expect, it } from "vitest";
import { watchBriefTarget } from "./watch.js";

describe("watchBriefTarget", () => {
  const root = "/repo";

  it("returns the repo-relative posix path for a source file", () => {
    expect(watchBriefTarget(root, "src/app.ts")).toBe("src/app.ts");
    expect(watchBriefTarget(root, "/repo/src/app.ts")).toBe("src/app.ts");
  });

  it("normalizes backslash paths", () => {
    expect(watchBriefTarget(root, "src\\nested\\mod.ts")).toBe("src/nested/mod.ts");
  });

  it("ignores non-source extensions", () => {
    expect(watchBriefTarget(root, "README.md")).toBeNull();
    expect(watchBriefTarget(root, "config.json")).toBeNull();
    expect(watchBriefTarget(root, ".agent-memory/memories.db")).toBeNull();
  });

  it("ignores vendored and generated directories", () => {
    expect(watchBriefTarget(root, "node_modules/pkg/index.ts")).toBeNull();
    expect(watchBriefTarget(root, "dist/index.ts")).toBeNull();
    expect(watchBriefTarget(root, ".git/x.ts")).toBeNull();
  });

  it("ignores paths outside the repo and empty names", () => {
    expect(watchBriefTarget(root, "")).toBeNull();
    expect(watchBriefTarget(root, "/other/place/app.ts")).toBeNull();
  });
});
