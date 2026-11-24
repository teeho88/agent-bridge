import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonicalEvidence } from './comparison-evidence.mjs';
import { createProviderObservationKeys, signProviderObservation, providerObservationBinding } from './provider-observations.mjs';

const base = dirname(fileURLToPath(import.meta.url)), root = resolve(base, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = path => digest(readFileSync(path));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const implementations = { 'compare-audit.mjs': 'compare-audit-telemetry.mjs', 'compare-report.mjs': 'compare-report-telemetry.mjs' };
import { createInvocationTelemetry } from './invocation-telemetry.mjs';
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const files = ['telemetry-evidence.mjs','invocation-telemetry.mjs','compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs', 'comparison.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs', 'powershell-cwd.mjs', 'remediation-policy.mjs', 'profile-storage.mjs'];

export function fixture(t, { partialId = null } = {}) {
  const formal = true, retry = false;
  const parent = join(root, '.local/compare-validation-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')), pointer = join(directory, 'round.json');
  const phase = formal ? 'formal' : 'smoke';
  const frozen = join(directory, 'protocol');
  mkdirSync(frozen);
  const scratch = join(directory, 'scratch');
  for (const part of ['home', 'temp', 'cache']) mkdirSync(join(scratch, part), { recursive: true });
  const env = { ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'home'), LOCALAPPDATA: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home/codex'),
    TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp'), TMPDIR: join(scratch, 'temp'),
    npm_config_cache: join(scratch, 'cache'), XDG_CACHE_HOME: join(scratch, 'cache') };
  t.after(() => {
    const rel = relative(parent, resolve(directory));
    assert.ok(rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel));
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Remove-Item -LiteralPath $env:COMPARE_TEST_DIRECTORY -Recurse -Force'],
      { cwd: root, env: { ...process.env, COMPARE_TEST_DIRECTORY: directory }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  });
  const frozenHashes = {};
  for (const name of files) { copyFileSync(join(base, implementations[name] ?? name), join(frozen, name)); frozenHashes[name] = sha(join(frozen, name)); }
  const schedule = formal ? [1, 2, 3, 4, 5].flatMap(repetition => ['B', 'S'].flatMap(branch =>
    [['small', 1], ['debug', 1], ['multi', 1], ['handoff', 1], ['handoff', 2]].map(([taskId, stage]) =>
      ({ id: `${branch}-${repetition}-${taskId}-${stage}`, branch, repetition, taskId, stage })))) :
    [{ id: 'B-0-small-1', branch: 'B', repetition: 0, taskId: 'small', stage: 1 }];
  for (const task of ['small', 'debug', 'multi', 'handoff']) {
    for (const stage of task === 'handoff' ? [1, 2] : [1]) {
      const name = `fixtures/${task}/REQUEST${task === 'handoff' ? '-' + stage : ''}.md`;
      mkdirSync(dirname(join(frozen, name)), { recursive: true });
      writeFileSync(join(frozen, name), 'fixture request'); frozenHashes[name] = sha(join(frozen, name));
    }
  }
  const source = { 'src/value.mjs': digest('export const value = 1;') };
  const rows = schedule.map((slot, index) => {
    const evidence = join(directory, 'evidence', slot.id);
    const inputTokens = slot.branch === 'B' ? 100 : 80;
    const usage = { inputTokens, cachedInputTokens: inputTokens - 10, outputTokens: 20, uncachedInputTokens: 10,
      cacheWriteInputTokens: null, reasoningOutputTokens: null };
    const events = [
      { method: 'thread/settings/updated', params: { threadSettings: { model: 'gpt-6-luna', effort: 'medium' } } },
      ...[{ id: 'cmd-1', type: 'commandExecution', exitCode: 0 }, { id: 'edit-1', type: 'fileChange' }, { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }]
        .map(item => ({ method: 'item/completed', params: { item } })),
      { method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer' } } },
      { method: 'thread/tokenUsage/updated', params: { turnId: slot.id, tokenUsage: { total: usage } } },
    ];
    save(join(evidence, 'source-before.json'), source); save(join(evidence, 'source-after.json'), source);
    mkdirSync(join(evidence, 'source-after'), { recursive: true });
    writeFileSync(join(evidence, 'source-after/value.mjs'), 'export const value = 1;');
    writeFileSync(join(evidence, 'RESULT.md'), 'fixture result');
    writeFileSync(join(evidence, 'request.txt'), 'fixture request');
    writeFileSync(join(evidence, 'events.jsonl'), events.map(message => JSON.stringify({ message })).join('\n') + '\n');
    writeFileSync(join(evidence, 'raw.jsonl'), 'raw fixture');
    writeFileSync(join(evidence, 'acceptance.stdout.log'), '# tests 2\n# fail 0\n');
    save(join(evidence, 'handoff/evidence/final.json'), { evidence: [{ command: 'test', result: 'passed', cases: 2, artifact: 'RESULT.md' }] });
    writeFileSync(join(evidence, 'handoff/CURRENT.md'), `src/value.mjs ${source['src/value.mjs']}\nFull evidence: .handoff/evidence/final.json\n`);
    mkdirSync(join(evidence, 'agent-memory'));
    const db = new DatabaseSync(join(evidence, 'agent-memory/memories.db'));
    db.exec('CREATE TABLE tasks(id TEXT,title TEXT,goal TEXT,status TEXT,owner_agent TEXT); CREATE TABLE file_leases(released_at TEXT); CREATE TABLE decisions(task_id TEXT,decision TEXT,reason TEXT); CREATE TABLE memories(task_id TEXT,type TEXT,content TEXT); CREATE TABLE handoffs(task_id TEXT,summary TEXT,done TEXT,next TEXT,risks TEXT,files_changed TEXT);');
    const taskId = `${slot.branch}-${slot.repetition}-${slot.taskId}`;
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(taskId, 'fixture', 'fixture', 'active', 'codex'); db.close();
    const stop = { appContainer: true, writersStopped: true, activeProcesses: 0 };
    return { ...slot, slotId: slot.id, phase, attempt: 1, status: 'finished', evidence,
      usage, elapsedMs: 100, implementationMs: 80, toolCalls: 2, toolCallItems: ['cmd-1', 'edit-1'],
      startedAt: new Date(1800000000000 + index * 2000).toISOString(),
      launch: { runId: slot.id, turnId: slot.id, requestHash: digest('fixture request') },
      nativeStop: { ...stop, runId: slot.id }, turn: { status: 'completed' },
      acceptance: { passed: true, cases: 2, failures: 0, exitStatus: 0, nativeStop: stop },
      rawProtocol: join(evidence, 'raw.jsonl'), rawProtocolHash: sha(join(evidence, 'raw.jsonl')),
      binding: { taskId, sessionId: slot.id }, failureClass: null, unexpectedFiles: [],
      ...(slot.stage === 2 ? { continuationFrom: `${slot.branch}-${slot.repetition}-handoff-1` } : {}) };
  });
  const manifest = { budgetMode: 'unbounded', maxTokens: null, maxWeightedTokens: null, outputTokenWeight: 8,
    telemetryContract: {kind:'durable-invocation-journal-v1'}, nodeHash: sha(process.execPath), frozen: frozenHashes, model: 'gpt-6-luna', effort: 'medium',
    smoke: formal ? [] : schedule, schedule: formal ? schedule : [], maxAttempts: 2 };
  if (retry) {
    const index = rows.findIndex(row => row.taskId === 'handoff' && row.stage === 1);
    const first = rows[index], second = structuredClone(first);
    second.id += '-attempt-2'; second.attempt = 2; second.continuationFrom = first.id;
    second.startedAt = new Date(Date.parse(first.startedAt) + 500).toISOString();
    second.evidence = join(directory, 'evidence', second.id);
    cpSync(first.evidence, second.evidence, { recursive: true });
    second.rawProtocol = join(second.evidence, 'raw.jsonl');
    second.launch.runId = second.id; second.launch.turnId = second.id; second.nativeStop.runId = second.id;
    second.binding.sessionId = second.id;
    const request = 'fixture reviewed\nfixture request';
    writeFileSync(join(second.evidence, 'request.txt'), request); second.launch.requestHash = digest(request);
    const eventsPath = join(second.evidence, 'events.jsonl');
    writeFileSync(eventsPath, readFileSync(eventsPath, 'utf8').split(first.id).join(second.id));
    first.failureClass = 'product'; first.acceptance.passed = false; first.acceptance.failures = 1; first.acceptance.exitStatus = 1;
    writeFileSync(join(first.evidence, 'acceptance.stdout.log'), '# tests 2\n# fail 1\n');
    rows[index + 1].continuationFrom = second.id;
    rows.splice(index + 1, 0, second);
  }
  const state = { slots: rows, status: formal ? 'formal-completed' : 'awaiting-review-smoke', failures: [] };
  let ledger;
  function persist() {
    delete manifest.protocolHash;
    manifest.protocolHash = digest(JSON.stringify(manifest));
    state.protocolHash = manifest.protocolHash;
    save(join(directory, 'protocol.json'), manifest);
    save(pointer, { protocolHash: manifest.protocolHash, protocol: join(directory, 'protocol.json'), directory });
    for (const row of rows) {
      row.attemptId ??= 'attempt-' + row.id;row.launch.threadId ??= 'thread-' + row.id;
      const eventPath=join(row.evidence,'events.jsonl');
      let messages=readFileSync(eventPath,'utf8').trim().split('\n').map(line=>JSON.parse(line).message).filter(x=>x.method!=='turn/completed');
      for(const message of messages){message.params.threadId=row.launch.threadId;if(message.method!=='thread/settings/updated')message.params.turnId=row.launch.turnId;}
      const terminal={method:'turn/completed',params:{threadId:row.launch.threadId,turn:{id:row.launch.turnId,status:'completed'}}};
      if(row.id!==partialId)messages.push(terminal);
      row.turn=row.id===partialId?{status:'timeout'}:terminal.params.turn;
      writeFileSync(eventPath,messages.map(message=>JSON.stringify({message})).join('\n')+'\n');
      writeFileSync(row.rawProtocol,messages.map(message=>JSON.stringify(message)).join('\n')+'\n');row.rawProtocolHash=sha(row.rawProtocol);
      const file=join(row.evidence,'invocation-telemetry.jsonl');if(existsSync(file))unlinkSync(file);
      let now=0;const journal=createInvocationTelemetry({file,binding:{protocolHash:manifest.protocolHash,slotId:row.slotId,attemptId:row.attemptId},startMonotonicMs:0,now:()=>now+=5,wallNow:()=>Date.parse(row.startedAt)+now});
      journal.bind({runId:row.launch.runId,threadId:row.launch.threadId,turnId:row.launch.turnId});
      for(const message of messages)journal.observe(message);
      journal.implementationStopped(row.nativeStop);journal.finish('finished');
      const summary=journal.snapshot();journal.close();row.telemetry={path:file,...summary};row.usage=summary.finalUsage;row.observedUsage=summary.observedUsage;
      row.implementationMs=summary.timing.implementationMs;row.elapsedMs=summary.timing.elapsedMs;
    }
    ledger = { protocolHash: manifest.protocolHash, rows: rows.map(row => ({ id: row.id, verdict: row.failureClass ? 'rework' : 'pass', reason: 'fixture reviewed',
      sourceManifestHash: sha(join(row.evidence, 'source-after.json')), resultHash: sha(join(row.evidence, 'RESULT.md')),
      assessment: { canonicalHash: canonicalEvidence(row.evidence).hash, eventsHash: sha(join(row.evidence, 'events.jsonl')) },
      activeReviewMs: 50, endToEndMs: 150, reviewedAt: new Date(Date.parse(row.startedAt) + 150).toISOString() })) };
    for (const row of rows.filter(row => row.attempt === 2)) {
      const feedback = ledger.rows.find(item => item.id === row.continuationFrom);
      row.reworkFeedback = { from: feedback.id, reason: feedback.reason, reviewHash: digest(JSON.stringify(feedback)) };
    }
    save(join(directory, 'state.json'), state);
    save(join(directory, formal ? 'content-review.json' : 'smoke-content-review.json'), ledger);
  }
  persist();
  function run(name, args = []) {
    if (name === 'compare-report.mjs' && existsSync(join(directory, 'comparison-report.json'))) {
      const old = readFileSync(join(directory, 'comparison-report.json'));
      writeFileSync(join(directory, 'previous-report.json'), old);
      const remove = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:COMPARE_TEST_REPORT'],
        { cwd: root, env: { ...env, COMPARE_TEST_REPORT: join(directory, 'comparison-report.json') }, windowsHide: true });
      assert.equal(remove.status, 0);
    }
    return spawnSync(process.execPath, [join(base, implementations[name] ?? name), ...args, '--pointer', pointer], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  }
  const audit = () => run('compare-audit.mjs', [phase]);
  const finalize = () => run('compare-review.mjs', ['finalize', phase]);
  const report = () => { const result = run('compare-report.mjs'); assert.equal(result.status, 0, result.stderr); return read(join(directory, 'comparison-report.json')); };
  return { directory, manifest, state, rows, persist, run, audit, finalize, report, get ledger() { return ledger; } };
}

