// Auto-brief generation. The repo map already shows each file's symbols,
// imports, and fan-in, so a brief that merely restates them wastes tokens. The
// highest-signal thing we can add WITHOUT an LLM is the file's own intent:
//  - its leading header/doc comment (human-written purpose), and
//  - a role label inferred from path/name conventions.
// These functions are pure so they can be unit-tested; graph.ts wires them to
// the indexed symbol/import data.

export type BriefSymbol = { name: string; kind: string };

export type ComposeBriefInput = {
  path: string;
  language?: string;
  symbols: BriefSymbol[];
  importsInternal: string[];
  importsExternal: string[];
  dependentsCount: number;
  docComment?: string;
};

const LANGUAGE_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++"
};

function languageLabel(language?: string): string {
  return (language && LANGUAGE_LABELS[language]) || "Code";
}

function basenameOf(path: string): string {
  return path.split("/").pop() || path;
}

// Name a test file's subject from its internal imports. Prefer the import whose
// basename matches the test's own name (foo.test.ts -> foo), else the first
// non-test, non-barrel import.
function subjectOfTest(importsInternal: string[], testName: string): string | undefined {
  const bases = importsInternal
    .map((imp) => (imp.split("/").pop() || "").replace(/\.[cm]?[jt]sx?$/, ""))
    .filter((base) => base && !/test|spec/i.test(base) && base !== "index");
  return bases.find((base) => base === testName) ?? bases[0];
}

const SYMBOL_PRIORITY: Record<string, number> = {
  class: 0,
  struct: 0,
  trait: 1,
  interface: 1,
  function: 2,
  enum: 3,
  type: 4,
  const: 5
};

// The single most representative symbol: prefer a definition (class/function)
// over a type alias or const, then fall back to source order.
export function pickPrimarySymbol(symbols: BriefSymbol[]): BriefSymbol | undefined {
  let best: BriefSymbol | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  symbols.forEach((symbol) => {
    const rank = SYMBOL_PRIORITY[symbol.kind] ?? 6;
    if (rank < bestRank) {
      bestRank = rank;
      best = symbol;
    }
  });
  return best;
}

export function inferFileRole(
  path: string,
  language: string | undefined,
  symbols: BriefSymbol[],
  importsInternal: string[]
): string {
  const base = basenameOf(path);
  const lower = base.toLowerCase();
  const label = languageLabel(language);

  const testMatch = /^(.*)\.(test|spec)\.[cm]?[jt]sx?$/.exec(lower);
  if (testMatch) {
    const subject = subjectOfTest(importsInternal, testMatch[1]);
    return subject ? `Test suite for ${subject}` : "Test suite";
  }
  if (/^index\.[cm]?[jt]sx?$/.test(lower)) return `${label} module entry point (barrel)`;
  if (path.includes("/commands/")) return "CLI command module";
  if (lower === "package.json" || lower === "tsconfig.json" || /\.config\.[cm]?[jt]s$/.test(lower)) {
    return "Configuration";
  }
  if (
    lower === "types.ts" ||
    (symbols.length > 0 && symbols.every((symbol) => ["type", "interface", "enum"].includes(symbol.kind)))
  ) {
    return "Type definitions";
  }
  if ((language === "tsx" || language === "jsx") && symbols.some((symbol) => /^[A-Z]/.test(symbol.name))) {
    return "UI component";
  }
  return `${label} module`;
}

// First one or two sentences of a doc comment, whitespace-collapsed and capped.
function firstSentences(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = sentences.slice(0, max).join(" ").trim();
  if (out.length > 220) out = `${out.slice(0, 217).trimEnd()}…`;
  return out;
}

function ensurePeriod(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

// Read a comment block (block, line-run, or python docstring) starting exactly
// at line `start`. Returns the cleaned prose, or "" if line `start` is not a
// comment.
function readCommentAt(lines: string[], start: number): string {
  const collected: string[] = [];
  let i = start;
  if (i < lines.length && lines[i].trimStart().startsWith("/*")) {
    for (; i < lines.length; i++) {
      const hasEnd = lines[i].includes("*/");
      collected.push(
        lines[i]
          .replace(/^\s*\/\*+/, "")
          .replace(/\*\/\s*$/, "")
          .replace(/^\s*\*\s?/, "")
      );
      if (hasEnd) break;
    }
  } else {
    const lineComment = /^\s*(\/\/+|#)\s?/;
    while (i < lines.length && lineComment.test(lines[i])) {
      collected.push(lines[i].replace(lineComment, ""));
      i++;
    }
    if (!collected.length && i < lines.length && /^\s*("""|''')/.test(lines[i])) {
      const quote = lines[i].trim().slice(0, 3);
      const firstRest = lines[i].trim().slice(3);
      if (firstRest.includes(quote)) {
        collected.push(firstRest.slice(0, firstRest.indexOf(quote)));
      } else {
        collected.push(firstRest);
        for (i += 1; i < lines.length; i++) {
          if (lines[i].includes(quote)) {
            collected.push(lines[i].slice(0, lines[i].indexOf(quote)));
            break;
          }
          collected.push(lines[i]);
        }
      }
    }
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

const IMPORT_LINE = /^\s*(import\b|export\b[^;]*\bfrom\b|export\s+\*|(?:const|let|var)\b[^=]*=\s*require\(|require\(|['"]use strict['"])/;

// Pull the file's leading header/doc comment as plain prose. Looks at the very
// top first, then just past a leading import block (the common TS layout where
// the module comment follows the imports). Returns undefined for license
// headers, pragma-only comments, or when there is no usable comment.
export function extractLeadingDoc(text: string): string | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("#!"))) i++;

  let doc = readCommentAt(lines, i);
  if (!doc) {
    let j = i;
    while (j < lines.length && (lines[j].trim() === "" || IMPORT_LINE.test(lines[j]))) j++;
    if (j > i) doc = readCommentAt(lines, j);
  }

  if (!doc) return undefined;
  if (/^@/.test(doc)) return undefined; // JSDoc tag-only comment, no prose.
  if (/^(copyright\b|spdx-|licensed under|all rights reserved|eslint-|@ts-|prettier-ignore|@flow|use strict)/i.test(doc)) {
    return undefined;
  }
  return doc;
}

export function composeBrief(input: ComposeBriefInput): string {
  const role = inferFileRole(input.path, input.language, input.symbols, input.importsInternal);
  const purpose = input.docComment ? firstSentences(input.docComment, 2) : undefined;
  if (purpose) return `${role}. ${ensurePeriod(purpose)}`;

  const primary = pickPrimarySymbol(input.symbols);
  if (primary?.name) {
    const extra = input.symbols.length > 1 ? ` (+${input.symbols.length - 1} more)` : "";
    return `${role}. Defines ${primary.kind} ${primary.name}${extra}.`;
  }
  return `${role}.`;
}
