import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Knowledge graph: a lightweight, language-agnostic map of a repository's files,
// the symbols they define, and the import edges between them. The goal is to let
// an agent understand a repo and find the right file WITHOUT reading every file —
// a compact graph costs far fewer tokens than raw source.
//
// Extraction is heuristic (regex/line-scan), not a real parser: ~80% accurate,
// zero extra dependencies, runs on any repo. JS/TS relative imports are resolved
// to concrete files; everything else is recorded as an external module edge.

export type GraphNodeKind = "file" | "symbol";

export type GraphNode = {
  // file: the repo-relative posix path. symbol: `<path>#<name>@<line>`.
  id: string;
  kind: GraphNodeKind;
  path: string;
  name?: string;
  language?: string;
  symbolKind?: string;
  line?: number;
  signature?: string;
  contentHash?: string;
};

export type GraphEdge = {
  src: string; // file node id
  dst: string; // resolved file node id, or `ext:<module>` for externals
  kind: "imports";
  raw?: string; // original import specifier
};

export type ExtractedGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type RepoMapFile = {
  path: string;
  language?: string;
  symbols: { name: string; kind: string }[];
  importsInternal: string[];
  importsExternal: string[];
  usedByCount: number;
  brief?: string;
  manualPriority?: number;
  briefStale?: boolean;
  selectionReason?: "task" | "neighbor" | "structural";
};

type SymbolRule = { kind: string; regex: RegExp };

type LanguageRule = {
  language: string;
  imports: RegExp[]; // each captures the specifier in group 1
  symbols: SymbolRule[]; // each captures the symbol name in group 1; first match per line wins
  // Import resolution mode. JS resolves only relative package specifiers; C/C++
  // includes also try project-root paths and unique header suffixes.
  resolve: "js" | "cInclude" | false;
};

const JS_TS: LanguageRule = {
  language: "ts",
  imports: [
    /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  ],
  symbols: [
    { kind: "function", regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/ },
    { kind: "function", regex: /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/ },
    { kind: "class", regex: /^\s*export\s+(?:default\s+|abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: "class", regex: /^\s*(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: "interface", regex: /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/ },
    { kind: "interface", regex: /^\s*interface\s+([A-Za-z0-9_$]+)/ },
    { kind: "enum", regex: /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/ },
    { kind: "type", regex: /^\s*export\s+type\s+([A-Za-z0-9_$]+)/ },
    { kind: "type", regex: /^\s*type\s+([A-Za-z0-9_$]+)\s*[<=]/ },
    { kind: "const", regex: /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/ }
  ],
  resolve: "js"
};

const PYTHON: LanguageRule = {
  language: "py",
  imports: [/^\s*from\s+([A-Za-z0-9_.]+)\s+import/gm, /^\s*import\s+([A-Za-z0-9_.]+)/gm],
  symbols: [
    { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
    { kind: "class", regex: /^\s*class\s+([A-Za-z0-9_]+)/ }
  ],
  resolve: false
};

const GO: LanguageRule = {
  language: "go",
  imports: [/^\s*(?:import\s+)?"([A-Za-z0-9_./-]+)"\s*$/gm],
  symbols: [
    { kind: "function", regex: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/ },
    { kind: "type", regex: /^\s*type\s+([A-Za-z0-9_]+)/ }
  ],
  resolve: false
};

const RUST: LanguageRule = {
  language: "rs",
  imports: [/^\s*use\s+([A-Za-z0-9_:]+)/gm],
  symbols: [
    { kind: "function", regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
    { kind: "struct", regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/ },
    { kind: "enum", regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/ },
    { kind: "trait", regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/ }
  ],
  resolve: false
};

const JAVA: LanguageRule = {
  language: "java",
  imports: [/^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)/gm],
  symbols: [
    { kind: "class", regex: /\bclass\s+([A-Za-z0-9_]+)/ },
    { kind: "interface", regex: /\binterface\s+([A-Za-z0-9_]+)/ },
    { kind: "enum", regex: /\benum\s+([A-Za-z0-9_]+)/ }
  ],
  resolve: false
};

const C_LIKE: LanguageRule = {
  language: "c",
  imports: [/^\s*#include\s+["<]([^">]+)[">]/gm],
  symbols: [],
  resolve: "cInclude"
};

// Extension -> language rule. Extensions absent here are skipped entirely so the
// graph stays code-focused (no docs/assets noise).
const RULES_BY_EXT: Record<string, LanguageRule> = {
  ".ts": JS_TS,
  ".tsx": { ...JS_TS, language: "tsx" },
  ".mts": JS_TS,
  ".cts": JS_TS,
  ".js": { ...JS_TS, language: "js" },
  ".jsx": { ...JS_TS, language: "jsx" },
  ".mjs": { ...JS_TS, language: "js" },
  ".cjs": { ...JS_TS, language: "js" },
  ".py": PYTHON,
  ".go": GO,
  ".rs": RUST,
  ".java": JAVA,
  ".kt": JAVA,
  ".c": C_LIKE,
  ".h": C_LIKE,
  ".cc": { ...C_LIKE, language: "cpp" },
  ".cxx": { ...C_LIKE, language: "cpp" },
  ".cpp": { ...C_LIKE, language: "cpp" },
  ".hh": { ...C_LIKE, language: "cpp" },
  ".hpp": { ...C_LIKE, language: "cpp" },
  ".hxx": { ...C_LIKE, language: "cpp" }
};

// Resolution candidates for a JS/TS relative import with no explicit extension.
const JS_RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];

const DEFAULT_IGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  ".git/",
  "coverage/",
  ".cache/",
  ".next/",
  ".vite/",
  ".agent-memory/"
];

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export type ExtractGraphOptions = {
  // Glob-ish ignore patterns. Directory names ("node_modules/"), extension globs
  // ("*.pem"), and path prefixes ("src/gen/") are supported.
  ignore?: string[];
  // Optional allowlist of repo-relative paths to scan. Empty means scan all
  // non-ignored code files.
  include?: string[];
  maxFileBytes?: number;
};

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function extname(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

// Lightweight ignore matcher covering the patterns we generate in config:
// bare names match any path segment, "*.ext" matches the basename extension,
// and patterns with "/" match a path prefix.
export function isIgnored(relPath: string, patterns: string[]): boolean {
  const posix = toPosix(relPath);
  const segments = posix.split("/");
  const base = segments[segments.length - 1];
  for (const rawPattern of patterns) {
    const pattern = rawPattern.replace(/\/+$/, "");
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      if (base.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (pattern.includes("/")) {
      if (posix === pattern || posix.startsWith(`${pattern}/`)) return true;
      continue;
    }
    if (segments.includes(pattern) || base === pattern) return true;
  }
  return false;
}

// True for files the graph would index: a recognized source extension that is not
// in a conventionally-ignored location. Gates on-the-fly briefing so it fires for
// code only, never vendored/generated/binary files.
export function isGraphSourceFile(relPath: string): boolean {
  const norm = toPosix(relPath);
  if (!RULES_BY_EXT[extname(norm)]) return false;
  return !isIgnored(norm, DEFAULT_IGNORE);
}

function normalizePattern(rawPattern: string): string {
  return toPosix(rawPattern).replace(/^\/+|\/+$/g, "");
}

function isIncluded(relPath: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  const posix = toPosix(relPath);
  const segments = posix.split("/");
  const base = segments[segments.length - 1];
  return patterns.some((rawPattern) => {
    const pattern = normalizePattern(rawPattern);
    if (!pattern) return false;
    if (pattern.startsWith("*.")) return base.endsWith(pattern.slice(1));
    if (pattern.includes("/")) return posix === pattern || posix.startsWith(`${pattern}/`);
    return segments.includes(pattern) || posix === pattern || posix.startsWith(`${pattern}/`);
  });
}

function shouldDescend(relDir: string, include: string[]): boolean {
  if (!include.length) return true;
  const dir = normalizePattern(relDir);
  if (!dir) return true;
  return include.some((rawPattern) => {
    const pattern = normalizePattern(rawPattern);
    if (!pattern || pattern.startsWith("*.")) return true;
    return pattern === dir || pattern.startsWith(`${dir}/`) || dir.startsWith(`${pattern}/`);
  });
}

function walk(root: string, ignore: string[], include: string[]): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(root, full));
      if (isIgnored(rel, ignore)) continue;
      if (entry.isDirectory()) {
        if (shouldDescend(rel, include)) stack.push(full);
      } else if (entry.isFile()) {
        if (isIncluded(rel, include)) out.push(rel);
      }
    }
  }
  return out.sort();
}

// Extract symbols from file text. Each line yields at most one symbol (the
// highest-priority rule that matches), so `export function` is not double-counted.
function extractSymbols(path: string, language: string, rules: SymbolRule[], text: string): GraphNode[] {
  if (!rules.length) return [];
  const nodes: GraphNode[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      const match = rule.regex.exec(line);
      if (match && match[1]) {
        const name = match[1];
        nodes.push({
          id: `${path}#${name}@${i + 1}`,
          kind: "symbol",
          path,
          name,
          language,
          symbolKind: rule.kind,
          line: i + 1,
          signature: line.trim().slice(0, 200)
        });
        break;
      }
    }
  }
  return nodes;
}

function extractImports(rule: LanguageRule, text: string): string[] {
  const specifiers = new Set<string>();
  for (const regex of rule.imports) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) specifiers.add(match[1]);
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return [...specifiers];
}

// Top-level external module name: "react" from "react/jsx", "@scope/pkg" from
// "@scope/pkg/sub". For non-bare specifiers, the raw value is used.
function externalModuleName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

// Resolve a JS/TS relative import to a known repo file. Returns the file path or
// undefined when it cannot be matched (then it is treated as external). Handles
// the TS ESM convention where a `.js` specifier actually points at a `.ts` source
// (so `./util.js` resolves to `util.ts`).
function resolveRelative(fromDir: string, specifier: string, fileSet: Set<string>): string | undefined {
  const base = toPosix(join(fromDir, specifier));
  const withoutExt = base.replace(/\.(js|jsx|mjs|cjs|mts|cts)$/, "");
  const candidates = new Set<string>([base]);
  for (const ext of JS_RESOLVE_EXTENSIONS) {
    candidates.add(`${withoutExt}${ext}`);
    candidates.add(`${withoutExt}/index${ext}`);
  }
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveCInclude(fromDir: string, specifier: string, fileSet: Set<string>): string | undefined {
  const candidates = new Set<string>([toPosix(join(fromDir, specifier)), toPosix(specifier)]);
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }

  const suffix = `/${specifier}`;
  const suffixMatches = [...fileSet].filter((file) => file.endsWith(suffix));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function extractGraph(root: string, options: ExtractGraphOptions = {}): ExtractedGraph {
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const include = options.include ?? [];
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const relPaths = walk(root, ignore, include).filter((rel) => RULES_BY_EXT[extname(rel)]);
  const fileSet = new Set(relPaths);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const rel of relPaths) {
    const rule = RULES_BY_EXT[extname(rel)];
    let text: string;
    try {
      if (statSync(join(root, rel)).size > maxBytes) {
        nodes.push({ id: rel, kind: "file", path: rel, language: rule.language });
        continue;
      }
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }

    nodes.push({ id: rel, kind: "file", path: rel, language: rule.language, contentHash: sha256(text) });
    nodes.push(...extractSymbols(rel, rule.language, rule.symbols, text));

    const fromDir = dirOf(rel);
    for (const specifier of extractImports(rule, text)) {
      let dst: string;
      if (rule.resolve === "js" && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        const resolved = resolveRelative(fromDir, specifier, fileSet);
        dst = resolved ?? `ext:${specifier}`;
      } else if (rule.resolve === "cInclude") {
        const resolved = resolveCInclude(fromDir, specifier, fileSet);
        dst = resolved ?? `ext:${specifier}`;
      } else {
        dst = `ext:${externalModuleName(specifier)}`;
      }
      edges.push({ src: rel, dst, kind: "imports", raw: specifier });
    }
  }

  return { nodes, edges };
}

// Render a compact, task-centred repo map. Files are expected pre-sorted by the
// selector so an agent can navigate the repo without reading every file.
export function renderRepoMap(files: RepoMapFile[], maxSymbolsPerFile = 6): string {
  if (!files.length) return "No repo graph. Run `agent-bridge graph build`.";
  const lines: string[] = [
    "Use this as a file-finding index: prefer paths whose symbol/imports/brief match the task, then open only those files. Briefs are optional and only maintained for important or previously used files; do not load every brief."
  ];
  for (const file of files) {
    const parts: string[] = [`\`${file.path}\``];
    if (file.language) parts[0] += ` (${file.language})`;
    if (file.manualPriority != null) parts.push(`priority ${file.manualPriority}`);
    if (file.selectionReason) parts.push(file.selectionReason);
    if (file.brief) parts.push(`brief ${file.brief}${file.briefStale ? " [stale]" : ""}`);
    if (file.symbols.length) {
      const shown = file.symbols
        .slice(0, maxSymbolsPerFile)
        .map((symbol) => `${symbol.kind[0]}:${symbol.name}`)
        .join(", ");
      const extra = file.symbols.length > maxSymbolsPerFile ? ` +${file.symbols.length - maxSymbolsPerFile}` : "";
      parts.push(`def ${shown}${extra}`);
    }
    const imps = [...file.importsInternal, ...file.importsExternal.map((name) => `${name}(ext)`)];
    if (imps.length) parts.push(`imports ${imps.slice(0, 8).join(", ")}`);
    if (file.usedByCount) parts.push(`used-by ${file.usedByCount}`);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}
