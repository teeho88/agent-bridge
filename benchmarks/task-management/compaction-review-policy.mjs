import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const compactionPolicyInstruction = 'tôi muốn bạn bỏ luôn việc xem xét context compaction khỏi review vì về sau nội dung task lớn lên dần dẫn đến dễ compaction, có thể chập nhận compaction khi đánh giá vì nó là công bằng giữa các lượt chạy task';
export const compactionPolicyFolder = 'review-policy/compaction-accepted-20261105';
const read = p => JSON.parse(readFileSync(p));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function loadCompactionReviewPolicy(directory, manifest, parentSources) {
  const folder = join(directory, compactionPolicyFolder), originalFile = join(folder, 'authorization.json');
  const secondFile = join(folder, 'authorization.v2.json'), thirdFile = join(folder, 'authorization.v3.json');
  const revision = existsSync(thirdFile) ? 3 : existsSync(secondFile) ? 2 : 1;
  const file = revision === 3 ? thirdFile : revision === 2 ? secondFile : originalFile;
  if (!existsSync(file)) return null;
  const auth = read(file), state = read(join(directory, 'state.json'));
  if (revision > 1) { assert.equal(auth.revision, revision); assert.equal(auth.previousPolicyHash, sha(revision === 3 ? secondFile : originalFile)); }
  if (revision === 3) assert.deepEqual(auth.compatibleAssessmentPolicyHashes, [sha(secondFile)]);
  assert.equal(auth.kind, 'user-approved-compaction-neutral-review-v1');
  assert.equal(auth.userInstruction, compactionPolicyInstruction);
  assert.equal(auth.protocolHash, manifest.protocolHash); assert.equal(auth.acceptCompaction, true);
  assert.deepEqual(auth.branches, ['B', 'S']); assert.deepEqual(auth.phases, ['smoke', 'formal']);
  assert.equal(auth.extraProviderLaunches, 0); assert.equal(auth.capChanges, false);
  assert.equal(auth.keepAllActualUsage, true); assert.equal(auth.allowIncompleteTurns, false);
  assert.equal(auth.parentAuthorizationHash, sha(join(directory, 'formal-B2-handoff2-cap3-recovery-20261105/prelaunch-scope-recovery-1/authorization.json')));
  const before = read(join(folder, 'before/state.json'));
  assert.equal(auth.baseSlotCount, before.slots.length - (before.slots.at(-1).status === 'launched' ? 1 : 0));
  assert.equal(digest(before.slots.slice(0, auth.baseSlotCount)), auth.baseSlotsHash);
  assert.equal(digest(state.slots.slice(0, auth.baseSlotCount)), auth.baseSlotsHash);
  for (const phase of auth.phases) {
    const name = phase === 'formal' ? 'content-review.json' : 'smoke-content-review.json';
    const legacy = read(join(folder, 'before', name)), current = read(join(directory, name));
    assert.equal(auth.baseReviewCounts[phase], legacy.rows.length);
    assert.equal(digest(current.rows.slice(0, legacy.rows.length)), auth.baseReviewHashes[phase]);
    assert.equal(digest(legacy.rows), auth.baseReviewHashes[phase]);
  }
  assert.equal(sha(join(folder, 'before/manifest.json')), auth.archiveManifestHash);
  for (const entry of read(join(folder, 'before/manifest.json')).files) {
    assert.ok(!entry.name.split(/[\\/]/).includes('..'));
    assert.equal(sha(join(folder, 'before', entry.name)), entry.sha256);
    if (/^reviews[\\/]/.test(entry.name)) assert.equal(sha(entry.source), entry.sha256);
  }
  assert.ok(Array.isArray(auth.ignoredFindingIds));
  assert.equal(new Set(auth.ignoredFindingIds).size, auth.ignoredFindingIds.length);
  assert.ok(auth.ignoredFindingIds.every(id => typeof id === 'string' && !/^ERR-/.test(id) &&
    (/COMPACTION/i.test(id) || id === 'G6-B2-HANDOFF2-A2-HOST-FINDING-CONTINUITY-001')));
  assert.deepEqual(auth.sources.map(s => s.name).sort(), [...parentSources.map(s => s.name), 'compaction-review-policy.mjs'].sort());
  for (const source of parentSources) assert.equal(sha(join(folder, 'before/sources', source.name)), source.sha256);
  const sourceDirectory = revision > 1 ? 'revision-' + revision + '/sources' : 'sources';
  for (const source of auth.sources) assert.equal(sha(join(folder, sourceDirectory, source.name)), source.sha256);
  const policy = { ...auth, folder, authorizationHash: sha(file), reassessments: {} };
  const indexFile = join(folder, 'reassessments.json');
  if (existsSync(indexFile)) {
    const index = read(indexFile); assert.ok([policy.authorizationHash, ...(auth.compatibleAssessmentPolicyHashes ?? [])].includes(index.policyHash));
    for (const item of index.rows) {
      assert.equal(policy.reassessments[item.id], undefined);
      const target = resolve(folder, item.assessment);
      assert.ok(target.startsWith(resolve(folder) + sep)); assert.equal(sha(target), item.assessmentHash);
      const assessment = read(target);
      assert.equal(assessment.id, item.id); assert.equal(assessment.policyHash, index.policyHash);
      assert.ok(['pass', 'rework', 'blocked'].includes(assessment.proposedVerdict));
      const row = state.slots.find(x => x.id === item.id); assert.ok(row);
      assert.equal(sha(join(row.evidence, 'events.jsonl')), assessment.eventsHash);
      if (assessment.proposedVerdict === 'pass') {
        assert.equal(assessment.rawTraceReviewed, true); assert.equal(assessment.rubricPassed, true);
        assert.equal(assessment.checkpointBeforeFinal, true); assert.equal(assessment.freshAcceptanceReviewed, true);
        assert.equal(sha(join(row.evidence, 'source-after.json')), assessment.sourceManifestHash);
        assert.equal(sha(join(row.evidence, 'RESULT.md')), assessment.resultHash);
      }
      policy.reassessments[item.id] = assessment;
    }
  }
  return policy;
}

export const activeCompactionReviewPolicy = recovery => recovery?.formalDisconnectRecovery?.compactionReviewPolicy ?? null;
export const ignoresReviewFinding = (policy, id) => policy?.acceptCompaction === true && policy.ignoredFindingIds.includes(id);
export const acceptsCompactionFailure = (policy, row) => policy?.acceptCompaction === true && row.failureClass === 'controlled_input_compaction' && row.turn?.status === 'completed';

export function allowsIncompleteBlockedReview(policy, row, audited) {
  return policy?.acceptCompaction === true && row?.status === 'finished' && row.turn?.status === 'timeout' &&
    row.nativeStop?.appContainer === true && row.nativeStop.writersStopped === true && row.nativeStop.activeProcesses === 0 &&
    row.nativeStop.runId === row.launch?.runId && row.cleanup?.passed === true && audited?.id === row.id &&
    audited.problems?.includes('Final turn usage ordering/binding') &&
    audited.problems.every(problem => problem === 'Final turn usage ordering/binding' || problem.startsWith('Workflow history:'));
}

export function policyReview(policy, row, legacy) {
  const reassessed = policy?.reassessments?.[row.id];
  if (!legacy || !reassessed) return legacy;
  return { ...legacy, legacyVerdict: legacy.verdict, legacyReason: legacy.reason, verdict: reassessed.proposedVerdict,
    reason: reassessed.reason, assessment: reassessed, policyHash: policy.authorizationHash,
    policyReviewedAt: reassessed.reviewedAt };
}

export function policyMeasurementRow(policy, row) {
  if (policy?.acceptCompaction !== true || row.failureClass !== 'controlled_input_compaction') return row;
  const completeUsage = ['inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0) && row.usage.cachedInputTokens <= row.usage.inputTokens;
  const eligible = row.status === 'finished' && row.turn?.status === 'completed' && row.acceptance?.passed === true && !row.unexpectedFiles?.length && row.review?.verdict === 'pass' && row.integrityPassed === true &&
    completeUsage && row.nativeStop?.appContainer === true && row.nativeStop.writersStopped === true && row.nativeStop.activeProcesses === 0 && row.cleanup?.passed === true;
  const failureClass = row.turn?.status !== 'completed' ? 'incomplete-turn'
    : row.acceptance?.passed === false || row.unexpectedFiles?.length ? 'product'
    : !completeUsage || row.nativeStop?.appContainer !== true || row.nativeStop.writersStopped !== true || row.nativeStop.activeProcesses !== 0 || row.cleanup?.passed !== true ? 'incomplete-measurement' : null;
  return { ...row, legacyFailureClass: row.failureClass, legacyMeasurementEligible: row.measurementEligible,
    failureClass,
    measurementEligible: eligible, reviewPolicyHash: policy.authorizationHash };
}
