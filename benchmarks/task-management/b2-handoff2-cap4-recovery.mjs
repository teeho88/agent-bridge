import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence } from './comparison-evidence.mjs';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const cap4Folder = 'formal-B2-handoff2-cap4-recovery-20261105';
export function loadB2Handoff2Cap4Recovery(directory, manifest, parentSources, policy) {
  const folder = join(directory, cap4Folder), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(auth.kind, 'user-approved-B2-handoff2-cap4-v1'); assert.equal(auth.userInstruction, 'cho phép');
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff2-cap3-recovery-20261105/authorization.json')));
  assert.equal(auth.proposalHash, sha(join(folder, 'before/formal-B2-handoff2-attempt4-proposal-20261105.json')));
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.parentPolicyHash, policy.authorizationHash); assert.equal(policy.acceptCompaction, true);
  assert.equal(auth.slotId, 'B-2-handoff-2'); assert.equal(auth.predecessorId, auth.slotId + '-attempt-3'); assert.equal(auth.currentId, auth.slotId + '-attempt-4');
  assert.equal(auth.launchPermitted, true); assert.equal(auth.extraProviderLaunches, 1); assert.equal(auth.maxAttempts, 4);
  assert.equal(auth.maxAttemptMs, 3600000); assert.equal(manifest.maxAttemptMs, auth.maxAttemptMs); assert.equal(auth.scopeTimeoutMs, 300000);
  assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false); assert.equal(auth.finalUsage, null); assert.equal(auth.discloseMissingFinalUsage, true);
  assert.equal(sha(join(folder, 'before/manifest.json')), auth.archiveManifestHash);
  for (const item of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!item.name.split(/[\\/]/).includes('..')); assert.equal(sha(join(folder, 'before', item.name)), item.sha256);
    if (/^(?:evidence|reviews)[\\/]/.test(item.name)) assert.equal(sha(item.source), item.sha256);
  }
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash); assert.equal(auth.baseCount, 48);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash); assert.equal(auth.baseReviewCount, 35);
  assert.equal(digest(read(join(folder, 'before/state.json')).slots), auth.baseSlotsHash);
  assert.equal(digest(read(join(folder, 'before/content-review.json')).rows), auth.baseReviewsHash);
  const row = state.slots.find(r => r.id === auth.predecessorId), review = ledger.rows.find(r => r.id === row.id);
  assert.equal(digest(row), auth.predecessorHash); assert.equal(digest(review), auth.reviewHash); assert.equal(review.verdict, 'blocked');
  assert.equal(row.attemptId, 'a718fd5a-5322-47e6-9948-618b8b145f17'); assert.equal(row.launch.runId, 'deb157da-50d6-477e-b159-724a3b948591');
  assert.equal(row.status, 'finished'); assert.equal(row.turn.status, 'timeout'); assert.deepEqual(row.usage, auth.observedUsage);
  assert.equal(row.nativeStop.appContainer, true); assert.equal(row.nativeStop.writersStopped, true); assert.equal(row.nativeStop.activeProcesses, 0); assert.equal(row.nativeStop.runId, row.launch.runId);
  assert.equal(row.cleanup.passed, true); assert.equal(sha(row.cleanup.path), auth.cleanupHash);
  const cleanup = read(row.cleanup.path); assert.equal(cleanup.passed, true); assert.equal(cleanup.nativeStopVerified, true); assert.equal(cleanup.sessionRelease.verified, true);
  for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
  assert.equal(sha(join(row.evidence, 'events.jsonl')), auth.eventsHash); assert.equal(review.assessment.eventsHash, auth.eventsHash);
  assert.equal(sha(row.rawProtocol), row.rawProtocolHash);
  const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter(e => e.message?.method === 'turn/completed').length, 0);
  const usage = events.filter(e => e.message?.method === 'thread/tokenUsage/updated').at(-1).message.params;
  assert.equal(usage.turnId, row.launch.turnId); assert.equal(usage.threadId, row.launch.threadId);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) assert.equal(row.usage[key], usage.tokenUsage.total[key]);
  const canonical = canonicalEvidence(row.evidence); assert.equal(canonical.hash, auth.canonicalHash); assert.equal(review.assessment.canonicalHash, canonical.hash);
  assert.equal(auth.actualIssueIds.length, 13); assert.equal(new Set(auth.actualIssueIds).size, 13);
  assert.deepEqual(auth.actualIssueIds, review.issues.filter(i => !auth.hostFindingIds.includes(i.id)).map(i => i.id));
  assert.deepEqual(auth.hostFindingIds, ['G6-B2-HANDOFF2-A3-INCOMPLETE-TURN-001', 'G6-B2-HANDOFF2-A3-FINAL-VERIFIER-001']);
  for (const id of auth.hostFindingIds) assert.ok(review.issues.some(i => i.id === id));
  for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) assert.equal(sha(name === 'RESULT.md' ? join(row.evidence, name) : join(row.evidence, 'source-after', name.slice(4))), hash);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === auth.slotId);
  assert.ok(attempts.length === 3 || attempts.length === 4); assert.deepEqual(attempts.map(r => r.attempt), attempts.map((_, i) => i + 1));
  if (attempts.length === 3) {
    assert.equal(state.slots.at(-1).id, row.id);
    for (const [name, hash] of Object.entries(read(join(row.evidence, 'source-after.json')))) assert.equal(sha(join(row.workspace, name)), hash);
  } else {
    const next = attempts[3]; assert.equal(next.id, auth.currentId); assert.equal(next.attempt, 4);
    if (next.workspace) assert.equal(next.workspace, row.workspace);
    if (next.launch) { assert.equal(next.continuationFrom, row.id); assert.equal(next.formalDisconnectRecoveryHash, sha(file)); }
    if (next.binding?.taskId) assert.equal(next.binding.taskId, row.binding.taskId);
    if (next.binding?.sessionId) assert.notEqual(next.binding.sessionId, row.binding.sessionId);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), [...parentSources.map(s => s.name), 'b2-handoff2-cap4-recovery.mjs'].sort());
  for (const source of parentSources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  for (const source of auth.sources) assert.equal(sha(join(folder, 'sources', source.name)), source.sha256);
  return { ...auth, authorizationHash: sha(file), approvedTimeoutGap: true, feedbackIssues: review.issues.filter(i => auth.hostFindingIds.includes(i.id)),
    feedbackReason: `Attempt4/4 authorized. Attempt3 remains BLOCKED: timeout with unknown final usage and no verifier matching its last publication. Preserve both host finding IDs ${auth.hostFindingIds.join(', ')} in RESULT and canonical summary; keep them separate from command errors. Preserve all thirteen actual historical errors ${auth.actualIssueIds.join(', ')} with original signed receipts, failures and corrections. Preserve earlier verifier FAIL and earlier PASS without claiming they verify the later publication. Fresh session/context, fresh acceptance and RESULT, checkpoint before final publication, unique matching verifier PASS and full readback, then complete the provider turn. Compaction is accepted; no compaction finding continuity requirement. Avoid unrelated process diagnostics. Host owns native stop/cleanup. No attempt5.` };
}

export function validateB2Handoff2Cap4History(proof, row, previous, assessment, result, canonical, errors) {
  if (!proof || row.id !== proof.currentId) return false;
  assert.equal(row.continuationFrom, proof.predecessorId); assert.equal(previous?.id, proof.predecessorId);
  const text = JSON.stringify(canonical);
  for (const id of proof.actualIssueIds) {
    assert.ok(errors.issues.some(i => i.id === id), `Missing actual error ${id}`);
    assert.ok(assessment.issues.some(i => i.id === id), `Missing assessed error ${id}`);
    assert.ok(result.includes(id) && text.includes(id), `Missing actual error history ${id}`);
  }
  for (const id of proof.hostFindingIds) {
    assert.ok(!errors.issues.some(i => i.id === id) && !assessment.issues.some(i => i.id === id), `Host finding invented as command error ${id}`);
    assert.ok(result.includes(id) && text.includes(id), `Missing host history ${id}`);
    const finding = assessment.hostFindings?.find(i => i.id === id);
    assert.equal(finding?.verified, true); assert.equal(finding?.priorVerdict, 'blocked'); assert.equal(finding?.recoveryAuthorizationHash, proof.authorizationHash);
    assert.ok(finding?.rawReference?.includes(proof.eventsHash));
  }
  return true;
}
