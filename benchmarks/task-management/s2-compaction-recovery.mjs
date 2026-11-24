import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence, validateCommandCaptures } from './comparison-evidence.mjs';
import { verifyProviderObservation, providerObservationBinding } from './provider-observations.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function loadS2CompactionRecovery(directory, manifest, parentSources) {
  const folder = join(directory, 'formal-S2-handoff1-compaction-recovery-20261031');
  const file = join(folder, 'authorization.json');
  if (!existsSync(file)) return null;
  const auth = read(file), proposal = read(join(folder, 'proposal.json'));
  assert.equal(auth.kind, 'user-approved-S2-handoff1-compaction-attempt3-v1');
  assert.equal(auth.userInstruction, 'phê duyệt');
  assert.equal(auth.launchPermitted, true);
  assert.ok(Number.isFinite(Date.parse(auth.approvedAt)));
  assert.equal(auth.protocolHash, manifest.protocolHash);
  assert.equal(auth.round, directory);
  assert.equal(auth.slotId, 'S-2-handoff-1');
  assert.equal(auth.predecessorId, auth.slotId + '-attempt-2');
  assert.equal(auth.maxAttempts, 3);
  assert.equal(auth.extraProviderLaunches, 1);
  assert.equal(auth.infrastructureOnly, false);
  assert.equal(auth.efficiencyExcluded, false);
  assert.equal(manifest.maxAttempts, 2);
  assert.equal(manifest.recoveryPolicy.maxProviderLaunchesPerSlot, 2);
  assert.equal(sha(join(folder, 'proposal.json')), auth.proposalHash);
  assert.equal(proposal.status, 'PENDING_EXPLICIT_APPROVAL');
  assert.equal(proposal.launchPermitted, false);
  assert.equal(proposal.userInstruction, null);
  assert.equal(proposal.scope.nextInvocationId, auth.slotId + '-attempt-3');
  assert.equal(sha(join(directory, 'formal-S2-handoff1-cancel-recovery-20261031/authorization.json')), auth.parentAuthorizationHash);
  assert.equal(sha(join(folder, 'before/manifest.json')), proposal.base.archiveManifestHash);
  for (const entry of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!entry.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', entry.name)), entry.sha256);
    if (entry.source.startsWith(join(directory, 'e') + '\\') || entry.source.startsWith(join(directory, 'reviews') + '\\'))
      assert.equal(sha(entry.source), entry.sha256);
  }
  const state = read(join(directory, 'state.json')), ledger = read(join(directory, 'content-review.json'));
  assert.equal(digest(state.slots.slice(0, auth.baseCount)), auth.baseSlotsHash);
  assert.equal(digest(ledger.rows.slice(0, auth.baseReviewCount)), auth.baseReviewsHash);
  const row = state.slots.find(r => r.id === auth.predecessorId), review = ledger.rows.find(r => r.id === row.id);
  assert.equal(digest(row), proposal.base.predecessorDigest);
  assert.equal(digest(review), proposal.base.reviewDigest);
  assert.equal(review.verdict, 'rework');
  assert.equal(row.status, 'finished');
  assert.equal(row.turn.status, 'completed');
  assert.equal(row.failureClass, 'controlled_input_compaction');
  assert.equal(row.measurementEligible, false);
  assert.equal(row.nativeStop.appContainer, true);
  assert.equal(row.nativeStop.writersStopped, true);
  assert.equal(row.nativeStop.activeProcesses, 0);
  assert.equal(row.cleanup.passed, true);
  assert.equal(read(row.cleanup.path).sessionRelease.verified, true);
  assert.deepEqual(row.usage, proposal.accounting.predecessorUsage);
  assert.equal(row.workspace, proposal.scope.workspace);
  assert.equal(row.binding.taskId, proposal.scope.taskId);
  assert.equal(row.launch.model, manifest.model);
  assert.equal(row.launch.effort, manifest.effort);
  assert.equal(sha(row.rawProtocol), row.rawProtocolHash);
  const events = readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const compact = events.filter(e => e.message?.params?.item?.type === 'contextCompaction');
  assert.deepEqual(compact.map(e => e.message.method), ['item/started', 'item/completed']);
  for (const e of compact) {
    assert.equal(e.message.params.item.id, '01a1918a-bd0a-7863-8f99-79d8510bcb3b');
    assert.equal(e.message.params.turnId, row.launch.turnId);
    assert.equal(e.message.params.threadId, row.launch.threadId);
  }
  const finals = events.filter(e => e.message?.method === 'turn/completed');
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0].message.params.turn, row.turn);
  const commands = events.filter(e => e.message?.method === 'item/completed' && e.message.params?.item?.type === 'commandExecution');
  const key = readFileSync(join(directory, 'protocol/provider-observation-public.pem'), 'utf8');
  for (const envelope of commands) verifyProviderObservation(read(join(row.evidence, 'handoff/provider-observations', envelope.message.params.item.id + '.json')), key, { binding: providerObservationBinding(manifest.protocolHash, row), envelope });
  validateCommandCaptures(row.evidence, commands.map(e => e.message.params.item));
  const canonical = canonicalEvidence(row.evidence);
  assert.equal(canonical.hash, review.assessment.canonicalHash);
  assert.equal(canonical.artifacts.length, 101);
  const attempts = state.slots.filter(r => (r.slotId ?? r.id) === auth.slotId);
  assert.ok(attempts.length >= 2 && attempts.length <= 3);
  assert.deepEqual(attempts.map(r => r.id), [auth.slotId, auth.predecessorId, ...(attempts.length === 3 ? [auth.slotId + '-attempt-3'] : [])]);
  if (attempts.length === 2) {
    assert.equal(state.slots.at(-1).id, row.id);
    for (const [name, hash] of Object.entries(proposal.sourceAfter)) assert.equal(sha(join(row.workspace, name)), hash);
  } else {
    const next = attempts[2];
    assert.equal(next.attempt, 3);
    assert.equal(next.workspace, row.workspace);
    if (next.launch) {
      assert.equal(next.continuationFrom, row.id);
      assert.equal(next.formalDisconnectRecoveryHash, sha(file));
    }
    if (next.binding?.taskId) assert.equal(next.binding.taskId, row.binding.taskId);
    if (next.binding?.sessionId) assert.notEqual(next.binding.sessionId, row.binding.sessionId);
  }
  assert.deepEqual(auth.sources.map(s => s.name).sort(), [...parentSources.map(s => s.name), 's2-compaction-recovery.mjs'].sort());
  for (const s of parentSources) assert.equal(sha(join(folder, 'before/sources', s.name)), s.sha256);
  for (const s of auth.sources) assert.equal(sha(join(folder, 'sources', s.name)), s.sha256);
  let sources = auth.sources;
  const compatibilityFolder = join(folder, 'postlaunch-review-compatibility');
  const compatibilityFile = join(compatibilityFolder, 'authorization.json');
  if (existsSync(compatibilityFile)) {
    const compatibility = read(compatibilityFile);
    assert.equal(compatibility.kind, 'S2-compaction-host-review-compatibility-v1');
    assert.equal(compatibility.parentAuthorizationHash, sha(file));
    assert.equal(compatibility.protocolHash, manifest.protocolHash);
    assert.equal(compatibility.extraProviderLaunches, 0);
    const third = attempts[2];
    assert.equal(third?.status, 'finished');
    assert.equal(third.turn.status, 'completed');
    assert.equal(third.failureClass, null);
    assert.equal(third.nativeStop.writersStopped, true);
    assert.equal(third.nativeStop.activeProcesses, 0);
    assert.equal(third.cleanup.passed, true);
    assert.equal(digest(third), compatibility.completedAttemptDigest);
    assert.equal(sha(join(third.evidence, 'events.jsonl')), compatibility.eventsHash);
    assert.equal(sha(join(third.evidence, 'result.json')), compatibility.resultHash);
    assert.equal(sha(third.cleanup.path), compatibility.cleanupHash);
    assert.deepEqual(compatibility.sources.map(s => s.name).sort(), auth.sources.map(s => s.name).sort());
    for (const s of auth.sources) assert.equal(sha(join(compatibilityFolder, 'before', s.name)), s.sha256);
    for (const s of compatibility.sources) assert.equal(sha(join(compatibilityFolder, 'sources', s.name)), s.sha256);
    sources = compatibility.sources;
  }
  return { ...auth, sources, canonicalHash: canonical.hash, predecessorHash: digest(row), authorizationHash: sha(file), completedCompaction: true, issues: review.issues };
}
