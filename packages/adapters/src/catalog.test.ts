import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getProviderCatalog,
  isCommandOnPath,
  listInstalledProviderCatalogs,
  listProviderCatalogs,
  listStaffableProviderCatalogs,
  mergeProviderCatalog,
} from "./catalog.js";

describe("provider catalog", () => {
  it("lists codex, claude, and antigravity, with reasoning levels where supported", () => {
    const catalogs = listProviderCatalogs();
    const providers = catalogs.map((catalog) => catalog.provider);
    expect(providers).toEqual(expect.arrayContaining(["codex", "claude", "antigravity"]));
    // gemini's CLI is deprecated and was replaced by antigravity.
    expect(providers).not.toContain("gemini");

    const codex = getProviderCatalog("codex")!;
    expect(codex.reasoningFlag).toBe("codex-config");
    expect(codex.reasoning.map((level) => level.value)).toContain("high");

    // Antigravity's headless agent is `agy`; the `antigravity` binary only
    // launches the IDE and could never be read back by a spawned run.
    const antigravity = getProviderCatalog("antigravity")!;
    expect(antigravity.defaultCommand).toBe("agy");
    expect(antigravity.headless).toBe(true);
    expect(antigravity.models.map((model) => model.value)).toContain("gemini-3.1-pro-high");
    expect(antigravity.models.map((model) => model.value)).toContain("gemini-3.7-flash-high");
    expect(getProviderCatalog("codex")!.headless).toBe(true);
    expect(getProviderCatalog("claude")!.headless).toBe(true);
  });

  it("seeds real codex model slugs, not the bare \"gpt-5.6\" (which Codex rejects with a 400 for ChatGPT auth)", () => {
    const codex = getProviderCatalog("codex")!;
    const values = codex.models.map((model) => model.value);
    expect(values).toContain("gpt-5.6-sol");
    expect(values).not.toContain("gpt-5.6");
    expect(values).not.toContain("gpt-5.4-codex");
  });

  it("detects installed CLIs from PATH, including Windows .cmd shims", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-path-"));
    try {
      const extension = process.platform === "win32" ? ".cmd" : "";
      writeFileSync(join(dir, `claude${extension}`), "");
      // Detection keys off the catalog's defaultCommand, so antigravity is
      // found by `agy` — an `antigravity` binary on PATH is the IDE launcher
      // and must NOT count as the agent being available.
      writeFileSync(join(dir, `agy${extension}`), "");
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

      expect(isCommandOnPath("claude", env)).toBe(true);
      expect(isCommandOnPath("codex", env)).toBe(false);

      const installed = listInstalledProviderCatalogs(env).map((catalog) => catalog.provider);
      expect(installed).toEqual(["claude", "antigravity"]);
      expect(listStaffableProviderCatalogs(env).map((catalog) => catalog.provider)).toEqual([
        "claude",
        "antigravity",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for unknown providers", () => {
    expect(getProviderCatalog("unknown-provider")).toBeUndefined();
  });

  it("merges probed models into the seed catalog without duplicating entries", () => {
    const codex = getProviderCatalog("codex")!;
    const merged = mergeProviderCatalog(codex, {
      models: [
        { value: "gpt-5.6-terra", label: "gpt-5.6-terra" }, // duplicate of a seeded model
        { value: "gpt-5.7-preview", label: "gpt-5.7-preview" },
      ],
    });
    const values = merged.models.map((model) => model.value);
    expect(values.filter((value) => value === "gpt-5.6-terra")).toHaveLength(1);
    expect(values).toContain("gpt-5.7-preview");
  });
});
