import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hash, readJSON, hashes, files } from '../benchmarks/order-pricing/lib/io.mjs';

const root = resolve(process.argv[2]);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = await readJSON(join(root, 'checkpoint.json'));
const manifest = await readJSON(join(root, 'protocol/manifest.json'));
const expected = await readJSON(join(root, 'protocol/content-hashes.json'));
const mismatches = [];
for (const [path, digest] of Object.entries(expected)) if (hash(await readFile(join(root, 'protocol', path))) !== digest) mismatches.push('protocol:' + path);
assert.deepEqual(await hashes(join(root, 'evaluation')), manifest.evaluatorHashes);
const sessions = new Set(), rows = [];
const jsonl = async path => (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
for (const row of Object.values(state.invocations)) {
  if (!row.provider) { mismatches.push('incomplete:' + row.id); continue; }
  assert.ok(!sessions.has(row.provider.sessionId), 'Reused provider session');
  sessions.add(row.provider.sessionId);
  const rollout = await jsonl(join(root, 'evidence', row.id + '.rollout.jsonl'));
  const counters = rollout.filter(event => event.payload?.type === 'token_count').map(event => event.payload.info?.total_token_usage).filter(Boolean);
  const final = counters.at(-1);
  if (!final || final.input_tokens !== row.usage.input || final.cached_input_tokens !== row.usage.cacheRead || final.output_tokens !== row.usage.output || row.usage.uncached !== final.input_tokens - final.cached_input_tokens) mismatches.push('usage:' + row.id);
  const snapshot = join(root, 'runs', row.pair === 0 ? 'smoke' : 'pair-' + row.pair, row.branch, 'snapshots', 'ABCD'[row.stage - 1]);
  const observed = await hashes(snapshot);
  if (JSON.stringify(observed) !== JSON.stringify(row.snapshotHashes)) mismatches.push('snapshot:' + row.id);
  if (observed['src/order.js'] !== row.acceptance.sourceHash) mismatches.push('source:' + row.id);
  const trace = await readJSON(join(root, row.candidateTraceRecheck ?? ('evidence/' + row.id + '.trace.json')));
  const native = await jsonl(join(root, 'evidence', row.id + '.cli.jsonl'));
  if (!trace.coverageValid) mismatches.push('trace:' + row.id);
  rows.push({ id: row.id, pair: row.pair, branch: row.branch, stage: row.stage, status: row.status, usage: row.usage,
    durationMs: row.durationMs, modelRequests: counters.length, sourceReads: trace.sourceReadCount,
    toolCalls: trace.toolCalls.length, commandFailures: native.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution' && event.item.exit_code !== 0).length,
    overhead: row.overhead, compactions: trace.compactions.length,
    acceptance: row.acceptance, handoff: row.handoff, sessionId: row.provider.sessionId });
}
const formal = rows.filter(row => row.pair > 0);
const handoffs = formal.filter(row => row.stage < 4 && row.handoff.created).length;
const incoming = formal.filter(row => row.stage > 1 && row.handoff.received).length;
const archives = [];
const activeShippingRules = [];
const Database = createRequire(join(repo, 'packages/memory/package.json'))('better-sqlite3');
for (const pair of [1, 2, 3]) {
  const final = formal.find(row => row.pair === pair && row.branch === 'bridge' && row.stage === 4);
  if (final) {
    const snapshot = join(root, 'runs/pair-' + pair, 'bridge/snapshots/D');
    archives.push({ pair, count: (await files(join(snapshot, '.handoff/history'))).filter(path => path.endsWith('.md')).length });
    const scratch = await mkdtemp(join(tmpdir(), 'bridge-candidate-audit-'));
    await cp(join(snapshot, '.agent-memory/memories.db'), join(scratch, 'memory.db'));
    const db = new Database(join(scratch, 'memory.db'), { readonly: true, fileMustExist: true });
    try {
      activeShippingRules.push({ pair,
        decisions: db.prepare("SELECT id, scope, decision, reason, stale FROM decisions WHERE superseded_by IS NULL AND (lower(decision) LIKE '%shipping%' OR lower(scope) LIKE '%shipping%')").all(),
        memories: db.prepare("SELECT id, type, content, stale FROM memories WHERE superseded_by IS NULL AND lower(content) LIKE '%shipping%'").all() });
    } finally {
      db.close();
      assert.equal(dirname(scratch), tmpdir());
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
const complete = state.status === 'completed' && formal.length === 24 && rows.length === 28;
const obsoleteShippingDecisions = activeShippingRules.flatMap(row => row.decisions
  .filter(value => !value.stale && /shipping/i.test(value.scope + ' ' + value.decision) && /subtotal/i.test(value.decision) && /itemDiscountTotal/i.test(value.decision) && !/orderDiscountTotal/i.test(value.decision))
  .map(value => ({ pair: row.pair, ...value })));
const audit = { createdAt: new Date().toISOString(), complete, protocolHash: hash(await readFile(join(root, 'protocol/content-hashes.json'))),
  frozenFiles: Object.keys(expected).length, sessions: sessions.size, mismatches, handoffs, incoming, archives, activeShippingRules, obsoleteShippingDecisions, rows };
await writeFile(join(root, 'reports/candidate-audit.json'), JSON.stringify(audit, null, 2) + '\n');
assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
assert.ok(complete, 'Formal run incomplete; partial audit saved');
const result = await readJSON(join(root, 'reports/results.json'));
const v3 = await readJSON(join(resolve(root, '../bridge-workflow-evaluation-v3-20261012'), 'reports/results.json'));
const v3Root = resolve(root, '../bridge-workflow-evaluation-v3-20261012');
const v3Frozen = await readJSON(join(v3Root, 'protocol/content-hashes.json'));
for (const [path, digest] of Object.entries(v3Frozen)) assert.equal(hash(await readFile(join(v3Root, 'protocol', path))), digest, 'v3 changed: ' + path);
audit.v3FrozenFilesChecked = Object.keys(v3Frozen).length;
await writeFile(join(root, 'reports/candidate-audit.json'), JSON.stringify(audit, null, 2) + '\n');
const sum = (branch, field) => formal.filter(row => row.branch === branch).reduce((value, row) => value + row[field], 0);
const seconds = branch => result.pairs.reduce((value, pair) => value + pair.branches.find(row => row.branch === branch).durationMs, 0) / 1000;
const lines = ['# Benchmark candidate giảm uncached input', '', 'Ngày: 2026-10-13. Đã chạy 4 smoke và 24 formal, không replay model. Model/effort giữ gpt-6-luna/high; manual lifecycle, hooks tắt, lexical retrieval, budget 4.000 và tokenizer heuristic.', '',
  '| Chỉ số formal | Baseline mới | Candidate Bridge |', '| --- | ---: | ---: |',
  ...['uncached', 'input', 'output', 'cacheRead', 'reasoning'].map(field => `| ${field} | ${result.summaries[field].totals.baseline} | ${result.summaries[field].totals.bridge} |`),
  `| Lượt model (token_count) | ${sum('baseline', 'modelRequests')} | ${sum('bridge', 'modelRequests')} |`,
  `| Tool calls | ${sum('baseline', 'toolCalls')} | ${sum('bridge', 'toolCalls')} |`,
  `| Source reads | ${sum('baseline', 'sourceReads')} | ${sum('bridge', 'sourceReads')} |`,
  `| Lệnh shell lỗi (giữ trong usage) | ${sum('baseline', 'commandFailures')} | ${sum('bridge', 'commandFailures')} |`,
  `| Thời gian giây (provider + lifecycle) | ${seconds('baseline').toFixed(3)} | ${seconds('bridge').toFixed(3)} |`, '',
  `Giảm uncached tổng: ${result.uncachedTotalReductionPercent.toFixed(2)}%; median theo cặp: ${result.summaries.uncached.reductions.median.toFixed(2)}%. Giảm âm nghĩa là Bridge dùng nhiều hơn. Mục tiêu nội bộ đạt: ${result.internalTargetMet}.`, '',
  '| Cặp | Baseline uncached | Bridge uncached | Giảm % |', '| --- | ---: | ---: | ---: |',
  ...result.pairs.map(pair => `| ${pair.pair} | ${pair.deltas.uncached.baseline} | ${pair.deltas.uncached.bridge} | ${pair.deltas.uncached.reductionPercent.toFixed(2)} |`), '',
  `D cuối: ${formal.filter(row => row.stage === 4 && row.acceptance.passed && row.acceptance.cases === 231).length}/6 pass 231/231. Handoff tạo: ${handoffs}/18; incoming nhận qua artifact hoặc context chứa summary thực: ${incoming}/18. Archive Bridge cuối mỗi cặp: ${archives.map(row => row.count).join('/')}. Đối soát usage/source/snapshot/protocol/trace: ${mismatches.length} mismatch; ${sessions.size} session độc lập.`, '',
  ...formal.filter(row => row.stage === 4 && !row.acceptance.passed).map(row => `- ${row.id}: ${row.acceptance.cases - row.acceptance.failures.length}/${row.acceptance.cases} pass; ${row.acceptance.failures.length} ca lỗi. Nhóm: ${[...new Set(row.acceptance.failures.map(value => value.group))].join(', ')}. Không mở repair/replay. Chưa đạt tương đương chất lượng giữa hai nhánh.`), '',
  `Audit memory phát hiện ${obsoleteShippingDecisions.length} canonical decision còn active/stale=0 với shipping basis cũ sau D. Đây là lỗi bàn giao; pass test sản phẩm không chứng minh memory nhất quán. InternalTargetMet của harness không thay thế kiểm tra ngữ nghĩa này.`, '',
  ...obsoleteShippingDecisions.map(value => `- Cặp ${value.pair}, scope ${value.scope}: ${value.decision}`), '',
  `Mốc lịch sử v3: baseline ${v3.summaries.uncached.totals.baseline}, Bridge ${v3.summaries.uncached.totals.bridge} uncached. Không gộp usage v3 với đợt mới; so sánh nghiệm thu dùng baseline mới.`, '',
  `Đối chiếu lại ${Object.keys(v3Frozen).length} file frozen v3: nguyên vẹn. Audit SQLite chạy trên bản sao temp để tránh tạo sidecar trong snapshot.`, '',
  'Bộ kiểm tra smoke cũ chỉ đếm compile/brief/memory add và đọc trực tiếp CURRENT.md. Đã đối soát offline, nhận startup/checkpoint và việc đọc immutable compiled context chứa summary handoff thực; lưu harness/checkpoint cũ trong evidence/candidate-smoke-counter-correction. Không đổi product build, prompt, oracle, source smoke hoặc chạy lại provider. Harness đã freeze lại trước formal.', '',
  'Cache provider không được ép cold/ngang nhau; ba cặp chỉ là bằng chứng mô tả trên workload order-pricing. Keyword checks và summary delivery không chứng minh mọi chi tiết handoff được agent hiểu đúng. Provider total thiếu giữ null; reasoning/tool tokens không cộng thêm vào output/input. Không có dữ liệu billing tiền, không suy tiền từ token. Quota thường/zero credits được kiểm tra trước từng phiên; không mua thêm hoặc dùng paid API fallback.', '',
  `Smoke usage riêng: ${JSON.stringify(result.smokeUsage)}. Toàn thử nghiệm (smoke + formal): ${JSON.stringify(result.experimentUsage)}.`, '',
  `Overhead formal Bridge: ${formal.filter(row => row.branch === 'bridge').reduce((n, row) => n + row.overhead.handoffWrite, 0)} lần gọi handoff create cho 9 handoff cần tạo. Raw trace giữ lỗi quoting và payload validation. Không quy chính xác số token provider cho từng lệnh.`, '',
  'Quyết định: candidate chưa đạt nghiệm thu và chưa đủ bằng chứng để triển khai như một cải tiến tiết kiệm token. Ưu tiên lần sửa tiếp theo là công bố schema payload rõ ràng và cung cấp đường cập nhật canonical decision cho D mà không tạo handoff thứ tư; sau đó phân tích trace mới trước khi đổi budget/tokenizer. Các thay đổi này chưa được áp dụng trong benchmark.', '',
  `Evidence đầy đủ: ${root.replaceAll('\\', '/')}/reports/results.json, reports/candidate-audit.json, evidence/usage-ledger.csv và raw rollout từng phiên.`, ''];
await writeFile(join(repo, 'docs/bridge-uncached-candidate-results-20261013.md'), lines.join('\n'));
console.log(JSON.stringify({ complete, mismatches: 0, sessions: sessions.size, handoffs, incoming, reduction: result.uncachedTotalReductionPercent, targetMet: result.internalTargetMet }));
