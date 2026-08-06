import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractGraph, isIgnored, renderRepoMap } from "./graph.js";

describe("isIgnored", () => {
  it("matches directory names, extension globs, and path prefixes", () => {
    const patterns = ["node_modules/", "*.pem", "src/gen/"];
    expect(isIgnored("node_modules/react/index.js", patterns)).toBe(true);
    expect(isIgnored("a/b/secret.pem", patterns)).toBe(true);
    expect(isIgnored("src/gen/types.ts", patterns)).toBe(true);
    expect(isIgnored("src/app.ts", patterns)).toBe(false);
  });
});

describe("extractGraph", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "graph-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  it("extracts symbols and resolves relative TS imports to files", () => {
    write("src/util.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    write(
      "src/index.ts",
      ["import { add } from './util';", "import express from 'express';", "export class App {}", "function boot() {}"].join("\n")
    );

    const graph = extractGraph(root);

    const fileNodes = graph.nodes.filter((node) => node.kind === "file").map((node) => node.path);
    expect(fileNodes).toEqual(expect.arrayContaining(["src/util.ts", "src/index.ts"]));

    const symbolNames = graph.nodes.filter((node) => node.kind === "symbol").map((node) => node.name);
    expect(symbolNames).toEqual(expect.arrayContaining(["add", "App", "boot"]));

    // Relative import resolves to the concrete file; bare import becomes external.
    const internal = graph.edges.find((edge) => edge.src === "src/index.ts" && edge.dst === "src/util.ts");
    const external = graph.edges.find((edge) => edge.src === "src/index.ts" && edge.dst === "ext:express");
    expect(internal).toBeDefined();
    expect(external).toBeDefined();
  });

  it("skips ignored directories and non-code files", () => {
    write("src/keep.ts", "export const x = 1;\n");
    write("node_modules/pkg/index.ts", "export const y = 2;\n");
    write("README.md", "# docs\n");

    const paths = extractGraph(root).nodes.filter((node) => node.kind === "file").map((node) => node.path);
    expect(paths).toContain("src/keep.ts");
    expect(paths).not.toContain("node_modules/pkg/index.ts");
    expect(paths).not.toContain("README.md");
  });

  it("limits scanning to included source paths", () => {
    write("src/app.cpp", '#include "app.h"\n');
    write("src/app.h", "#pragma once\n");
    write("Drivers/vendor.c", "void vendor(void) {}\n");
    write("Middlewares/stack.c", "void stack(void) {}\n");

    const paths = extractGraph(root, { include: ["src/"] }).nodes
      .filter((node) => node.kind === "file")
      .map((node) => node.path);

    expect(paths).toEqual(expect.arrayContaining(["src/app.cpp", "src/app.h"]));
    expect(paths).not.toContain("Drivers/vendor.c");
    expect(paths).not.toContain("Middlewares/stack.c");
  });

  it("counts each line as at most one symbol (no export double-count)", () => {
    write("a.ts", "export function only() {}\n");
    const symbols = extractGraph(root).nodes.filter((node) => node.kind === "symbol");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "only", symbolKind: "function", line: 1 });
  });

  it("extracts python defs and imports", () => {
    write("app.py", ["from os import path", "import sys", "def main():", "    pass", "class Service:", "    pass"].join("\n"));
    const graph = extractGraph(root);
    const symbols = graph.nodes.filter((node) => node.kind === "symbol").map((node) => node.name);
    expect(symbols).toEqual(expect.arrayContaining(["main", "Service"]));
    expect(graph.edges.map((edge) => edge.dst)).toEqual(expect.arrayContaining(["ext:os", "ext:sys"]));
  });

  it("resolves C/C++ includes to project files", () => {
    write("src/local.h", "#pragma once\n");
    write("include/project/core.hpp", "#pragma once\n");
    write("include/config.h", "#pragma once\n");
    write(
      "src/main.cpp",
      [
        '#include "local.h"',
        '#include "include/project/core.hpp"',
        '#include "config.h"',
        "#include <vector>",
        "int main() { return 0; }"
      ].join("\n")
    );

    const graph = extractGraph(root);
    const imports = graph.edges.filter((edge) => edge.src === "src/main.cpp").map((edge) => edge.dst);

    expect(imports).toEqual(
      expect.arrayContaining(["src/local.h", "include/project/core.hpp", "include/config.h", "ext:vector"])
    );
  });
});

describe("renderRepoMap", () => {
  it("renders a compact line per file with symbols, imports, and fan-in", () => {
    const out = renderRepoMap([
      {
        path: "src/util.ts",
        language: "ts",
        symbols: [{ name: "add", kind: "function" }],
        importsInternal: [],
        importsExternal: ["express"],
        usedByCount: 3,
        brief: "Shared math helpers.",
        manualPriority: 4,
        briefStale: true,
        selectionReason: "task"
      }
    ]);
    expect(out).toContain("Use this as a file-finding index");
    expect(out).toContain("`src/util.ts` (ts)");
    expect(out).toContain("priority 4");
    expect(out).toContain("task");
    expect(out).toContain("brief Shared math helpers. [stale]");
    expect(out).toContain("f:add");
    expect(out).toContain("express(ext)");
    expect(out).toContain("used-by 3");
  });

  it("falls back to a hint when empty", () => {
    expect(renderRepoMap([])).toContain("graph build");
  });
});
