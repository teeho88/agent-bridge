import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCapacityFailure } from './g4-targeted-recovery.mjs';
import { loadReceiptRecovery } from './receipt-recovery.mjs';
import { loadCompactionRecovery } from './compaction-recovery.mjs';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const capacitySources = ['capacity-recovery.mjs', 'campaign-admission.mjs', 'comparison-attempts.mjs', 'compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs'];

export function verifyCapacityRecord(row, expectedAttempt = 1) {
  const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validateCapacityFailure(row, events, read(join(row.evidence, 'source-before.json')), read(join(row.evidence, 'source-after.json')));
  const final = events.filter(event => event.message?.method === 'turn/completed')[0].message.params;
  const cleanup = read(row.cleanup.path);
  const prefix = join(row.evidence, 'supervisor', row.launch.runId), request = read(prefix + '.json'), stop = read(prefix + '.receipt');
  if (request.receipt !== prefix + '.receipt' || request.stdout !== prefix + '.stdout' ||
      row.rawProtocol !== prefix + '.stdout' || sha(row.rawProtocol) !== row.rawProtocolHash ||
      stop.appContainer !== true || stop.writersStopped !== true || stop.activeProcesses !== 0 ||
      Object.entries(stop).some(([key, value]) => row.nativeStop[key] !== value)) throw Error('Capacity native receipt/raw protocol binding failed');
  if (row.attempt !== expectedAttempt || row.usage !== null || row.turn?.error?.codexErrorInfo !== 'serverOverloaded' ||
      final.threadId !== row.launch.threadId || final.turn.id !== row.launch.turnId ||
      final.turn.error?.codexErrorInfo !== 'serverOverloaded' || digest(final.turn) !== digest(row.turn) ||
      row.binding?.taskId || row.continuationFrom || row.profileStorage?.privateStorageAllowedVerified !== true ||
      row.profileStorage.unexpectedExternalWrites?.length !== 0 || cleanup.passed !== true ||
      cleanup.nativeStopVerified !== true || cleanup.sessionRelease?.verified !== true ||
      cleanup.sessionRelease.activeSessions !== 0 || cleanup.sessionRelease.currentSessions !== 0 ||
      cleanup.sessionRelease.unreleasedLeases !== 0 || digest(read(join(row.evidence, 'result.json'))) !== digest(row))
    throw Error('Capacity recovery requires bound serverOverloaded before task startup, null usage and verified cleanup');
  return true;
}

export function loadCapacityRecovery(directory, manifest, root, { authorizeThird = false, authorizeReceipt = false } = {}) {
  const folder = join(directory, 'capacity-recovery'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json'));
  const extraFolder = join(folder, 'attempt-3'), extraFile = join(extraFolder, 'authorization.json');
  const extra = existsSync(extraFile) ? read(extraFile) : null;
  const receiptRecovery = loadReceiptRecovery(directory, manifest, root);
  const { protocolHash, ...body } = manifest;
  if (digest(body) !== protocolHash) throw Error('Capacity protocol fingerprint changed');
  if (auth.schemaVersion !== 1 || auth.kind !== 'user-authorized-capacity-retry-v1' ||
      auth.protocolHash !== manifest.protocolHash || state.protocolHash !== manifest.protocolHash ||
      !auth.userInstruction?.trim() || auth.maxAttempts !== 2 || manifest.maxAttempts !== 2 ||
      !Array.isArray(auth.sources) || auth.sources.length !== capacitySources.length ||
      new Set(auth.sources.map(x => x.name)).size !== capacitySources.length ||
      !auth.sources.every(x => capacitySources.includes(x.name))) throw Error('Invalid capacity authorization');
  for (const source of auth.sources) {
    if (!extra && !authorizeThird && source.sha256 !== sha(join(root, 'benchmarks/task-management', source.name)) ||
        source.sha256 !== sha(join(folder, 'sources', source.name))) throw Error('Capacity amendment source changed: ' + source.name);
  }
  const row = state.slots.find(item => item.id === auth.predecessorId);
  if (!row || digest(row) !== auth.predecessorHash || row.attemptId !== auth.attemptId ||
      row.phase !== 'smoke' || row.id !== row.slotId || row.stage !== 1 ||
      !manifest.smoke.some(slot => slot.id === row.id) || digest(read(join(folder, 'predecessor-state.json')).slots) !== auth.baseSlotsHash)
    throw Error('Capacity predecessor changed');
  verifyCapacityRecord(row);
  if (sha(row.cleanup.path) !== auth.cleanupHash || sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')) !== auth.stopReceiptHash)
    throw Error('Capacity cleanup/stop proof changed');
  if (digest(state.slots.slice(0, auth.baseCount)) !== auth.baseSlotsHash ||
      row.launch.model !== manifest.model || row.launch.effort !== manifest.effort)
    throw Error('Capacity baseline/model changed');
  for (const item of auth.evidence) if (sha(join(row.evidence, item.name)) !== item.sha256) throw Error('Capacity evidence changed');
  if (auth.evidence.length !== 4 || new Set(auth.evidence.map(x => x.name)).size !== 4 ||
      !auth.evidence.every(x => ['events.jsonl', 'result.json', 'source-before.json', 'source-after.json'].includes(x.name)))
    throw Error('Incomplete capacity evidence');
  const attempts = state.slots.filter(item => (item.slotId ?? item.id) === row.id);
  if (attempts.length > (extra ? 3 : 2) || attempts.some((item, index) => item.attempt !== index + 1) ||
      attempts[1] && (attempts[1].capacityRetryFrom !== row.id || attempts[1].capacityRecoveryHash !== sha(file)))
    throw Error('Capacity retry cap/binding changed');
  if (extra) {
    const second = attempts[1];
    if (extra.schemaVersion !== 1 || extra.kind !== 'user-authorized-capacity-third-attempt-v1' ||
        extra.protocolHash !== manifest.protocolHash || extra.baseAuthorizationHash !== sha(file) || extra.maxAttempts !== 3 ||
        !extra.userInstruction?.trim() || extra.predecessorId !== second?.id || second?.attempt !== 2 ||
        digest(second) !== extra.predecessorHash || digest(state.slots.slice(0, extra.baseCount)) !== extra.baseSlotsHash ||
        digest(read(join(extraFolder, 'predecessor-state.json')).slots) !== extra.baseSlotsHash ||
        extra.sources?.length !== capacitySources.length || new Set(extra.sources.map(x => x.name)).size !== capacitySources.length ||
        !extra.sources.every(x => capacitySources.includes(x.name))) throw Error('Invalid third capacity authorization');
    verifyCapacityRecord(second, 2);
    if (sha(second.cleanup.path) !== extra.cleanupHash || sha(join(second.evidence, 'supervisor', second.launch.runId + '.receipt')) !== extra.stopReceiptHash ||
        second.launch.model !== manifest.model || second.launch.effort !== manifest.effort) throw Error('Third capacity proof changed');
    for (const source of extra.sources) if (source.sha256 !== sha(join(extraFolder, 'sources', source.name)) ||
        !receiptRecovery && !authorizeReceipt && source.sha256 !== sha(join(root, 'benchmarks/task-management', source.name))) throw Error('Third capacity amendment source changed');
    if (attempts[2] && (attempts[2].capacityRetryFrom !== second.id || attempts[2].capacityRecoveryHash !== sha(extraFile))) throw Error('Third capacity retry binding changed');
    return loadCompactionRecovery(directory, manifest, root, { ...auth, capacityRetry: true, maxAttempts: 3, predecessor: second, predecessorIds: [row.id, second.id],
      authorizationHash: sha(extraFile), receiptRecovery, interruptedRecovery: receiptRecovery?.transportRecovery,
      cancelledRecovery: receiptRecovery?.cancelledRecovery,
      ...(receiptRecovery?.transportRecovery ? { slotId: receiptRecovery.transportRecovery.predecessorId,
        reason: receiptRecovery.transportRecovery.reason, issues: receiptRecovery.transportRecovery.issues,
        interruptedAttempt: { kind: 'cancelled-handoff', authorizationHash: receiptRecovery.transportRecovery.authorizationHash } } : {}),
      thirdAttempt: { slotId: row.id, maxAttempts: 3, sources: receiptRecovery?.sources ?? extra.sources },
      attemptLimits: { default: 2, [row.id]: 3 } });
  }
  return { ...auth, capacityRetry: true, predecessor: row, predecessorIds: [row.id], authorizationHash: sha(file) };
}

export function authorizeThirdCapacityRetry(pointerPath, userInstruction, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const prior = loadCapacityRecovery(pointer.directory, manifest, root, { authorizeThird: true });
  const row = state.slots.at(-1);
  if (!prior || prior.thirdAttempt || !userInstruction?.trim() || state.slots.filter(x => (x.slotId ?? x.id) === row.slotId).length !== 2 ||
      row.attempt !== 2 || row.capacityRetryFrom !== prior.predecessor.id || row.phase !== 'smoke' || row.stage !== 1)
    throw Error('Third capacity retry requires explicit authorization after stopped attempt two');
  verifyCapacityRecord(row, 2);
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) {
    if ((!name.startsWith('src/') && name !== 'RESULT.md') || name.includes('\\') || name.split('/').some(x => !x || x === '..' || x === '.')) throw Error('Invalid capacity source path');
    if (sha(join(row.workspace, name)) !== hash) throw Error('Live source changed before third capacity retry');
  }
  const folder = join(pointer.directory, 'capacity-recovery/attempt-3');
  if (existsSync(folder)) throw Error('Third capacity authorization already exists');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  copyFileSync(join(pointer.directory, 'state.json'), join(folder, 'predecessor-state.json'));
  const sources = capacitySources.map(name => { copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name)); return { name, sha256: sha(join(folder, 'sources', name)) }; });
  const auth = { schemaVersion: 1, kind: 'user-authorized-capacity-third-attempt-v1', protocolHash: pointer.protocolHash,
    baseAuthorizationHash: sha(join(pointer.directory, 'capacity-recovery/authorization.json')), maxAttempts: 3,
    userInstruction, authorizedAt: new Date().toISOString(), predecessorId: row.id, predecessorHash: digest(row),
    baseCount: state.slots.length, baseSlotsHash: digest(state.slots), sources,
    cleanupHash: sha(row.cleanup.path), stopReceiptHash: sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')) };
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify(auth, null, 2) + '\n', { flag: 'wx' });
  return loadCapacityRecovery(pointer.directory, manifest, root);
}

export function authorizeCapacityRetry(pointerPath, userInstruction, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const { protocolHash, ...body } = manifest;
  if (digest(body) !== protocolHash) throw Error('Capacity protocol fingerprint changed');
  const row = state.slots.at(-1);
  if (!userInstruction?.trim() || state.protocolHash !== pointer.protocolHash || manifest.protocolHash !== pointer.protocolHash ||
      manifest.maxAttempts !== 2 || row?.phase !== 'smoke' || row.id !== row.slotId || row.stage !== 1 ||
      state.slots.some(item => item !== row && (item.slotId ?? item.id) === row.slotId)) throw Error('One first-attempt smoke capacity failure required');
  verifyCapacityRecord(row);
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) {
    if ((!name.startsWith('src/') && name !== 'RESULT.md') || name.includes('\\') || name.split('/').some(x => !x || x === '..' || x === '.')) throw Error('Invalid capacity source path');
    if (sha(join(row.workspace, name)) !== hash) throw Error('Live source changed before capacity recovery');
  }
  const folder = join(pointer.directory, 'capacity-recovery');
  if (existsSync(folder)) throw Error('Capacity authorization already exists; never overwrite/replay');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  copyFileSync(join(pointer.directory, 'state.json'), join(folder, 'predecessor-state.json'));
  const sources = capacitySources.map(name => {
    copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name));
    return { name, sha256: sha(join(folder, 'sources', name)) };
  });
  const auth = { schemaVersion: 1, kind: 'user-authorized-capacity-retry-v1', protocolHash: pointer.protocolHash,
    userInstruction, authorizedAt: new Date().toISOString(), maxAttempts: 2, predecessorId: row.id, attemptId: row.attemptId,
    predecessorHash: digest(row), baseCount: state.slots.length, baseSlotsHash: digest(state.slots), sources,
    cleanupHash: sha(row.cleanup.path), stopReceiptHash: sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')),
    evidence: ['events.jsonl', 'result.json', 'source-before.json', 'source-after.json'].map(name => ({ name, sha256: sha(join(row.evidence, name)) })),
    accounting: 'Retain terminal attempt and null usage; aggregate measurement stays incomplete; no paid fallback or third attempt.' };
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify(auth, null, 2) + '\n', { flag: 'wx' });
  return loadCapacityRecovery(pointer.directory, manifest, root);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, pointer, ...reason] = process.argv.slice(2);
  if (!['authorize', 'authorize-third'].includes(action) || !pointer || !reason.length) throw Error('Usage: capacity-recovery.mjs authorize|authorize-third <pointer> <user instruction>');
  const auth = (action === 'authorize-third' ? authorizeThirdCapacityRetry : authorizeCapacityRetry)(resolve(pointer), reason.join(' '), fileURLToPath(new URL('../..', import.meta.url)));
  console.log(JSON.stringify({ predecessorId: auth.predecessorId, maxAttempts: auth.maxAttempts, authorizationHash: auth.authorizationHash }));
}
