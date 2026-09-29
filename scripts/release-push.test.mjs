import { describe, expect, it, vi } from "vitest";
import { releaseAndPush, validateVersionSpec } from "./release-push.mjs";

function dependencies(overrides = {}) {
  const calls = [];
  const git = vi.fn((args) => {
    calls.push(args);
    if (args[0] === "status") return "";
    if (args[0] === "branch") return "main";
    if (args[0] === "remote") return "git@example.com:owner/repo.git";
    return "";
  });
  return {
    calls,
    git,
    runVersion: vi.fn(),
    readVersion: vi.fn(() => "1.4.0"),
    ...overrides,
  };
}

describe("release push script", () => {
  it.each(["major", "minor", "patch", "2.3.4"])("accepts version spec %s", spec => {
    expect(() => validateVersionSpec(spec)).not.toThrow();
  });

  it("rejects an invalid version before invoking Git", () => {
    const deps = dependencies();
    expect(() => releaseAndPush("latest", deps)).toThrow("Version must be");
    expect(deps.git).not.toHaveBeenCalled();
  });

  it("refuses a dirty working tree", () => {
    const deps = dependencies({
      git: vi.fn(args => args[0] === "status" ? " M package.json" : ""),
    });
    expect(() => releaseAndPush("patch", deps)).toThrow("Working tree must be clean");
    expect(deps.runVersion).not.toHaveBeenCalled();
  });

  it("versions, commits, tags, and atomically pushes the current branch", () => {
    const deps = dependencies();
    expect(releaseAndPush("minor", deps)).toEqual({
      branch: "main",
      tag: "v1.4.0",
      version: "1.4.0",
    });
    expect(deps.runVersion).toHaveBeenCalledWith("minor");
    expect(deps.calls).toContainEqual(["commit", "-m", "release: v1.4.0"]);
    expect(deps.calls).toContainEqual(["tag", "-a", "v1.4.0", "-m", "Release v1.4.0"]);
    expect(deps.calls).toContainEqual([
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      "refs/tags/v1.4.0:refs/tags/v1.4.0",
    ]);
  });
});
