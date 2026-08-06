import { describe, expect, it } from "vitest";
import { composeBrief, extractLeadingDoc, inferFileRole, pickPrimarySymbol } from "./brief.js";

describe("extractLeadingDoc", () => {
  it("reads a block header comment as prose", () => {
    const doc = extractLeadingDoc("/*\n * Script-aware token estimate.\n * Weights each code point by script.\n */\nexport function x() {}");
    expect(doc).toBe("Script-aware token estimate. Weights each code point by script.");
  });

  it("reads consecutive line comments", () => {
    const doc = extractLeadingDoc("// Knowledge graph utilities.\n// Language-agnostic.\nimport x from 'y';");
    expect(doc).toBe("Knowledge graph utilities. Language-agnostic.");
  });

  it("skips a shebang before the comment", () => {
    expect(extractLeadingDoc("#!/usr/bin/env node\n// CLI entry point.\n")).toBe("CLI entry point.");
  });

  it("ignores license headers and pragma-only comments", () => {
    expect(extractLeadingDoc("// Copyright 2026 ACME. All rights reserved.\n")).toBeUndefined();
    expect(extractLeadingDoc("/* eslint-disable */\n")).toBeUndefined();
    expect(extractLeadingDoc("/** @param a */\n")).toBeUndefined();
  });

  it("returns undefined when code starts immediately", () => {
    expect(extractLeadingDoc("export function x() {}\n")).toBeUndefined();
  });

  it("finds a module comment sitting just after the import block", () => {
    const text = [
      'import { createHash } from "node:crypto";',
      'import { join } from "node:path";',
      "",
      "// Knowledge graph: a language-agnostic map of a repo.",
      "// Lets an agent find files without reading them.",
      "export function extractGraph() {}"
    ].join("\n");
    expect(extractLeadingDoc(text)).toBe("Knowledge graph: a language-agnostic map of a repo. Lets an agent find files without reading them.");
  });

  it("reads a python module docstring", () => {
    expect(extractLeadingDoc('"""Embedding provider."""\nimport os')).toBe("Embedding provider.");
  });
});

describe("inferFileRole", () => {
  it("labels test files with their subject", () => {
    expect(inferFileRole("src/workspace.test.ts", "ts", [], ["src/workspace.ts"])).toBe("Test suite for workspace");
    expect(inferFileRole("src/a.test.ts", "ts", [], [])).toBe("Test suite");
  });

  it("prefers the import matching the test's own name as subject", () => {
    expect(
      inferFileRole("src/workspace.test.ts", "ts", [], ["src/commands/claude.ts", "src/workspace.ts"])
    ).toBe("Test suite for workspace");
  });

  it("labels entry points, commands, types, and config", () => {
    expect(inferFileRole("src/index.ts", "ts", [], [])).toBe("TypeScript module entry point (barrel)");
    expect(inferFileRole("src/commands/ui.ts", "ts", [], [])).toBe("CLI command module");
    expect(inferFileRole("src/types.ts", "ts", [{ name: "T", kind: "type" }], [])).toBe("Type definitions");
    expect(inferFileRole("package.json", undefined, [], [])).toBe("Configuration");
  });

  it("falls back to a language module label", () => {
    expect(inferFileRole("src/util.ts", "ts", [{ name: "f", kind: "function" }], [])).toBe("TypeScript module");
    expect(inferFileRole("src/util.go", "go", [], [])).toBe("Go module");
  });
});

describe("pickPrimarySymbol", () => {
  it("prefers a function over a const defined earlier", () => {
    const primary = pickPrimarySymbol([
      { name: "fmt", kind: "const" },
      { name: "registerOptimize", kind: "function" }
    ]);
    expect(primary?.name).toBe("registerOptimize");
  });
});

describe("composeBrief", () => {
  it("uses the doc comment when present", () => {
    expect(
      composeBrief({
        path: "src/commands/optimize.ts",
        language: "ts",
        symbols: [{ name: "registerOptimize", kind: "function" }],
        importsInternal: [],
        importsExternal: [],
        dependentsCount: 1,
        docComment: "Token saving utilities."
      })
    ).toBe("CLI command module. Token saving utilities.");
  });

  it("falls back to role plus primary symbol with no doc", () => {
    expect(
      composeBrief({
        path: "src/commands/optimize.ts",
        language: "ts",
        symbols: [
          { name: "fmt", kind: "const" },
          { name: "registerOptimize", kind: "function" }
        ],
        importsInternal: [],
        importsExternal: [],
        dependentsCount: 1
      })
    ).toBe("CLI command module. Defines function registerOptimize (+1 more).");
  });

  it("uses role only when there are no symbols and no doc", () => {
    expect(
      composeBrief({ path: "src/x.ts", language: "ts", symbols: [], importsInternal: [], importsExternal: [], dependentsCount: 0 })
    ).toBe("TypeScript module.");
  });
});
