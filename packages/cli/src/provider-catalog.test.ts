import { describe, expect, it } from "vitest";
import { getProviderCatalog } from "@agent-bridge/adapters";
import { applyCatalogOverride, parseAntigravityModels, parseClaudeCatalog, parseCodexCatalog } from "./provider-catalog.js";

describe("runtime provider catalog", () => {
  it("parses Codex's model JSON and model-specific reasoning levels", () => {
    const catalog = parseCodexCatalog(JSON.stringify({ models: [
      { slug: "gpt-new", display_name: "GPT New", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
    ] }));
    expect(catalog.models.map((model) => model.value)).toEqual(["gpt-new"]);
    expect(catalog.reasoning?.map((level) => level.value)).toEqual(["low", "ultra"]);
  });

  it("parses Antigravity's tabular model list and ignores status text", () => {
    expect(parseAntigravityModels("gemini-new-high\tGemini New (High)\nFetching available models...\n"))
      .toEqual([{ value: "gemini-new-high", label: "Gemini New (High)" }]);
  });

  it("uses Claude's current aliases and advertised full model names", () => {
    const catalog = parseClaudeCatalog([
      "  --effort <level>  Effort level (low, medium, high, xhigh, max)",
      "  --model <model>    Alias (e.g. 'fable', 'opus', or 'sonnet') or full name (e.g. 'claude-fable-5').",
      "  -n, --name <name>  Session name",
    ].join("\n"));
    expect(catalog.models.map((model) => model.value)).toEqual(["fable", "opus", "sonnet", "claude-fable-5"]);
    expect(catalog.reasoning?.map((level) => level.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps seeded Claude models and removes aliases duplicated by full model names", () => {
    const base = getProviderCatalog("claude")!;
    const merged = applyCatalogOverride(base, {
      models: [
        { value: "fable", label: "Fable" },
        { value: "opus", label: "Opus" },
        { value: "claude-fable-5", label: "Claude Fable 5" },
        { value: "claude-sonnet-6", label: "Claude Sonnet 6" },
      ],
    });
    const values = merged.models.map((model) => model.value);

    expect(values).toContain("claude-haiku-4-5-20251001");
    expect(values).toContain("claude-fable-5");
    expect(values).toContain("claude-sonnet-6");
    expect(values).not.toContain("fable");
    expect(values).not.toContain("opus");
  });
});
