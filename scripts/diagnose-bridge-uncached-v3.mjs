import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.argv[2];
const outArg = process.argv.indexOf("--out-dir");
if (!root || (outArg >= 0 && !process.argv[outArg + 1])) {
  throw new Error("Usage: node scripts/diagnose-bridge-uncached-v3.mjs <v3-root> [--out-dir <directory>]");
}
const out = resolve(outArg >= 0 ? process.argv[outArg + 1] : "docs");
const evidenceDir = join(resolve(root), "evidence");
const audit = JSON.parse(readFileSync(join(root, "reports", "audit.json"), "utf8"));
const formal = audit.rows.filter((row) => /^pair-[1-3]-(?:baseline|bridge)-[ABCD]$/.test(row.id));
if (formal.length !== 24) throw new Error(`Expected 24 formal rows, found ${formal.length}`);

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function phaseOf(input) {
  const command = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const phases = [];
  if (/\b(?:session start|context (?:startup|bootstrap|compile)|current-task|AGENTS\.md)\b/i.test(command)) phases.push("startup");
  if (/\b(?:handoff|context (?:query|expand)|memory (?:add|search|list)|shipping rule|decision)\b/i.test(command)) phases.push("takeover-memory");
  if (/\b(?:verify\.mjs|(?:npm|pnpm|node) test|vitest|regression|test\.js)\b/i.test(command)) phases.push("verification");
  if (/\b(?:apply_patch|writeFileSync|src[\\/]order\.js|patch)\b/i.test(command)) phases.push("product-change");
  if (/\b(?:readFileSync|Get-Content|(?:sed|grep|rg)\b)\b/i.test(command)) phases.push("source-read");
  return [...new Set(phases)];
}

function classify(calls) {
  const distinct = [...new Set(calls.flatMap((call) => call.phases))];
  if (!calls.length) return "no-tool-observed";
  if (distinct.length === 0) return "unknown";
  return distinct.length === 1 ? distinct[0] : "mixed/uncertain";
}

const sessions = [];
for (const row of formal) {
  const events = jsonl(join(evidenceDir, `${row.id}.rollout.jsonl`));
  const calls = new Map();
  let since = [];
  let ordinal = 0;
  const requests = [];
  for (const event of events) {
    if (event.type === "response_item" && event.payload.type === "custom_tool_call") {
      const item = { name: event.payload.name, phases: phaseOf(event.payload.input), outputBytes: 0, outputChars: 0 };
      calls.set(event.payload.call_id, item);
      since.push(item);
    } else if (event.type === "response_item" && event.payload.type === "custom_tool_call_output") {
      const item = calls.get(event.payload.call_id);
      if (item) {
        const output = typeof event.payload.output === "string" ? event.payload.output : JSON.stringify(event.payload.output ?? "");
        item.outputBytes += Buffer.byteLength(output, "utf8");
        item.outputChars += output.length;
      }
    } else if (event.type === "token_usage_record") {
      const usage = event.payload.usage;
      if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.cached_input_tokens)) {
        throw new Error(`Malformed usage in ${row.id} at ordinal ${event.ordinal}`);
      }
      requests.push({
        request: ++ordinal, timestamp: event.timestamp,
        input: usage.input_tokens, cachedInput: usage.cached_input_tokens,
        uncachedInput: usage.input_tokens - usage.cached_input_tokens,
        output: usage.output_tokens, reasoning: usage.reasoning_output_tokens,
        observedToolEventsNearRecord: since,
        phase: classify(since),
      });
      since = [];
    }
  }
  for (const request of requests) {
    request.toolOutputBytesNearRecord = request.observedToolEventsNearRecord.reduce((sum, item) => sum + item.outputBytes, 0);
    request.toolOutputCharsNearRecord = request.observedToolEventsNearRecord.reduce((sum, item) => sum + item.outputChars, 0);
  }
  const total = (key) => requests.reduce((sum, request) => sum + request[key], 0);
  for (const [key, expected] of [["input", row.usage.input], ["cachedInput", row.usage.cacheRead], ["uncachedInput", row.usage.uncached], ["output", row.usage.output], ["reasoning", row.usage.reasoning]]) {
    if (total(key) !== expected) throw new Error(`${row.id} ${key}: raw ${total(key)} != audit ${expected}`);
  }
  const ioPath = readdirSync(evidenceDir).find((name) => name.startsWith(`${row.id}-`) && name.endsWith(".io.jsonl"));
  const io = ioPath ? jsonl(join(evidenceDir, ioPath)) : [];
  const operations = {};
  for (const entry of io) operations[entry.operation ?? "unknown"] = (operations[entry.operation ?? "unknown"] ?? 0) + 1;
  sessions.push({
    id: row.id, pair: row.pair, branch: row.branch, stage: row.stage,
    usage: { input: total("input"), cachedInput: total("cachedInput"), uncachedInput: total("uncachedInput"), output: total("output"), reasoning: total("reasoning") },
    modelRequests: requests.length,
    observedToolEvents: requests.reduce((sum, item) => sum + item.observedToolEventsNearRecord.length, 0) + since.length,
    trailingToolEvents: since.length,
    toolOutputBytesNearRecords: total("toolOutputBytesNearRecord"),
    trace: { cliToolCalls: row.overhead.toolCalls, sourceReads: row.overhead.sourceReadCount, contextReads: row.overhead.contextReads?.length ?? 0,
      compile: row.overhead.compile, query: row.overhead.query, handoffWrite: row.overhead.handoffWrite,
      sessionStart: row.overhead.sessionStart, artifactReadBytes: row.overhead.artifactReadBytes,
      ioOperations: operations },
    requests
  });
}

const branchTotals = {};
for (const branch of ["baseline", "bridge"]) {
  const set = sessions.filter((session) => session.branch === branch);
  branchTotals[branch] = {
    uncached: set.reduce((sum, item) => sum + item.usage.uncachedInput, 0),
    input: set.reduce((sum, item) => sum + item.usage.input, 0),
    output: set.reduce((sum, item) => sum + item.usage.output, 0),
    modelRequests: set.reduce((sum, item) => sum + item.modelRequests, 0),
    firstRequestUncached: set.reduce((sum, item) => sum + (item.requests[0]?.uncachedInput ?? 0), 0),
    toolOutputBytes: set.reduce((sum, item) => sum + item.toolOutputBytesNearRecords, 0)
  };
  if (branchTotals[branch].uncached !== audit.totals[branch].uncached) throw new Error(`Raw ${branch} uncached does not match audit`);
}
const pair2D = sessions.filter((session) => session.pair === 2 && session.stage === 4);
const diagnostic = {
  source: "v3 formal rollout token_usage_record + audit.json (read only)",
    warning: "Tool events are observed near token records; output can arrive after its usage record. No tool bytes or phase are causally assigned provider tokens. CLI/IO observations are separate counters.",
  formalSessions: sessions.length, branchTotals, sessions,
  pair2D: pair2D.map(({ id, usage, modelRequests, observedToolEvents, trace }) => ({ id, usage, modelRequests, observedToolEvents, trace }))
};

const rows = sessions.map((s) => `| ${s.id} | ${s.modelRequests} | ${s.usage.uncachedInput.toLocaleString("en-US")} | ${s.usage.cachedInput.toLocaleString("en-US")} | ${s.observedToolEvents} | ${s.trace.sourceReads} | ${s.trace.compile} | ${s.trace.query} | ${s.toolOutputBytesNearRecords.toLocaleString("en-US")} |`);
const selected = pair2D.map((s) => `- ${s.id}: ${s.modelRequests} model requests; ${s.usage.uncachedInput.toLocaleString("en-US")} uncached; ${s.trace.sourceReads} source reads; ${s.trace.toolCalls ?? s.trace.cliToolCalls} wrapper tool calls; ${s.trace.compile} compiles; ${s.trace.query} queries.`);
const report = [
  "# Chẩn đoán uncached input formal v3 (read only)", "",
  "Nguồn: 24 session formal từ `audit.json`, `*.rollout.jsonl` và IO trace. Raw request usage đối soát chính xác với audit. Evidence v3 không bị sửa.", "",
  "## Tổng provider usage", "",
  `- Baseline: ${branchTotals.baseline.uncached.toLocaleString("en-US")} uncached; ${branchTotals.baseline.modelRequests} request; ${branchTotals.baseline.firstRequestUncached.toLocaleString("en-US")} uncached ở request đầu mỗi session.`,
  `- Bridge: ${branchTotals.bridge.uncached.toLocaleString("en-US")} uncached; ${branchTotals.bridge.modelRequests} request; ${branchTotals.bridge.firstRequestUncached.toLocaleString("en-US")} uncached ở request đầu mỗi session.`,
  `- Bridge nhiều hơn ${((branchTotals.bridge.uncached / branchTotals.baseline.uncached - 1) * 100).toFixed(1)}% uncached so với baseline v3. Đây không phải kết quả candidate mới.`, "",
  "## Mỗi session", "",
  "| Session | Model requests | Uncached input | Cached input | Observed tool calls | Source reads (audit) | Compiles | Queries | Tool output bytes observed |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows, "",
  "## Pair-2 D", "", ...selected, "",
  "## Diễn giải và ưu tiên", "",
  "1. Vòng model tăng mạnh ở pair-2 D; trace cho phép đếm lượt và output tool, nhưng không phân rã token provider chính xác cho từng lệnh trong wrapper. Ưu tiên gom startup và trả context/handoff sẵn có trong một lượt; không đọc lại bản sao context.",
  "2. Các lệnh cần tuân thủ thứ tự lease → sửa → brief → release. Batch chỉ gom những bước độc lập. Trace IO và source reads không được coi là token provider.",
  "3. Trả query rỗng rõ ràng, chỉ expand khi có dữ liệu mới; lưu decision có supersedes để rule cũ không còn trong context hiện hành; evidence dài nằm ở artifact tham chiếu.",
  "4. Pha của từng request trong JSON là heuristic và được gắn `mixed/uncertain` nếu một wrapper có nhiều loại lệnh. Token chỉ là usage provider cho cả request; không quy nhân quả cho pha.",
  "", "JSON request-level: `docs/bridge-uncached-v3-diagnostic-20261012.json`.", ""
].join("\n");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "bridge-uncached-v3-diagnostic-20261012.json"), JSON.stringify(diagnostic, null, 2) + "\n");
writeFileSync(join(out, "bridge-uncached-v3-diagnostic-20261012.md"), report);
console.log(`Reconciled ${sessions.length} formal sessions; baseline ${branchTotals.baseline.uncached}, bridge ${branchTotals.bridge.uncached} uncached.`);
