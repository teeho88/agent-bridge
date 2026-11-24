import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateCommandCaptures, canonicalEvidence, validateWorkflowChain } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';
import { loadS2CompactionRecovery } from './s2-compaction-recovery.mjs';
import { loadB2HandoffCompactionRecovery } from './b2-handoff-compaction-recovery.mjs';
import { loadB2HandoffCap5Recovery } from './b2-handoff-cap5-recovery.mjs';
import { loadB2Handoff2Cap4Recovery } from './b2-handoff2-cap4-recovery.mjs';
import { loadCompactionReviewPolicy } from './compaction-review-policy.mjs';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateFormalDisconnectRecord(row, events, cleanup, expectedSlot = 'B-1-debug-1', errorMode = 'disconnect') {
  assert.equal(row.id, expectedSlot); assert.equal(row.slotId, row.id);
  assert.equal(row.phase, 'formal'); assert.equal(row.attempt, 1); assert.equal(row.status, 'finished');
  assert.equal(row.turn?.status, 'failed');
  if (errorMode === 'host-cancel') { const error = JSON.parse(row.turn.error.message).error; assert.equal(error.code,'client_cancelled'); assert.ok(error.message.includes('ChatGPT browser tab was closed')); }
  else assert.ok(row.turn.error?.message.includes('stream disconnected before completion'));
  assert.ok(!events.some(x => x.message?.params?.item?.type === 'contextCompaction'));
  const finals = events.filter(x => x.message?.method === 'turn/completed');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].message.params.threadId, row.launch.threadId);
  assert.equal(finals[0].message.params.turn.id, row.launch.turnId);
  assert.equal(digest(finals[0].message.params.turn), digest(row.turn));
  assert.equal(row.nativeStop?.appContainer, true); assert.equal(row.nativeStop.writersStopped, true);
  assert.equal(row.nativeStop.activeProcesses, 0); assert.equal(row.cleanup?.passed, true);
  assert.equal(cleanup.passed, true); assert.equal(cleanup.nativeStopVerified, true);
  assert.equal(cleanup.sessionRelease?.verified, true);
  for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
  assert.ok(row.binding?.taskId && row.binding?.sessionId);
  assert.equal(row.profileStorage?.privateStorageAllowedVerified, true);
  assert.deepEqual(row.profileStorage.unexpectedExternalWrites, []);
  assert.equal(row.acceptance?.passed, true);
  const usage = events.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1);
  assert.equal(usage?.message.params.threadId, row.launch.threadId);
  assert.equal(usage?.message.params.turnId, row.launch.turnId);
  for (const key of ['inputTokens','cachedInputTokens','outputTokens']) {
    assert.ok(Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0);
    assert.equal(usage.message.params.tokenUsage.total[key], row.usage[key]);
  }
  return true;
}
function loadEntry(directory, manifest, root, handoff = false) {
  const folder = join(directory, handoff ? 'formal-handoff-disconnect-recovery' : 'formal-disconnect-recovery'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory,'state.json')), ledger = read(join(directory,'content-review.json'));
  assert.equal(auth.kind, handoff ? 'user-approved-formal-handoff-disconnect-retry-v1' : 'user-approved-formal-debug-disconnect-retry-v1');
  assert.equal(auth.userInstruction, handoff ? 'vừa mất kết nối internet, thử lại' : 'cho phép'); assert.equal(auth.accountingExceptionApproved, true);
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(state.protocolHash, manifest.protocolHash);
  assert.equal(auth.slotId, handoff ? 'B-1-handoff-1' : 'B-1-debug-1'); assert.equal(auth.maxAttempts, 2); assert.equal(manifest.maxAttempts, 2);
  assert.equal(auth.baseCount, handoff ? 18 : 15); assert.equal(auth.baseReviewCount, handoff ? 5 : 2);
  assert.equal(digest(state.slots.slice(0,auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)), auth.baseReviewsHash);
  assert.equal(sha(join(folder,'before/manifest.json')), auth.archiveManifestHash);
  for (const item of read(join(folder,'before/manifest.json')).files) assert.equal(sha(join(folder,'before',item.name)),item.sha256);
  const row = state.slots.find(x=>x.id===auth.slotId);
  assert.equal(digest(row),auth.predecessorHash); assert.equal(row.attemptId,auth.attemptId);
  assert.equal(row.launch.model,manifest.model); assert.equal(row.launch.effort,manifest.effort);
  const review = ledger.rows.find(x=>x.id===row.id); assert.equal(review.verdict,'blocked');
  assert.equal(review.assessment.eventsHash,sha(join(row.evidence,'events.jsonl')));
  assert.equal(review.assessment.canonicalHash,null);
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validateFormalDisconnectRecord(row,events,read(row.cleanup.path),auth.slotId);
  assert.equal(sha(row.cleanup.path),auth.cleanupHash);
  assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);
  assert.equal(sha(row.rawProtocol),row.rawProtocolHash);
  for (const item of auth.evidence) assert.equal(sha(join(row.evidence,item.name)),item.sha256);
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');
  assert.equal(commands.length,handoff ? 40 : 15); assert.equal(commands.filter(x=>x.message.params.item.exitCode!==0).length,handoff ? 2 : 0);
  const publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');
  for (const envelope of commands) verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});
  validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  for (const [name,hash] of Object.entries(read(join(row.evidence,'source-after.json')))) assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  const expected=['compaction-recovery.mjs','g4-targeted-recovery.mjs','campaign-admission.mjs','compare-run.mjs','compare-audit.mjs','compare-review.mjs','compare-report.mjs','comparison-evidence.mjs','formal-disconnect-recovery.mjs'];
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),expected.sort());
  for (const source of auth.sources) {assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===row.id);
  assert.ok(attempts.length>=1 && attempts.length <= (handoff && existsSync(join(folder,'attempt-3/authorization.json')) ? 3 : 2));
  if(attempts.length===1) {assert.equal(state.slots.at(-1).id,row.id);for(const [name,hash] of Object.entries(read(join(row.evidence,'source-after.json')))) assert.equal(sha(join(row.workspace,name)),hash);}
  else {const next=attempts[1];assert.equal(next.id,row.id+'-attempt-2');assert.equal(next.attempt,2);assert.equal(next.workspace,row.workspace);if(next.launch){assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId) assert.equal(next.binding.taskId,row.binding.taskId);}
  return {...auth, predecessorId:row.id, authorizationHash:sha(file), issues:review.issues, predecessorHash:digest(row)};
}

export function loadFormalDisconnectRecovery(directory, manifest, root) {
  const primary = loadEntry(directory, manifest, root);
  if (!primary) return null;
  const handoff = loadEntry(directory, manifest, root, true);
  if (handoff) assert.equal(handoff.parentAuthorizationHash, sha(join(directory,'formal-disconnect-recovery/authorization.json')));
  const publicationRetry = handoff ? loadPublicationRetry(directory, manifest, handoff) : null;
  const parentSources = publicationRetry?.sources ?? handoff?.sources ?? primary.sources;
  const hostCancelled = loadS1DebugCancelRecovery(directory, manifest, parentSources);
  const currentSources = hostCancelled?.sources ?? parentSources;
  const timeoutReviewCompatibility = loadTimeoutReviewCompatibility(directory, manifest, currentSources);
  const timeoutRetry = loadS1MultiTimeoutRecovery(directory, manifest, timeoutReviewCompatibility?.sources ?? currentSources);
  const handoffTimeoutRetry = loadS1Handoff2TimeoutRecovery(directory, manifest, timeoutRetry?.sources ?? timeoutReviewCompatibility?.sources ?? currentSources);
  const mixedCancelled = loadS2Handoff1CancelRecovery(directory, manifest, handoffTimeoutRetry?.sources ?? timeoutRetry?.sources ?? timeoutReviewCompatibility?.sources ?? currentSources);
  const compactionRetry = loadS2CompactionRecovery(directory, manifest, mixedCancelled?.sources ?? handoffTimeoutRetry?.sources ?? timeoutRetry?.sources ?? timeoutReviewCompatibility?.sources ?? currentSources);
  const effectiveSources = compactionRetry?.sources ?? mixedCancelled?.sources ?? handoffTimeoutRetry?.sources ?? timeoutRetry?.sources ?? timeoutReviewCompatibility?.sources ?? currentSources;
  const b2DebugReviewCompatibility = loadB2DebugReviewCompatibility(directory, manifest, effectiveSources);
  const b2HandoffCompactionRecovery = loadB2HandoffCompactionRecovery(directory, manifest, b2DebugReviewCompatibility?.sources ?? effectiveSources);
  const b2HandoffCap5Recovery = loadB2HandoffCap5Recovery(directory, manifest, b2HandoffCompactionRecovery?.sources ?? b2DebugReviewCompatibility?.sources ?? effectiveSources);
  const b2Handoff2ReviewCompatibility = loadB2Handoff2ReviewCompatibility(directory, manifest, b2HandoffCap5Recovery?.sources ?? b2HandoffCompactionRecovery?.sources ?? b2DebugReviewCompatibility?.sources ?? effectiveSources);
  const b2Handoff2Cap3Recovery = loadB2Handoff2Cap3Recovery(directory, manifest, b2Handoff2ReviewCompatibility?.sources ?? b2HandoffCap5Recovery?.sources ?? b2HandoffCompactionRecovery?.sources ?? b2DebugReviewCompatibility?.sources ?? effectiveSources);
  const policyParentSources = b2Handoff2Cap3Recovery?.sources ?? b2Handoff2ReviewCompatibility?.sources ?? b2HandoffCap5Recovery?.sources ?? b2HandoffCompactionRecovery?.sources ?? b2DebugReviewCompatibility?.sources ?? effectiveSources;
  const compactionReviewPolicy = loadCompactionReviewPolicy(directory, manifest, policyParentSources);
  const b2Handoff2Cap4Recovery = loadB2Handoff2Cap4Recovery(directory, manifest, compactionReviewPolicy?.sources ?? policyParentSources, compactionReviewPolicy);
  const s4ParentSources = b2Handoff2Cap4Recovery?.sources ?? compactionReviewPolicy?.sources ?? policyParentSources;
  const s4SmallTimeoutRecovery = loadS4SmallTimeoutRecovery(directory, manifest, s4ParentSources);
  const currentSourcesForScope = s4SmallTimeoutRecovery?.sources ?? s4ParentSources;
  const scopeFolder = join(directory, 'formal-B4-small1-scope-recovery-20261111');
  const scopeAuthorization = join(scopeFolder, 'authorization.json');
  const b4SmallScopeRecovery = existsSync(scopeAuthorization) ? read(scopeAuthorization) : null;
  let sources = currentSourcesForScope;
  if (b4SmallScopeRecovery) {
    const auth = b4SmallScopeRecovery;
    assert.equal(auth.kind, 'user-authorized-B4-small1-scope-timeout');
    assert.equal(auth.userInstruction, 'có');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-small-1');
    assert.equal(auth.attempt, 1);
    assert.equal(auth.scopeTimeoutMs, 300000);
    const retained = read(join(directory, 'state.json')).preflightFailures.find(x => x.record?.attemptId === auth.preflightAttemptId);
    assert.equal(retained.inferenceNotStarted, true);
    assert.equal(retained.record.launch, null);
    assert.equal(retained.record.usage, null);
    assert.equal(digest(retained.record), auth.preflightRecordHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit/command.json')), auth.failedScopeHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit-recheck-300s/command.json')), auth.checkedScopeHash);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs']);
    for (const source of auth.sources) {
      assert.equal(currentSourcesForScope.find(x => x.name === source.name)?.sha256, source.parentHash);
      assert.equal(sha(join(scopeFolder, 'sources', source.name)), source.sha256);
    }
    sources = currentSourcesForScope.map(source => auth.sources.find(x => x.name === source.name) ?? source);
  }
  const debugScopeFolder = join(directory, 'formal-B4-debug1-scope-recovery-20261111');
  const debugScopeAuthorization = join(debugScopeFolder, 'authorization.json');
  const b4DebugScopeRecovery = existsSync(debugScopeAuthorization) ? read(debugScopeAuthorization) : null;
  const debugParentSources = sources;
  if (b4DebugScopeRecovery) {
    const auth = b4DebugScopeRecovery;
    assert.equal(auth.kind, 'user-authorized-B4-debug1-scope-timeout');
    assert.equal(auth.userInstruction, 'có');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-debug-1');
    assert.equal(auth.attempt, 1);
    assert.equal(auth.scopeTimeoutMs, 300000);
    const retained = read(join(directory, 'state.json')).preflightFailures.find(x => x.record?.attemptId === auth.preflightAttemptId);
    assert.equal(retained.inferenceNotStarted, true);
    assert.equal(retained.record.launch, null);
    assert.equal(retained.record.usage, null);
    assert.equal(digest(retained.record), auth.preflightRecordHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit/command.json')), auth.failedScopeHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit-recheck-300s/command.json')), auth.checkedScopeHash);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs']);
    for (const source of auth.sources) {
      assert.equal(debugParentSources.find(x => x.name === source.name)?.sha256, source.parentHash);
      assert.equal(sha(join(debugScopeFolder, 'sources', source.name)), source.sha256);
    }
    sources = debugParentSources.map(source => auth.sources.find(x => x.name === source.name) ?? source);
  }

  const retryFolder = join(directory, 'formal-B4-debug1-retry-20261111');
  const retryFile = join(retryFolder, 'authorization.json');
  let b4DebugRetry = null;
  if (existsSync(retryFile)) {
    const auth = read(retryFile);
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(row => row.id === auth.predecessorId);
    const review = ledger.rows.find(row => row.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B4-debug1-retry-v1');
    assert.equal(auth.userInstruction, 'thử lại');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-debug-1');
    assert.equal(auth.attempt, 2);
    assert.equal(auth.maxAttempts, 2);
    assert.equal(auth.scopeTimeoutMs, 300000);
    assert.equal(auth.finalUsage, null);
    assert.equal(digest(prior), auth.predecessorHash);
    assert.equal(digest(review), auth.reviewHash);
    assert.equal(review.verdict, 'blocked');
    assert.equal(prior.turn.status, 'failed');
    assert.ok(prior.turn.error.message.includes('stream disconnected before completion'));
    assert.equal(prior.cleanup.passed, true);
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    for (const source of auth.sources) {
      assert.equal(sources.find(item => item.name === source.name)?.sha256, source.parentHash);
      assert.equal(sha(join(retryFolder, 'sources', source.name)), source.sha256);
    }
    sources = sources.map(source => auth.sources.find(item => item.name === source.name) ?? source);
    b4DebugRetry = {...auth, authorizationHash: sha(retryFile), canonicalHash: null, feedbackIssues: review.issues};
  }

  const attempt3Folder = join(directory, 'formal-B4-debug1-attempt3-recovery-20261111');
  const attempt3File = join(attempt3Folder, 'authorization.json');
  let b4DebugAttempt3 = null;
  if (existsSync(attempt3File)) {
    const auth = read(attempt3File);
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(row => row.id === auth.predecessorId);
    const review = ledger.rows.find(row => row.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B4-debug1-attempt3-v1');
    assert.equal(auth.userInstruction, 'mở lại dashboard và thử lại');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-debug-1');
    assert.equal(auth.attempt, 3);
    assert.equal(auth.maxAttempts, 3);
    assert.equal(auth.scopeTimeoutMs, 300000);
    assert.equal(digest(prior), auth.predecessorHash);
    assert.equal(digest(review), auth.reviewHash);
    assert.equal(prior.turn.status, 'completed');
    assert.equal(prior.cleanup.passed, true);
    assert.equal(review.verdict, 'blocked');
    assert.deepEqual(prior.usage, auth.finalUsage);
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    for (const item of auth.sources) {
      assert.equal(sources.find(source => source.name === item.name)?.sha256, item.parentHash);
      assert.equal(sha(join(attempt3Folder, 'sources', item.name)), item.sha256);
    }
    sources = sources.map(source => auth.sources.find(item => item.name === source.name) ?? source);
    b4DebugAttempt3 = {...auth, authorizationHash: sha(attempt3File), canonicalHash: null, completedIncompleteWorkflow: true, feedbackIssues: review.issues};
  }

  const attempt4Folder = join(directory, 'formal-B4-debug1-attempt4-recovery-20261111');
  const attempt4File = join(attempt4Folder, 'authorization.json');
  let b4DebugAttempt4 = null;
  if (existsSync(attempt4File)) {
    const auth = read(attempt4File);
    const state = read(join(directory, 'state.json'));
    const ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(row => row.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B4-debug1-attempt4-v1');
    assert.equal(auth.userInstruction, 'thử lại');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-debug-1');
    assert.equal(auth.attempt, 4);
    assert.equal(auth.maxAttempts, 4);
    assert.equal(auth.scopeTimeoutMs, 300000);
    assert.equal(digest(prior), auth.predecessorHash);
    assert.equal(prior.status, 'terminal_infrastructure_failed');
    assert.equal(prior.turn.error.codexErrorInfo, 'serverOverloaded');
    assert.equal(prior.usage, null);
    assert.equal(prior.toolCalls, 0);
    assert.equal(prior.cleanup.passed, true);
    const previous = state.slots.find(row => row.id === prior.continuationFrom);
    assert.equal(previous.binding.taskId, auth.taskId);
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    for (const item of auth.sources) {
      assert.equal(sources.find(source => source.name === item.name)?.sha256 ?? read(join(directory, 'compaction-recovery/authorization.json')).sources.find(source => source.name === item.name)?.sha256 ?? manifest.frozen[item.name], item.parentHash);
      assert.equal(sha(join(attempt4Folder, 'sources', item.name)), item.sha256);
    }
    sources = [...sources.map(source => auth.sources.find(item => item.name === source.name) ?? source),
      ...auth.sources.filter(item => !sources.some(source => source.name === item.name))];
    const review = ledger.rows.find(row => row.id === auth.predecessorId);
    if (review) {
      assert.equal(review.verdict, 'blocked');
      assert.equal(review.assessment.eventsHash, auth.eventsHash);
    }
    b4DebugAttempt4 = {...auth, capacityFailure: true, authorizationHash: sha(attempt4File), canonicalHash: null, feedbackIssues: review?.issues};
  }

  const attempt5Folder = join(directory, 'formal-B4-debug1-attempt5-recovery-20261111');
  const attempt5File = join(attempt5Folder, 'authorization.json');
  let b4DebugAttempt5 = null;
  if (existsSync(attempt5File)) {
    const auth = read(attempt5File), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(row => row.id === auth.predecessorId), review = ledger.rows.find(row => row.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B4-debug1-attempt5-v1');
    assert.equal(auth.userInstruction, 'thử lại');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-debug-1'); assert.equal(auth.attempt, 5); assert.equal(auth.maxAttempts, 5); assert.equal(auth.scopeTimeoutMs, 300000);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash);
    assert.equal(prior.turn.status, 'completed'); assert.equal(prior.cleanup.passed, true); assert.equal(review.verdict, 'blocked');
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    for (const item of auth.sources) {assert.equal(sources.find(x => x.name === item.name)?.sha256, item.parentHash); assert.equal(sha(join(attempt5Folder, 'sources', item.name)), item.sha256);}
    sources = sources.map(source => auth.sources.find(item => item.name === source.name) ?? source);
    b4DebugAttempt5 = {...auth, completedIncompleteWorkflow: true, canonicalHash: null, authorizationHash: sha(attempt5File), feedbackIssues: review.issues};
  }

  const startupFolder = join(directory, 'formal-B4-handoff2-startup-recovery-20261111'), startupFile = join(startupFolder, 'authorization.json');
  let b4Handoff2Startup = null;
  if (existsSync(startupFile)) {
    const auth = read(startupFile), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(x => x.id === auth.predecessorId), ancestor = state.slots.find(x => x.id === prior.continuationFrom);
    assert.equal(auth.kind, 'user-authorized-B4-handoff2-startup-retry-v1'); assert.equal(auth.userInstruction, 'thử lại'); assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-4-handoff-2'); assert.equal(auth.predecessorId, auth.slotId); assert.equal(auth.attempt, 2); assert.equal(auth.maxAttempts, 2);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(prior.status, 'terminal_infrastructure_failed'); assert.equal(prior.turn.status, 'completed'); assert.equal(prior.toolCalls, 0); assert.equal(prior.binding, undefined);
    assert.equal(prior.invocationError.message, 'Missing Bridge task/session identity'); assert.equal(prior.cleanup.passed, true); assert.equal(prior.nativeStop.activeProcesses, 0); assert.equal(prior.nativeStop.writersStopped, true);
    assert.equal(ancestor.binding.taskId, auth.taskId); assert.deepEqual(prior.usage, auth.finalUsage);
    const events = readFileSync(join(prior.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter(x=>x.message?.method==='item/completed' && x.message.params.item.type==='commandExecution').length, 0);
    const usage = events.filter(x=>x.message?.method==='thread/tokenUsage/updated').at(-1).message.params;
    assert.equal(usage.threadId, prior.launch.threadId); assert.equal(usage.turnId, prior.launch.turnId);
    for (const field of ['inputTokens','cachedInputTokens','outputTokens']) assert.equal(usage.tokenUsage.total[field],prior.usage[field]);
    assert.deepEqual(read(join(prior.evidence,'source-before.json')),read(join(prior.evidence,'source-after.json')));
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence,item.path)),item.sha256);
    for (const item of auth.sources) {assert.equal(sources.find(x=>x.name===item.name)?.sha256,item.parentHash);assert.equal(sha(join(startupFolder,'sources',item.name)),item.sha256);}
    sources = sources.map(x=>auth.sources.find(y=>y.name===x.name)??x);
    const review = ledger.rows.find(x=>x.id===prior.id); if(review){assert.equal(review.verdict,'blocked');assert.equal(review.assessment.eventsHash,auth.eventsHash);}
    b4Handoff2Startup = {...auth,startupFailure:true,authorizationHash:sha(startupFile),canonicalHash:null,feedbackIssues:review?.issues};
  }
  const b5ScopeFolder = join(directory, 'formal-B5-small1-scope-recovery-20261112');
  const b5ScopeAuthorization = join(b5ScopeFolder, 'authorization.json');
  const b5SmallScopeRecovery = existsSync(b5ScopeAuthorization) ? read(b5ScopeAuthorization) : null;
  const b5ParentSources = sources;
  if (b5SmallScopeRecovery) {
    const auth = b5SmallScopeRecovery;
    assert.equal(auth.kind, 'user-authorized-B5-small1-scope-timeout');
    assert.equal(auth.userInstruction, 'cho phép');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-5-small-1');
    assert.equal(auth.attempt, 1);
    assert.equal(auth.scopeTimeoutMs, 300000);
    const retained = read(join(directory, 'state.json')).preflightFailures.find(x => x.record?.attemptId === auth.preflightAttemptId);
    assert.equal(retained.inferenceNotStarted, true);
    assert.equal(retained.record.launch, null);
    assert.equal(retained.record.usage, null);
    assert.equal(digest(retained.record), auth.preflightRecordHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit/command.json')), auth.failedScopeHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit-recheck-300s/command.json')), auth.checkedScopeHash);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs']);
    for (const source of auth.sources) {
      assert.equal(b5ParentSources.find(x => x.name === source.name)?.sha256, source.parentHash);
      assert.equal(sha(join(b5ScopeFolder, 'sources', source.name)), source.sha256);
    }
    sources = b5ParentSources.map(source => auth.sources.find(x => x.name === source.name) ?? source);
  }


  const b5Attempt2Folder = join(directory, 'formal-B5-small1-attempt2-recovery-20261112'), b5Attempt2File = join(b5Attempt2Folder, 'authorization.json');
  let b5SmallAttempt2Recovery = null;
  if (existsSync(b5Attempt2File)) {
    const auth = read(b5Attempt2File), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(x => x.id === auth.predecessorId), review = ledger.rows.find(x => x.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B5-small1-attempt2-scope-v1'); assert.equal(auth.userInstruction, 'cho phép'); assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-5-small-1'); assert.equal(auth.predecessorId, auth.slotId); assert.equal(auth.currentId, auth.slotId + '-attempt-2');
    assert.equal(auth.attempt, 2); assert.equal(auth.maxAttempts, 2); assert.equal(auth.scopeTimeoutMs, 300000);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash); assert.equal(review.verdict, 'rework');
    assert.equal(prior.turn.status, 'completed'); assert.equal(prior.cleanup.passed, true); assert.equal(prior.nativeStop.activeProcesses, 0); assert.deepEqual(prior.usage, auth.finalUsage);
    assert.deepEqual(review.issues.map(x => x.id), ['G6-B5-SMALL1-VERIFIER-RECEIPT-001']);
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs', 'g4-targeted-recovery.mjs']);
    for (const item of auth.sources) { assert.equal(sources.find(x => x.name === item.name)?.sha256, item.parentHash); assert.equal(sha(join(b5Attempt2Folder, 'sources', item.name)), item.sha256); }
    sources = sources.map(x => auth.sources.find(y => y.name === x.name) ?? x);
    b5SmallAttempt2Recovery = {...auth, authorizationHash: sha(b5Attempt2File)};
  }

  const b5DebugFolder = join(directory, 'formal-B5-debug1-attempt2-recovery-20261112'), b5DebugFile = join(b5DebugFolder, 'authorization.json');
  let b5DebugAttempt2Recovery = null;
  if (existsSync(b5DebugFile)) {
    const auth = read(b5DebugFile), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(x => x.id === auth.predecessorId), review = ledger.rows.find(x => x.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-B5-debug1-attempt2-lifecycle-recovery-v1'); assert.equal(auth.userInstruction, 'cho phép'); assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'B-5-debug-1'); assert.equal(auth.predecessorId, auth.slotId); assert.equal(auth.currentId, auth.slotId + '-attempt-2');
    assert.equal(auth.attempt, 2); assert.equal(auth.maxAttempts, 2); assert.equal(auth.scopeTimeoutMs, 120000); assert.equal(auth.maxAttemptMs, manifest.maxAttemptMs);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash); assert.equal(review.verdict, 'blocked'); assert.equal(prior.turn.status, 'completed');
    assert.equal(prior.cleanup.passed, true); assert.equal(prior.nativeStop.writersStopped, true); assert.equal(prior.nativeStop.activeProcesses, 0); assert.deepEqual(prior.usage, auth.finalUsage);
    assert.equal(review.assessment.canonicalHash, auth.canonicalHash); assert.equal(review.assessment.eventsHash, auth.eventsHash);
    assert.deepEqual(review.issues.map(x => x.id), ['E001', 'E002', 'E003', 'E004', 'E005', 'G6-B5-DEBUG1-LIFECYCLE-RECEIPT-001']);
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    assert.deepEqual(auth.sources.map(x => x.name), ['formal-disconnect-recovery.mjs']);
    for (const item of auth.sources) { assert.equal(sources.find(x => x.name === item.name)?.sha256, item.parentHash); assert.equal(sha(join(b5DebugFolder, 'sources', item.name)), item.sha256); }
    sources = sources.map(x => auth.sources.find(y => y.name === x.name) ?? x);
    b5DebugAttempt2Recovery = {...auth, completedIncompleteWorkflow: true, authorizationHash: sha(b5DebugFile), feedbackIssues: review.issues};
  }
  const s5ScopeFolder = join(directory, 'formal-S5-small1-scope-recovery-20261113');
  const s5ScopeAuthorization = join(s5ScopeFolder, 'authorization.json');
  const s5SmallScopeRecovery = existsSync(s5ScopeAuthorization) ? read(s5ScopeAuthorization) : null;
  const s5ParentSources = sources;
  if (s5SmallScopeRecovery) {
    const auth = s5SmallScopeRecovery;
    assert.equal(auth.kind, 'user-authorized-S5-small1-scope-timeout');
    assert.equal(auth.userInstruction, 'cho phép');
    assert.equal(auth.protocolHash, manifest.protocolHash);
    assert.equal(auth.slotId, 'S-5-small-1');
    assert.equal(auth.attempt, 1);
    assert.equal(auth.scopeTimeoutMs, 300000);
    const retained = read(join(directory, 'state.json')).preflightFailures.find(x => x.record?.attemptId === auth.preflightAttemptId);
    assert.equal(retained.inferenceNotStarted, true);
    assert.equal(retained.record.launch, null);
    assert.equal(retained.record.usage, null);
    assert.equal(digest(retained.record), auth.preflightRecordHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit/command.json')), auth.failedScopeHash);
    assert.equal(sha(join(retained.evidence, 'scope-audit-diagnostic-300s/command.json')), auth.checkedScopeHash);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs']);
    for (const source of auth.sources) {
      assert.equal(s5ParentSources.find(x => x.name === source.name)?.sha256, source.parentHash);
      assert.equal(sha(join(s5ScopeFolder, 'sources', source.name)), source.sha256);
    }
    sources = s5ParentSources.map(source => auth.sources.find(x => x.name === source.name) ?? source);
  }


  const s5TransportFolder = join(directory, 'formal-S5-small1-transport-recovery-20261113'), s5TransportFile = join(s5TransportFolder, 'authorization.json');
  let s5SmallTransportRecovery = null;
  if (existsSync(s5TransportFile)) {
    const auth = read(s5TransportFile), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(x => x.id === auth.predecessorId), review = ledger.rows.find(x => x.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-S5-small1-transport-retry-v1'); assert.equal(auth.userInstruction, "mở dashboard và thử lại"); assert.equal(auth.accountingExceptionApproved, true);
    assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.slotId, 'S-5-small-1'); assert.equal(auth.predecessorId, auth.slotId); assert.equal(auth.currentId, auth.slotId + '-attempt-2');
    assert.equal(auth.attempt, 2); assert.equal(auth.maxAttempts, 2); assert.equal(auth.scopeTimeoutMs, 300000); assert.equal(auth.maxAttemptMs, manifest.maxAttemptMs); assert.equal(auth.finalUsage, null);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash); assert.equal(review.verdict, 'blocked');
    assert.equal(prior.status, 'finished'); assert.equal(prior.turn.status, 'failed'); assert.ok(prior.turn.error.message.includes('stream disconnected before completion')); assert.equal(prior.toolCalls, 1);
    assert.equal(prior.acceptance.passed, false); assert.equal(prior.acceptance.cases, 2); assert.equal(prior.acceptance.failures, 1);
    assert.equal(prior.cleanup.passed, true); assert.equal(prior.nativeStop.appContainer, true); assert.equal(prior.nativeStop.writersStopped, true); assert.equal(prior.nativeStop.activeProcesses, 0); assert.equal(prior.nativeStop.runId, prior.launch.runId);
    const cleanup = read(prior.cleanup.path); assert.equal(cleanup.nativeStopVerified, true); assert.equal(cleanup.sessionRelease.verified, true);
    for (const field of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[field], 0);
    assert.equal(prior.binding.taskId, auth.taskId); assert.deepEqual(prior.usage, auth.observedUsage);
    assert.deepEqual(read(join(prior.evidence, 'source-before.json')), read(join(prior.evidence, 'source-after.json')));
    assert.equal(prior.profileStorage.privateStorageAllowedVerified, true); assert.deepEqual(prior.profileStorage.unexpectedExternalWrites, []);
    const events = readFileSync(join(prior.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse), finals = events.filter(x => x.message?.method === 'turn/completed');
    assert.equal(finals.length, 1); assert.equal(finals[0].message.params.threadId, prior.launch.threadId); assert.equal(digest(finals[0].message.params.turn), digest(prior.turn));
    const usage = events.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1).message.params;
    assert.equal(usage.threadId, prior.launch.threadId); assert.equal(usage.turnId, prior.launch.turnId);
    for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) assert.equal(usage.tokenUsage.total[field], prior.usage[field]);
    const envelopes = events.filter(x => x.message?.method === 'item/completed' && x.message.params.item.type === 'commandExecution'); assert.equal(envelopes.length, 1); assert.equal(envelopes[0].message.params.item.exitCode, 0);
    const key = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
    verifyProviderObservation(read(join(prior.evidence, 'handoff/provider-observations', envelopes[0].message.params.item.id + '.json')), key, {binding:providerObservationBinding(manifest.protocolHash, prior), envelope:envelopes[0]});
    validateCommandCaptures(prior.evidence, envelopes.map(x => x.message.params.item));
    assert.deepEqual(review.issues.map(x => x.id), ['G6-S5-SMALL1-TRANSPORT-001']); assert.equal(review.assessment.canonicalHash, null); assert.equal(review.assessment.eventsHash, sha(join(prior.evidence, 'events.jsonl')));
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-run.mjs', 'formal-disconnect-recovery.mjs']);
    for (const item of auth.sources) { assert.equal(sources.find(x => x.name === item.name)?.sha256, item.parentHash); assert.equal(sha(join(s5TransportFolder, 'sources', item.name)), item.sha256); }
    sources = sources.map(x => auth.sources.find(y => y.name === x.name) ?? x);
    s5SmallTransportRecovery = {...auth, authorizationHash:sha(s5TransportFile), canonicalHash:null, feedbackIssues:review.issues};
  }
  const s5Attempt3Folder = join(directory, 'formal-S5-small1-attempt3-recovery-20261113'), s5Attempt3File = join(s5Attempt3Folder, 'authorization.json');
  let s5SmallAttempt3Recovery = null;
  if (existsSync(s5Attempt3File)) {
    const auth = read(s5Attempt3File), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
    const prior = state.slots.find(x => x.id === auth.predecessorId), review = ledger.rows.find(x => x.id === auth.predecessorId);
    assert.equal(auth.kind, 'user-authorized-S5-small1-attempt3-host-recovery-v1'); assert.equal(auth.userInstruction, 'thử lại S-5-small-1'); assert.equal(auth.accountingExceptionApproved, true);
    assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.slotId, 'S-5-small-1'); assert.equal(auth.predecessorId, auth.slotId + '-attempt-2'); assert.equal(auth.currentId, auth.slotId + '-attempt-3');
    assert.equal(auth.attempt, 3); assert.equal(auth.maxAttempts, 3); assert.equal(auth.scopeTimeoutMs, 300000); assert.equal(auth.maxAttemptMs, manifest.maxAttemptMs); assert.equal(auth.finalUsage, null);
    assert.equal(auth.baseSlotCount, 84); assert.equal(auth.baseReviewCount, 70); assert.equal(digest(state.slots.slice(0, auth.baseSlotCount)), auth.baseSlotsHash); assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
    assert.equal(digest(prior), auth.predecessorHash); assert.equal(prior.status, 'terminal_infrastructure_failed'); assert.equal(prior.failureClass, 'host_interrupted'); assert.equal(prior.turn, null); assert.equal(prior.usage, null);
    assert.equal(prior.nativeStop.exitStatus, 125); assert.equal(prior.nativeStop.appContainer, true); assert.equal(prior.nativeStop.writersStopped, true); assert.equal(prior.nativeStop.activeProcesses, 0); assert.equal(prior.nativeStop.runId, prior.launch.runId);
    assert.equal(prior.cleanup.passed, true); const cleanup = read(prior.cleanup.path); assert.equal(cleanup.nativeStopVerified, true); assert.equal(cleanup.sessionRelease.verified, true);
    for (const field of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[field], 0);
    assert.equal(prior.binding.taskId, auth.taskId); assert.deepEqual(prior.observedUsage, auth.observedUsage); assert.deepEqual(read(join(prior.evidence, 'source-after.json')), auth.sourceFinal);
    assert.equal(prior.capturedAcceptance.passed, true); assert.equal(prior.capturedAcceptance.cases, 2); assert.equal(prior.acceptance, null);
    const events = readFileSync(join(prior.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse), raw = readFileSync(prior.rawProtocol, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter(x => x.message?.method === 'turn/completed').length, 0); assert.equal(raw.filter(x => x.method === 'turn/completed').length, 0);
    assert.equal(sha(prior.rawProtocol), prior.rawProtocolHash); const usage = events.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1).message.params;
    assert.equal(usage.threadId, prior.launch.threadId); assert.equal(usage.turnId, prior.launch.turnId);
    for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) assert.equal(usage.tokenUsage.total[field], prior.observedUsage[field]);
    const envelopes = events.filter(x => x.message?.method === 'item/completed' && x.message.params.item.type === 'commandExecution'); assert.equal(envelopes.length, 13); assert.ok(envelopes.every(x => x.message.params.item.exitCode === 0));
    const key = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
    for (const envelope of envelopes) verifyProviderObservation(read(join(prior.evidence, 'handoff/provider-observations', envelope.message.params.item.id + '.json')), key, {binding:providerObservationBinding(manifest.protocolHash, prior), envelope});
    validateCommandCaptures(prior.evidence, envelopes.map(x => x.message.params.item));
    assert.equal(sha(auth.assessment.path), auth.assessment.sha256); assert.equal(sha(auth.originalAssessment.path), auth.originalAssessment.sha256); const assessment = read(auth.assessment.path);
    assert.equal(assessment.proposedVerdict, 'blocked'); assert.equal(assessment.eventsHash, sha(join(prior.evidence, 'events.jsonl'))); assert.equal(assessment.canonicalHash, null); assert.equal(assessment.commands.length, 13);
    assert.deepEqual(assessment.issues.map(x => x.id), ['G6-S5-SMALL1-TRANSPORT-001', 'G6-S5-SMALL1-A2-HOST-RESTART-001']);
    if (review) { assert.equal(review.verdict, 'blocked'); assert.equal(digest(review.assessment), digest(assessment)); }
    for (const item of auth.evidence) assert.equal(sha(join(prior.evidence, item.path)), item.sha256);
    assert.deepEqual(auth.sources.map(x => x.name).sort(), ['campaign-admission.mjs', 'compaction-recovery.mjs', 'compare-audit.mjs', 'compare-report.mjs', 'compare-review.mjs', 'compare-run.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'formal-disconnect-recovery.mjs']);
    for (const item of auth.sources) { assert.equal(sources.find(x => x.name === item.name)?.sha256, item.parentHash); assert.equal(sha(join(s5Attempt3Folder, 'sources', item.name)), item.sha256); }
    const attempts = state.slots.filter(x => (x.slotId ?? x.id) === auth.slotId); assert.ok(attempts.length >= 2 && attempts.length <= 3);
    if (attempts[2]) { assert.equal(attempts[2].attempt, 3); assert.equal(attempts[2].workspace, prior.workspace); if (attempts[2].launch) assert.equal(attempts[2].continuationFrom, prior.id); }
    sources = sources.map(x => auth.sources.find(y => y.name === x.name) ?? x);
    s5SmallAttempt3Recovery = {...auth, hostInterruptedFailure:true, authorizationHash:sha(s5Attempt3File), canonicalHash:null, feedbackIssues:assessment.issues};
  }

  const finalReviewCompatibility = loadFinalReviewCompatibility(directory, manifest, sources, b4Handoff2Startup);
  if (finalReviewCompatibility) {
    sources = finalReviewCompatibility.sources;
    b4Handoff2Startup = {...b4Handoff2Startup, preserveAbsentReviewCanonicalHash: true};
  }
  for (const source of sources) assert.equal(sha(join(root,'benchmarks/task-management',source.name)),source.sha256);
  return {...primary, sources, publicationRetry, timeoutReviewCompatibility, compactionRetry, b2DebugReviewCompatibility, b2HandoffCompactionRecovery, b2HandoffCap5Recovery, b2Handoff2ReviewCompatibility, b2Handoff2Cap3Recovery, b2Handoff2Cap4Recovery, s4SmallTimeoutRecovery, b4SmallScopeRecovery, b4DebugScopeRecovery, b4DebugRetry, b4DebugAttempt3, b4DebugAttempt4, b4DebugAttempt5, b4Handoff2Startup, b5SmallScopeRecovery, b5SmallAttempt2Recovery, b5DebugAttempt2Recovery, s5SmallScopeRecovery, s5SmallTransportRecovery, s5SmallAttempt3Recovery, compactionReviewPolicy, entries: Object.fromEntries([primary,handoff,publicationRetry,hostCancelled,timeoutRetry,handoffTimeoutRetry,mixedCancelled,compactionRetry,b2HandoffCompactionRecovery,b2Handoff2Cap4Recovery,s4SmallTimeoutRecovery,b4DebugRetry,b4DebugAttempt3,b4DebugAttempt4,b4DebugAttempt5,b4Handoff2Startup,b5DebugAttempt2Recovery,s5SmallTransportRecovery,s5SmallAttempt3Recovery,...(b2HandoffCap5Recovery?.entries ?? [])].filter(Boolean).map(entry=>[entry.predecessorId,entry]))};
}

export function loadFinalReviewCompatibility(directory, manifest, parentSources, startup) {
  const folder = join(directory, 'formal-final-review-compatibility-20261113');
  const file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file);
  assert.equal(auth.kind, 'retained-B4-startup-absent-canonical-review-v1');
  assert.equal(auth.protocolHash, manifest.protocolHash);
  assert.equal(auth.slotId, 'B-4-handoff-2');
  assert.ok(auth.userInstruction?.trim());
  assert.equal(auth.extraProviderLaunches, 0);
  assert.equal(auth.retryAllowed, false);
  assert.equal(auth.historicalVerdictChangesAllowed, false);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-S5-small1-attempt3-recovery-20261113/authorization.json')));
  assert.equal(auth.startupAuthorizationHash, startup?.authorizationHash);
  assert.equal(startup?.predecessorId, auth.slotId);
  assert.equal(startup?.startupFailure, true);
  assert.equal(sha(join(directory, 'state.json')), auth.stateHash);
  assert.equal(sha(join(directory, 'content-review.json')), auth.ledgerHash);
  assert.equal(sha(join(directory, 'formal-audit.json')), auth.auditHash);
  const state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(state.protocolHash, manifest.protocolHash);
  assert.equal(ledger.protocolHash, manifest.protocolHash);
  assert.equal(state.status, 'formal-completed');
  assert.equal(state.slots.length, 89);
  assert.equal(ledger.rows.length, 76);
  const row = state.slots.find(x => x.id === auth.slotId), review = ledger.rows.find(x => x.id === auth.slotId);
  assert.equal(digest(row), auth.predecessorHash);
  assert.equal(digest(review), auth.reviewHash);
  assert.equal(review.verdict, 'blocked');
  assert.equal(Object.hasOwn(review.assessment, 'canonicalHash'), false);
  assert.equal(review.assessment.eventsHash, sha(join(row.evidence, 'events.jsonl')));
  assert.equal(review.sourceManifestHash, sha(join(row.evidence, 'source-after.json')));
  assert.equal(review.resultHash, sha(join(row.evidence, 'RESULT.md')));
  assert.deepEqual(auth.sources.map(x => x.name), ['formal-disconnect-recovery.mjs']);
  const source = auth.sources[0];
  assert.equal(source.parentHash, parentSources.find(x => x.name === source.name)?.sha256);
  assert.equal(sha(join(folder, 'before', source.name)), source.parentHash);
  assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  assert.equal(sha(join(folder, 'before/state.json')), auth.stateHash);
  assert.equal(sha(join(folder, 'before/content-review.json')), auth.ledgerHash);
  assert.equal(sha(join(folder, 'before/formal-audit.json')), auth.auditHash);
  return {...auth, authorizationHash: sha(file), sources: parentSources.map(x => x.name === source.name ? source : x)};
}

export function loadS4SmallTimeoutRecovery(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-S4-small1-timeout-recovery-20261110'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(auth.kind, 'user-authorized-S4-small1-timeout-retry-v1');
  assert.equal(auth.userInstruction, 'mở lại dashboard và thử Attempt lại');
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(state.protocolHash, manifest.protocolHash); assert.equal(ledger.protocolHash, manifest.protocolHash);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff2-cap4-recovery-20261105/authorization.json')));
  assert.equal(auth.slotId, 'S-4-small-1'); assert.equal(auth.predecessorId, auth.slotId); assert.equal(auth.currentId, auth.slotId + '-attempt-2');
  assert.equal(auth.maxAttempts, 2); assert.equal(manifest.maxAttempts, 2); assert.equal(auth.extraProviderLaunches, 1); assert.equal(auth.launchPermitted, true);
  assert.equal(auth.maxAttemptMs, 3600000); assert.equal(manifest.maxAttemptMs, auth.maxAttemptMs); assert.equal(auth.scopeTimeoutMs, 120000);
  assert.equal(auth.finalUsage, null); assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false);
  assert.equal(auth.baseCount, 60); assert.equal(auth.baseReviewCount, 47);
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
  assert.equal(digest(read(join(folder, 'before/state.json')).slots), auth.baseSlotsHash);
  assert.equal(digest(read(join(folder, 'before/content-review.json')).rows), auth.baseReviewsHash);
  const row = state.slots.find(x => x.id === auth.predecessorId), review = ledger.rows.find(x => x.id === auth.predecessorId);
  assert.equal(digest(row), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash); assert.equal(review.verdict, 'blocked');
  assert.equal(row.status, 'finished'); assert.equal(row.attempt, 1); assert.equal(row.phase, 'formal'); assert.equal(row.turn.status, 'timeout');
  assert.equal(row.launch.model, manifest.model); assert.equal(row.launch.effort, manifest.effort);
  assert.equal(row.nativeStop.appContainer, true); assert.equal(row.nativeStop.writersStopped, true); assert.equal(row.nativeStop.activeProcesses, 0); assert.equal(row.nativeStop.runId, row.launch.runId);
  assert.equal(row.cleanup.passed, true); assert.equal(sha(row.cleanup.path), auth.cleanupHash);
  const cleanup = read(row.cleanup.path); assert.equal(cleanup.passed, true); assert.equal(cleanup.nativeStopVerified, true); assert.equal(cleanup.sessionRelease.verified, true);
  for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
  assert.equal(row.acceptance.passed, true); assert.equal(row.acceptance.cases, 2); assert.deepEqual(row.unexpectedFiles, []);
  assert.equal(sha(join(row.evidence, 'events.jsonl')), auth.eventsHash); assert.equal(review.assessment.eventsHash, auth.eventsHash);
  assert.equal(sha(row.rawProtocol), row.rawProtocolHash); assert.equal(sha(join(row.evidence, 'supervisor', row.launch.runId + '.receipt')), auth.stopHash);
  const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(x => x.message?.method === 'turn/completed').length, 0);
  const usage = events.filter(x => x.message?.method === 'thread/tokenUsage/updated').at(-1).message.params;
  assert.equal(usage.threadId, row.launch.threadId); assert.equal(usage.turnId, row.launch.turnId); assert.deepEqual(row.usage, auth.observedUsage);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) assert.equal(row.usage[key], usage.tokenUsage.total[key]);
  for (const item of auth.evidence) { assert.ok(!item.name.split(/[\\/]/).includes('..')); assert.equal(sha(join(row.evidence, item.name)), item.sha256); }
  const canonical = canonicalEvidence(row.evidence); assert.equal(canonical.hash, auth.canonicalHash);
  const commands = events.filter(x => x.message?.method === 'item/completed' && x.message.params?.item?.type === 'commandExecution');
  assert.equal(commands.length, auth.completedCommands);
  const publicKey = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
  for (const envelope of commands) verifyProviderObservation(read(join(row.evidence, 'handoff/provider-observations', envelope.message.params.item.id + '.json')), publicKey, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
  validateCommandCaptures(row.evidence, commands.map(x => x.message.params.item));
  assert.equal(read(join(row.evidence, 'handoff/verifications/g4s4-revision-02.json')).passed, true);
  assert.equal(sha(join(folder, 'before/transport-fix.json')), auth.repairProofHash);
  const repair = read(join(folder, 'before/transport-fix.json')).repair;
  assert.equal(repair.liveSmoke.completionCommitted, true); assert.equal(repair.liveSmoke.inferenceRequests, 0);
  for (const source of repair.files) assert.equal(sha(source.path), source.sha256);
  const attempts = state.slots.filter(x => (x.slotId ?? x.id) === auth.slotId);
  assert.ok(attempts.length === 1 || attempts.length === 2); assert.deepEqual(attempts.map(x => x.attempt), attempts.map((_, i) => i + 1));
  if (attempts.length === 1) {
    assert.equal(state.slots.at(-1).id, row.id);
    for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) assert.equal(sha(join(row.workspace, name)), hash);
  } else {
    const next = attempts[1]; assert.equal(next.id, auth.currentId);
    if (next.launch) { assert.equal(next.workspace, row.workspace); assert.equal(next.continuationFrom, row.id); assert.equal(next.formalDisconnectRecoveryHash, sha(file)); }
    if (next.binding?.taskId) { assert.equal(next.binding.taskId, row.binding.taskId); assert.notEqual(next.binding.sessionId, row.binding.sessionId); }
  }
  assert.deepEqual(auth.sources.map(x => x.name).sort(), ['compare-review.mjs', 'formal-disconnect-recovery.mjs']);
  for (const source of parentSources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  for (const source of auth.sources) assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  return { ...auth, sources: parentSources.map(source => auth.sources.find(x => x.name === source.name) ?? source), authorizationHash: sha(file), finalTurnTimeout: true, preserveAbsentReviewCanonicalHash: review.assessment.canonicalHash === undefined, canonicalHash: canonical.hash, issues: review.issues,
    feedbackIssues: review.issues, feedbackReason: 'Attempt2/2 authorized after broker activity lease repair. Keep attempt1 BLOCKED and its unknown final usage. Same task/source, fresh session/context and fresh acceptance. Preserve ERR-001-RG, ERR-002-VERIFY and original verifier FAIL with their exact signed evidence. Preserve host finding G6-S4-MISSING-COMPLETION-001 in RESULT and canonical summary, separate from shell errors. Produce fresh RESULT, checkpoint before final publication, matching unique verifier PASS, full readback and completed provider turn with final usage. Compaction accepted. No attempt3 authorized.' };
}

export function loadB2Handoff2ReviewCompatibility(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-B2-handoff2-review-compatibility-20261105'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(auth.kind, 'B2-handoff2-compaction-host-finding-review-v1');
  assert.equal(auth.userInstruction, 'thử lại');
  assert.equal(auth.protocolHash, manifest.protocolHash);
  assert.equal(state.protocolHash, manifest.protocolHash); assert.equal(ledger.protocolHash, manifest.protocolHash);
  assert.equal(auth.extraProviderLaunches, 0); assert.equal(auth.maxAttempts, 2);
  assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false);
  assert.equal(manifest.maxAttempts, 2); assert.equal(manifest.recoveryPolicy.maxProviderLaunchesPerSlot, 2);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff1-cap5-recovery-20261102/authorization.json')));
  assert.equal(auth.predecessorId, 'B-2-handoff-2'); assert.equal(auth.currentId, 'B-2-handoff-2-attempt-2');
  assert.equal(auth.findingId, 'G6-B2-HANDOFF2-COMPACTION-001');
  const before = read(join(folder, 'before/state.json')), beforeLedger = read(join(folder, 'before/content-review.json'));
  assert.equal(auth.baseCount, before.slots.length); assert.equal(auth.baseReviewCount, beforeLedger.rows.length);
  assert.equal(before.slots.at(-1).id, auth.predecessorId); assert.equal(beforeLedger.rows.at(-1).id, auth.predecessorId);
  assert.equal(digest(before.slots), auth.baseSlotsHash); assert.equal(digest(beforeLedger.rows), auth.baseReviewsHash);
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
  assert.equal(sha(join(folder, 'before/manifest.json')), auth.archiveManifestHash);
  for (const entry of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!entry.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', entry.name)), entry.sha256);
    if (/^(evidence|reviews)[\\/]/.test(entry.name)) assert.equal(sha(entry.source), entry.sha256);
  }
  const previous = state.slots.find(r => r.id === auth.predecessorId), review = ledger.rows.find(r => r.id === auth.predecessorId);
  assert.equal(digest(previous), auth.predecessorHash); assert.equal(digest(review), auth.previousReviewHash);
  assert.equal(previous.attemptId, '1f229667-1904-4196-8152-d8f4b378b64a');
  assert.equal(previous.status, 'finished'); assert.equal(previous.turn.status, 'completed');
  assert.equal(previous.failureClass, 'controlled_input_compaction'); assert.equal(previous.measurementEligible, false);
  assert.equal(review.verdict, 'rework'); assert.ok(review.issues.some(x => x.id === auth.findingId));
  assert.equal(review.issues.filter(x => x.id !== auth.findingId).length, 11);
  assert.equal(previous.usage.inputTokens, 3234951); assert.equal(previous.usage.outputTokens, 27207);
  assert.equal(previous.nativeStop.writersStopped, true); assert.equal(previous.nativeStop.activeProcesses, 0);
  assert.equal(previous.nativeStop.appContainer, true); assert.equal(previous.cleanup.passed, true);
  const cleanup = read(previous.cleanup.path); assert.equal(cleanup.sessionRelease.verified, true);
  for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
  assert.equal(sha(join(previous.evidence, 'events.jsonl')), auth.eventsHash);
  assert.equal(review.assessment.eventsHash, auth.eventsHash);
  assert.equal(canonicalEvidence(previous.evidence).hash, review.assessment.canonicalHash);
  const events = readFileSync(join(previous.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const compactions = events.filter(e => e.message?.method === 'item/completed' && e.message.params?.item?.type === 'contextCompaction');
  assert.equal(compactions.length, 1); assert.equal(compactions[0].message.params.item.id, '01a19c77-e732-7ad2-8b34-c2bf6b0e5efa');
  assert.equal(compactions[0].message.params.turnId, previous.launch.turnId);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === auth.predecessorId);
  const cap3File = join(directory, 'formal-B2-handoff2-cap3-recovery-20261105/authorization.json');
  assert.ok(attempts.length >= 1 && attempts.length <= (existsSync(join(directory, 'formal-B2-handoff2-cap4-recovery-20261105/authorization.json')) ? 4 : existsSync(cap3File) ? 3 : 2));
  if (attempts.length === 1) {
    assert.equal(state.slots.at(-1).id, previous.id);
    for (const [name, hash] of Object.entries(read(join(previous.evidence, 'source-after.json')))) assert.equal(sha(join(previous.workspace, name)), hash);
  } else {
    const current = attempts[1]; assert.equal(current.id, auth.currentId); assert.equal(current.attempt, 2);
    if (current.workspace) assert.equal(current.workspace, previous.workspace);
    if (current.launch) assert.equal(current.continuationFrom, previous.id);
    if (current.binding?.taskId) assert.equal(current.binding.taskId, previous.binding.taskId);
    if (current.binding?.sessionId) assert.notEqual(current.binding.sessionId, previous.binding.sessionId);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), parentSources.map(s => s.name).sort());
  for (const source of parentSources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  for (const source of auth.sources) assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  return { ...auth, authorizationHash: sha(file) };
}

export function loadB2Handoff2Cap3Recovery(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-B2-handoff2-cap3-recovery-20261105'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(auth.kind, 'user-requested-B2-handoff2-cap3-v1'); assert.equal(auth.userInstruction, 'thử lại');
  assert.equal(auth.launchPermitted, true); assert.equal(auth.maxAttempts, 3); assert.equal(auth.extraProviderLaunches, 1);
  assert.equal(auth.slotId, 'B-2-handoff-2'); assert.equal(auth.predecessorId, 'B-2-handoff-2-attempt-2');
  assert.equal(auth.currentId, 'B-2-handoff-2-attempt-3');
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(state.protocolHash, manifest.protocolHash);
  assert.equal(ledger.protocolHash, manifest.protocolHash); assert.equal(manifest.maxAttempts, 2);
  assert.equal(manifest.recoveryPolicy.maxProviderLaunchesPerSlot, 2);
  assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff2-review-compatibility-20261105/authorization.json')));
  assert.equal(auth.proposalHash, sha(join(directory, 'formal-B2-handoff2-cap3-proposal-20261105.json')));
  const proposal = read(join(folder, 'before/formal-B2-handoff2-cap3-proposal-20261105.json'));
  assert.equal(proposal.launchPermitted, false); assert.equal(proposal.proposedMaxAttempts, 3);
  assert.equal(proposal.slotId, auth.slotId); assert.equal(proposal.predecessorId, auth.predecessorId);
  assert.equal(sha(join(folder, 'before/formal-B2-handoff2-cap3-proposal-20261105.json')), auth.proposalHash);
  const before = read(join(folder, 'before/state.json')), beforeLedger = read(join(folder, 'before/content-review.json'));
  assert.equal(auth.baseCount, before.slots.length); assert.equal(auth.baseReviewCount, beforeLedger.rows.length);
  assert.equal(before.slots.at(-1).id, auth.predecessorId); assert.equal(beforeLedger.rows.at(-1).id, auth.predecessorId);
  assert.equal(digest(before.slots), auth.baseSlotsHash); assert.equal(digest(beforeLedger.rows), auth.baseReviewsHash);
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
  assert.equal(sha(join(folder, 'before/manifest.json')), auth.archiveManifestHash);
  for (const entry of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!entry.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', entry.name)), entry.sha256);
    if (/^(evidence|reviews)[\\/]/.test(entry.name)) assert.equal(sha(entry.source), entry.sha256);
  }
  const previous = state.slots.find(r => r.id === auth.predecessorId), review = ledger.rows.find(r => r.id === auth.predecessorId);
  assert.equal(digest(previous), auth.predecessorHash); assert.equal(digest(review), auth.previousReviewHash);
  assert.equal(previous.attemptId, '15d699e5-f225-4d23-a58f-b2f88d2b7eb1');
  assert.equal(previous.status, 'finished'); assert.equal(previous.turn.status, 'completed');
  assert.equal(previous.failureClass, null); assert.notEqual(previous.measurementEligible, false);
  assert.equal(previous.usage.inputTokens, 880962); assert.equal(previous.usage.outputTokens, 9979);
  assert.equal(previous.nativeStop.appContainer, true); assert.equal(previous.nativeStop.writersStopped, true);
  assert.equal(previous.nativeStop.activeProcesses, 0); assert.equal(previous.cleanup.passed, true);
  assert.equal(previous.launch.model, manifest.model); assert.equal(previous.launch.effort, manifest.effort);
  const cleanup = read(previous.cleanup.path); assert.equal(cleanup.sessionRelease.verified, true);
  for (const field of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[field], 0);
  assert.equal(review.verdict, 'rework');
  assert.deepEqual(auth.hostFindingIds, ['G6-B2-HANDOFF2-COMPACTION-001', 'G6-B2-HANDOFF2-A2-HOST-FINDING-CONTINUITY-001']);
  assert.ok(review.issues.some(x => x.id === auth.hostFindingIds[1]));
  assert.equal(review.issues.filter(x => !auth.hostFindingIds.includes(x.id)).length, 11);
  assert.equal(sha(join(previous.evidence, 'events.jsonl')), auth.eventsHash);
  assert.equal(review.assessment.eventsHash, auth.eventsHash);
  assert.equal(canonicalEvidence(previous.evidence).hash, review.assessment.canonicalHash);
  const events = readFileSync(join(previous.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(!events.some(e => e.message?.params?.item?.type === 'contextCompaction'));
  const finals = events.filter(e => e.message?.method === 'turn/completed');
  assert.equal(finals.length, 1); assert.deepEqual(finals[0].message.params.turn, previous.turn);
  assert.deepEqual(auth.findingEventsHashes, [ledger.rows.find(r => r.id === auth.slotId).assessment.eventsHash, auth.eventsHash]);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === auth.slotId);
  assert.ok(attempts.length >= 2 && attempts.length <= (existsSync(join(directory, 'formal-B2-handoff2-cap4-recovery-20261105/authorization.json')) ? 4 : 3));
  assert.deepEqual(attempts.map(r => r.attempt), attempts.map((_, i) => i + 1));
  if (attempts.length === 2) {
    assert.equal(state.slots.at(-1).id, previous.id);
    for (const [name, hash] of Object.entries(read(join(previous.evidence, 'source-after.json')))) assert.equal(sha(join(previous.workspace, name)), hash);
  } else {
    const current = attempts[2]; assert.equal(current.id, auth.currentId); assert.equal(current.attempt, 3);
    if (current.workspace) assert.equal(current.workspace, previous.workspace);
    if (current.launch) assert.equal(current.continuationFrom, previous.id);
    if (current.binding?.taskId) assert.equal(current.binding.taskId, previous.binding.taskId);
    if (current.binding?.sessionId) assert.notEqual(current.binding.sessionId, previous.binding.sessionId);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), parentSources.map(s => s.name).sort());
  for (const source of parentSources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  for (const source of auth.sources) assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  const prelaunchRecovery = loadB2Handoff2PrelaunchRecovery(directory, manifest, auth);
  return { ...auth, sources: prelaunchRecovery?.sources ?? auth.sources, scopeTimeoutMs: prelaunchRecovery?.scopeTimeoutMs, prelaunchRecovery, authorizationHash: sha(file), feedbackReason: review.reason + ' Authorized attempt3/3 only. Keep G6-B2-HANDOFF2-COMPACTION-001 and G6-B2-HANDOFF2-A2-HOST-FINDING-CONTINUITY-001 verbatim in RESULT.md and canonical summary/done or decisions, not only referenced artifact contents. Preserve both REWORK verdicts and all eleven actual command errors. These two host finding IDs are not failed model commands: keep them separately from errors.json, never invent receipts for them. Preserve source, use one fresh session/context and fresh acceptance, checkpoint before final publication, unique verifier and full readback. No attempt4.' };
}

export function loadB2Handoff2PrelaunchRecovery(directory, manifest, parent) {
  const folder = join(directory, 'formal-B2-handoff2-cap3-recovery-20261105/prelaunch-scope-recovery-1'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), before = read(join(folder, 'before/state.json')), state = read(join(directory, 'state.json'));
  assert.equal(auth.kind, 'same-approved-B2-handoff2-attempt3-scope-timeout-v1');
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.scopeTimeoutMs, 300000);
  assert.equal(auth.maxModelAttempts, 3); assert.equal(auth.extraProviderLaunches, 0);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff2-cap3-recovery-20261105/authorization.json')));
  assert.equal(auth.preflightAttemptId, '3f20a7d3-1362-4757-bdbb-220204f25816');
  const failed = before.slots.at(-1);
  assert.equal(failed.attemptId, auth.preflightAttemptId); assert.equal(failed.id, parent.currentId);
  assert.equal(failed.status, 'preflight_failed'); assert.equal(failed.launch, null); assert.equal(failed.usage, null);
  assert.equal(digest(failed), auth.preflightHash); assert.equal(auth.beforeStateHash, sha(join(folder, 'before/state.json')));
  const retained = state.preflightFailures?.filter(x => x.record?.attemptId === auth.preflightAttemptId);
  assert.equal(retained?.length, 1); assert.equal(digest(retained[0].record), auth.preflightHash);
  assert.equal(retained[0].inferenceNotStarted, true); assert.equal(retained[0].sourceAndTaskPreserved, true);
  assert.equal(retained[0].recovery, file);
  assert.equal(digest(state.preflightFailures.slice(0, before.preflightFailures.length)), digest(before.preflightFailures));
  const timeoutFile = join(failed.evidence, 'scope-audit/command.json'), checkedFile = join(failed.evidence, 'scope-audit-recheck-300s/command.json');
  assert.equal(sha(timeoutFile), auth.timeoutCommandHash); assert.equal(sha(checkedFile), auth.recheckCommandHash);
  assert.equal(sha(join(failed.evidence, 'scope-input.json.gz')), auth.scopeInputHash);
  const timeout = read(timeoutFile), checked = read(checkedFile), scope = read(checked.stdout.path);
  assert.ok(timeout.error.includes('ETIMEDOUT')); assert.equal(timeout.exitCode, null); assert.equal(timeout.signal, 'SIGTERM');
  assert.deepEqual(checked.argv, timeout.argv); assert.equal(checked.cwd, timeout.cwd);
  assert.equal(checked.exitCode, 0); assert.equal(checked.error, null); assert.equal(checked.signal, null);
  assert.equal(sha(checked.stdout.path), checked.stdout.hash); assert.equal(scope.sid, failed.identity.sid);
  assert.equal(scope.passed, true); assert.deepEqual(scope.matches, []); assert.deepEqual(scope.failures, []); assert.ok(scope.checked > 0);
  for (const name of ['events.jsonl', 'provider', 'boundary.json']) assert.equal(existsSync(join(failed.evidence, name)), false);
  assert.equal(sha(join(folder, 'before/manifest.json')), auth.archiveManifestHash);
  for (const entry of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!entry.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', entry.name)), entry.sha256);
    if (/^evidence[\\/]/.test(entry.name)) assert.equal(sha(entry.source), entry.sha256);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), parent.sources.map(s => s.name).sort());
  for (const source of parent.sources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  for (const source of auth.sources) assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  assert.equal(auth.retainedScratchNotNativeCleanupPass, true);
  return { ...auth, authorizationHash: sha(file) };
}

export function validateB2Handoff2Cap3Findings(proof, row, previous, assessment, result, canonical) {
  if (!proof || proof.currentId !== row.id || proof.predecessorId !== previous?.id || row.continuationFrom !== previous.id) return false;
  for (const [index, id] of proof.hostFindingIds.entries()) {
    if (!result.includes(id) || !(canonical.current + canonical.full).includes(id) ||
        assessment.issues?.some(issue => issue.id === id) ||
        !assessment.hostFindings?.some(finding => finding.id === id && finding.verified === true && finding.priorVerdict === 'rework' &&
          finding.authorizationHash === proof.authorizationHash && finding.rawReference?.includes(proof.findingEventsHashes[index])))
      throw Error('Historical B2 handoff2 cap3 host finding missing or misclassified: ' + id);
  }
  return true;
}

export function loadB2DebugReviewCompatibility(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-B2-debug-review-compatibility-20261102'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(auth.kind, 'B2-debug-compaction-host-finding-review-v1');
  assert.equal(auth.protocolHash, manifest.protocolHash);
  assert.equal(auth.extraProviderLaunches, 0);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-S2-handoff1-compaction-recovery-20261031/postlaunch-review-compatibility/authorization.json')));
  assert.equal(auth.predecessorId, 'B-2-debug-1');
  assert.equal(auth.currentId, 'B-2-debug-1-attempt-2');
  assert.equal(auth.findingId, 'G6-B2-DEBUG1-COMPACTION-001');
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
  assert.equal(sha(join(folder, 'before/state.json')), auth.beforeStateHash);
  assert.equal(sha(join(folder, 'before/content-review.json')), auth.beforeLedgerHash);
  const previous = state.slots.find(r => r.id === auth.predecessorId), current = state.slots.find(r => r.id === auth.currentId);
  assert.equal(digest(previous), auth.predecessorHash); assert.equal(digest(current), auth.currentHash);
  const review = ledger.rows.find(r => r.id === previous.id);
  assert.equal(review.verdict, 'rework'); assert.equal(digest(review), auth.previousReviewHash);
  assert.ok(review.issues.some(x => x.id === auth.findingId));
  assert.equal(previous.failureClass, 'controlled_input_compaction'); assert.equal(previous.measurementEligible, false);
  assert.equal(current.status, 'finished'); assert.equal(current.turn.status, 'completed'); assert.equal(current.failureClass, null);
  assert.equal(current.continuationFrom, previous.id); assert.equal(current.attempt, 2);
  assert.equal(current.workspace, previous.workspace); assert.equal(current.binding.taskId, previous.binding.taskId);
  assert.notEqual(current.binding.sessionId, previous.binding.sessionId);
  assert.equal(current.nativeStop.appContainer, true); assert.equal(current.nativeStop.writersStopped, true);
  assert.equal(current.nativeStop.activeProcesses, 0); assert.equal(current.cleanup.passed, true);
  const events = readFileSync(join(current.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(!events.some(e => e.message?.params?.item?.type === 'contextCompaction'));
  const canonical = canonicalEvidence(current.evidence);
  const report = readFileSync(join(current.evidence, 'RESULT.md'), 'utf8');
  assert.ok(report.includes('compaction') && report.includes('measurementEligible=false'));
  assert.ok((canonical.current + canonical.full).includes('compaction'));
  assert.equal(canonical.hash, auth.canonicalHash);
  assert.equal(sha(join(folder, 'evidence-manifest.json')), auth.evidenceManifestHash);
  for (const entry of read(join(folder, 'evidence-manifest.json'))) assert.equal(sha(entry.path), entry.sha256);
  assert.deepEqual(auth.sources.map(s => s.name).sort(), parentSources.map(s => s.name).sort());
  for (const s of parentSources) assert.equal(sha(join(folder, 'before/sources', s.name)), s.sha256);
  for (const s of auth.sources) assert.equal(sha(join(folder, 'sources', s.name)), s.sha256);
  return { ...auth, authorizationHash: sha(file) };
}

export function validatePublicationRetryRecord(row, events, cleanup) {
  assert.equal(row.id,'B-1-handoff-1-attempt-2'); assert.equal(row.slotId,'B-1-handoff-1');
  assert.equal(row.attempt,2); assert.equal(row.phase,'formal'); assert.equal(row.status,'finished');
  assert.equal(row.turn.status,'completed'); assert.equal(row.failureClass,null);
  const finals=events.filter(x=>x.message?.method==='turn/completed'); assert.equal(finals.length,1);
  assert.equal(finals[0].message.params.threadId,row.launch.threadId); assert.equal(finals[0].message.params.turn.id,row.launch.turnId);
  assert.equal(digest(finals[0].message.params.turn),digest(row.turn));
  assert.ok(!events.some(x=>x.message?.params?.item?.type==='contextCompaction'));
  assert.equal(row.nativeStop?.appContainer,true); assert.equal(row.nativeStop.writersStopped,true); assert.equal(row.nativeStop.activeProcesses,0);
  assert.equal(row.cleanup?.passed,true); assert.equal(cleanup.passed,true); assert.equal(cleanup.nativeStopVerified,true); assert.equal(cleanup.sessionRelease?.verified,true);
  for(const key of ['activeSessions','currentSessions','unreleasedLeases']) assert.equal(cleanup.sessionRelease[key],0);
  assert.equal(row.acceptance?.passed,true); assert.equal(row.acceptance.cases,2); assert.ok(row.binding?.taskId && row.binding?.sessionId);
  assert.equal(row.profileStorage?.privateStorageAllowedVerified,true); assert.deepEqual(row.profileStorage.unexpectedExternalWrites,[]);
  const usage=events.filter(x=>x.message?.method==='thread/tokenUsage/updated').at(-1);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens']) {assert.ok(Number.isSafeInteger(row.usage[key])&&row.usage[key]>=0);assert.equal(usage.message.params.tokenUsage.total[key],row.usage[key]);}
  return true;
}
function loadPublicationRetry(directory, manifest, parent) {
  const folder=join(directory,'formal-handoff-disconnect-recovery/attempt-3'),file=join(folder,'authorization.json');
  if(!existsSync(file))return null;
  const auth=read(file),state=read(join(directory,'state.json')),ledger=read(join(directory,'content-review.json'));
  assert.equal(auth.kind,'user-requested-handoff-publication-attempt3-v1'); assert.equal(auth.userInstruction,'thử lại');
  assert.equal(auth.protocolHash,manifest.protocolHash); assert.equal(auth.parentAuthorizationHash,parent.authorizationHash);
  assert.equal(auth.slotId,'B-1-handoff-1'); assert.equal(auth.maxAttempts,3); assert.equal(auth.defaultMaxAttempts,2);
  assert.equal(auth.baseCount,19); assert.equal(auth.baseReviewCount,6);
  assert.equal(digest(state.slots.slice(0,auth.baseCount)),auth.baseSlotsHash); assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)),auth.baseReviewsHash);
  assert.equal(sha(join(folder,'before/manifest.json')),auth.archiveManifestHash);
  for(const item of read(join(folder,'before/manifest.json')).files)assert.equal(sha(join(folder,'before',item.name)),item.sha256);
  const row=state.slots.find(x=>x.id===auth.predecessorId); assert.equal(digest(row),auth.predecessorHash); assert.equal(row.attemptId,auth.attemptId);
  assert.equal(row.workspace,state.slots.find(x=>x.id===parent.predecessorId).workspace); assert.equal(row.binding.taskId,state.slots.find(x=>x.id===parent.predecessorId).binding.taskId);
  const review=ledger.rows.find(x=>x.id===row.id); assert.equal(review.verdict,'blocked'); assert.equal(review.assessment.canonicalHash,null);
  assert.equal(review.assessment.eventsHash,sha(join(row.evidence,'events.jsonl'))); assert.equal(digest(review),auth.reviewHash);
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validatePublicationRetryRecord(row,events,read(row.cleanup.path));
  assert.equal(sha(row.cleanup.path),auth.cleanupHash); assert.equal(sha(row.rawProtocol),row.rawProtocolHash);
  assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);
  for(const item of auth.evidence)assert.equal(sha(join(row.evidence,item.name)),item.sha256);
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');assert.equal(commands.length,12);assert.ok(commands.every(x=>x.message.params.item.exitCode===0));
  const publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');
  for(const envelope of commands)verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});
  validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),parent.sources.map(x=>x.name).sort());
  for(const source of auth.sources)assert.equal(sha(join(folder,'sources',source.name)),source.sha256);
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===auth.slotId); assert.ok(attempts.length===2||attempts.length===3);
  if(attempts.length===2){assert.equal(state.slots.at(-1).id,row.id);for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(join(row.workspace,name)),hash);}
  else{const next=attempts[2];assert.equal(next.id,auth.slotId+'-attempt-3');assert.equal(next.attempt,3);if(next.launch){assert.equal(next.workspace,row.workspace);assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId)assert.equal(next.binding.taskId,row.binding.taskId);}
  let sources = auth.sources;
  const fixFolder=join(folder,'review-compatibility'),fixFile=join(fixFolder,'authorization.json');
  if(existsSync(fixFile)) {
    const fix=read(fixFile),current=state.slots.find(x=>x.id==='B-1-handoff-1-attempt-3');
    assert.equal(fix.kind,'bound-ancestor-failed-verifier-history-correction-v1'); assert.equal(fix.parentAuthorizationHash,sha(file));
    assert.equal(fix.protocolHash,manifest.protocolHash); assert.equal(fix.extraProviderLaunches,0);
    assert.equal(digest(current),fix.completedAttemptHash); assert.equal(current.turn.status,'completed'); assert.equal(current.cleanup.passed,true);
    assert.equal(sha(join(current.evidence,'events.jsonl')),fix.completedEventsHash);
    assert.equal(sha(join(current.evidence,'handoff/verifications/B-1-revision-07.json')),fix.currentVerifierHash);
    assert.equal(read(join(current.evidence,'handoff/verifications/B-1-revision-07.json')).passed,true);
    assert.deepEqual(fix.sources.map(x=>x.name).sort(),['comparison-evidence.mjs','formal-disconnect-recovery.mjs']);
    for(const source of fix.sources) {assert.equal(sha(join(fixFolder,'before',source.name)),auth.sources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(fixFolder,'sources',source.name)),source.sha256);}
    sources=auth.sources.map(source=>fix.sources.find(x=>x.name===source.name)??source);
  }
  return {...auth,sources,authorizationHash:sha(file),completedIncompleteWorkflow:true,issues:review.issues};
}

function loadS1DebugCancelRecovery(directory, manifest, parentSources) {
  const folder=join(directory,'formal-S-debug-cancel-recovery'),file=join(folder,'authorization.json');
  if(!existsSync(file))return null;
  const auth=read(file),state=read(join(directory,'state.json')),ledger=read(join(directory,'content-review.json'));
  assert.equal(auth.kind,'user-requested-S1-debug-host-cancel-retry-v1');assert.equal(auth.userInstruction,'thử lại đi');
  assert.equal(auth.userConfirmedTabClosure,true);assert.equal(auth.maxAttempts,2);assert.equal(manifest.maxAttempts,2);
  assert.equal(auth.protocolHash,manifest.protocolHash);assert.equal(auth.slotId,'S-1-debug-1');assert.equal(auth.baseCount,24);assert.equal(auth.baseReviewCount,11);
  assert.equal(auth.parentAuthorizationHash,sha(join(directory,'formal-handoff-disconnect-recovery/attempt-3/authorization.json')));
  assert.equal(digest(state.slots.slice(0,auth.baseCount)),auth.baseSlotsHash);assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)),auth.baseReviewsHash);
  assert.equal(sha(join(folder,'before/manifest.json')),auth.archiveManifestHash);
  for(const item of read(join(folder,'before/manifest.json')).files)assert.equal(sha(join(folder,'before',item.name)),item.sha256);
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),parentSources.map(x=>x.name).sort());
  for(const source of auth.sources){assert.equal(sha(join(folder,'before/sources',source.name)),parentSources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  const row=state.slots.find(x=>x.id===auth.slotId),review=ledger.rows.find(x=>x.id===auth.slotId);
  assert.equal(digest(row),auth.predecessorHash);assert.equal(row.attemptId,auth.attemptId);assert.equal(digest(review),auth.reviewHash);assert.equal(review.verdict,'blocked');
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  validateFormalDisconnectRecord(row,events,read(row.cleanup.path),auth.slotId,'host-cancel');
  assert.equal(row.launch.model,manifest.model);assert.equal(row.launch.effort,manifest.effort);
  assert.equal(sha(row.cleanup.path),auth.cleanupHash);assert.equal(sha(row.rawProtocol),row.rawProtocolHash);assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);
  for(const item of auth.evidence)assert.equal(sha(join(row.evidence,item.name)),item.sha256);
  const canonical=canonicalEvidence(row.evidence);assert.equal(canonical.hash,review.assessment.canonicalHash);assert.equal(sha(join(row.evidence,'events.jsonl')),review.assessment.eventsHash);
  assert.equal(read(join(row.evidence,'handoff/verifications/verify-debug-20261030-r8.json')).passed,true);
  validateWorkflowChain(state.slots,row,{requireFinalPass:true});
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');assert.equal(commands.length,48);assert.equal(commands.filter(x=>x.message.params.item.exitCode!==0).length,1);
  const publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');
  for(const envelope of commands)verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});
  validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===row.id);assert.ok(attempts.length===1||attempts.length===2);
  if(attempts.length===1){assert.equal(state.slots.at(-1).id,row.id);for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(join(row.workspace,name)),hash);}
  else{const next=attempts[1];assert.equal(next.id,row.id+'-attempt-2');assert.equal(next.attempt,2);if(next.launch){assert.equal(next.workspace,row.workspace);assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId)assert.equal(next.binding.taskId,row.binding.taskId);}
  return {...auth,predecessorId:row.id,authorizationHash:sha(file),issues:review.issues,hostCancelled:true,canonicalHash:canonical.hash};
}

export function allowTimeoutBlockedReview(row, audited, recovery) {
  const proof=recovery?.formalDisconnectRecovery?.timeoutReviewCompatibility;
  return Boolean(proof && row?.id==='S-1-multi-1' && row.turn?.status==='timeout' && row.failureClass==='controlled_input_compaction' &&
    digest(row)===proof.predecessorHash && row.nativeStop?.writersStopped===true && row.nativeStop.activeProcesses===0 && row.cleanup?.passed===true &&
    audited?.problems?.length===2 && audited.problems.includes('Final turn usage ordering/binding') && audited.problems.includes('Workflow history: Evidence identity missing or ambiguous'));
}
function loadTimeoutReviewCompatibility(directory, manifest, parentSources) {
  const folder=join(directory,'formal-review-timeout-compatibility-20261030'),file=join(folder,'authorization.json');
  if(!existsSync(file))return null;
  const fix=read(file),state=read(join(directory,'state.json')),row=state.slots.find(x=>x.id==='S-1-multi-1');
  assert.equal(fix.kind,'blocked-only-timeout-review-compatibility-v1');assert.equal(fix.protocolHash,manifest.protocolHash);assert.equal(fix.extraProviderLaunches,0);assert.equal(fix.passAllowed,false);assert.equal(fix.retryAllowed,false);
  assert.equal(fix.parentAuthorizationHash,sha(join(directory,'formal-S-debug-cancel-recovery/authorization.json')));
  assert.equal(digest(row),fix.predecessorHash);assert.equal(sha(join(row.evidence,'events.jsonl')),fix.eventsHash);assert.equal(sha(row.cleanup.path),fix.cleanupHash);assert.equal(row.nativeStop.appContainer,true);
  const audit=read(join(folder,'before/formal-audit.partial.json')).details.find(x=>x.id===row.id);
  assert.equal(allowTimeoutBlockedReview(row,audit,{formalDisconnectRecovery:{timeoutReviewCompatibility:fix}}),true);
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(x=>x.message?.method==='turn/completed').length,0);
  assert.deepEqual(fix.sources.map(x=>x.name).sort(),['compare-review.mjs','formal-disconnect-recovery.mjs']);
  for(const source of fix.sources){assert.equal(sha(join(folder,'before',source.name)),parentSources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  return {...fix,sources:parentSources.map(source=>fix.sources.find(x=>x.name===source.name)??source)};
}

export function validateS1MultiTimeoutRecord(row, events, cleanup, audited) {
  assert.equal(row.id,'S-1-multi-1');assert.equal(row.slotId,row.id);assert.equal(row.phase,'formal');assert.equal(row.attempt,1);assert.equal(row.status,'finished');
  assert.equal(row.turn?.status,'timeout');assert.equal(row.failureClass,'controlled_input_compaction');assert.equal(row.measurementEligible,false);
  assert.equal(row.nativeStop?.appContainer,true);assert.equal(row.nativeStop.writersStopped,true);assert.equal(row.nativeStop.activeProcesses,0);assert.equal(row.nativeStop.runId,row.launch.runId);
  assert.equal(row.cleanup?.passed,true);assert.equal(cleanup.passed,true);assert.equal(cleanup.nativeStopVerified,true);assert.equal(cleanup.sessionRelease?.verified,true);
  for(const key of ['activeSessions','currentSessions','unreleasedLeases'])assert.equal(cleanup.sessionRelease[key],0);
  assert.equal(row.acceptance?.passed,true);assert.equal(row.acceptance.cases,2);assert.deepEqual(row.unexpectedFiles,[]);
  assert.ok(row.binding?.taskId && row.binding?.sessionId);assert.equal(row.profileStorage?.privateStorageAllowedVerified,true);assert.deepEqual(row.profileStorage.unexpectedExternalWrites,[]);
  assert.equal(events.filter(x=>x.message?.method==='turn/completed').length,0);
  const compactions=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='contextCompaction');assert.equal(compactions.length,1);assert.equal(compactions[0].message.params.turnId,row.launch.turnId);
  assert.equal(audited.id,row.id);assert.equal(audited.leaseCount,0);assert.equal(audited.sourceRevisionEvidence?.passed,true);
  assert.deepEqual([...audited.problems].sort(),['Final turn usage ordering/binding','Workflow history: Evidence identity missing or ambiguous'].sort());
  const usage=events.filter(x=>x.message?.method==='thread/tokenUsage/updated').at(-1)?.message.params;assert.equal(usage.threadId,row.launch.threadId);assert.equal(usage.turnId,row.launch.turnId);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens']){assert.ok(Number.isSafeInteger(row.usage[key])&&row.usage[key]>=0);assert.equal(row.usage[key],usage.tokenUsage.total[key]);}
  return true;
}

function loadS1MultiTimeoutRecovery(directory, manifest, parentSources) {
  const folder=join(directory,'formal-S-multi-timeout-recovery-20261031'),file=join(folder,'authorization.json');if(!existsSync(file))return null;
  const auth=read(file),state=read(join(directory,'state.json')),ledger=read(join(directory,'content-review.json'));
  assert.equal(auth.kind,'user-requested-S1-multi-timeout-retry-v1');assert.equal(auth.userInstruction,'thử lại S-1-multi-1');assert.equal(auth.protocolHash,manifest.protocolHash);
  assert.equal(auth.parentAuthorizationHash,sha(join(directory,'formal-review-timeout-compatibility-20261030/authorization.json')));
  assert.equal(auth.slotId,'S-1-multi-1');assert.equal(auth.predecessorId,auth.slotId);assert.equal(auth.maxAttempts,2);assert.equal(manifest.maxAttempts,2);assert.equal(auth.extraProviderLaunches,1);
  assert.equal(auth.infrastructureOnly,false);assert.equal(auth.efficiencyExcluded,false);assert.equal(auth.finalUsage,null);assert.equal(auth.baseCount,26);assert.equal(auth.baseReviewCount,13);
  for(const[name,field]of [['state.json','baseSlotsHash'],['content-review.json','baseReviewsHash']]){const archived=read(join(folder,'before',name));assert.equal(digest(name==='state.json'?archived.slots:archived.rows),auth[field]);}
  assert.equal(digest(state.slots.slice(0,auth.baseCount)),auth.baseSlotsHash);assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)),auth.baseReviewsHash);
  const row=state.slots.find(x=>x.id===auth.predecessorId),review=ledger.rows.find(x=>x.id===row.id);assert.equal(digest(row),auth.predecessorHash);assert.equal(row.attemptId,auth.attemptId);assert.equal(digest(review),auth.reviewHash);assert.equal(review.verdict,'blocked');
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse),audited=read(join(folder,'before/formal-audit.partial.json')).details.find(x=>x.id===row.id);
  validateS1MultiTimeoutRecord(row,events,read(row.cleanup.path),audited);assert.equal(row.launch.model,manifest.model);assert.equal(row.launch.effort,manifest.effort);
  assert.equal(sha(join(row.evidence,'events.jsonl')),auth.eventsHash);assert.equal(review.assessment.eventsHash,auth.eventsHash);assert.equal(sha(row.cleanup.path),auth.cleanupHash);assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);
  assert.equal(sha(row.rawProtocol),row.rawProtocolHash);assert.equal(sha(join(folder,'evidence-manifest.json')),auth.evidenceManifestHash);
  for(const item of read(join(folder,'evidence-manifest.json'))){assert.ok(!item.name.split(/[\\/]/).includes('..'));assert.equal(sha(join(row.evidence,item.name)),item.sha256);}
  const canonical=canonicalEvidence(row.evidence);assert.equal(canonical.hash,auth.canonicalHash);assert.equal(review.assessment.canonicalHash,canonical.hash);
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');assert.equal(commands.length,59);assert.equal(commands.filter(x=>x.message.params.item.exitCode!==0).length,7);
  const publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');
  for(const envelope of commands)verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});
  validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  assert.equal(read(join(row.evidence,'handoff/verifications/syncFinal4.json')).passed,false);
  for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===row.id);assert.ok(attempts.length===1||attempts.length===2);
  if(attempts.length===1){assert.equal(state.slots.at(-1).id,row.id);for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(join(row.workspace,name)),hash);}
  else{const next=attempts[1];assert.equal(next.id,row.id+'-attempt-2');assert.equal(next.attempt,2);if(next.launch){assert.equal(next.workspace,row.workspace);assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId)assert.equal(next.binding.taskId,row.binding.taskId);}
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),['compare-audit.mjs','comparison-evidence.mjs','formal-disconnect-recovery.mjs']);
  for(const source of auth.sources){assert.equal(sha(join(folder,'before',source.name)),parentSources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  return {...auth,sources:parentSources.map(source=>auth.sources.find(x=>x.name===source.name)??source),authorizationHash:sha(file),timeoutIncompleteWorkflow:true,canonicalHash:canonical.hash,issues:review.issues};
}

export function validateS1Handoff2TimeoutRecord(row, events, cleanup, audited) {
  assert.equal(row.id,'S-1-handoff-2');assert.equal(row.slotId,row.id);assert.equal(row.phase,'formal');assert.equal(row.attempt,1);assert.equal(row.status,'finished');assert.equal(row.continuationFrom,'S-1-handoff-1');
  assert.equal(row.turn?.status,'timeout');assert.equal(row.failureClass,'product');assert.equal(row.nativeStop?.appContainer,true);assert.equal(row.nativeStop.writersStopped,true);assert.equal(row.nativeStop.activeProcesses,0);assert.equal(row.nativeStop.runId,row.launch.runId);
  assert.equal(row.cleanup?.passed,true);assert.equal(cleanup.passed,true);assert.equal(cleanup.nativeStopVerified,true);assert.equal(cleanup.sessionRelease?.verified,true);
  for(const key of ['activeSessions','currentSessions','unreleasedLeases'])assert.equal(cleanup.sessionRelease[key],0);
  assert.equal(row.acceptance?.passed,true);assert.equal(row.acceptance.cases,2);assert.deepEqual(row.unexpectedFiles,[]);assert.ok(row.binding?.taskId&&row.binding?.sessionId);
  assert.equal(row.profileStorage?.privateStorageAllowedVerified,true);assert.deepEqual(row.profileStorage.unexpectedExternalWrites,[]);
  assert.equal(events.filter(x=>x.message?.method==='turn/completed').length,0);assert.ok(!events.some(x=>x.message?.params?.item?.type==='contextCompaction'));
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');assert.equal(commands.length,55);assert.ok(commands.every(x=>x.message.params.item.exitCode===0));
  assert.equal(audited.id,row.id);assert.equal(audited.integrityPassed,true);assert.equal(audited.leaseCount,0);assert.equal(audited.sourceRevisionEvidence?.passed,true);assert.deepEqual(audited.problems,[]);
  const usage=events.filter(x=>x.message?.method==='thread/tokenUsage/updated').at(-1)?.message.params;assert.equal(usage.threadId,row.launch.threadId);assert.equal(usage.turnId,row.launch.turnId);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens']){assert.ok(Number.isSafeInteger(row.usage[key])&&row.usage[key]>=0);assert.equal(row.usage[key],usage.tokenUsage.total[key]);}
  return true;
}

function loadS1Handoff2TimeoutRecovery(directory, manifest, parentSources) {
  const folder=join(directory,'formal-S-handoff2-timeout-recovery-20261031'),file=join(folder,'authorization.json');if(!existsSync(file))return null;
  const auth=read(file),state=read(join(directory,'state.json')),ledger=read(join(directory,'content-review.json'));
  assert.equal(auth.kind,'user-requested-S1-handoff2-final-timeout-retry-v1');assert.equal(auth.userInstruction,'thử lại');assert.equal(auth.protocolHash,manifest.protocolHash);assert.equal(auth.parentAuthorizationHash,sha(join(directory,'formal-S-multi-timeout-recovery-20261031/authorization.json')));
  assert.equal(auth.slotId,'S-1-handoff-2');assert.equal(auth.predecessorId,auth.slotId);assert.equal(auth.maxAttempts,2);assert.equal(manifest.maxAttempts,2);assert.equal(auth.extraProviderLaunches,1);assert.equal(auth.infrastructureOnly,false);assert.equal(auth.efficiencyExcluded,false);assert.equal(auth.finalUsage,null);assert.equal(auth.baseCount,29);assert.equal(auth.baseReviewCount,16);
  assert.equal(digest(state.slots.slice(0,auth.baseCount)),auth.baseSlotsHash);assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)),auth.baseReviewsHash);
  assert.equal(digest(read(join(folder,'before/state.json')).slots),auth.baseSlotsHash);assert.equal(digest(read(join(folder,'before/content-review.json')).rows),auth.baseReviewsHash);
  const row=state.slots.find(x=>x.id===auth.slotId),review=ledger.rows.find(x=>x.id===row.id),prior=state.slots.find(x=>x.id==='S-1-handoff-1');
  assert.equal(digest(row),auth.predecessorHash);assert.equal(row.attemptId,auth.attemptId);assert.equal(digest(review),auth.reviewHash);assert.equal(review.verdict,'blocked');assert.equal(row.binding.taskId,prior.binding.taskId);assert.notEqual(row.binding.sessionId,prior.binding.sessionId);assert.equal(row.workspace,prior.workspace);
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse),audit=read(join(folder,'before/formal-audit.partial.json')).details.find(x=>x.id===row.id);
  validateS1Handoff2TimeoutRecord(row,events,read(row.cleanup.path),audit);assert.equal(row.launch.model,manifest.model);assert.equal(row.launch.effort,manifest.effort);assert.equal(sha(join(row.evidence,'events.jsonl')),auth.eventsHash);assert.equal(review.assessment.eventsHash,auth.eventsHash);assert.equal(sha(row.cleanup.path),auth.cleanupHash);assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);assert.equal(sha(row.rawProtocol),row.rawProtocolHash);
  assert.equal(sha(join(folder,'evidence-manifest.json')),auth.evidenceManifestHash);for(const item of read(join(folder,'evidence-manifest.json'))){assert.ok(!item.name.split(/[\\/]/).includes('..'));assert.equal(sha(join(row.evidence,item.name)),item.sha256);}
  const canonical=canonicalEvidence(row.evidence);assert.equal(canonical.hash,auth.canonicalHash);assert.equal(review.assessment.canonicalHash,canonical.hash);assert.equal(read(join(row.evidence,'handoff/verifications/S2-verify-1.json')).passed,true);validateWorkflowChain(state.slots,row,{requireFinalPass:true});
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution'),publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');for(const envelope of commands)verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===row.id);assert.ok(attempts.length===1||attempts.length===2);
  if(attempts.length===1){assert.equal(state.slots.at(-1).id,row.id);for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(join(row.workspace,name)),hash);}
  else{const next=attempts[1];assert.equal(next.id,row.id+'-attempt-2');assert.equal(next.attempt,2);if(next.launch){assert.equal(next.workspace,row.workspace);assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId)assert.equal(next.binding.taskId,row.binding.taskId);}
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),['compare-audit.mjs','comparison-evidence.mjs','formal-disconnect-recovery.mjs']);for(const source of auth.sources){assert.equal(sha(join(folder,'before',source.name)),parentSources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  return {...auth,sources:parentSources.map(source=>auth.sources.find(x=>x.name===source.name)??source),authorizationHash:sha(file),finalTurnTimeout:true,canonicalHash:canonical.hash,issues:review.issues};
}

export function validateS2Handoff1CancelRecord(row, events, cleanup, audited) {
  validateFormalDisconnectRecord(row,events,cleanup,'S-2-handoff-1','host-cancel');
  assert.equal(row.failureClass,'product');assert.equal(row.acceptance.cases,2);assert.deepEqual(row.unexpectedFiles,[]);assert.ok(!row.continuationFrom);
  assert.equal(audited.id,row.id);assert.equal(audited.leaseCount,0);assert.equal(audited.sourceRevisionEvidence?.passed,true);assert.equal(audited.integrityPassed,false);
  assert.deepEqual(audited.problems,['Workflow history: canonical publication unavailable: Invalid handoff evidence']);
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution');assert.equal(commands.length,42);assert.deepEqual(commands.flatMap((x,i)=>x.message.params.item.exitCode!==0?[i+1]:[]),[36]);
  return true;
}

function loadS2Handoff1CancelRecovery(directory, manifest, parentSources) {
  const folder=join(directory,'formal-S2-handoff1-cancel-recovery-20261031'),file=join(folder,'authorization.json');if(!existsSync(file))return null;
  const auth=read(file),state=read(join(directory,'state.json')),ledger=read(join(directory,'content-review.json'));
  assert.equal(auth.kind,'user-requested-S2-handoff1-mixed-cancel-retry-v1');assert.equal(auth.userInstruction,'thử lại');assert.equal(auth.protocolHash,manifest.protocolHash);assert.equal(auth.parentAuthorizationHash,sha(join(directory,'formal-S-handoff2-timeout-recovery-20261031/authorization.json')));
  assert.equal(auth.slotId,'S-2-handoff-1');assert.equal(auth.predecessorId,auth.slotId);assert.equal(auth.maxAttempts,2);assert.equal(manifest.maxAttempts,2);assert.equal(auth.extraProviderLaunches,1);assert.equal(auth.infrastructureOnly,false);assert.equal(auth.efficiencyExcluded,false);assert.equal(auth.finalUsage,null);assert.equal(auth.canonicalHash,null);assert.equal(auth.baseCount,34);assert.equal(auth.baseReviewCount,21);
  assert.equal(digest(state.slots.slice(0,auth.baseCount)),auth.baseSlotsHash);assert.equal(digest(ledger.rows.slice(0,auth.baseReviewCount)),auth.baseReviewsHash);assert.equal(digest(read(join(folder,'before/state.json')).slots),auth.baseSlotsHash);assert.equal(digest(read(join(folder,'before/content-review.json')).rows),auth.baseReviewsHash);
  const row=state.slots.find(x=>x.id===auth.slotId),review=ledger.rows.find(x=>x.id===row.id);assert.equal(digest(row),auth.predecessorHash);assert.equal(row.attemptId,auth.attemptId);assert.equal(digest(review),auth.reviewHash);assert.equal(review.verdict,'blocked');assert.equal(review.assessment.canonicalHash,null);
  const events=readFileSync(join(row.evidence,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse),audit=read(join(folder,'before/formal-audit.partial.json')).details.find(x=>x.id===row.id);
  validateS2Handoff1CancelRecord(row,events,read(row.cleanup.path),audit);assert.equal(row.launch.model,manifest.model);assert.equal(row.launch.effort,manifest.effort);assert.equal(sha(join(row.evidence,'events.jsonl')),auth.eventsHash);assert.equal(review.assessment.eventsHash,auth.eventsHash);assert.equal(sha(row.cleanup.path),auth.cleanupHash);assert.equal(sha(join(row.evidence,'supervisor',row.launch.runId+'.receipt')),auth.stopHash);assert.equal(sha(row.rawProtocol),row.rawProtocolHash);
  assert.equal(sha(join(folder,'evidence-manifest.json')),auth.evidenceManifestHash);for(const item of read(join(folder,'evidence-manifest.json'))){assert.ok(!item.name.split(/[\\/]/).includes('..'));assert.equal(sha(join(row.evidence,item.name)),item.sha256);}
  assert.throws(()=>canonicalEvidence(row.evidence),/Invalid handoff evidence/);assert.equal(read(join(row.evidence,'handoff/verifications/shipping-S2-v1.json')).passed,false);
  const failed=read(join(row.evidence,'handoff/commands/build-payload-shipping-S2-1/command.json'));assert.equal(failed.exitCode,1);assert.equal(sha(join(row.evidence,failed.stderr.path.replace(/^\.handoff[\\/]/,'handoff/'))),failed.stderr.hash);assert.ok(readFileSync(join(row.evidence,failed.stderr.path.replace(/^\.handoff[\\/]/,'handoff/')),'utf8').includes('ENOENT'));
  const commands=events.filter(x=>x.message?.method==='item/completed'&&x.message.params?.item?.type==='commandExecution'),publicKey=readFileSync(join(directory,'protocol/provider-observation-public.pem'),'utf8');for(const envelope of commands)verifyProviderObservation(read(join(row.evidence,'handoff/provider-observations',envelope.message.params.item.id+'.json')),publicKey,{binding:providerObservationBinding(manifest.protocolHash,row),envelope});validateCommandCaptures(row.evidence,commands.map(x=>x.message.params.item));
  for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(name==='RESULT.md'?join(row.evidence,name):join(row.evidence,'source-after',name.slice(4))),hash);
  const attempts=state.slots.filter(x=>(x.slotId??x.id)===row.id);assert.ok(attempts.length===1||attempts.length===2||attempts.length===3&&existsSync(join(directory,'formal-S2-handoff1-compaction-recovery-20261031/authorization.json')));
  if(attempts.length===1){assert.equal(state.slots.at(-1).id,row.id);for(const[name,hash]of Object.entries(read(join(row.evidence,'source-after.json'))))assert.equal(sha(join(row.workspace,name)),hash);}
  else{const next=attempts[1];assert.equal(next.id,row.id+'-attempt-2');assert.equal(next.attempt,2);if(next.launch){assert.equal(next.workspace,row.workspace);assert.equal(next.continuationFrom,row.id);assert.equal(next.formalDisconnectRecoveryHash,sha(file));}if(next.binding?.taskId)assert.equal(next.binding.taskId,row.binding.taskId);}
  assert.deepEqual(auth.sources.map(x=>x.name).sort(),['compare-audit.mjs','formal-disconnect-recovery.mjs']);for(const source of auth.sources){assert.equal(sha(join(folder,'before',source.name)),parentSources.find(x=>x.name===source.name).sha256);assert.equal(sha(join(folder,'sources',source.name)),source.sha256);}
  return {...auth,sources:parentSources.map(source=>auth.sources.find(x=>x.name===source.name)??source),authorizationHash:sha(file),hostCancelled:true,mixedCancelledWorkflow:true,issues:review.issues};
}
