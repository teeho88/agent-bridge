import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/check-runtime-cycles.mjs <report.json>");
const roots = ["memory", "core", "adapters", "cli"].map((name) => `packages/${name}/dist`);
const files = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name).replaceAll("\\", "/");
    if (item.isDirectory()) walk(file);
    else if (file.endsWith(".js") && !file.endsWith(".test.js")) files.push(file);
  }
}
roots.forEach(walk);
const known = new Set(files);
const graph = new Map();
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edges = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier?.text;
    if (!specifier) continue;
    const target = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : specifier.startsWith("@agent-bridge/") ? `packages/${specifier.slice(14)}/dist/index.js` : null;
    if (known.has(target)) edges.push(target);
  }
  graph.set(file, edges);
}
let index = 0;
const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), cycles = [];
function visit(node) {
  indices.set(node, index); low.set(node, index++); stack.push(node); onStack.add(node);
  for (const next of graph.get(node)) {
    if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
    else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
  }
  if (low.get(node) === indices.get(node)) {
    const component = [];
    let next;
    do { next = stack.pop(); onStack.delete(next); component.push(next); } while (next !== node);
    if (component.length > 1 || graph.get(node).includes(node)) cycles.push(component);
  }
}
files.forEach((file) => { if (!indices.has(file)) visit(file); });
const result = { timestamp: new Date().toISOString(), runtimeModules: files.length,
  scope: "Emitted JavaScript static runtime imports and re-exports across four workspace packages; test modules excluded",
  runtimeCycles: cycles };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ runtimeModules: files.length, runtimeCycles: cycles.length }) + "\n");
if (cycles.length) process.exitCode = 1;
