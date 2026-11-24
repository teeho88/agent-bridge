import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence, validateCommandCaptures, validateWorkflowChain } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';
const read = p => JSON.parse(readFileSync(p));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const slotId = 'B-2-handoff-1';

export function loadB2HandoffCap5Recovery(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-B2-handoff1-cap5-recovery-20261102'), file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), proposal = read(join(folder, 'proposal.json'));
  assert.equal(auth.kind, 'user-approved-B2-handoff1-cap5-v1');
  assert.equal(auth.userInstruction, 'cho phép thử lần 4, nâng giới hạn lên 5');
  assert.equal(auth.launchPermitted, true); assert.ok(Number.isFinite(Date.parse(auth.approvedAt)));
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.round, directory);
  assert.equal(auth.slotId, slotId); assert.equal(auth.maxAttempts, 5); assert.equal(auth.extraProviderLaunches, 2);
  assert.equal(auth.infrastructureOnly, false); assert.equal(auth.efficiencyExcluded, false);
  assert.equal(manifest.maxAttempts, 2); assert.equal(manifest.recoveryPolicy.maxProviderLaunchesPerSlot, 2);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff1-compaction-recovery-20261102/authorization.json')));
  assert.equal(auth.proposalHash, sha(join(folder, 'proposal.json')));
  assert.equal(proposal.userInstruction, auth.userInstruction); assert.equal(proposal.launchPermitted, false);
  assert.equal(proposal.maxAttempts, 5); assert.equal(proposal.defaultCap, 2);
  assert.equal(auth.archiveManifestHash, sha(join(folder, 'before/manifest.json')));
  assert.equal(auth.archiveManifestHash, proposal.archiveManifestHash);
  for (const item of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!item.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', item.name)), item.sha256);
    if (/^(evidence|reviews)[\\/]/.test(item.name)) assert.equal(sha(item.source), item.sha256);
  }
  const state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(digest(state.slots.slice(0, proposal.baseCount)), proposal.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, proposal.baseReviewCount)), proposal.baseReviewsHash);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === slotId);
  assert.ok(attempts.length >= 3 && attempts.length <= 5);
  assert.deepEqual(attempts.map(r => r.id), attempts.map((_, i) => i === 0 ? slotId : slotId + '-attempt-' + (i + 1)));
  assert.deepEqual(attempts.map(r => r.attempt), attempts.map((_, i) => i + 1));
  const publicKey = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
  const entries = [];
  for (const [index, row] of attempts.entries()) {
    if (index < 2) continue;
    const previous = attempts[index - 1];
    if (row.workspace) assert.equal(row.workspace, previous.workspace);
    if (row.launch) {
      assert.equal(row.continuationFrom, previous.id);
      if (index >= 3) assert.equal(row.formalDisconnectRecoveryHash, sha(file));
    }
    if (row.binding?.taskId) assert.equal(row.binding.taskId, 'g4-handoff-6afe04a9');
    if (row.binding?.sessionId) assert.notEqual(row.binding.sessionId, previous.binding.sessionId);
    const review = ledger.rows.find(x => x.id === row.id);
    if (index >= 3 && !review) continue;
    if (index >= 3 && review.verdict !== 'rework') continue;
    if (index >= 3 && row.failureClass !== 'controlled_input_compaction') continue;
    assert.equal(row.status, 'finished'); assert.equal(row.turn.status, 'completed');
    assert.equal(row.nativeStop.appContainer, true); assert.equal(row.nativeStop.writersStopped, true);
    assert.equal(row.nativeStop.activeProcesses, 0); assert.equal(row.cleanup.passed, true);
    assert.equal(row.launch.model, manifest.model); assert.equal(row.launch.effort, manifest.effort);
    assert.equal(sha(row.rawProtocol), row.rawProtocolHash);
    const cleanup = read(row.cleanup.path); assert.equal(cleanup.sessionRelease.verified, true);
    for (const key of ['activeSessions', 'currentSessions', 'unreleasedLeases']) assert.equal(cleanup.sessionRelease[key], 0);
    const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const finals = events.filter(e => e.message?.method === 'turn/completed');
    assert.equal(finals.length, 1); assert.deepEqual(finals[0].message.params.turn, row.turn);
    const usage = events.filter(e => e.message?.method === 'thread/tokenUsage/updated').at(-1);
    assert.equal(usage.message.params.turnId, row.launch.turnId);
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) assert.equal(row.usage[key], usage.message.params.tokenUsage.total[key]);
    const commands = events.filter(e => e.message?.method === 'item/completed' && e.message.params?.item?.type === 'commandExecution');
    for (const envelope of commands) verifyProviderObservation(read(join(row.evidence, 'handoff/provider-observations', envelope.message.params.item.id + '.json')), publicKey, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
    validateCommandCaptures(row.evidence, commands.map(e => e.message.params.item));
    const canonical = canonicalEvidence(row.evidence);
    assert.equal(canonical.hash, review.assessment.canonicalHash);
    validateWorkflowChain(state.slots, row, { requireFinalPass: true });
    if (index >= 3 && row.failureClass !== 'controlled_input_compaction') continue;
    assert.equal(review.verdict, 'rework'); assert.equal(row.failureClass, 'controlled_input_compaction'); assert.equal(row.measurementEligible, false);
    const compact = events.filter(e => e.message?.params?.item?.type === 'contextCompaction');
    assert.ok(compact.length >= 2); assert.equal(compact[0].message.method, 'item/started');
    assert.ok(compact.some(e => e.message.method === 'item/completed' && e.message.params.item.id === compact[0].message.params.item.id));
    assert.ok(compact.every(e => e.message.params.turnId === row.launch.turnId));
    const findingId = 'G6-B2-HANDOFF1-A' + row.attempt + '-COMPACTION-001';
    assert.ok(review.issues.some(x => x.id === findingId));
    entries.push({ predecessorId: row.id, nextInvocationId: slotId + '-attempt-' + (row.attempt + 1),
      predecessorHash: digest(row), completedCompaction: true, cap5Authorized: true, canonicalHash: canonical.hash,
      authorizationHash: sha(file), compactionFindingId: findingId, historicalFindingIds: ['G6-B2-HANDOFF1-COMPACTION-001',
        ...attempts.slice(1, index + 1).map(x => 'G6-B2-HANDOFF1-A' + x.attempt + '-COMPACTION-001')], issues: review.issues });
  }
  if (attempts.length === 3) {
    assert.equal(state.slots.at(-1).id, attempts[2].id);
    for (const [name, hash] of Object.entries(read(join(attempts[2].evidence, 'source-after.json')))) assert.equal(sha(join(attempts[2].workspace, name)), hash);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), [...parentSources.map(s => s.name), 'b2-handoff-cap5-recovery.mjs'].sort());
  for (const s of parentSources) assert.equal(sha(join(folder, 'before/sources', s.name)), s.sha256);
  for (const s of auth.sources) assert.equal(sha(join(folder, 'sources', s.name)), s.sha256);
  return { ...auth, authorizationHash: sha(file), entries };
}
