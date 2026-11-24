import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phase = process.argv[2];
const partial = process.argv[3] === '--partial';
if (!['smoke', 'formal'].includes(phase)) throw new Error('Usage: audit.mjs smoke|formal');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pointer = read(join(root, 'docs/phase0-20261016/round.json'));
const protocol = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
const { protocolHash, ...body } = protocol;
if (hash(JSON.stringify(body)) !== protocolHash || state.protocolHash !== protocolHash) throw new Error('Protocol/state binding mismatch');
for (const [path, expected] of Object.entries(protocol.frozen))
  if (hash(readFileSync(join(pointer.directory, 'protocol', path))) !== expected) throw new Error('Frozen file mismatch: ' + path);
const fullSchedule = phase === 'smoke' ? protocol.smoke : protocol.schedule;
const rows = state.slots.filter(slot => slot.phase === phase && (!partial || slot.status === 'finished')), mismatches = [], details = [];
const expected = partial ? fullSchedule.filter(slot => rows.some(row => row.id === slot.id)) : fullSchedule;
if (partial && !rows.length) mismatches.push('No completed slots to audit');
if (new Set(rows.map(row => row.id)).size !== rows.length) mismatches.push('Duplicate slot identity');
for (const row of rows) if (!fullSchedule.some(slot => slot.id === row.id)) mismatches.push('Unscheduled slot: ' + row.id);
if (rows.length !== expected.length) mismatches.push('Expected ' + expected.length + ' slots, observed ' + rows.length);
for (const slot of expected) {
  const row = rows.find(value => value.id === slot.id);
  if (!row) { mismatches.push(slot.id + ': scheduled slot missing'); continue; }
  const problems = [];
  if (row.status !== 'finished') problems.push('Invocation not finished');
  const evidence = row.evidence;
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(row.nativeStop?.appContainer === true && row.nativeStop.writersStopped === true && row.nativeStop.activeProcesses === 0 && row.nativeStop.runId === row.launch?.runId, 'Native stop/run binding');
  if (row.rawProtocol && existsSync(row.rawProtocol)) check(hash(readFileSync(row.rawProtocol)) === row.rawProtocolHash, 'Raw protocol hash');
  else problems.push('Raw protocol missing');
  if (!existsSync(join(evidence, 'events.jsonl'))) { mismatches.push(slot.id + ': events missing'); continue; }
  const events = readFileSync(join(evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).message);
  const promptPath = join(evidence, 'request.txt');
  const requestName = slot.taskId === 'handoff' ? 'REQUEST-' + slot.stage + '.md' : 'REQUEST.md';
  const requestText = readFileSync(promptPath, 'utf8');
  check(hash(requestText) === row.launch?.requestHash, 'Recorded request hash');
  check(requestText.endsWith(readFileSync(join(pointer.directory, 'protocol/fixtures', slot.taskId, requestName), 'utf8')), 'Frozen current request');
  check(!events.some(event => event.method === 'item/completed' && /collabAgent|webSearch|imageGeneration|mcpToolCall|dynamicToolCall/.test(event.params?.item?.type ?? '')), 'Unexpected external/subagent tool');
  const settings = events.filter(event => event.method === 'thread/settings/updated').at(-1)?.params.threadSettings;
  check(settings?.model === protocol.model && settings.effort === protocol.effort, 'Actual model/effort');
  const rawUsage = events.filter(event => event.method === 'thread/tokenUsage/updated').at(-1)?.params.tokenUsage.total;
  const usageIndex = events.findLastIndex(event => event.method === 'thread/tokenUsage/updated');
  const finalIndex = events.findLastIndex(event => event.method === 'item/completed' && event.params?.item?.type === 'agentMessage' && event.params.item.phase === 'final_answer');
  check(usageIndex > finalIndex && events.filter(event => event.method === 'thread/tokenUsage/updated').at(-1)?.params.turnId === row.launch?.turnId, 'Final turn usage ordering/binding');
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens'])
    check((rawUsage?.[field] ?? null) === (row.usage?.[field] ?? null), 'Usage differs from raw: ' + field);
  check(Number.isSafeInteger(rawUsage?.inputTokens) && Number.isSafeInteger(rawUsage?.cachedInputTokens) && Number.isSafeInteger(rawUsage?.outputTokens), 'Mandatory usage missing');
  check(row.usage?.uncachedInputTokens === rawUsage?.inputTokens - rawUsage?.cachedInputTokens, 'Uncached subset calculation');
  check(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, 'Elapsed time missing');
  check(row.acceptance?.nativeStop?.writersStopped === true && row.acceptance.nativeStop.activeProcesses === 0 && row.acceptance.nativeStop.appContainer === true, 'Evaluator stop proof');
  const acceptance = existsSync(join(evidence, 'acceptance.stdout.log')) ? readFileSync(join(evidence, 'acceptance.stdout.log'), 'utf8') : '';
  check(Number(acceptance.match(/^# tests (\d+)$/m)?.[1]) === row.acceptance?.cases && row.acceptance?.cases === 2, 'Fixed acceptance test count');
  check((row.acceptance?.exitStatus === 0 && Number(acceptance.match(/^# fail (\d+)$/m)?.[1]) === 0) === row.acceptance?.passed, 'Acceptance result mismatch');
  const sourceManifest = existsSync(join(evidence, 'source-after.json')) ? read(join(evidence, 'source-after.json')) : {};
  for (const [path, expectedHash] of Object.entries(sourceManifest)) {
    const artifact = path.startsWith('src/') ? join(evidence, 'source-after', path.slice(4)) : join(evidence, path);
    check(existsSync(artifact) && hash(readFileSync(artifact)) === expectedHash, 'Source artifact hash: ' + path);
  }
  const metadata = join(evidence, 'agent-memory');
  let task = null, leaseCount = null, decisions = [], memoryConstraints = [], handoffs = [];
  if (existsSync(join(metadata, 'memories.db'))) {
    const db = new DatabaseSync(join(metadata, 'memories.db'), { readOnly: true });
    const tasks = db.prepare('SELECT id,title,goal,status,owner_agent FROM tasks').all();
    check(tasks.length === 1 && tasks[0].id === row.binding?.taskId, 'Exactly one canonical task');
    task = tasks[0];
    leaseCount = db.prepare('SELECT count(*) AS n FROM file_leases WHERE released_at IS NULL').get().n;
    check(leaseCount === 0, 'Lease left active after host session close');
    decisions = db.prepare('SELECT decision,reason FROM decisions WHERE task_id=?').all(row.binding.taskId);
    memoryConstraints = db.prepare("SELECT content FROM memories WHERE task_id=? AND type='constraint'").all(row.binding.taskId);
    handoffs = db.prepare('SELECT summary,done,next,risks,files_changed FROM handoffs WHERE task_id=?').all(row.binding.taskId);
    db.close();
  } else problems.push('Task metadata snapshot missing');
  if (slot.stage === 2) {
    const predecessor = rows.find(value => value.taskId === slot.taskId && value.repetition === slot.repetition && value.stage === 1);
    check(predecessor?.binding?.taskId === row.binding?.taskId && predecessor?.binding?.sessionId !== row.binding?.sessionId, 'Handoff same task, fresh session');
    check(hash(readFileSync(join(predecessor.evidence, 'source-after.json'))) === hash(readFileSync(join(evidence, 'source-before.json'))), 'Handoff actual source continuity');
  }
  details.push({ id: slot.id, evidence, task, leaseCount, decisions, memoryConstraints, handoffs,
    acceptancePassed: row.acceptance?.passed ?? false, failureClass: row.failureClass, unexpectedFiles: row.unexpectedFiles ?? null,
    sourceFiles: Object.keys(sourceManifest), resultPresent: existsSync(join(evidence, 'RESULT.md')),
    actualModel: settings?.model ?? null, actualEffort: settings?.effort ?? null,
    usage: row.usage, elapsedMs: row.elapsedMs, integrityPassed: problems.length === 0, problems });
  mismatches.push(...problems.map(problem => slot.id + ': ' + problem));
}
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), protocolHash, phase, partial, fullScheduleSlots: fullSchedule.length, expectedSlots: expected.length,
  observedSlots: rows.length, mechanicalIntegrityPassed: mismatches.length === 0, mismatches, details,
  contentReviewRequired: true, baselineComplete: false, auditSourceHash: hash(readFileSync(fileURLToPath(import.meta.url))) };
const output = join(pointer.directory, phase + '-audit' + (partial ? '.partial' : '') + '.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, phase, mechanicalIntegrityPassed: report.mechanicalIntegrityPassed, mismatches }));
process.exitCode = report.mechanicalIntegrityPassed ? 0 : 2;
