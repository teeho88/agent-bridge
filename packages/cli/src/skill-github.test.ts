import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installGitHubSkill, searchGitHubSkills } from "./skill-github.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub skill library", () => {
  it("searches GitHub code for SKILL.md and forwards authentication", async () => {
    const requestedUrls: string[] = [];
    const authorizations: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.endsWith("/repos/acme/skills")) return json({
        description: "Reusable agent skills",
        stargazers_count: 1234,
        pushed_at: "2026-08-20T10:00:00Z",
        default_branch: "main",
        html_url: "https://github.com/acme/skills",
      });
      return json({ items: [{
        path: "skills/review/SKILL.md",
        html_url: "https://github.com/acme/skills/blob/main/skills/review/SKILL.md",
        repository: { full_name: "acme/skills", html_url: "https://github.com/acme/skills", default_branch: "main" },
      }] });
    }) as typeof fetch;

    await expect(searchGitHubSkills("review", { fetchImpl, token: "secret" })).resolves.toEqual([{
      repository: "acme/skills",
      repositoryUrl: "https://github.com/acme/skills",
      description: "Reusable agent skills",
      stars: 1234,
      updatedAt: "2026-08-20T10:00:00Z",
      path: "skills/review/SKILL.md",
      ref: "main",
      skillUrl: "https://github.com/acme/skills/blob/main/skills/review/SKILL.md",
    }]);
    expect(requestedUrls.some((url) => url.includes("filename%3ASKILL.md"))).toBe(true);
    expect(requestedUrls).toContain("https://api.github.com/repos/acme/skills");
    expect(authorizations.every((value) => value === "Bearer secret")).toBe(true);
  });

  it("uses stars and latest repository activity to break equal relevance", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/code?")) return json({ items: [
        { path: "skills/review/SKILL.md", repository: { full_name: "acme/low" } },
        { path: "skills/review/SKILL.md", repository: { full_name: "acme/high-old" } },
        { path: "skills/review/SKILL.md", repository: { full_name: "acme/high-new" } },
      ] });
      const details: Record<string, unknown> = url.endsWith("/acme/low")
        ? { stargazers_count: 10, pushed_at: "2026-08-21T00:00:00Z" }
        : url.endsWith("/acme/high-old")
          ? { stargazers_count: 100, pushed_at: "2026-08-01T00:00:00Z" }
          : { stargazers_count: 100, pushed_at: "2026-08-20T00:00:00Z" };
      return json(details);
    }) as typeof fetch;

    const results = await searchGitHubSkills("review", { fetchImpl, token: "secret" });
    expect(results.map((result) => result.repository)).toEqual([
      "acme/high-new",
      "acme/high-old",
      "acme/low",
    ]);
  });

  it("ranks keyword relevance ahead of repository popularity", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/code?")) return json({ items: [
        { path: "SKILL.md", repository: { full_name: "popular/general-tools" } },
        { path: "skills/code-review/SKILL.md", repository: { full_name: "small/review-tools" } },
      ] });
      return url.endsWith("/popular/general-tools")
        ? json({ description: "General utilities", stargazers_count: 50_000 })
        : json({ description: "Automate code review", stargazers_count: 5 });
    }) as typeof fetch;

    const results = await searchGitHubSkills("code review", { fetchImpl, token: "secret" });
    expect(results.map((result) => result.repository)).toEqual([
      "small/review-tools",
      "popular/general-tools",
    ]);
  });

  it("reranks results using SKILL.md name, description, headings, and body", async () => {
    const relevantSkill = [
      "---",
      "name: pull-request-reviewer",
      "description: Reviews pull requests for correctness and maintainability",
      "---",
      "# Automated code review",
      "Inspect changed code and report actionable findings.",
    ].join("\n");
    const genericSkill = "---\nname: general-tools\ndescription: Common developer utilities\n---\n# Utilities\n";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/code?")) return json({ items: [
        {
          path: "SKILL.md",
          url: "https://api.github.test/generic-skill",
          repository: { full_name: "popular/general-tools" },
        },
        {
          path: "SKILL.md",
          url: "https://api.github.test/review-skill",
          repository: { full_name: "small/toolbox" },
        },
      ] });
      if (url === "https://api.github.test/generic-skill") {
        return json({ encoding: "base64", content: Buffer.from(genericSkill).toString("base64") });
      }
      if (url === "https://api.github.test/review-skill") {
        return json({ encoding: "base64", content: Buffer.from(relevantSkill).toString("base64") });
      }
      return url.endsWith("/popular/general-tools")
        ? json({ description: "Popular developer tools", stargazers_count: 50_000 })
        : json({ description: "Small toolbox", stargazers_count: 2 });
    }) as typeof fetch;

    const results = await searchGitHubSkills("code review", { fetchImpl, token: "secret" });
    expect(results.map((result) => result.repository)).toEqual([
      "small/toolbox",
      "popular/general-tools",
    ]);
  });

  it("preserves GitHub ranking when repository metadata has no keyword signal", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/code?")) return json({ items: [
        { path: "SKILL.md", repository: { full_name: "acme/first" } },
        { path: "SKILL.md", repository: { full_name: "acme/popular" } },
      ] });
      return url.endsWith("/acme/first")
        ? json({ description: "Utilities", stargazers_count: 1 })
        : json({ description: "Toolbox", stargazers_count: 10_000 });
    }) as typeof fetch;

    const results = await searchGitHubSkills("review", { fetchImpl, token: "secret" });
    expect(results.map((result) => result.repository)).toEqual([
      "acme/first",
      "acme/popular",
    ]);
  });

  it("downloads the whole selected directory and installs it in either scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-github-client-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const skillMarkdown = "---\nname: github-review\ndescription: GitHub review\n---\n\nReview the change.\n";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/contents/skills/review/scripts?")) {
        return json([{ type: "file", name: "check.js", path: "skills/review/scripts/check.js", size: 12, url: "https://api.github.test/check" }]);
      }
      if (url.includes("/contents/skills/review?")) {
        return json([
          { type: "file", name: "SKILL.md", path: "skills/review/SKILL.md", size: skillMarkdown.length, url: "https://api.github.test/skill" },
          { type: "dir", name: "scripts", path: "skills/review/scripts" },
        ]);
      }
      if (url === "https://api.github.test/skill") return json({ encoding: "base64", content: Buffer.from(skillMarkdown).toString("base64") });
      if (url === "https://api.github.test/check") return json({ encoding: "base64", content: Buffer.from("check();\n").toString("base64") });
      return json({ message: `Unexpected URL: ${url}` }, 404);
    }) as typeof fetch;
    try {
      const installed = await installGitHubSkill({
        repository: "acme/skills",
        path: "skills/review/SKILL.md",
        ref: "main",
        scope: "global",
      }, repo, { fetchImpl, userHome: home });
      expect(installed.scope).toBe("global");
      expect(readFileSync(join(home, ".agents", "skills", "github-review", "scripts", "check.js"), "utf8"))
        .toBe("check();\n");
      expect(existsSync(join(repo, ".agents", "skills", "github-review"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing token before making a GitHub request", async () => {
    let requested = false;
    const fetchImpl = (async () => {
      requested = true;
      return json({ message: "Requires authentication" }, 401);
    }) as typeof fetch;
    await expect(searchGitHubSkills("review", { fetchImpl, token: "" }))
      .rejects.toThrow("GitHub token is not visible to the running Agent Bridge process");
    expect(requested).toBe(false);
  });

  it("does not classify an invalid configured token as a missing token", async () => {
    const fetchImpl = (async () => json({ message: "Bad credentials" }, 401)) as typeof fetch;
    await expect(searchGitHubSkills("review", { fetchImpl, token: "invalid" }))
      .rejects.toThrow("Check that the configured GitHub token is valid");
  });
});
