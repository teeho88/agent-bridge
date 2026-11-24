import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence, validateCommandCaptures, validateWorkflowChain } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';
const read = p => JSON.parse(readFileSync(p));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function loadB2HandoffCompactionRecovery(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-B2-handoff1-compaction-recovery-20261102'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), proposal = read(join(folder, 'proposal.json'));
  assert.equal(auth.kind, 'user-requested-B2-handoff1-compaction-attempt3-v1');
  assert.equal(auth.userInstruction, 'thử lại'); assert.equal(auth.launchPermitted, true);
  assert.ok(Number.isFinite(Date.parse(auth.approvedAt)));
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.round, directory);
  assert.equal(auth.slotId, 'B-2-handoff-1'); assert.equal(auth.predecessorId, auth.slotId + '-attempt-2');
  assert.equal(auth.nextInvocationId, auth.slotId + '-attempt-3');
  assert.equal(auth.maxAttempts, 3); assert.equal(auth.extraProviderLaunches, 1);
  assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false);
  assert.equal(manifest.maxAttempts, 2); assert.equal(manifest.recoveryPolicy.maxProviderLaunchesPerSlot, 2);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-debug-review-compatibility-20261102/authorization.json')));
  assert.equal(auth.proposalHash, sha(join(folder, 'proposal.json')));
  assert.equal(proposal.userInstruction, auth.userInstruction); assert.equal(proposal.launchPermitted, false);
  assert.equal(proposal.proposedCap, 3); assert.equal(proposal.defaultCap, 2);
  assert.equal(auth.archiveManifestHash, sha(join(folder, 'before/manifest.json')));
  assert.equal(proposal.archiveManifestHash, auth.archiveManifestHash);
  for (const item of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!item.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', item.name)), item.sha256);
    if (/^(evidence|reviews)[\\/]/.test(item.name)) assert.equal(sha(item.source), item.sha256);
  }
  const state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(digest(state.slots.slice(0, proposal.baseCount)), proposal.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, proposal.baseReviewCount)), proposal.baseReviewsHash);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === auth.slotId);
  const cap5 = existsSync(join(directory, 'formal-B2-handoff1-cap5-recovery-20261102/authorization.json'));
  assert.ok(attempts.length >= 2 && attempts.length <= (cap5 ? 5 : 3));
  assert.deepEqual(attempts.map(r => r.id), attempts.map((_, i) => i === 0 ? auth.slotId : auth.slotId + '-attempt-' + (i + 1)));
  const before = read(join(folder, 'before/state.json')), reviews = read(join(folder, 'before/content-review.json'));
  for (const [index, row] of attempts.slice(0, 2).entries()) {
    assert.equal(digest(row), digest(before.slots.find(x => x.id === row.id)));
    const review = ledger.rows.find(x => x.id === row.id);
    assert.equal(digest(review), digest(reviews.rows.find(x => x.id === row.id)));
    assert.equal(review.verdict, 'rework'); assert.equal(row.status, 'finished'); assert.equal(row.turn.status, 'completed');
    assert.equal(row.failureClass, 'controlled_input_compaction'); assert.equal(row.measurementEligible, false);
    assert.equal(row.nativeStop.appContainer, true); assert.equal(row.nativeStop.writersStopped, true);
    assert.equal(row.nativeStop.activeProcesses, 0); assert.equal(row.cleanup.passed, true);
    assert.equal(row.binding.taskId, 'g4-handoff-6afe04a9');
    assert.equal(row.launch.model, manifest.model); assert.equal(row.launch.effort, manifest.effort);
    assert.equal(sha(row.rawProtocol), row.rawProtocolHash);
    const cleanup = read(row.cleanup.path); assert.equal(cleanup.sessionRelease.verified, true);
    for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
    const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const compact = events.filter(e => e.message?.params?.item?.type === 'contextCompaction');
    assert.deepEqual(compact.map(e => e.message.method), ['item/started', 'item/completed']);
    for (const e of compact) {
      assert.equal(e.message.params.item.id, index === 0 ? '01a19b65-12c3-76c0-ab95-5853975a8f5d' : '01a19bb9-6c21-7cf3-913a-a0f7d02a5ba0');
      assert.equal(e.message.params.turnId, row.launch.turnId);
    }
    const finals = events.filter(e => e.message?.method === 'turn/completed');
    assert.equal(finals.length, 1); assert.deepEqual(finals[0].message.params.turn, row.turn);
    const commands = events.filter(e => e.message?.method === 'item/completed' && e.message.params?.item?.type === 'commandExecution');
    const key = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
    for (const envelope of commands) verifyProviderObservation(read(join(row.evidence, 'handoff/provider-observations', envelope.message.params.item.id + '.json')), key, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
    validateCommandCaptures(row.evidence, commands.map(e => e.message.params.item));
    assert.equal(canonicalEvidence(row.evidence).hash, review.assessment.canonicalHash);
    validateWorkflowChain(state.slots, row, { requireFinalPass: true });
  }
  const previous = attempts[1], review = ledger.rows.find(x => x.id === previous.id);
  if (attempts.length === 2) {
    assert.equal(state.slots.at(-1).id, previous.id);
    for (const [name, hash] of Object.entries(read(join(previous.evidence, 'source-after.json')))) assert.equal(sha(join(previous.workspace, name)), hash);
  } else {
    const next = attempts[2]; assert.equal(next.attempt, 3);
    if (next.workspace) assert.equal(next.workspace, previous.workspace);
    if (next.launch) { assert.equal(next.continuationFrom, previous.id); assert.equal(next.formalDisconnectRecoveryHash, sha(file)); }
    if (next.binding?.taskId) assert.equal(next.binding.taskId, previous.binding.taskId);
    if (next.binding?.sessionId) assert.notEqual(next.binding.sessionId, previous.binding.sessionId);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), [...parentSources.map(s => s.name), 'b2-handoff-compaction-recovery.mjs'].sort());
  for (const s of parentSources) assert.equal(sha(join(folder, 'before/sources', s.name)), s.sha256);
  for (const s of auth.sources) assert.equal(sha(join(folder, 'sources', s.name)), s.sha256);
  return { ...auth, authorizationHash: sha(file), predecessorHash: digest(previous), canonicalHash: canonicalEvidence(previous.evidence).hash,
    completedCompaction: true, compactionFindingId: 'G6-B2-HANDOFF1-A2-COMPACTION-001', historicalFindingIds: ['G6-B2-HANDOFF1-COMPACTION-001', 'G6-B2-HANDOFF1-A2-COMPACTION-001'], issues: review.issues };
}
