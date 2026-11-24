import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorkflowChain, canonicalEvidence, validateCommandCaptures } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const transportSources = ['capacity-recovery.mjs', 'campaign-admission.mjs', 'comparison-attempts.mjs',
  'compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs',
  'comparison-evidence.mjs', 'receipt-recovery.mjs', 'transport-recovery.mjs'];
const evidenceNames = ['events.jsonl', 'result.json', 'source-before.json', 'source-after.json', 'RESULT.md',
  'evaluator-boundary.json', 'provider-storage.json', 'session-close.stdout.log', 'confinement-proof.json'];
const proofNames = ['reconciliation.json', 'boundary-recheck.json', 'host-review.json', 'unfinalized-state.json', 'boundary-proof.json'];

export function validateInterruptedRecord(row, envelopes, boundary, cleanup) {
  const turns = envelopes.filter(x => x.message?.method === 'turn/completed');
  const final = turns[0]?.message.params;
  if (row.id !== 'B-0-handoff-1' || row.slotId !== row.id || row.attempt !== 1 || row.phase !== 'smoke' ||
      row.branch !== 'B' || row.taskId !== 'handoff' || row.stage !== 1 || row.repetition !== 0 ||
      row.status !== 'terminal_infrastructure_failed' || row.measurementEligible !== false || row.usage !== null ||
      row.acceptance !== null || row.turn?.status !== 'failed' || row.continuationFrom ||
      row.elapsedMs != null || row.implementationMs != null ||
      row.reconciliation?.sourceModified !== false || row.reconciliation?.providerReplayed !== false ||
      turns.length !== 1 || final?.threadId !== row.launch?.threadId || final?.turn?.id !== row.launch?.turnId ||
      digest(final?.turn) !== digest(row.turn) || !row.turn.error?.message?.includes('client_cancelled') ||
      !row.turn.error.message.includes('The ChatGPT browser tab was closed') ||
      row.nativeStop?.runId !== row.launch?.runId || row.nativeStop?.appContainer !== true ||
      row.nativeStop.writersStopped !== true || row.nativeStop.activeProcesses !== 0 ||
      !row.binding?.taskId || !row.binding?.sessionId || row.cleanup?.passed !== true ||
      row.profileStorage?.privateStorageAllowedVerified !== true || row.profileStorage.unexpectedExternalWrites?.length !== 0 ||
      boundary?.writerEnabled !== false || boundary.reason !== 'workspace-owner-unverified' ||
      boundary.steps?.find(x => x.operation === 'verify-workspace-owner')?.exitStatus !== 3221225794 ||
      cleanup?.passed !== true || cleanup.nativeStopVerified !== true || cleanup.sessionRelease?.verified !== true ||
      cleanup.sessionRelease.activeSessions !== 0 || cleanup.sessionRelease.currentSessions !== 0 || cleanup.sessionRelease.unreleasedLeases !== 0)
    throw Error('Interrupted recovery requires the exact cancelled handoff, failed evaluator and verified closure');
  const usage = envelopes.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1);
  if (!usage || usage.message.params.threadId !== row.launch.threadId || usage.message.params.turnId !== row.launch.turnId ||
      row.observedUsage?.finalMeasurement !== false || row.observedUsage.observedAt !== usage.at ||
      Object.entries(usage.message.params.tokenUsage.total).some(([key, value]) => row.observedUsage[key] !== value))
    throw Error('Interrupted usage must remain an explicitly incomplete raw-bound observation');
  return true;
}

export function verifyInterruptedRecord(row, state, manifest, directory) {
  const envelopes = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validateInterruptedRecord(row, envelopes, read(join(row.evidence, 'evaluator-boundary.json')), read(row.cleanup.path));
  const prefix = join(row.evidence, 'supervisor', row.launch.runId), request = read(prefix + '.json'), stop = read(prefix + '.receipt');
  if (request.receipt !== prefix + '.receipt' || request.stdout !== prefix + '.stdout' || request.workspace !== row.workspace ||
      row.rawProtocol !== prefix + '.stdout' || sha(row.rawProtocol) !== row.rawProtocolHash ||
      Object.entries(stop).some(([key, value]) => row.nativeStop[key] !== value) || digest(read(join(row.evidence, 'result.json'))) !== digest(row) ||
      row.launch.model !== manifest.model || row.launch.effort !== manifest.effort)
    throw Error('Interrupted native/result/model binding differs');
  const calls = envelopes.filter(x => x.message?.method === 'item/completed' && x.message.params.item?.type === 'commandExecution');
  if (!calls.length || calls.length !== row.toolCalls || new Set(calls.map(x => x.message.params.item.id)).size !== calls.length ||
      row.toolCallItems?.length !== calls.length || !calls.every(x => row.toolCallItems.includes(x.message.params.item.id)))
    throw Error('Interrupted command coverage differs');
  const publicKey = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
  for (const envelope of calls) {
    const id = envelope.message.params.item.id;
    const file = join(row.evidence, 'handoff/provider-observations', id + '.json');
    verifyProviderObservation(read(file), publicKey, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
    if (!row.providerObservationEvents?.some(item => item.id === id && item.hash === sha(file))) throw Error('Interrupted observation hash differs');
  }
  validateCommandCaptures(row.evidence, calls.map(x => x.message.params.item));
  validateWorkflowChain(state.slots, row, { requireFinalPass: true });
  const confinement = read(join(row.evidence, 'confinement-proof.json'));
  if (confinement.passed !== true || confinement.nativeBoundaryVerified !== true || confinement.nativeStopVerified !== true ||
      confinement.scopeVerified !== true || confinement.workspace !== row.workspace || confinement.sid !== row.identity?.sid)
    throw Error('Interrupted launch confinement proof changed');
  for (const name of ['REQUEST-1.md', 'acceptance-1.test.mjs', 'checks.mjs', 'package.json'])
    if (sha(join(row.evidence, name)) !== sha(join(directory, 'protocol/fixtures/handoff', name)))
      throw Error('Interrupted read-only fixture changed: ' + name);
  if (sha(join(row.evidence, 'AGENTS.md')) !== sha(join(directory, 'protocol/B-WORKFLOW-AGENTS.md')))
    throw Error('Interrupted workflow instructions changed');
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) {
    if ((!name.startsWith('src/') && name !== 'RESULT.md') || name.split(/[\\/]/).includes('..')) throw Error('Invalid interrupted source path');
    if (sha(name === 'RESULT.md' ? join(row.evidence, name) : join(row.evidence, 'source-after', name.slice(4))) !== hash)
      throw Error('Interrupted source archive changed');
  }
  return true;
}

export function loadTransportRecovery(directory, manifest, root, { authorizeSourceCorrection = false } = {}) {
  const folder = join(directory, 'transport-recovery'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json'));
  let correction = null, correctionFile = null, correctionCount = 0, effectiveSources = auth.sources;
  if (auth.schemaVersion !== 1 || auth.kind !== 'user-authorized-cancelled-handoff-retry-v1' ||
      !auth.userInstruction?.trim() || auth.protocolHash !== manifest.protocolHash || state.protocolHash !== manifest.protocolHash ||
      auth.baseAuthorizationHash !== sha(join(directory, 'receipt-recovery/authorization.json')) ||
      auth.predecessorId !== 'B-0-handoff-1' || auth.maxAttempts !== 2 || manifest.maxAttempts !== 2 ||
      !Number.isSafeInteger(auth.baseCount) || auth.baseCount < 1 ||
      digest(state.slots.slice(0, auth.baseCount)) !== auth.baseSlotsHash ||
      digest(read(join(folder, 'predecessor-state.json')).slots) !== auth.baseSlotsHash ||
      auth.sources?.length !== transportSources.length || new Set(auth.sources.map(x => x.name)).size !== transportSources.length ||
      !auth.sources.every(x => transportSources.includes(x.name))) throw Error('Transport recovery authorization changed');
  for (const source of auth.sources) if (sha(join(folder, 'sources', source.name)) !== source.sha256)
    throw Error('Transport recovery source changed: ' + source.name);
  for (let revision = 1; revision <= 2; revision++) {
    const correctionFolder = join(folder, 'source-correction-' + revision), nextFile = join(correctionFolder, 'authorization.json');
    if (!existsSync(nextFile)) {
      if (revision === 1 && existsSync(join(folder, 'source-correction-2/authorization.json'))) throw Error('Transport source correction chain missing predecessor');
      break;
    }
    const next = read(nextFile);
    if (next.kind !== 'prelaunch-transport-source-correction-v1' || next.baseAuthorizationHash !== sha(file) ||
        next.protocolHash !== manifest.protocolHash || next.baseCount !== auth.baseCount || next.baseSlotsHash !== auth.baseSlotsHash ||
        !next.reason?.trim() || revision > 1 && next.predecessorCorrectionHash !== sha(correctionFile) ||
        next.sources?.length !== transportSources.length || new Set(next.sources.map(x => x.name)).size !== transportSources.length ||
        !next.sources.every(x => transportSources.includes(x.name))) throw Error('Transport source correction changed');
    const changed = next.sources.filter(x => effectiveSources.find(y => y.name === x.name)?.sha256 !== x.sha256).map(x => x.name);
    if (changed.length !== 2 || !['compare-run.mjs', 'transport-recovery.mjs'].every(x => changed.includes(x)) ||
        digest([...changed].sort()) !== digest([...(next.changed ?? [])].sort())) throw Error('Transport source correction exceeded guard scope');
    for (const source of next.sources) if (sha(join(correctionFolder, 'sources', source.name)) !== source.sha256)
      throw Error('Transport corrected source changed: ' + source.name);
    correction = next; correctionFile = nextFile; correctionCount = revision; effectiveSources = next.sources;
  }
  if (existsSync(join(folder, 'source-correction-3/authorization.json'))) throw Error('Transport prelaunch correction cap exceeded');
  if (!authorizeSourceCorrection) for (const source of effectiveSources)
    if (sha(join(root, 'benchmarks/task-management', source.name)) !== source.sha256) throw Error('Transport recovery source changed: ' + source.name);
  const row = state.slots.find(x => x.id === auth.predecessorId);
  if (!row || digest(row) !== auth.predecessorHash || sha(row.cleanup.path) !== auth.cleanupHash ||
      sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')) !== auth.stopReceiptHash)
    throw Error('Interrupted predecessor changed');
  verifyInterruptedRecord(row, state, manifest, directory);
  if (auth.evidence?.length !== evidenceNames.length || new Set(auth.evidence.map(x => x.name)).size !== evidenceNames.length ||
      !auth.evidence.every(x => evidenceNames.includes(x.name))) throw Error('Interrupted evidence set incomplete');
  for (const item of auth.evidence) if (sha(join(row.evidence, item.name)) !== item.sha256) throw Error('Interrupted evidence changed');
  if (auth.proofs?.length !== proofNames.length || new Set(auth.proofs.map(x => x.name)).size !== proofNames.length ||
      !auth.proofs.every(x => proofNames.includes(x.name)))
    throw Error('Interrupted recovery proofs incomplete');
  for (const item of auth.proofs) if (sha(join(folder, item.name)) !== item.sha256) throw Error('Interrupted recovery proof changed');
  const boundary = read(join(folder, 'boundary-recheck.json')), review = read(join(folder, 'host-review.json'));
  const original = read(join(folder, 'unfinalized-state.json')), originalRow = original.slots.at(-1);
  const boundaryProof = read(join(folder, 'boundary-proof.json'));
  if (boundary.writerEnabled !== true || boundary.nativeCanaryStopped !== true || boundary.cleanupPassed !== true ||
      boundary.sourceUnchanged !== true || boundary.providerInvocations !== 0 ||
      boundaryProof.writerEnabled !== true || boundaryProof.verifiedChildStop !== true || boundaryProof.verifiedWriteBoundary !== true ||
      originalRow?.status !== 'launched' || originalRow.id !== row.id || originalRow.attemptId !== row.attemptId ||
      digest(originalRow.launch) !== digest(row.launch) || digest(original.slots.slice(0, -1)) !== digest(state.slots.slice(0, auth.baseCount - 1)) ||
      review.verdict !== 'blocked' || review.rawTraceReviewed !== true || review.eventsHash !== sha(join(row.evidence, 'events.jsonl')) ||
      review.commands?.length !== row.toolCalls || review.commands.some((x, i) => x.id !== row.toolCallItems[i]) ||
      review.canonicalHash !== canonicalEvidence(row.evidence).hash || !review.contentFindings?.length)
    throw Error('Interrupted boundary/content review proof invalid');
  const attempts = state.slots.filter(x => (x.slotId ?? x.id) === row.id);
  if (attempts.length > 2 || attempts[1] && (attempts[1].attempt !== 2 || attempts[1].id !== row.id + '-attempt-2' ||
      attempts[1].workspace !== row.workspace || attempts[1].launch && (attempts[1].continuationFrom !== row.id ||
      attempts[1].interruptedRecoveryHash !== sha(file)))) throw Error('Interrupted retry cap/continuity differs');
  return { ...auth, sources: effectiveSources, authorizationHash: sha(file), sourceCorrectionCount: correctionCount,
    sourceCorrectionHash: correction ? sha(correctionFile) : null, folder };
}

export function authorizeTransportSourceCorrection(pointerPath, reason, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const auth = loadTransportRecovery(pointer.directory, manifest, root, { authorizeSourceCorrection: true });
  const folder = join(pointer.directory, 'transport-recovery/source-correction-' + (auth.sourceCorrectionCount + 1));
  if (!auth || !reason?.trim() || auth.sourceCorrectionCount >= 2 || state.slots.length !== auth.baseCount || existsSync(folder))
    throw Error('Prelaunch source corrections are capped at two and forbidden after retry reservation');
  const changed = auth.sources.filter(x => sha(join(root, 'benchmarks/task-management', x.name)) !== x.sha256).map(x => x.name);
  if (changed.length !== 2 || !['compare-run.mjs', 'transport-recovery.mjs'].every(x => changed.includes(x)))
    throw Error('Only the runner guard and correction loader may change in this prelaunch correction');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  const sources = transportSources.map(name => {
    copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name));
    return { name, sha256: sha(join(folder, 'sources', name)) };
  });
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify({ kind: 'prelaunch-transport-source-correction-v1',
    protocolHash: manifest.protocolHash, baseAuthorizationHash: auth.authorizationHash, baseCount: auth.baseCount,
    baseSlotsHash: auth.baseSlotsHash, predecessorCorrectionHash: auth.sourceCorrectionHash,
    reason, recordedAt: new Date().toISOString(), changed, sources }, null, 2) + '\n', { flag: 'wx' });
  return loadTransportRecovery(pointer.directory, manifest, root);
}

export function authorizeTransportRecovery(pointerPath, userInstruction, reviewPath, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const row = state.slots.at(-1), folder = join(pointer.directory, 'transport-recovery');
  if (!userInstruction?.trim() || row?.id !== 'B-0-handoff-1' || state.protocolHash !== pointer.protocolHash ||
      manifest.protocolHash !== pointer.protocolHash || state.slots.filter(x => (x.slotId ?? x.id) === row.id).length !== 1)
    throw Error('Explicit authorization and one stopped handoff required');
  verifyInterruptedRecord(row, state, manifest, pointer.directory);
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json'))))
    if (sha(join(row.workspace, name)) !== hash) throw Error('Live source changed before interrupted retry');
  if (existsSync(folder)) throw Error('Transport authorization already exists; never overwrite');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  copyFileSync(join(pointer.directory, 'state.json'), join(folder, 'predecessor-state.json'));
  const sources = transportSources.map(name => {
    copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name));
    return { name, sha256: sha(join(folder, 'sources', name)) };
  });
  const reconciliation = join(pointer.directory, 'interrupted-reconciliation-20261029');
  for (const [source, name] of [[join(reconciliation, 'result.json'), 'reconciliation.json'],
    [join(reconciliation, 'boundary-recheck-2/result.json'), 'boundary-recheck.json'], [resolve(reviewPath), 'host-review.json'],
    [join(reconciliation, 'state-before.json'), 'unfinalized-state.json'],
    [join(reconciliation, 'boundary-recheck-2/boundary.json'), 'boundary-proof.json']])
    copyFileSync(source, join(folder, name));
  const auth = { schemaVersion: 1, kind: 'user-authorized-cancelled-handoff-retry-v1', protocolHash: pointer.protocolHash,
    userInstruction, authorizedAt: new Date().toISOString(), baseAuthorizationHash: sha(join(pointer.directory, 'receipt-recovery/authorization.json')),
    predecessorId: row.id, predecessorHash: digest(row), maxAttempts: 2, baseCount: state.slots.length, baseSlotsHash: digest(state.slots), sources,
    cleanupHash: sha(row.cleanup.path), stopReceiptHash: sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')),
    evidence: evidenceNames.map(name => ({ name, sha256: sha(join(row.evidence, name)) })),
    proofs: proofNames.map(name => ({ name, sha256: sha(join(folder, name)) })),
    reason: 'G6-HOST-CANCEL-001: prior turn cancelled when its ChatGPT browser tab closed; host evaluator boundary subsequently failed. Preserve all earlier product corrections, source/task and immutable verifier history; obtain fresh acceptance, checkpoint, publication, verification and a completed turn with metrics.',
    issues: [{ id: 'G6-HOST-CANCEL-001', rawReference: 'turn/completed:' + row.launch.turnId,
      correction: 'Continue the same source/task in a fresh session; preserve historical null usage/timings and publish fresh complete evidence.' }],
    accounting: 'Historical cancelled invocation stays ineligible with null final usage/timings; observedUsage is an incomplete observation. G6 dataset qualification requires latest 6 smoke and 50 formal PASS with complete metrics; no G7/release conclusion.' };
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify(auth, null, 2) + '\n', { flag: 'wx' });
  return loadTransportRecovery(pointer.directory, manifest, root);
}
