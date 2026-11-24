import { comparisonPointer, validateBudget } from './remediation-policy.mjs';
import { requireFormalPermission } from './diagnostic-plan.mjs';
import { resolveRunWorkspace, validateWorkspaceStartup } from './run-workspace.mjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadTargetedRecovery, recoverySourceHash, recoveryReviews, recoveryAttemptLimits, recoveredSessionIds } from './g4-targeted-recovery.mjs';
import { loadCapacityRecovery } from './capacity-recovery.mjs';
import { activeCompactionReviewPolicy } from './compaction-review-policy.mjs';
import { missingPowerShellBootstrap } from './powershell-cwd.mjs';
import { slotIdentity, latestAttempt, validateAttempts, sourceRevisionEvidence } from './comparison-attempts.mjs';

import { canonicalEvidence, validateWorkflowChain } from './comparison-evidence.mjs';
import { isProviderLaunchFailure, isCompletedCommandEvent, providerObservationBinding, verifyProviderObservation, providerObservationAncestors } from './provider-observations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phase = process.argv[2];
const partial = process.argv[3] === '--partial';
if (!['smoke', 'formal'].includes(phase)) throw new Error('Usage: audit.mjs smoke|formal');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pointer = read(comparisonPointer());
const protocol = read(pointer.protocol), state = read(join(pointer.directory, 'state.json'));
if (protocol.frozen?.['diagnostic-plan.mjs'] && protocol.frozen['diagnostic-plan.mjs'] !== hash(readFileSync(new URL('./diagnostic-plan.mjs', import.meta.url)))) throw Error('Frozen diagnostic policy helper mismatch');
if (protocol.workspaceLayout && protocol.frozen?.['run-workspace.mjs'] !== hash(readFileSync(new URL('./run-workspace.mjs', import.meta.url)))) throw Error('Frozen workspace allocator mismatch');
if (phase === 'formal') requireFormalPermission(protocol);
validateBudget(protocol);
const { protocolHash, ...body } = protocol;
if (hash(JSON.stringify(body)) !== protocolHash || pointer.protocolHash !== protocolHash || state.protocolHash !== protocolHash) throw new Error('Protocol/state binding mismatch');
const capacityRecovery = loadCapacityRecovery(pointer.directory, protocol, root);
const compactionReviewPolicy = activeCompactionReviewPolicy(capacityRecovery);
const recovery = loadTargetedRecovery(pointer.directory, protocol, root) ?? capacityRecovery;
const strict = protocol.budgetMode === 'unbounded';
let observationPublicKey = null;
if (protocol.providerObservations) {
  observationPublicKey = readFileSync(join(pointer.directory, 'protocol/provider-observation-public.pem'), 'utf8');
  if (!['ed25519-provider-launch-v1', 'ed25519-completed-command-v2'].includes(protocol.providerObservations.scheme) ||
      hash(observationPublicKey) !== protocol.providerObservations.publicKeyHash) throw Error('Frozen provider observation policy/key mismatch');
}
if ((strict || protocol.nodeHash !== undefined) && protocol.nodeHash !== hash(readFileSync(process.execPath))) throw new Error('Frozen Node binary mismatch');
for (const name of ['compare-audit.mjs', 'remediation-policy.mjs', 'profile-storage.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs', 'powershell-cwd.mjs']) {
  const expected = recoverySourceHash(name, protocol.frozen[name], recovery);
  if ((strict || expected !== undefined) && expected !== hash(readFileSync(name === 'compare-audit.mjs' ? fileURLToPath(import.meta.url) : new URL(name, import.meta.url)))) throw new Error('Frozen executing code mismatch: ' + name);
}
for (const [path, expected] of Object.entries(protocol.frozen))
  if (hash(readFileSync(join(pointer.directory, 'protocol', path))) !== expected) throw new Error('Frozen file mismatch: ' + path);
const fullSchedule = phase === 'smoke' ? protocol.smoke : protocol.schedule;
const rows = state.slots.filter(slot => slot.phase === phase && (!partial || slot.status === 'finished' || capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.startupFailure || capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.hostInterruptedFailure || capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.capacityFailure || capacityRecovery?.predecessorIds.includes(slot.id) || capacityRecovery?.interruptedRecovery?.predecessorId === slot.id)), mismatches = [], details = [];
const expected = partial ? fullSchedule.filter(slot => rows.some(row => slotIdentity(row) === slot.id)) : fullSchedule;
if (partial && !rows.length) mismatches.push('No completed slots to audit');
if (new Set(rows.map(row => row.id)).size !== rows.length) mismatches.push('Duplicate slot identity');
for (const row of rows) if (!fullSchedule.some(slot => slot.id === slotIdentity(row))) mismatches.push('Unscheduled slot: ' + row.id);
try { validateAttempts(fullSchedule, rows, recoveryAttemptLimits(protocol.maxAttempts, recovery)); } catch (error) { mismatches.push(error.message); }
for (const slot of expected) if (!rows.some(row => slotIdentity(row) === slot.id)) mismatches.push(slot.id + ': scheduled slot missing');
for (const row of rows) {
  const slot = fullSchedule.find(value => value.id === slotIdentity(row));
  if (!slot) continue;
  if (capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]) {
    details.push({ id: row.id, slotId: slot.id, attempt: row.attempt, evidence: row.evidence, integrityPassed: true,
      kind: capacityRecovery.formalDisconnectRecovery.entries[row.id].finalTurnTimeout ? 'retained-final-turn-timeout' : capacityRecovery.formalDisconnectRecovery.entries[row.id].timeoutIncompleteWorkflow ? 'retained-timeout-incomplete-workflow' : capacityRecovery.formalDisconnectRecovery.entries[row.id].completedIncompleteWorkflow ? 'retained-completed-incomplete-publication' : 'retained-formal-disconnect', measurementEligible: false, usage: capacityRecovery.formalDisconnectRecovery.entries[row.id].completedIncompleteWorkflow ? row.usage : null, observedUsage: row.usage,
      observedTimings: { elapsedMs: row.elapsedMs, implementationMs: row.implementationMs }, acceptancePassed: row.acceptance?.passed,
      canonicalHash: capacityRecovery.formalDisconnectRecovery.entries[row.id].canonicalHash ?? null, leaseCount: 0, problems: [], retainedHistoricalProblems: capacityRecovery.formalDisconnectRecovery.entries[row.id].timeoutIncompleteWorkflow ? ['Final turn usage ordering/binding','Workflow history: Evidence identity missing or ambiguous','Context compaction, timeout, seven signed command failures and verifier FAIL retained; not infrastructure-only; final usage unknown'] : [capacityRecovery.formalDisconnectRecovery.entries[row.id].hostCancelled ? 'User-confirmed tab closure after canonical/verifier PASS; final turn cancelled, final usage unknown' : capacityRecovery.formalDisconnectRecovery.entries[row.id].completedIncompleteWorkflow ? 'Completed turn but canonical publication/verifier missing; current metrics retained' : 'Failed disconnected turn; canonical publication/verifier missing; final usage unknown'],
      authorizationHash: capacityRecovery.formalDisconnectRecovery.entries[row.id].authorizationHash,
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].mixedCancelledWorkflow ? {kind:'retained-cancelled-incomplete-workflow',retainedHistoricalProblems:['Provider client_cancelled tab closure; canonical invalid and shipping-S2-v1 verifier FAIL before cancellation; correction not republished/reverified; final usage unknown; mixed quality failure not infrastructure-only']} : {}),
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].finalTurnTimeout ? {retainedHistoricalProblems:['Source/acceptance/verifier PASS, but host timeout without raw turn/completed; final usage unknown; not classified infrastructure-only']} : {}),
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].approvedTimeoutGap ? {kind:'retained-approved-timeout-gap',usage:null,observedUsage:row.usage,retainedHistoricalProblems:['Timeout without raw turn/completed; final usage unknown; final publication lacks matching verifier; thirteen actual command errors retained; mixed failure, no efficiency exclusion']} : {}),
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].startupFailure ? {kind:'retained-zero-command-startup-failure',usage:row.usage,acceptancePassed:false,retainedHistoricalProblems:['Completed provider turn but zero tool calls; Bridge session missing. Provider reports invalid Native2 token, not independently confirmed in host trace. Final usage retained; no product/acceptance/publication/verifier completion.']} : {}),
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].hostInterruptedFailure ? {kind:'retained-host-daemon-interruption',usage:null,observedUsage:row.observedUsage,capturedAcceptance:row.capturedAcceptance,retainedHistoricalProblems:['Daemon restart terminated native job with exit125; no final turn or final usage; captured acceptance2/2 retained without canonical completion']} : {}),
      ...(capacityRecovery.formalDisconnectRecovery.entries[row.id].completedCompaction ? {kind:'retained-completed-compaction',usage:row.usage,retainedHistoricalProblems:['Completed turn with full final usage and valid canonical/verifier; actual controlled-input compaction retains REWORK and measurementEligible=false; not infrastructure-only']} : {}) });
    continue;
  }
  if (capacityRecovery?.cancelledRecovery?.predecessorId === row.id) {
    details.push({ id: row.id, slotId: slot.id, attempt: row.attempt, evidence: row.evidence, integrityPassed: true,
      kind: 'retained-cancelled-S-handoff', measurementEligible: false, usage: null, observedUsage: row.usage,
      observedTimings: { elapsedMs: row.elapsedMs, implementationMs: row.implementationMs }, acceptancePassed: false,
      canonicalHash: null, leaseCount: 0, problems: [], retainedHistoricalProblems: ['Failed client_cancelled turn; canonical publication/verifier absent; usage is an incomplete observation'],
      authorizationHash: capacityRecovery.cancelledRecovery.authorizationHash });
    continue;
  }
  if (capacityRecovery?.interruptedRecovery?.predecessorId === row.id) {
    details.push({ id: row.id, slotId: slot.id, attempt: row.attempt, evidence: row.evidence, integrityPassed: true,
      kind: 'retained-interrupted-failure', measurementEligible: false, usage: null, acceptancePassed: false,
      canonicalHash: canonicalEvidence(row.evidence).hash, leaseCount: 0, problems: [],
      retainedHistoricalProblems: ['Cancelled provider turn; host acceptance unavailable; final usage and monotonic timings unavailable'],
      authorizationHash: capacityRecovery.interruptedRecovery.authorizationHash });
    continue;
  }
  if (capacityRecovery?.predecessorIds.includes(row.id)) {
    details.push({ id: row.id, slotId: slot.id, attempt: row.attempt, evidence: row.evidence, integrityPassed: true,
      kind: 'retained-capacity-failure', measurementEligible: false, usage: null, acceptancePassed: false,
      problems: [], retainedHistoricalProblems: ['Provider serverOverloaded; final usage unavailable'], authorizationHash: capacityRecovery.authorizationHash });
    continue;
  }
  const problems = [];
  if (row.status !== 'finished') problems.push('Invocation not finished');
  const evidence = row.evidence;
  const check = (condition, message) => { if (!condition) problems.push(message); };
  if (protocol.workspaceLayout) {
    try {
      const workspace = resolveRunWorkspace(protocol.workspaceLayout, pointer.directory, phase, slot, protocol.id);
      check(row.workspace === workspace && row.workspaceBinding?.workspace === workspace &&
        row.workspaceBinding?.attemptId === row.attemptId && row.workspaceBinding?.sid === row.identity?.sid &&
        row.workspaceBinding?.layoutHash === protocol.workspaceLayout.reservationHash, 'Workspace/attempt layout binding');
      const { hash: bindingHash, ...binding } = row.workspaceBinding ?? {};
      const bindingBytes = readFileSync(join(evidence, 'workspace-binding.json'));
      check(hash(bindingBytes) === bindingHash && bindingBytes.toString() === JSON.stringify(binding, null, 2) + '\n', 'Workspace binding receipt hash');
      const preflight = read(join(pointer.directory, 'workspace-startup-preflight.json'));
      validateWorkspaceStartup(preflight.entries?.find(entry => entry.workspace === workspace), {
        layout: protocol.workspaceLayout, workspace, identity: row.identity, providerHash: protocol.providerHash, codeModeHostHash: protocol.codeModeHostHash, nodeHash: protocol.nodeHash });
    } catch (error) { problems.push(error.message); }
  }
  check(row.nativeStop?.appContainer === true && row.nativeStop.writersStopped === true && row.nativeStop.activeProcesses === 0 && row.nativeStop.runId === row.launch?.runId, 'Native stop/run binding');
  if (row.rawProtocol && existsSync(row.rawProtocol)) check(hash(readFileSync(row.rawProtocol)) === row.rawProtocolHash, 'Raw protocol hash');
  else problems.push('Raw protocol missing');
  if (!existsSync(join(evidence, 'events.jsonl'))) { mismatches.push(slot.id + ': events missing'); continue; }
  const events = readFileSync(join(evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).message);
  const compacted = events.some(event => /compacted/.test(event.method ?? '') || event.params?.item?.type === 'contextCompaction');
  check(compactionReviewPolicy?.acceptCompaction === true || !compacted || row.failureClass === 'controlled_input_compaction' && row.measurementEligible === false,
    'Compacted invocation must remain ineligible for PASS/measurement');
  if (observationPublicKey) {
    const envelopes = readFileSync(join(evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const observed = envelopes.filter(event => isProviderLaunchFailure(event.message) ||
      protocol.providerObservations.scheme === 'ed25519-completed-command-v2' && isCompletedCommandEvent(event.message));
    for (const envelope of observed) {
      const id = envelope.message.params.item.id;
      try {
        const observation = read(join(evidence, 'handoff/provider-observations', id + '.json'));
        const verified = verifyProviderObservation(observation, observationPublicKey, { binding: providerObservationBinding(protocolHash, row), envelope });
        check(verified.kind === (isProviderLaunchFailure(envelope.message) ? 'provider-launch-failure' : 'provider-completed-command'), 'Provider observation event kind: ' + id);
        check(row.providerObservationEvents?.some(event => event.id === id &&
          (protocol.providerObservations.scheme === 'ed25519-provider-launch-v1' || event.kind === verified.kind) &&
          event.path === '.handoff/provider-observations/' + id + '.json' &&
          event.hash === hash(readFileSync(join(evidence, 'handoff/provider-observations', id + '.json')))), 'Provider observation record hash: ' + id);
      } catch (error) { problems.push('Provider observation: ' + id + ': ' + error.message); }
    }
    check((row.providerObservationEvents?.length ?? 0) === observed.length &&
      new Set(row.providerObservationEvents?.map(event => event.id) ?? []).size === observed.length, 'Provider observation coverage count/identity');
  }
  if (protocol.nativeCompatibility?.includes('powershell-workspace-psdrive-v1')) {
    const completed = events.filter(event => event.method === 'item/completed').map(event => event.params?.item).filter(Boolean);
    check(missingPowerShellBootstrap(completed).length === 0, 'PowerShell workspace bootstrap missing');
  }
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
  check((row.turn?.status === 'completed' || row.failureClass === 'product') && usageIndex >= 0 && (finalIndex < 0 || usageIndex > finalIndex) && events.filter(event => event.method === 'thread/tokenUsage/updated').at(-1)?.params.turnId === row.launch?.turnId, 'Final turn usage ordering/binding');
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens'])
    check((rawUsage?.[field] ?? null) === (row.usage?.[field] ?? null), 'Usage differs from raw: ' + field);
  check(Number.isSafeInteger(rawUsage?.inputTokens) && Number.isSafeInteger(rawUsage?.cachedInputTokens) && Number.isSafeInteger(rawUsage?.outputTokens), 'Mandatory usage missing');
  check(row.usage?.uncachedInputTokens === rawUsage?.inputTokens - rawUsage?.cachedInputTokens, 'Uncached subset calculation');
  check(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, 'Elapsed time missing');
  check(Number.isFinite(row.implementationMs) && row.implementationMs > 0 && row.implementationMs <= row.elapsedMs, 'Mandatory implementation time missing or invalid');
  const callItems = events.filter(event => event.method === 'item/completed' && /^(commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent)/.test(event.params?.item?.type ?? '')).map(event => event.params.item);
  const callIds = [...new Set(callItems.map(item => item.id))];
  check(callIds.every(id => typeof id === 'string' && id.length > 0) && Number.isSafeInteger(row.toolCalls) && row.toolCalls >= 0 && row.toolCalls === callIds.length, 'Mandatory tool count differs from completed call trace');
  if (strict || row.toolCallItems !== undefined) check(Array.isArray(row.toolCallItems) && row.toolCallItems.length === callIds.length && new Set(row.toolCallItems).size === callIds.length && callIds.every(id => row.toolCallItems.includes(id)), 'Tool call IDs differ from completed call trace');
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
    if (protocol.workflowContract === 'g4-lifecycle-report-history-v1') {
      const expectedSessions = new Set([...providerObservationAncestors(state.slots, row).map(prior => prior.binding?.sessionId),
        ...(recovery ? recoveredSessionIds(state, row) : [])].filter(Boolean));
      const observedSessions = db.prepare("SELECT DISTINCT session_id,task_id FROM session_events WHERE kind='session_started'").all();
      check(observedSessions.length === expectedSessions.size && observedSessions.every(session => expectedSessions.has(session.session_id) && session.task_id === row.binding?.taskId), 'Workflow history: session metadata differs from invocation ancestry');
    }
    leaseCount = db.prepare('SELECT count(*) AS n FROM file_leases WHERE released_at IS NULL').get().n;
    check(leaseCount === 0, 'Lease left active after host session close');
    decisions = db.prepare('SELECT decision,reason FROM decisions WHERE task_id=?').all(row.binding.taskId);
    memoryConstraints = db.prepare("SELECT content FROM memories WHERE task_id=? AND type='constraint'").all(row.binding.taskId);
    handoffs = db.prepare('SELECT summary,done,next,risks,files_changed FROM handoffs WHERE task_id=?').all(row.binding.taskId);
    db.close();
  } else problems.push('Task metadata snapshot missing');
  const priorRows = rows.slice(0, rows.indexOf(row));
  const predecessor = (row.attempt ?? 1) > 1 ? latestAttempt(priorRows, slot.id)
    : slot.stage === 2 ? latestAttempt(priorRows, slot.branch + '-' + slot.repetition + '-handoff-1') : null;
  const capacityPredecessor = predecessor && capacityRecovery?.predecessorIds.includes(predecessor.id) && row.capacityRetryFrom === predecessor.id;
  if (predecessor && predecessor.id === capacityRecovery?.compactionRecovery?.predecessorId)
    check(row.id === 'S-0-handoff-1-attempt-3' && row.attempt === 3 &&
      row.compactionRecoveryHash === capacityRecovery.compactionRecovery.authorizationHash,
      'Scoped compaction attempt 3 authorization binding');
  if (capacityPredecessor) {
    check(!row.continuationFrom && row.capacityRecoveryHash === capacityRecovery.authorizationHash, 'Capacity retry authorization binding');
    check(hash(readFileSync(join(predecessor.evidence, 'source-after.json'))) === hash(readFileSync(join(evidence, 'source-before.json'))), 'Capacity retry source preserved');
  } else if (predecessor) {
    if (predecessor.id === capacityRecovery?.interruptedRecovery?.predecessorId)
      check(row.interruptedRecoveryHash === capacityRecovery.interruptedRecovery.authorizationHash, 'Interrupted retry authorization binding');
    if (predecessor.id === capacityRecovery?.cancelledRecovery?.predecessorId)
      check(row.cancelledRecoveryHash === capacityRecovery.cancelledRecovery.authorizationHash, 'Cancelled retry authorization binding');
    check((predecessor.binding?.taskId ?? capacityRecovery?.formalDisconnectRecovery?.entries?.[predecessor.id]?.taskId) === row.binding?.taskId && predecessor.binding?.sessionId !== row.binding?.sessionId, 'Continuation same task, fresh session');
    check(hash(readFileSync(join(predecessor.evidence, 'source-after.json'))) === hash(readFileSync(join(evidence, 'source-before.json'))), 'Actual continuation source, no reseed');
    if (protocol.frozen['comparison-attempts.mjs']) check(row.continuationFrom === predecessor.id, 'Continuation invocation binding');
  } else if (slot.stage === 2 || (row.attempt ?? 1) > 1) check(false, 'Continuation predecessor missing');
  if ((row.attempt ?? 1) > 1 && !capacityPredecessor) {
    const ledgerPath = join(pointer.directory, phase === 'smoke' ? 'smoke-content-review.json' : 'content-review.json');
    const ledger = existsSync(ledgerPath) ? read(ledgerPath) : null;
    const feedback = ledger ? recoveryReviews(ledger.rows, recovery).find(item => item.id === predecessor?.id) : null;
    check(ledger?.protocolHash === protocolHash && feedback?.verdict === 'rework' && row.reworkFeedback?.from === predecessor?.id && row.reworkFeedback?.reason === feedback?.reason && row.reworkFeedback?.reviewHash === hash(JSON.stringify(feedback)), 'Retry has bound REWORK review');
    check(requestText.includes(feedback?.reason ?? '\0'), 'Retry prompt preserves reviewed feedback');
  }
  const packetPath = join(evidence, 'handoff/CURRENT.md');
  let canonical = null;
  try { canonical = canonicalEvidence(evidence); } catch (error) {
    if (protocol.workflowContract === 'g4-lifecycle-report-history-v1') problems.push('Workflow history: canonical publication unavailable: ' + error.message);
  }
  if (protocol.workflowContract === 'g4-lifecycle-report-history-v1' && canonical) {
    try { validateWorkflowChain(state.slots, row, { requireFinalPass: false, recovery }); } catch (error) { problems.push('Workflow history: ' + error.message); }
  }
  const sourceEvidence = sourceRevisionEvidence(sourceManifest, canonical ? canonical.current + '\n' + canonical.full : existsSync(packetPath) ? readFileSync(packetPath, 'utf8') : '');
  const continuationPass = recovery?.transportContinuation && slot.id === 'S-0-handoff-2' && row.attempt >= 2
    ? state.slots.find(item => (item.slotId ?? item.id) === slot.id && item.attempt > row.attempt &&
      item.status === 'finished' && item.turn?.status === 'completed' && !item.failureClass &&
      read(join(pointer.directory, 'smoke-content-review.json')).rows.some(review => review.id === item.id && review.verdict === 'pass'))?.id : null;
  const interruptedSuccessor = recovery?.interruptedAttempt && row.id === recovery.slotId
    ? state.slots.find(item => (item.slotId ?? item.id) === slot.id && item.attempt === 2 &&
      item.status === 'finished' && item.turn?.status === 'completed' && !item.failureClass &&
      read(join(pointer.directory, 'smoke-content-review.json')).rows.some(review => review.id === item.id && review.verdict === 'pass'))?.id : null;
  const successor = interruptedSuccessor ?? continuationPass ?? (recovery?.fourthAttempt && [recovery.thirdAttempt?.predecessorId,
    recovery.fourthAttempt.predecessorId].includes(row.id) ? 'S-0-handoff-2-attempt-4'
    : row.id === recovery?.thirdAttempt?.predecessorId ? 'S-0-handoff-2-attempt-3' : null);
  const historicalProblems = interruptedSuccessor ? problems.length === 1 && problems[0] === 'Final turn usage ordering/binding'
    : continuationPass ? problems.length > 0 &&
    problems.includes('Workflow history: canonical publication unavailable: Final full evidence reference missing') &&
    problems.every(problem => problem === 'Final turn usage ordering/binding' ||
      problem === 'Workflow history: canonical publication unavailable: Final full evidence reference missing')
    : row.id === recovery?.fourthAttempt?.predecessorId
    ? problems.length === 2 && problems.includes('Final turn usage ordering/binding') &&
      problems.includes('Workflow history: canonical publication unavailable: Final full evidence reference missing')
    : problems.length === 1 && problems[0] === 'Workflow history: canonical publication unavailable: Final full evidence reference missing';
  const superseded = Boolean(successor && historicalProblems &&
    state.slots.some(item => item.id === successor && item.status === 'finished') &&
    read(join(pointer.directory, 'smoke-content-review.json')).rows.some(item => item.id === successor && item.verdict === 'pass'));
  details.push({ id: row.id, slotId: slot.id, attempt: row.attempt ?? 1, evidence, task, leaseCount, decisions, memoryConstraints, handoffs, sourceRevisionEvidence: sourceEvidence, canonicalHash: canonical?.hash ?? null,
    acceptancePassed: row.acceptance?.passed ?? false, failureClass: row.failureClass, unexpectedFiles: row.unexpectedFiles ?? null,
    sourceFiles: Object.keys(sourceManifest), resultPresent: existsSync(join(evidence, 'RESULT.md')),
    actualModel: settings?.model ?? null, actualEffort: settings?.effort ?? null,
    usage: row.usage, elapsedMs: row.elapsedMs, integrityPassed: problems.length === 0 || superseded,
    ...(superseded ? { supersededBy: successor, retainedHistoricalProblems: problems } : {}),
    problems: superseded ? [] : problems });
  if (!superseded) mismatches.push(...problems.map(problem => row.id + ': ' + problem));
}
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), protocolHash, phase, partial, fullScheduleSlots: fullSchedule.length, expectedSlots: expected.length,
  reviewPolicyHash: compactionReviewPolicy?.authorizationHash ?? null,
  capacityRecovery: capacityRecovery ? { authorizationHash: capacityRecovery.authorizationHash, missingUsageInvocations: capacityRecovery.predecessorIds, measurementComplete: false } : null,
  phaseStateHash: hash(JSON.stringify(state.slots.filter(row => row.phase === phase))),
  observedSlots: rows.length, mechanicalIntegrityPassed: mismatches.length === 0, mismatches, details,
  contentReviewRequired: true, baselineComplete: false, auditSourceHash: hash(readFileSync(fileURLToPath(import.meta.url))) };
const output = join(pointer.directory, phase + '-audit' + (partial ? '.partial' : '') + '.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, phase, mechanicalIntegrityPassed: report.mechanicalIntegrityPassed, mismatches }));
process.exitCode = report.mechanicalIntegrityPassed ? 0 : 2;
