import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteSkill,
  installSkillFiles,
  listSkills,
  normalizeSkillName,
  parseSkillMarkdown,
  saveSkill,
  skillRoot,
} from "./skill-library.js";

describe("skill library", () => {
  it("uses the Codex-compatible global and repository roots", () => {
    expect(skillRoot("repo", "C:\\repo", "C:\\user")).toBe(join("C:\\repo", ".agents", "skills"));
    expect(skillRoot("global", "C:\\repo", "C:\\user")).toBe(join("C:\\user", ".agents", "skills"));
  });

  it("normalizes names and parses an uploaded SKILL.md", () => {
    expect(normalizeSkillName(" My Review Skill ")).toBe("my-review-skill");
    expect(parseSkillMarkdown('---\nname: review\ndescription: "Review code"\n---\n\nDo the review.')).toEqual({
      name: "review",
      description: "Review code",
      instructions: "Do the review.",
    });
  });

  it("saves, lists, updates, and deletes repo and global skills", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-skills-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    try {
      const repoSkill = saveSkill({
        scope: "repo",
        name: "Release Notes",
        description: "Create release notes",
        content: "Summarize user-visible changes.",
      }, repo, home);
      expect(repoSkill.name).toBe("release-notes");
      expect(readFileSync(repoSkill.path, "utf8")).toContain("name: release-notes");
      expect(listSkills("repo", repo, home)).toHaveLength(1);

      saveSkill({
        scope: "global",
        content: "---\nname: audit\ndescription: Audit a repository\n---\n\nInspect risks.",
      }, repo, home);
      expect(listSkills("global", repo, home)[0]?.description).toBe("Audit a repository");
      expect(deleteSkill("global", "audit", repo, home)).toBe(true);
      expect(existsSync(join(home, ".agents", "skills", "audit"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty or oversized skill content", () => {
    expect(() => saveSkill({ scope: "repo", name: "empty", description: "Empty", content: "" }, "."))
      .toThrow("instructions are required");
    expect(() => saveSkill({ scope: "repo", name: "large", description: "Large", content: "x".repeat(512 * 1024 + 1) }, "."))
      .toThrow("512 KB");
  });

  it("installs a complete skill directory locally or globally and requires overwrite consent", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-github-skill-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const files = [
      { path: "SKILL.md", content: Buffer.from("---\nname: github-review\ndescription: Review from GitHub\n---\n\nReview carefully.\n") },
      { path: "scripts/check.js", content: Buffer.from("console.log('check');\n") },
      { path: "references/rules.md", content: Buffer.from("# Rules\n") },
    ];
    try {
      const local = installSkillFiles({ scope: "repo", files }, repo, home);
      expect(local.path).toBe(join(repo, ".agents", "skills", "github-review", "SKILL.md"));
      expect(readFileSync(join(repo, ".agents", "skills", "github-review", "scripts", "check.js"), "utf8"))
        .toContain("check");
      expect(() => installSkillFiles({ scope: "repo", files }, repo, home)).toThrow("already exists");

      const global = installSkillFiles({
        scope: "global",
        files: files.map((file) => file.path === "references/rules.md"
          ? { ...file, content: Buffer.from("# Updated rules\n") }
          : file),
      }, repo, home);
      expect(global.path).toBe(join(home, ".agents", "skills", "github-review", "SKILL.md"));

      installSkillFiles({ scope: "repo", files, overwrite: true }, repo, home);
      expect(listSkills("repo", repo, home)[0]?.name).toBe("github-review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths that escape the skill directory", () => {
    expect(() => installSkillFiles({
      scope: "repo",
      files: [
        { path: "SKILL.md", content: Buffer.from("---\nname: safe\ndescription: Safe\n---\n\nDo work.\n") },
        { path: "../outside.txt", content: Buffer.from("no") },
      ],
    }, ".")).toThrow("Invalid skill file path");
  });
});
