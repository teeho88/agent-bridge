import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docs = join(root, 'docs/phase0-20261016');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const pointer = read(join(docs, 'round.json')), protocol = read(pointer.protocol);
const state = read(join(pointer.directory, 'state.json'));
if (state.protocolHash !== pointer.protocolHash) throw new Error('Round identity mismatch');
const baseline = read(join(docs, 'baseline.json'));
const rows = state.slots.filter(row => row.phase === 'formal');
const sum = field => rows.length === 25 && rows.every(row => Number.isFinite(row.usage?.[field]))
  ? rows.reduce((value, row) => value + row.usage[field], 0) : null;
const excluded = ['interrupted-smoke.json', 'interrupted-smoke-v3.json'].filter(path => existsSync(join(docs, path)))
  .map(path => { const value = read(join(docs, path)); return { artifact: path, protocolHash: value.protocolHash,
    providerInvocations: value.providerInvocations, partialUsage: value.partialUsage, validForBaseline: false }; });
const formalReview = existsSync(join(pointer.directory, 'formal-review.json')) ? read(join(pointer.directory, 'formal-review.json')) : null;
const audit = existsSync(join(pointer.directory, 'formal-audit.json')) ? read(join(pointer.directory, 'formal-audit.json')) : null;
const complete = rows.length === 25 && rows.every(row => row.status === 'finished' && row.acceptance?.passed) &&
  audit?.protocolHash === pointer.protocolHash && audit.mechanicalIntegrityPassed === true && audit.mismatches?.length === 0 &&
  formalReview?.protocolHash === pointer.protocolHash && formalReview.dataComplete === true &&
  formalReview.rows?.length === 25 && formalReview.acceptancePassed === 25;
baseline.status = complete ? 'done' : state.status === 'infrastructure_failed' ? 'blocked' : 'in_progress';
baseline.baselineComplete = complete; baseline.observedAt = new Date().toISOString();
baseline.protocolHash = pointer.protocolHash; baseline.round = pointer;
baseline.runtimeSnapshot = pointer.protocol; baseline.runtimeSnapshotRevision = pointer.protocolHash;
baseline.protocolControls = 'protocol-verification-v4/report.json';
baseline.configuration.model = protocol.model;
baseline.configuration.effort = protocol.effort;
baseline.configuration.actualEffortVerified = state.slots.some(row => row.launch) ? 'see actual thread/settings/updated in raw evidence; audited per invocation' : null;
const reviewById = new Map(formalReview?.rows?.map(row => [row.id, row]) ?? []);
baseline.slots = protocol.schedule.map(slot => {
  const row = rows.find(value => value.id === slot.id);
  return row ? { ...row, usage: row.usage ? { ...row.usage, cacheWriteInputTokens: null } : null,
    cacheWriteReason: 'Provider cache-write counter uses adapter default 0; write semantics unverified.',
    review: reviewById.get(row.id) ?? null, attempts: [row.attemptId] } : { ...slot, status: 'not_started', attempts: [], sourceRevision: null,
    usage: null, elapsedMs: null, toolCalls: null, retries: null, rework: null, acceptance: null, review: null };
});
baseline.measurements = {
  providerInvocations: rows.filter(row => row.launch).length,
  ...Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'uncachedInputTokens'].map(field => [field, sum(field)])),
  cacheWriteInputTokens: null,
  cacheWriteReason: 'Raw adapter value 0 does not establish provider cache-write semantics; raw evidence is unchanged.',
  elapsedMs: rows.length === 25 && rows.every(row => Number.isFinite(row.elapsedMs)) ? rows.reduce((total, row) => total + row.elapsedMs, 0) : null,
  implementationMs: rows.length === 25 && rows.every(row => Number.isFinite(row.implementationMs)) ? rows.reduce((total, row) => total + row.implementationMs, 0) : null,
  elapsedReason: 'Elapsed covers each invocation and native acceptance; content review took place afterward and is recorded separately per review row.',
  toolCalls: rows.length === 25 && rows.every(row => Number.isInteger(row.toolCalls)) ? rows.reduce((total, row) => total + row.toolCalls, 0) : null,
  retries: rows.length === 25 ? rows.reduce((total, row) => total + (row.retryCount ?? 0), 0) : null,
  reworkAttempts: rows.length === 25 ? rows.reduce((total, row) => total + (row.reworkCount ?? 0), 0) : null,
  rework: formalReview?.reviewCounts?.rework ?? null,
  completionRate: formalReview?.completionRate ?? null,
  contentPassRate: formalReview?.contentPassRate ?? null,
  cost: null,
  reason: complete ? 'All baseline observations collected; content quality includes recorded rework. Monetary pricing unavailable; host setup/evaluation tracked separately.' : 'Formal baseline incomplete; smoke and infrastructure attempts reported separately.'
};
baseline.contentReview = formalReview ? { dataComplete: formalReview.dataComplete,
  qualityPassed: formalReview.qualityPassed, counts: formalReview.reviewCounts,
  pendingRework: formalReview.pendingRework, artifact: join(pointer.directory, 'formal-review.json') } : null;
baseline.excludedInfrastructureAttempts = excluded;
baseline.smoke = state.slots.filter(row => row.phase === 'smoke').map(row => ({ id: row.id, status: row.status, usage: row.usage,
  acceptance: row.acceptance ?? null, evidence: row.evidence, failureClass: row.failureClass ?? null }));
baseline.experimentAccounting = { providerInvocations: excluded.reduce((total, value) => total + value.providerInvocations, 0) + state.slots.filter(row => row.launch).length,
  excludedInfrastructureInvocations: excluded.reduce((total, value) => total + value.providerInvocations, 0),
  currentRoundInvocations: state.slots.filter(row => row.launch).length,
  hostSetupAndEvaluationTokenUsage: null, hostSetupAndEvaluationReason: 'Parent assistant usage is not exposed as per-invocation native provider counters; no separate reviewer provider call.', monetaryCost: null };
baseline.excludedPriorRound = { artifact: 'baseline-revision4-blocked.json', model: 'gpt-6.1-sol',
  completedFormalInvocations: 13, validForRevision5Baseline: false };
baseline.blockers = state.status === 'infrastructure_failed' ? state.failures : [];
baseline.prerequisites.smokePassed = existsSync(join(pointer.directory, 'smoke-review.json')) ? read(join(pointer.directory, 'smoke-review.json')).verdict === 'pass' : null;
baseline.nextStep = complete ? 'Phase 0 baseline collected. Preserve the single content REWORK finding; Phase 1 remains closed until separately requested.' : state.status === 'infrastructure_failed'
  ? 'Preserve the stopped round, diagnose recorded failure without replaying unresolved model turns.'
  : baseline.prerequisites.smokePassed ? 'Complete and audit all 25 formal B invocations.' : 'Complete and review smoke before formal.';
writeFileSync(join(docs, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
console.log(JSON.stringify({ status: baseline.status, formalInvocations: rows.length, smokeInvocations: baseline.smoke.length,
  experimentProviderInvocations: baseline.experimentAccounting.providerInvocations, baselineComplete: complete }));
