import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { compileContext, checkInvocationBudget, normalizeProviderUsage } from "../packages/core/src/index.ts";
import { SQLiteMemoryStore } from "../packages/memory/src/sqlite-store.ts";

const [model, effort, destination] = process.argv.slice(2);
if (!model || !effort || !destination) throw new Error("Usage: tsx scripts/provider-pilot.mts <model> <effort> <output-directory>");
const output = resolve(destination);
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), "bridge-provider-pilot-"));
const store = new SQLiteMemoryStore(join(directory, "memories.db"));
const task = store.createTask({ title: "JavaScript ID validation", goal: "Implement validateId without changing letter case" });
const rules = ["Accept only string input; trim surrounding whitespace and preserve case.", "Reject an empty ID, non-ASCII characters, dots or slashes. Allow only ASCII letters, digits and underscore.", "Reject IDs longer than 10 characters after trimming; return the trimmed ID otherwise. Throw Error for rejection."];
rules.forEach((content) => store.addMemory({ taskId: task.id, type: "constraint", content }));
for (let index = 0; index < 25; index++) store.addMemory({ taskId: task.id, type: "note", content: `Unrelated archived deployment observation ${index}. ${"Historical service routing details, queue names and release dates are unrelated to ID validation. ".repeat(8)}`, dedupe: false });
const schema = join(directory, "response-schema.json");
writeFileSync(schema, JSON.stringify({ type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false }));
const version = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true }).stdout?.trim();
const attempts: Record<string, any>[] = [];
const fingerprints = Object.fromEntries(["packages/core/src/context-compiler.ts", "packages/core/src/context-allocation.ts", "packages/memory/src/memory-repository.ts", "pnpm-lock.yaml", "scripts/provider-pilot.mts"].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
function quality(code: string, stage: number) {
  const cases: Array<[unknown, string | null]> = [[" Ab2 ", "Ab2"], ["abc", "abc"], ["", null], ["   ", null], [null, null], [123, null], ["数据库", null], ["a/b", null], ["a.b", null], ["A-B", null], ["Ab_2", stage ? null : "Ab_2"], ["ABCDEFGHI", stage ? null : "ABCDEFGHI"], ["abcdefghijk", null]];
  try {
    return cases.every(([input, expected]) => {
      try { return runInNewContext(`${code}; validateId(${JSON.stringify(input)})`, {}, { timeout: 1000 }) === expected; }
      catch { return expected === null; }
    });
  } catch { return false; }
}
async function invoke(prompt: string, id: string) {
  const assessment = checkInvocationBudget(prompt);
  const message = join(output, `${id}.message.json`);
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'approval_policy="never"', "--model", model, "-c", `model_reasoning_effort="${effort}"`, "--json", "--output-schema", schema, "--output-last-message", message, "-"];
  const started = performance.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timeout: boolean }>((resolveResult, reject) => {
    const child = spawn("codex", args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = ""; let timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 90000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolveResult({ code, stdout, stderr, timeout }); });
    child.stdin.end(prompt);
  });
  writeFileSync(join(output, `${id}.prompt.txt`), prompt);
  writeFileSync(join(output, `${id}.events.jsonl`), result.stdout);
  writeFileSync(join(output, `${id}.stderr.log`), result.stderr);
  let rawUsage: unknown;
  let usedTools = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed") rawUsage = event.usage;
      if (event.item?.type && !["agent_message", "reasoning"].includes(event.item.type)) usedTools = true;
    } catch {}
  }
  let code = "";
  try { code = JSON.parse(readFileSync(message, "utf8")).code; } catch {}
  return { ...result, stdout: undefined, stderr: undefined, codeText: code, usedTools, usage: normalizeProviderUsage(rawUsage), rawUsage, durationMs: performance.now() - started, assessment };
}
try {
  let infraFailures = 0;
  for (const workflow of ["independent", "sequential"]) {
    for (let pair = 0; pair < 5; pair++) {
      const order = pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
      for (const condition of order) {
        let previous = "";
        for (let stage = 0; stage < (workflow === "sequential" ? 2 : 1); stage++) {
          const request = stage ? "Update validateId: now reject underscore and limit trimmed IDs to 8 characters. Preserve every other rule. Return the complete replacement function." : "Implement a complete JavaScript function validateId(value) following all active constraints.";
          const handoff = previous ? `Previous accepted implementation (recheck against current request):\n${previous}` : "";
          const context = condition === "candidate" ? compileContext(store, { taskId: task.id, agent: "codex", tokenBudget: 1500, currentRequest: request, includeFiles: false }).renderedMarkdown
            : JSON.stringify({ task, memories: store.listMemoriesForTask(task.id, 1000) });
          const prompt = `This is an isolated, no-tool coding evaluation. Do not call tools or inspect files. All needed context is included. Return only the requested JSON with complete function code, no module exports.\nCurrent request: ${request}\n${handoff}\nContext:\n${context}`;
          const id = `${workflow}-${pair}-${condition}-${stage}`;
          const result = await invoke(prompt, id);
          const passed = result.code === 0 && !result.usedTools && quality(result.codeText, stage);
          attempts.push({ id, workflow, pair, condition, stage, ...result, qualityPassed: passed });
          previous = result.codeText;
          if (result.code !== 0) infraFailures++;
          writeFileSync(join(output, "attempts.json"), JSON.stringify({ model, effort, version, fingerprints, attempts }, null, 2));
          process.stdout.write(`${JSON.stringify({ id, passed, input: result.usage.input, output: result.usage.output, durationMs: result.durationMs, exitCode: result.code })}\n`);
          if (infraFailures >= 2) throw new Error("Provider pilot stopped after two infrastructure failures; retained every attempt");
        }
      }
    }
  }
  const groups = ["independent", "sequential"].map((workflow) => ({ workflow, conditions: ["baseline", "candidate"].map((condition) => {
    const group = attempts.filter((attempt) => attempt.workflow === workflow && attempt.condition === condition);
    const sum = (key: string) => group.every((attempt) => attempt.usage[key] !== null) ? group.reduce((total, attempt) => total + attempt.usage[key], 0) : null;
    return { condition, attempts: group.length, qualityPassed: group.filter((attempt) => attempt.qualityPassed).length, input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), latencyMs: group.reduce((total, attempt) => total + attempt.durationMs, 0) };
  }) }));
  writeFileSync(join(output, "summary.json"), JSON.stringify({ schemaVersion: 1, model, effort, version, fingerprints, groups,
    scope: "Five alternating paired runs per workflow; one small no-tool function task, explicit sequential handoff, CLI context injection only. Does not establish savings for other providers or general workflows.", costSavings: null }, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
