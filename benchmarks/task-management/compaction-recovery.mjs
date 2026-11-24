import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

import { loadFormalDisconnectRecovery } from './formal-disconnect-recovery.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slotId = 'S-0-handoff-1';
const archivedSourceNames = ['capacity-recovery.mjs', 'campaign-admission.mjs', 'comparison-attempts.mjs',
  'g4-targeted-recovery.mjs', 'compare-run.mjs', 'compare-audit.mjs', 'compare-review.mjs', 'compare-report.mjs'];
const sourceNames = [...archivedSourceNames, 'cancelled-recovery.mjs', 'receipt-recovery.mjs'];

export function loadCompactionRecovery(directory, manifest, root, capacity) {
  const folder = join(directory, 'compaction-recovery');
  const file = join(folder, 'authorization.json');
  if (!existsSync(file)) return capacity;
  assert.ok(capacity?.thirdAttempt && capacity.attemptLimits?.['B-0-small-1'] === 3,
    'Previous capacity exception must remain authorized');
  const auth = read(file);
  const formalDisconnectRecovery = loadFormalDisconnectRecovery(directory, manifest, root);
  const formalSourceHash = name => formalDisconnectRecovery?.sources.find(source => source.name === name)?.sha256;
  const draft = read(join(root, '.local/g6-s-handoff1-compaction-authorization-draft-20261030.json'));
  const archive = join(folder, 'preapproval-baseline-20261030');
  const archiveManifest = read(join(archive, 'manifest.json'));
  const compatibilityFolder = join(folder, 'postlaunch-compatibility-20261030');
  const compatibilityFile = join(compatibilityFolder, 'authorization.json');
  const compatibility = existsSync(compatibilityFile) ? read(compatibilityFile) : null;
  const reviewCompatibilityFolder = join(folder, 'postlaunch-review-compatibility-20261030');
  const reviewCompatibilityFile = join(reviewCompatibilityFolder, 'authorization.json');
  const reviewCompatibility = existsSync(reviewCompatibilityFile) ? read(reviewCompatibilityFile) : null;
  assert.equal(auth.schemaVersion, 1);
  assert.equal(auth.kind, 'g6-s-handoff1-compaction-attempt3-authorization-v1');
  assert.equal(auth.userInstruction, 'phê duyệt');
  assert.match(auth.approvedAt, /^2026-10-30T\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  assert.equal(auth.launchPermitted, true);
  assert.equal(auth.protocolHash, manifest.protocolHash);
  assert.equal(auth.round, directory);
  assert.equal(auth.pendingDraftHash, digest(draft));
  assert.equal(auth.archiveManifestHash, sha(join(archive, 'manifest.json')));
  assert.equal(draft.status, 'PENDING_EXPLICIT_APPROVAL');
  assert.equal(draft.launchPermitted, false);
  assert.equal(draft.userInstruction, null);
  assert.equal(draft.approvedAt, null);
  assert.equal(draft.scope.slotId, slotId);
  assert.equal(draft.scope.nextInvocationId, slotId + '-attempt-3');
  assert.equal(draft.scope.proposedCap, 3);
  assert.equal(draft.scope.defaultCap, 2);
  assert.equal(draft.scope.priorCapacityCap, 3);
  assert.equal(draft.scope.model, manifest.model);
  assert.equal(draft.scope.effort, manifest.effort);
  assert.equal(manifest.maxAttempts, 2);
  assert.equal(manifest.recoveryPolicy?.maxProviderLaunchesPerSlot, 2);
  assert.equal(auth.scope.slotId, slotId);
  assert.equal(auth.scope.maxAttempts, 3);
  assert.equal(auth.scope.defaultCap, 2);
  assert.equal(auth.scope.priorCapacitySlot, 'B-0-small-1');
  assert.equal(auth.scope.priorCapacityCap, 3);
  assert.equal(auth.scope.model, manifest.model);
  assert.equal(auth.scope.effort, manifest.effort);
  assert.equal(auth.predecessorId, draft.scope.nextInvocationId.replace(/-3$/, '-2'));
  assert.deepEqual(auth.forbiddenChanges, draft.forbiddenChanges);
  assert.equal(archiveManifest.kind, 'g6-s-handoff1-preapproval-baseline-v1');
  assert.equal(archiveManifest.protocolHash, manifest.protocolHash);
  assert.equal(archiveManifest.stateHash, draft.base.stateHash);
  assert.equal(archiveManifest.ledgerHash, draft.base.ledgerHash);
  assert.equal(archiveManifest.rawHash, draft.predecessor.rawHash);
  assert.equal(sha(join(archive, 'state.json')), draft.base.stateHash);
  assert.equal(sha(join(archive, 'smoke-content-review.json')), draft.base.ledgerHash);
  for (const item of archiveManifest.files) assert.equal(sha(join(archive, item.name)), item.sha256);
  assert.equal(archiveManifest.files.length, 12);
  assert.deepEqual(draft.sourceBaselines.map(x => x.name).sort(), [...archivedSourceNames].sort());
  for (const source of draft.sourceBaselines) {
    assert.equal(sha(join(archive, 'sources', source.name)), source.sha256);
    assert.equal(archiveManifest.files.find(x => x.name === join('sources', source.name))?.sha256, source.sha256);
  }
  assert.equal(auth.sources?.length, sourceNames.length);
  assert.deepEqual(auth.sources.map(x => x.name).sort(), [...sourceNames].sort());
  if (compatibility) {
    assert.equal(compatibility.kind, 'g6-postlaunch-third-attempt-legacy-loader-compatibility-v1');
    assert.equal(compatibility.parentAuthorizationHash, sha(file));
    assert.equal(compatibility.protocolHash, manifest.protocolHash);
    assert.equal(compatibility.slotId, slotId);
    assert.equal(compatibility.attemptId, slotId + '-attempt-3');
    assert.equal(compatibility.originalGuardHash, auth.guardSourceHash);
    assert.equal(compatibility.originalCancelledHash,
      auth.sources.find(x => x.name === 'cancelled-recovery.mjs').sha256);
    for (const name of ['compaction-recovery.mjs', 'cancelled-recovery.mjs']) {
      assert.equal(sha(join(compatibilityFolder, 'sources', name)),
        name === 'compaction-recovery.mjs' ? auth.guardSourceHash : compatibility.originalCancelledHash,
        'Pre-fix loader archive changed: ' + name);
    }
    assert.equal(compatibility.maxAttempts, 3);
    assert.equal(compatibility.protocolChanged, false);
  }
  if (reviewCompatibility) {
    assert.ok(compatibility, 'Postlaunch review requires established loader compatibility');
    assert.equal(reviewCompatibility.kind, 'g6-s-handoff1-attempt3-host-review-compatibility-v1');
    assert.equal(reviewCompatibility.parentAuthorizationHash, sha(file));
    assert.equal(reviewCompatibility.parentCompatibilityHash, sha(compatibilityFile));
    assert.equal(reviewCompatibility.protocolHash, manifest.protocolHash);
    assert.equal(reviewCompatibility.slotId, slotId);
    assert.equal(reviewCompatibility.attemptId, slotId + '-attempt-3');
    assert.equal(reviewCompatibility.predecessorId, slotId + '-attempt-2');
    assert.equal(reviewCompatibility.originalGuardHash, compatibility.guardSourceHash);
    assert.equal(reviewCompatibility.originalReviewHash,
      auth.sources.find(source => source.name === 'compare-review.mjs').sha256);
    assert.equal(sha(join(reviewCompatibilityFolder, 'sources', 'compaction-recovery.mjs')),
      reviewCompatibility.originalGuardHash);
    assert.equal(sha(join(reviewCompatibilityFolder, 'sources', 'compare-review.mjs')),
      reviewCompatibility.originalReviewHash);
    assert.equal(reviewCompatibility.protocolChanged, false);
    assert.equal(reviewCompatibility.extraProviderLaunches, 0);
    assert.equal(reviewCompatibility.excludedInheritedIssue, 'G6-S-HANDOFF1-A2-COMPACTION');
  }
  for (const source of auth.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha(join(root, 'benchmarks/task-management', source.name)),
      formalSourceHash(source.name) ?? (reviewCompatibility && source.name === 'compare-review.mjs' ? reviewCompatibility.reviewSourceHash :
        compatibility && source.name === 'cancelled-recovery.mjs' ? compatibility.cancelledSourceHash : source.sha256),
      'Authorized recovery host source drift: ' + source.name);
  }
  assert.equal(sha(resolve(root, 'benchmarks/task-management/compaction-recovery.mjs')),
    formalSourceHash('compaction-recovery.mjs') ?? reviewCompatibility?.guardSourceHash ?? compatibility?.guardSourceHash ?? auth.guardSourceHash, 'Recovery guard changed');
  const state = read(join(directory, 'state.json'));
  const ledger = read(join(directory, 'smoke-content-review.json'));
  if (compatibility) {
    const third = state.slots.find(row => row.id === compatibility.attemptId);
    assert.equal(third?.status, 'finished');
    assert.equal(third?.attempt, 3);
    assert.equal(third?.compactionRecoveryHash, sha(file));
    assert.equal(third?.nativeStop?.writersStopped, true);
    assert.equal(third?.nativeStop?.activeProcesses, 0);
    assert.equal(third?.cleanup?.passed, true);
    assert.equal(digest(third), compatibility.completedAttemptDigest);
    assert.equal(sha(join(third.evidence, 'result.json')), compatibility.completedResultHash);
    assert.equal(sha(join(third.evidence, 'events.jsonl')), compatibility.completedEventsHash);
    assert.equal(sha(join(third.evidence, 'supervisor', third.launch.runId + '.receipt')),
      compatibility.completedStopReceiptHash);
  }
  assert.equal(state.protocolHash, manifest.protocolHash);
  assert.equal(ledger.protocolHash, manifest.protocolHash);
  assert.ok(state.slots.length >= draft.base.slots);
  assert.ok(ledger.rows.length >= draft.base.slots);
  assert.equal(digest(state.slots.slice(0, draft.base.slots)), draft.base.slotsDigest,
    'Historical attempt prefix changed');
  assert.equal(digest(ledger.rows.slice(0, draft.base.slots)), digest(read(join(archive, 'smoke-content-review.json')).rows),
    'Historical review prefix changed');
  const prior = state.slots[9], first = state.slots[8];
  const priorReview = ledger.rows[9], firstReview = ledger.rows[8];
  assert.equal(prior.id, auth.predecessorId);
  assert.equal(prior.status, 'finished');
  assert.equal(prior.turn?.status, 'completed');
  assert.equal(prior.failureClass, 'controlled_input_compaction');
  assert.equal(prior.measurementEligible, false);
  assert.equal(prior.nativeStop?.writersStopped, true);
  assert.equal(prior.nativeStop?.activeProcesses, 0);
  assert.equal(prior.cleanup?.passed, true);
  assert.equal(priorReview.verdict, 'rework');
  assert.equal(digest(prior), draft.predecessor.rowDigest);
  assert.equal(digest(priorReview), draft.predecessor.reviewDigest);
  assert.equal(digest(first), draft.historical.rowDigest);
  assert.equal(digest(firstReview), draft.historical.reviewDigest);
  assert.equal(sha(join(prior.evidence, 'events.jsonl')), draft.predecessor.rawHash);
  assert.equal(sha(prior.rawProtocol), draft.predecessor.rawProtocolHash);
  assert.equal(sha(join(directory, 'reviews', 'smoke-' + prior.id + '.assessment.json')),
    draft.predecessor.assessmentHash);
  assert.equal(sha(join(prior.evidence, 'source-after.json')), draft.predecessor.sourceHash);
  assert.equal(sha(join(prior.evidence, 'supervisor', prior.launch.runId + '.receipt')),
    draft.predecessor.stopReceiptHash);
  assert.equal(sha(prior.cleanup.path), draft.predecessor.cleanupHash);
  assert.equal(sha(join(first.evidence, 'result.json')), draft.historical.resultHash);
  assert.equal(digest(first.usage), digest(draft.historical.usage));
  const raw = readFileSync(join(prior.evidence, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .filter(event => event.message?.params?.item?.type === 'contextCompaction');
  assert.deepEqual(raw.map(x => x.message.method), ['item/started', 'item/completed']);
  assert.equal(raw[0].message.params.item.id, raw[1].message.params.item.id);
  assert.ok(raw.every(x => x.message.params.turnId === prior.launch.turnId));
  const attempts = state.slots.filter(x => (x.slotId ?? x.id) === slotId);
  assert.ok(attempts.length >= 2 && attempts.length <= 3, 'Only one recovery launch allowed');
  assert.deepEqual(attempts.map(x => x.attempt), attempts.length === 2 ? [1, 2] : [1, 2, 3]);
  assert.deepEqual(attempts.map(x => x.id), attempts.length === 2 ? [slotId, prior.id] : [slotId, prior.id, slotId + '-attempt-3']);
  if (attempts.length === 2) {
    assert.equal(state.status, 'quality_failed');
    assert.equal(ledger.rows.length, 10);
    assert.equal(state.slots.length, 10);
    const sourceManifest = read(join(prior.evidence, 'source-after.json'));
    for (const [name, expected] of Object.entries(sourceManifest)) {
      const live = resolve(prior.workspace, name);
      assert.ok(!isAbsolute(name) && !relative(prior.workspace, live).split(/[\\/]/).includes('..'));
      assert.equal(sha(live), expected, 'Continuation workspace source drift');
    }
  } else {
    const third = attempts[2];
    assert.equal(third.continuationFrom, prior.id);
    assert.equal(third.compactionRecoveryHash, sha(file));
    assert.equal(third.workspace, prior.workspace);
    if (third.binding?.taskId) assert.equal(third.binding.taskId, prior.binding?.taskId);
  }
  return { ...capacity, formalDisconnectRecovery, compactionRecovery: { authorizationHash: sha(file), predecessorId: prior.id,
    sources: formalDisconnectRecovery ? [...auth.sources.filter(source => !formalSourceHash(source.name)), ...formalDisconnectRecovery.sources] : auth.sources.map(source => reviewCompatibility && source.name === 'compare-review.mjs'
      ? { ...source, sha256: reviewCompatibility.reviewSourceHash } : source), maxAttempts: 3 },
    attemptLimits: { default: 2, ...(formalDisconnectRecovery?.s5SmallAttempt3Recovery ? { 'S-5-small-1': 3 } : {}), ...(formalDisconnectRecovery?.b4DebugAttempt5 ? { 'B-4-debug-1': 5 } : formalDisconnectRecovery?.b4DebugAttempt4 ? { 'B-4-debug-1': 4 } : formalDisconnectRecovery?.b4DebugAttempt3 ? { 'B-4-debug-1': 3 } : {}), 'B-0-small-1': 3, [slotId]: 3, ...(formalDisconnectRecovery?.publicationRetry ? { 'B-1-handoff-1': 3 } : {}), ...(formalDisconnectRecovery?.compactionRetry ? { 'S-2-handoff-1': 3 } : {}), ...(formalDisconnectRecovery?.b2HandoffCompactionRecovery ? { 'B-2-handoff-1': formalDisconnectRecovery?.b2HandoffCap5Recovery?.maxAttempts ?? 3 } : {}), ...(formalDisconnectRecovery?.b2Handoff2Cap3Recovery ? { 'B-2-handoff-2': formalDisconnectRecovery?.b2Handoff2Cap4Recovery?.maxAttempts ?? 3 } : {}) } };
}
