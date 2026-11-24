import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateCommandCaptures, canonicalEvidence } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';
import { loadTransportRecovery } from './transport-recovery.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const cancelledSources = ['capacity-recovery.mjs', 'campaign-admission.mjs', 'comparison-attempts.mjs', 'compare-run.mjs',
  'compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs', 'comparison-evidence.mjs', 'receipt-recovery.mjs',
  'transport-recovery.mjs', 'g4-targeted-recovery.mjs', 'cancelled-recovery.mjs'];
const evidenceNames = ['events.jsonl', 'result.json', 'source-before.json', 'source-after.json', 'RESULT.md',
  'evaluator-boundary.json', 'provider-storage.json', 'session-close.stdout.log', 'confinement-proof.json'];
const proofNames = ['predecessor-state.json', 'previous-review-ledger.json', 'previous-audit.json', 'host-review.json', 'approved-scope.md'];
export function validateCancelledRecord(row, envelopes, cleanup) {
  const finals = envelopes.filter(x => x.message?.method === 'turn/completed'), final = finals[0]?.message.params;
  let error;
  try { error = JSON.parse(row.turn?.error?.message).error; } catch { throw Error('Bound client cancellation required'); }
  const usage = envelopes.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1);
  const total = usage?.message.params.tokenUsage.total;
  if (row.id !== 'S-0-handoff-1' || row.slotId !== row.id || row.phase !== 'smoke' || row.branch !== 'S' || row.repetition !== 0 ||
      row.stage !== 1 || row.taskId !== 'handoff' || row.attempt !== 1 || row.status !== 'finished' || row.continuationFrom ||
      row.turn?.status !== 'failed' || error?.code !== 'client_cancelled' || !error.message?.includes('The ChatGPT browser tab was closed') ||
      finals.length !== 1 || final?.threadId !== row.launch?.threadId || final?.turn?.id !== row.launch?.turnId || digest(final?.turn) !== digest(row.turn) ||
      row.nativeStop?.appContainer !== true || row.nativeStop.runId !== row.launch.runId || row.nativeStop.writersStopped !== true || row.nativeStop.activeProcesses !== 0 ||
      !row.binding?.taskId || !row.binding?.sessionId || row.cleanup?.passed !== true || cleanup?.passed !== true || cleanup.nativeStopVerified !== true ||
      cleanup.sessionRelease?.verified !== true || cleanup.sessionRelease.activeSessions !== 0 || cleanup.sessionRelease.currentSessions !== 0 || cleanup.sessionRelease.unreleasedLeases !== 0 ||
      row.acceptance?.passed !== true || row.acceptance.cases !== 2 || row.acceptance.failures !== 0 ||
      row.profileStorage?.privateStorageAllowedVerified !== true || row.profileStorage.unexpectedExternalWrites?.length !== 0 ||
      ![row.elapsedMs, row.implementationMs].every(x => Number.isFinite(x) && x > 0) ||
      usage?.message.params.threadId !== row.launch.threadId || usage.message.params.turnId !== row.launch.turnId ||
      !['inputTokens', 'cachedInputTokens', 'outputTokens'].every(k => Number.isSafeInteger(total?.[k]) && total[k] >= 0 && row.usage?.[k] === total[k]))
    throw Error('Cancelled S-handoff identity, observation, stop or cleanup changed');
  return true;
}
export function verifyCancelledRecord(row, state, manifest, directory) {
  const envelopes = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validateCancelledRecord(row, envelopes, read(row.cleanup.path));
  const prefix = join(row.evidence, 'supervisor', row.launch.runId), request = read(prefix + '.json'), stop = read(prefix + '.receipt');
  if (request.workspace !== row.workspace || request.receipt !== prefix + '.receipt' || request.stdout !== prefix + '.stdout' ||
      row.rawProtocol !== prefix + '.stdout' || sha(row.rawProtocol) !== row.rawProtocolHash ||
      Object.entries(stop).some(([k, v]) => row.nativeStop[k] !== v) || digest(read(join(row.evidence, 'result.json'))) !== digest(row) ||
      row.launch.model !== manifest.model || row.launch.effort !== manifest.effort || read(join(row.evidence, 'evaluator-boundary.json')).writerEnabled !== true)
    throw Error('Cancelled raw/native/model/result binding changed');
  const calls = envelopes.filter(x => x.message?.method === 'item/completed' && x.message.params.item?.type === 'commandExecution');
  const key = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
  for (const envelope of calls) {
    const id = envelope.message.params.item.id, file = join(row.evidence, 'handoff/provider-observations', id + '.json');
    verifyProviderObservation(read(file), key, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
    if (!row.providerObservationEvents?.some(x => x.id === id && x.hash === sha(file))) throw Error('Cancelled signed observation changed');
  }
  const tools = envelopes.filter(x => x.message?.method === 'item/completed' && ['commandExecution', 'fileChange'].includes(x.message.params.item?.type));
  if (tools.length !== row.toolCalls || tools.some((x, i) => x.message.params.item.id !== row.toolCallItems[i]) ||
      calls.length !== row.providerObservationEvents?.length) throw Error('Cancelled command/file-change coverage changed');
  validateCommandCaptures(row.evidence, calls.map(x => x.message.params.item));
  const issues = read(join(row.evidence, 'handoff/errors.json')).issues, failures = calls.filter(x => x.message.params.item.exitCode !== 0);
  if (issues.length !== failures.length || failures.some(x => !issues.some(i => i.outputReference.eventId === x.message.params.item.id &&
      i.attempt === 1 && i.outputReference.kind === 'provider-completed-command' && i.outputReference.failureMode === 'nonzero' &&
      i.outputReference.path === '.handoff/provider-observations/' + x.message.params.item.id + '.json' &&
      i.outputReference.hash === sha(join(row.evidence, 'handoff/provider-observations', x.message.params.item.id + '.json')) &&
      i.command === x.message.params.item.command && (i.output ?? i.actualOutput) === x.message.params.item.aggregatedOutput))) throw Error('Cancelled error history changed');
  try { canonicalEvidence(row.evidence); throw Error('Canonical exists'); } catch (error) {
    if (error.message !== 'Final full evidence reference missing') throw error;
  }
  const confinement = read(join(row.evidence, 'confinement-proof.json'));
  if (!confinement.passed || !confinement.nativeBoundaryVerified || !confinement.nativeStopVerified || !confinement.scopeVerified ||
      confinement.workspace !== row.workspace || confinement.sid !== row.identity.sid) throw Error('Cancelled confinement changed');
  for (const name of ['REQUEST-1.md', 'acceptance-1.test.mjs', 'checks.mjs', 'package.json'])
    if (sha(join(row.evidence, name)) !== sha(join(directory, 'protocol/fixtures/handoff', name))) throw Error('Cancelled fixture changed');
  if (sha(join(row.evidence, 'AGENTS.md')) !== sha(join(directory, 'protocol/AGENTS.md'))) throw Error('Cancelled workflow instructions changed');
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) {
    if ((!name.startsWith('src/') && name !== 'RESULT.md') || name.split(/[\\/]/).includes('..') ||
        sha(name === 'RESULT.md' ? join(row.evidence, name) : join(row.evidence, 'source-after', name.slice(4))) !== hash) throw Error('Cancelled archived source changed');
  }
  return { envelopes, issues };
}
export function loadCancelledRecovery(directory, manifest, root, base, { authorizePreflightCorrection = false } = {}) {
  const folder = join(directory, 'cancelled-recovery'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'smoke-content-review.json'));
  if (auth.schemaVersion !== 1 || auth.kind !== 'user-authorized-S-cancelled-handoff-retry-v1' || !auth.userInstruction?.trim() ||
      auth.protocolHash !== manifest.protocolHash || state.protocolHash !== manifest.protocolHash || auth.predecessorId !== 'S-0-handoff-1' ||
      auth.baseTransportAuthorizationHash !== base.authorizationHash || auth.baseSourceCorrectionHash !== base.sourceCorrectionHash ||
      auth.maxAttempts !== 2 || manifest.maxAttempts !== 2 || auth.baseCount !== 9 || digest(state.slots.slice(0, auth.baseCount)) !== auth.baseSlotsHash ||
      digest(read(join(folder, 'predecessor-state.json')).slots) !== auth.baseSlotsHash ||
      digest(ledger.rows.slice(0, auth.baseReviewCount)) !== auth.baseReviewRowsHash ||
      auth.sources?.length !== cancelledSources.length || new Set(auth.sources.map(x => x.name)).size !== cancelledSources.length ||
      !auth.sources.every(x => cancelledSources.includes(x.name))) throw Error('Cancelled recovery authorization changed');
  for (const source of auth.sources) if (sha(join(folder, 'sources', source.name)) !== source.sha256) throw Error('Cancelled amendment archive changed: ' + source.name);
  const correctionFolder = join(folder, 'preflight-correction-1'), correctionFile = join(correctionFolder, 'authorization.json');
  const correction = existsSync(correctionFile) ? read(correctionFile) : null;
  let effectiveSources = auth.sources;
  if (correction) {
    const diagnosticPath = join(folder, 'preflight-diagnostics/observations.json'), diagnostic = read(diagnosticPath);
    const preflight = state.slots.find(x => x.id === auth.predecessorId + '-attempt-2' && x.status === 'preflight_failed' && !x.launch) ??
      state.preflightFailures?.map(x => x.record).find(x => x?.attemptId === correction.preflightAttemptId);
    if (correction.kind !== 'same-approved-retry-host-scope-watchdog-v1' || correction.parentAuthorizationHash !== sha(file) ||
        correction.protocolHash !== manifest.protocolHash || correction.scopeTimeoutMs !== 300000 || !correction.reason?.trim() ||
        sha(diagnosticPath) !== correction.diagnosticHash || diagnostic.diagnosticOnly !== true || diagnostic.scope?.passed !== true ||
        diagnostic.scope.sid !== preflight?.identity?.sid || diagnostic.scope.matches?.length !== 0 || diagnostic.scope.failures?.length !== 0 ||
        diagnostic.inputSha256 !== correction.scopeInputHash || !(diagnostic.totalElapsedRoundedMs > 120000 && diagnostic.totalElapsedRoundedMs < 300000) ||
        preflight?.id !== auth.predecessorId + '-attempt-2' || preflight.attempt !== 2 || preflight.launch !== null ||
        preflight.status !== 'preflight_failed' || digest(preflight) !== correction.preflightHash || preflight.attemptId !== correction.preflightAttemptId ||
        !preflight.invocationError?.message.startsWith('Fresh workspace identity scope audit failed') ||
        correction.sources?.length !== cancelledSources.length || new Set(correction.sources.map(x => x.name)).size !== cancelledSources.length ||
        !correction.sources.every(x => cancelledSources.includes(x.name))) throw Error('Scoped preflight correction changed');
    const changed = correction.sources.filter(x => auth.sources.find(y => y.name === x.name)?.sha256 !== x.sha256).map(x => x.name).sort();
    if (JSON.stringify(changed) !== JSON.stringify(['cancelled-recovery.mjs', 'compare-run.mjs'])) throw Error('Preflight correction exceeded host watchdog scope');
    const scope = read(join(preflight.evidence, 'scope-audit/command.json'));
    if (!scope.error?.includes('ETIMEDOUT') || scope.exitCode !== null || scope.signal !== 'SIGTERM' ||
        sha(join(preflight.evidence, 'scope-input.json.gz')) !== correction.scopeInputHash ||
        ['events.jsonl', 'provider', 'boundary.json'].some(name => existsSync(join(preflight.evidence, name)))) throw Error('Preflight correction requires exact pre-inference timeout');
    for (const source of correction.sources) if (sha(join(correctionFolder, 'sources', source.name)) !== source.sha256) throw Error('Preflight corrected source archive changed');
    effectiveSources = correction.sources;
  }
  if (!authorizePreflightCorrection && !existsSync(join(directory, 'compaction-recovery/authorization.json'))) for (const source of effectiveSources) if (sha(join(root, 'benchmarks/task-management', source.name)) !== source.sha256)
    throw Error('Cancelled amendment source changed: ' + source.name);
  for (const source of base.sources) if (sha(join(folder, 'previous-sources', source.name)) !== source.sha256) throw Error('Cancelled source chain changed');
  if (sha(join(folder, 'previous-sources/g4-targeted-recovery.mjs')) !== manifest.frozen['g4-targeted-recovery.mjs']) throw Error('Previous recovery helper changed');
  for (const [names, entries] of [[evidenceNames, auth.evidence], [proofNames, auth.proofs]]) {
    if (entries?.length !== names.length || new Set(entries.map(x => x.name)).size !== names.length || !entries.every(x => names.includes(x.name))) throw Error('Cancelled evidence set incomplete');
  }
  const row = state.slots.find(x => x.id === auth.predecessorId);
  if (!row || digest(row) !== auth.predecessorHash || row.attemptId !== auth.attemptId || sha(row.cleanup.path) !== auth.cleanupHash ||
      sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')) !== auth.stopHash) throw Error('Cancelled predecessor changed');
  verifyCancelledRecord(row, state, manifest, directory);
  for (const entry of auth.evidence) if (sha(join(row.evidence, entry.name)) !== entry.sha256) throw Error('Cancelled evidence changed');
  for (const entry of auth.proofs) if (sha(join(folder, entry.name)) !== entry.sha256) throw Error('Cancelled recovery proof changed');
  const review = ledger.rows.find(x => x.id === row.id), host = read(join(folder, 'host-review.json'));
  if (review?.verdict !== 'blocked' || digest(review.assessment) !== digest(host) || host.canonicalHash !== null || host.rawTraceReviewed !== true ||
      host.eventsHash !== sha(join(row.evidence, 'events.jsonl')) || host.commands.length !== row.providerObservationEvents.length || host.proposedVerdict !== 'blocked') throw Error('Cancelled blocked review changed');
  const attempts = state.slots.filter(x => (x.slotId ?? x.id) === row.id), retry = attempts[1];
  const compatibility = existsSync(join(directory, 'compaction-recovery/postlaunch-compatibility-20261030/authorization.json'));
  const third = attempts[2];
  if (attempts.length > (compatibility ? 3 : 2) || compatibility && third &&
      (third.id !== row.id + '-attempt-3' || third.attempt !== 3 ||
       third.continuationFrom !== retry?.id || third.workspace !== row.workspace ||
       third.compactionRecoveryHash !== sha(join(directory, 'compaction-recovery/authorization.json'))) ||
      retry && (retry.id !== row.id + '-attempt-2' || retry.attempt !== 2 ||
      retry.workspace && retry.workspace !== row.workspace || retry.launch && (retry.continuationFrom !== row.id || retry.cancelledRecoveryHash !== sha(file)))) throw Error('Cancelled retry cap/continuity changed');
  return { ...auth, sources: effectiveSources, authorizationHash: sha(file), folder,
    ...(correction ? { scopeTimeoutMs: correction.scopeTimeoutMs, preflightCorrectionHash: sha(correctionFile) } : {}) };
}
export function authorizeCancelledPreflightCorrection(pointerPath, reason, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const base = loadTransportRecovery(pointer.directory, manifest, root, { authorizeSourceCorrection: true });
  const auth = loadCancelledRecovery(pointer.directory, manifest, root, base, { authorizePreflightCorrection: true }), preflight = state.slots.at(-1);
  const folder = join(pointer.directory, 'cancelled-recovery/preflight-correction-1');
  if (!reason?.trim() || existsSync(folder) || auth.preflightCorrectionHash || preflight?.id !== auth.predecessorId + '-attempt-2' ||
      preflight.status !== 'preflight_failed' || preflight.launch !== null) throw Error('One same-attempt preflight correction allowed before inference');
  const changed = auth.sources.filter(x => sha(join(root, 'benchmarks/task-management', x.name)) !== x.sha256).map(x => x.name).sort();
  if (JSON.stringify(changed) !== JSON.stringify(['cancelled-recovery.mjs', 'compare-run.mjs'])) throw Error('Only scoped host watchdog and its loader may change');
  mkdirSync(join(folder, 'sources'), { recursive: true });
  const sources = cancelledSources.map(name => { copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name)); return { name, sha256: sha(join(folder, 'sources', name)) }; });
  writeFileSync(join(folder, 'authorization.json'), JSON.stringify({ kind: 'same-approved-retry-host-scope-watchdog-v1', parentAuthorizationHash: auth.authorizationHash,
    protocolHash: manifest.protocolHash, recordedAt: new Date().toISOString(), reason, scopeTimeoutMs: 300000,
    preflightAttemptId: preflight.attemptId, preflightHash: digest(preflight), scopeInputHash: sha(join(preflight.evidence, 'scope-input.json.gz')),
    diagnosticHash: sha(join(pointer.directory, 'cancelled-recovery/preflight-diagnostics/observations.json')),
    nativeModelBudgetUnchanged: true, maxModelAttempts: 2, noAdditionalProviderLaunch: true, sources }, null, 2) + '\n', { flag: 'wx' });
  return loadCancelledRecovery(pointer.directory, manifest, root, base);
}
export function authorizeCancelledRecovery(pointerPath, userInstruction, root) {
  const pointer = read(pointerPath), manifest = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
  const folder = join(pointer.directory, 'cancelled-recovery'), file = join(folder, 'authorization.json');
  if (!userInstruction?.trim() || existsSync(file) || state.slots.length !== 9) throw Error('Explicit single S-handoff approval required');
  const base = loadTransportRecovery(pointer.directory, manifest, root, { authorizeSourceCorrection: true }), row = state.slots.at(-1);
  verifyCancelledRecord(row, state, manifest, pointer.directory);
  const processes = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like ("*"+$env:G6_RECOVERY_WORKSPACE+"*") -or $_.CommandLine -match "compare-run\\.mjs\\s+(smoke|formal)") } | Select-Object ProcessId,Name | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, G6_RECOVERY_WORKSPACE: row.workspace } });
  if (processes.status !== 0 || processes.error || processes.stdout.trim() && processes.stdout.trim() !== '[]') throw Error('Cancelled recovery requires no live runner/workspace writer');
  for (const [name, expected] of Object.entries(read(join(row.evidence, 'source-after.json')))) if (sha(join(row.workspace, name)) !== expected) throw Error('Live source changed');
  const ledger = read(join(pointer.directory, 'smoke-content-review.json'));
  const auth = { schemaVersion: 1, kind: 'user-authorized-S-cancelled-handoff-retry-v1', protocolHash: manifest.protocolHash, userInstruction,
    authorizedAt: new Date().toISOString(), predecessorId: row.id, attemptId: row.attemptId, predecessorHash: digest(row),
    baseTransportAuthorizationHash: base.authorizationHash, baseSourceCorrectionHash: base.sourceCorrectionHash,
    baseCount: state.slots.length, baseSlotsHash: digest(state.slots), baseReviewCount: ledger.rows.length, baseReviewRowsHash: digest(ledger.rows), maxAttempts: 2,
    cleanupHash: sha(row.cleanup.path), stopHash: sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')),
    sources: [], evidence: evidenceNames.map(name => ({ name, sha256: sha(join(row.evidence, name)) })), proofs: proofNames.map(name => ({ name, sha256: sha(join(folder, name)) })),
    issues: [{ id: 'G6-S-HOST-CANCEL-001', rawReference: 'turn/completed:' + row.launch.turnId }],
    reason: 'G6-S-HOST-CANCEL-001: prior provider turn was cancelled when ChatGPT tab closed before canonical publication/verifier. Keep same task/workspace and source, both signed rg/git failures and raw outputs. Correct both ledger verificationStatus values to verified, record this host finding in RESULT/canonical, obtain fresh acceptance/checkpoint/publication/verifier and completed metrics without compaction. Do not create a new task, reseed or exceed attempt 2.',
    accounting: { historicalUsageComplete: false, finalMeasurement: false, observedUsage: row.usage, observedTimings: { elapsedMs: row.elapsedMs, implementationMs: row.implementationMs }, campaignMeasurementComplete: false, releasePassed: false } };
  mkdirSync(join(folder, 'sources'), { recursive: true });
  auth.sources = cancelledSources.map(name => { copyFileSync(join(root, 'benchmarks/task-management', name), join(folder, 'sources', name)); return { name, sha256: sha(join(folder, 'sources', name)) }; });
  writeFileSync(file, JSON.stringify(auth, null, 2) + '\n', { flag: 'wx' });
  return loadCancelledRecovery(pointer.directory, manifest, root, base);
}
