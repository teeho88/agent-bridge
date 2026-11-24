import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexManagedSection } from "../packages/adapters/dist/codex.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v3 = resolve(process.argv[2] ?? join(root, "../bridge-workflow-evaluation-v3-20261012"));
const output = resolve(process.argv[3] ?? join(root, "docs/bridge-uncached-candidate-20261013.json"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const original = JSON.parse(readFileSync(join(v3, "protocol/manifest.json"), "utf8"));
const frozen = JSON.parse(readFileSync(join(v3, "protocol/content-hashes.json"), "utf8"));
for (const [path, expected] of Object.entries(frozen)) {
  if (hash(join(v3, "protocol", path)) !== expected) throw new Error(`Frozen v3 mismatch: ${path}`);
}
const files = {};
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile()) files[relative(root, path).replaceAll("\\", "/")] = hash(path);
  }
}
for (const pkg of ["memory", "core", "adapters", "cli"]) {
  collect(join(root, "packages", pkg, "src"));
  collect(join(root, "packages", pkg, "dist"));
  files[`packages/${pkg}/package.json`] = hash(join(root, "packages", pkg, "package.json"));
}
for (const path of ["package.json", "pnpm-lock.yaml", "scripts/bridge-uncached-smoke.mjs", "scripts/diagnose-bridge-uncached-v3.mjs", "scripts/freeze-bridge-uncached-candidate.mjs"]) files[path] = hash(join(root, path));
const instructionsPath = join(root, "docs/bridge-uncached-candidate-instructions-20261013.md");
writeFileSync(instructionsPath, `${codexManagedSection({ hooked: false })}\n`);
const smoke = JSON.parse(readFileSync(join(root, "docs/bridge-uncached-smoke-20261013.json"), "utf8"));
if (!smoke.passed || smoke.providerInvocations !== 0) throw new Error("Missing no-model smoke pass");
const manifest = {
  schemaVersion: 1, createdAt: new Date().toISOString(), status: "implementation fingerprint; provider evaluation pending",
  files, filesHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  node: { version: process.version, executableHash: hash(process.execPath) },
  instructions: { path: relative(root, instructionsPath).replaceAll("\\", "/"), sha256: hash(instructionsPath) },
  lifecycle: "manual: task start creates A session; session start B/C/D; no duplicate session; session end after writers stop",
  hooks: [], workflow: "full", contextBudget: 4000, tokenizer: "script-aware-v1 heuristic; no precise counter override",
  retrieval: "lexical; no embedding provider; query only for missing evidence", model: original.model, effort: original.effort,
  compaction: original.compaction, schedule: original.schedule, cacheControl: original.cacheControl,
  workload: original.workload, v3: { root: v3, checkedFiles: Object.keys(frozen).length, manifestHash: hash(join(v3, "protocol/manifest.json")) },
  referenceHarnessHashes: original.harnessHashes, referenceEvaluatorHashes: original.evaluatorHashes,
  preflight: { smokeReport: "docs/bridge-uncached-smoke-20261013.json", smokeHash: hash(join(root, "docs/bridge-uncached-smoke-20261013.json")), cliChecks: smoke.checks.length, providerInvocations: 0 },
  providerEvaluation: { smokeInvocations: 0, formalInvocations: 0, uncachedReduction: null,
    requiredBeforeRun: ["Package isolated candidate runtime and hash all dependencies", "Freeze adapted candidate prompts and recorder/harness in a new workspace", "Verify ordinary quota with no purchase/overage", "Run 4 provider smoke sessions before locking 24 formal sessions" ] }
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ files: Object.keys(files).length, v3Checked: Object.keys(frozen).length, output }));
