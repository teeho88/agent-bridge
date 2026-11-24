import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pointer = JSON.parse(readFileSync(join(root, 'docs/phase0-20261016/round.json'), 'utf8'));
const state = JSON.parse(readFileSync(join(pointer.directory, 'state.json'), 'utf8'));
const record = state.slots.find(slot => slot.id === 'B-0-small-1');
const output = join(root, 'docs/phase0-20261016/interrupted-smoke.json');
if (existsSync(output)) throw new Error('Reconciliation already recorded');
if (state.status !== 'infrastructure_failed' || state.slots.length !== 1 || record?.nativeStop?.writersStopped !== true || record.nativeStop.activeProcesses !== 0 || record.nativeStop.runId !== record.launch.runId) throw new Error('Stopped smoke identity/proof mismatch');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (digest(readFileSync(record.rawProtocol)) !== record.rawProtocolHash) throw new Error('Raw protocol hash mismatch');
const events = readFileSync(join(record.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).message);
const usage = events.filter(event => event.method === 'thread/tokenUsage/updated').at(-1)?.params.tokenUsage.total;
for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'])
  if (usage[field] !== record.usage[field]) throw new Error('Raw usage mismatch: ' + field);
const database = new DatabaseSync(join(record.workspace, '.agent-memory/runtime.db'), { readOnly: true });
const runtime = JSON.parse(database.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload); database.close();
const sessionId = runtime.currentSessions?.codex, taskId = runtime.currentTasks?.codex;
if (!sessionId || runtime.sessionTasks?.[sessionId] !== taskId) throw new Error('Legacy runtime binding unavailable');
const close = spawnSync(process.execPath, ['.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js', 'session', 'end', '--agent', 'codex', '--id', sessionId], { cwd: record.workspace, encoding: 'utf8', timeout: 15000, windowsHide: true });
writeFileSync(join(record.evidence, 'recovery-session-close.stdout.log'), close.stdout ?? '');
writeFileSync(join(record.evidence, 'recovery-session-close.stderr.log'), close.stderr ?? '');
if (close.status !== 0) throw new Error('Session close failed after confirmed native stop');
const sourcePath = join(record.workspace, 'src/clamp.mjs');
const sourceUnchanged = digest(readFileSync(sourcePath)) === digest(readFileSync(join(pointer.directory, 'protocol/fixtures/small/src/clamp.mjs')));
const archive = join(record.evidence, 'interrupted-agent-memory'); mkdirSync(archive);
cpSync(join(record.workspace, '.agent-memory'), archive, { recursive: true });
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), protocolHash: pointer.protocolHash,
  phase: 'smoke', slotId: record.id, outcome: 'infrastructure_failed', validForBaseline: false, formalInvocations: 0,
  providerInvocations: 1, partialUsage: record.usage, observedCompletedNativeToolItems: record.toolCalls,
  implementationMs: record.implementationMs, rawProtocol: record.rawProtocol, rawProtocolHash: record.rawProtocolHash,
  nativeStop: record.nativeStop, recoveredBinding: { taskId, sessionId }, closeExitStatus: close.status, sourceUnchanged,
  issues: ['AppContainer piped Node child processes hang; reproduced without a model',
    'Runner incorrectly read runtime identity from stable config.json instead of canonical runtime.db',
    'Budget interrupt was sent as a notification; must use an acknowledged turn/interrupt request'],
  ledgerModified: false, modelReplay: false, nextStep: 'Qualify native stdio compatibility and corrected binding/budget accounting, freeze a new protocol/round before any further inference' };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sourceUnchanged, closeExitStatus: close.status, replay: false, partialUsage: record.usage }));
