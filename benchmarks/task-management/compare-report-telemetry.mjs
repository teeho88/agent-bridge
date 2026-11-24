import { comparisonPointer, containedPath, validateBudget } from './remediation-policy.mjs';
import { requireFormalPermission } from './diagnostic-plan.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compare } from './comparison.mjs';
import { slotIdentity, latestAttempt, nextInvocation } from './comparison-attempts.mjs';
import { canonicalEvidence, validateWorkflowChain } from './comparison-evidence.mjs';
import { loadCapacityRecovery } from './capacity-recovery.mjs';
import { activeCompactionReviewPolicy, policyReview, policyMeasurementRow } from './compaction-review-policy.mjs';
import { recoverySourceHash, recoveryReviews, recoveryAttemptLimits } from './g4-targeted-recovery.mjs';

import { verifyTelemetryEvidence } from './telemetry-evidence.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pointerPath = process.argv.includes('--pointer') ? comparisonPointer() : containedPath(process.argv[2] ?? join(root, 'docs/phase8-2-20261018/round.json'));
const pointer = read(pointerPath), manifest = read(pointer.protocol);
if (manifest.frozen?.['diagnostic-plan.mjs'] && manifest.frozen['diagnostic-plan.mjs'] !== sha(new URL('./diagnostic-plan.mjs', import.meta.url))) throw Error('Frozen diagnostic policy helper mismatch');
requireFormalPermission(manifest);
validateBudget(manifest);
const statePath = join(pointer.directory, 'state.json'), state = read(statePath);
const capacityRecovery = loadCapacityRecovery(pointer.directory, manifest, root);
const compactionReviewPolicy = activeCompactionReviewPolicy(capacityRecovery);
const { protocolHash, ...body } = manifest;
if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== protocolHash || pointer.protocolHash !== protocolHash || state.protocolHash !== protocolHash) throw new Error('Protocol/state binding mismatch');
if(manifest.telemetryContract?.kind!=='durable-invocation-journal-v1')throw Error('Telemetry report requires the new telemetry contract');
const strict = manifest.budgetMode === 'unbounded';
if ((strict || manifest.nodeHash !== undefined) && manifest.nodeHash !== sha(process.execPath)) throw new Error('Frozen Node binary mismatch');
for (const name of ['telemetry-evidence.mjs', 'invocation-telemetry.mjs', 'compare-report.mjs', 'comparison.mjs', 'remediation-policy.mjs', 'profile-storage.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs']) {
  const expected = recoverySourceHash(name, manifest.frozen[name], capacityRecovery);
  if ((strict || expected !== undefined) && expected !== sha(name === 'compare-report.mjs' ? fileURLToPath(import.meta.url) : new URL(name, import.meta.url))) throw new Error('Frozen executing code mismatch: ' + name);
}
for (const [path, hash] of Object.entries(manifest.frozen)) if (sha(join(pointer.directory, 'protocol', path)) !== hash) throw new Error('Frozen evidence changed: ' + path);
const auditPath = join(pointer.directory, 'formal-audit.json');
const audit = existsSync(auditPath) ? read(auditPath) : null;
const reviewPath = join(pointer.directory, 'content-review.json');
const reviews = existsSync(reviewPath) ? read(reviewPath) : null;
const finalizedPath = join(pointer.directory, 'formal-review.json');
const finalized = existsSync(finalizedPath) ? read(finalizedPath) : null;
const incidentPath = join(pointer.directory, 'incident.json');
const legacyIncidentPath = join(root, 'docs/phase8-2-20261018/incident.json');
const legacyIncident = existsSync(legacyIncidentPath) ? read(legacyIncidentPath) : null;
const incident = existsSync(incidentPath) ? read(incidentPath) : legacyIncident?.protocolHash === protocolHash ? legacyIncident : null;
if (incident && incident.protocolHash !== protocolHash) throw new Error('Incident binding mismatch');
if (audit && audit.protocolHash !== protocolHash || reviews && reviews.protocolHash !== protocolHash) throw new Error('Audit/review binding mismatch');
const phaseRows = state.slots.filter(row => row.phase === 'formal');
const phaseStateHash = createHash('sha256').update(JSON.stringify(phaseRows)).digest('hex');
let finalizedReviewPassed = false;
if (finalized && audit && reviews) {
  finalizedReviewPassed = finalized.protocolHash === protocolHash && finalized.verdict === 'pass' && finalized.reviewLedgerHash === sha(reviewPath) &&
    audit.partial === false && audit.phase === 'formal' && audit.mechanicalIntegrityPassed === true &&
    (!(strict || audit.auditSourceHash !== undefined) || /^[a-f0-9]{64}$/.test(audit.auditSourceHash ?? '') && audit.auditSourceHash === recoverySourceHash('compare-audit.mjs', manifest.frozen['compare-audit.mjs'], capacityRecovery)) &&
    (!(strict || audit.phaseStateHash !== undefined) || audit.phaseStateHash === phaseStateHash) &&
    (!(strict || finalized.phaseStateHash !== undefined) || finalized.phaseStateHash === phaseStateHash) &&
    (!(strict || finalized.auditHash !== undefined) || finalized.auditHash === sha(auditPath)) &&
    reviews.rows.length === phaseRows.length && new Set(reviews.rows.map(row => row.id)).size === phaseRows.length &&
    JSON.stringify(finalized.rows) === JSON.stringify(reviews.rows) &&
    audit.details.length === phaseRows.length && new Set(audit.details.map(row => row.id)).size === phaseRows.length &&
    phaseRows.every(row => audit.details.some(detail => detail.id === row.id && detail.integrityPassed === true));
  if (finalizedReviewPassed) finalizedReviewPassed = nextInvocation(manifest.schedule, phaseRows, recoveryReviews(reviews.rows, capacityRecovery), recoveryAttemptLimits(manifest.maxAttempts, capacityRecovery)).action === 'complete';
}
const telemetry = new Map(state.slots.filter(row=>row.launch).map(row=>{try{return [row.id,{value:verifyTelemetryEvidence(row,protocolHash)}];}catch(error){return [row.id,{error:error.message}];}}));
const rows = phaseRows.map((row, index) => {
  const review = reviews?.rows.find(item => item.id === row.id);
  const audited = audit?.details.find(item => item.id === row.id);
  let reviewed = false;
  if (review) reviewed = review.reason?.trim() && review.sourceManifestHash === sha(join(row.evidence, 'source-after.json')) && review.resultHash === (existsSync(join(row.evidence, 'RESULT.md')) ? sha(join(row.evidence, 'RESULT.md')) : null);
  const retainedFormalDisconnect = Boolean(capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]);
  const retainedCompleteMetrics = capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]?.completedIncompleteWorkflow || capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id]?.completedCompaction;
  if (retainedFormalDisconnect) reviewed = reviewed && review.verdict === (capacityRecovery.formalDisconnectRecovery.entries[row.id].completedCompaction ? 'rework' : 'blocked') && review.assessment?.eventsHash === sha(join(row.evidence, 'events.jsonl'));
  if (!retainedFormalDisconnect && reviewed && (review.verdict === 'pass' || manifest.providerObservations) && (strict || manifest.frozen['comparison-evidence.mjs'] !== undefined || review.assessment !== undefined)) {
    try { reviewed = review.assessment?.canonicalHash === canonicalEvidence(row.evidence).hash && review.assessment?.eventsHash === sha(join(row.evidence, 'events.jsonl')); }
    catch { reviewed = false; }
  }
  if (!retainedFormalDisconnect && reviewed && manifest.workflowContract === 'g4-lifecycle-report-history-v1') {
    try { validateWorkflowChain(state.slots, row, { requireFinalPass: review.verdict === 'pass', recovery: capacityRecovery }); } catch { reviewed = false; }
  }
  const rawBound = row.rawProtocol && existsSync(row.rawProtocol) && sha(row.rawProtocol) === row.rawProtocolHash;
  const integrityPassed = rawBound && audited?.integrityPassed === true && telemetry.get(row.id)?.value?.finalMeasurementPassed === true;
  const priorRows = phaseRows.slice(0, index);
  const predecessor = row.continuationFrom ? priorRows.find(item => item.id === row.continuationFrom) : row.stage === 2 ? latestAttempt(priorRows, row.branch + '-' + row.repetition + '-handoff-1') : null;
  const predecessorReview = predecessor ? reviews?.rows.find(item => item.id === predecessor.id) : null;
  const handoffGapMs = predecessorReview ? Date.parse(row.startedAt) - Date.parse(predecessorReview.reviewedAt) : row.stage === 2 || (row.attempt ?? 1) > 1 ? null : 0;
  const endToEndMs = reviewed && Number.isFinite(review.endToEndMs) && review.endToEndMs >= row.elapsedMs ? review.endToEndMs : null;
  return policyMeasurementRow(compactionReviewPolicy, { ...row, implementationMs: telemetry.get(row.id)?.value?.timing.implementationMs ?? null, usage: integrityPassed && (!retainedFormalDisconnect || retainedCompleteMetrics) ? row.usage : null, integrityPassed,
    review: reviewed ? policyReview(compactionReviewPolicy, row, review) : null,
    wallMs: telemetry.get(row.id)?.value?.timing.complete && endToEndMs !== null && Number.isFinite(handoffGapMs) && handoffGapMs >= 0 ? endToEndMs + handoffGapMs : null });
});
finalizedReviewPassed = finalizedReviewPassed && rows.every(row => row.review !== null && row.integrityPassed === true);
const metrics = compare(rows);
const launched = state.slots.filter(row => row.launch).map(row=>({...row,usage:telemetry.get(row.id)?.value?.finalMeasurementPassed?row.usage:null,observedUsage:telemetry.get(row.id)?.value?.observedUsage??null})).map(row => (row.turn?.status !== 'completed' || row.id === capacityRecovery?.cancelledRecovery?.predecessorId || (capacityRecovery?.formalDisconnectRecovery?.entries?.[row.id] && !capacityRecovery.formalDisconnectRecovery.entries[row.id].completedIncompleteWorkflow && !capacityRecovery.formalDisconnectRecovery.entries[row.id].completedCompaction)) ? { ...row, observedUsage: row.observedUsage ?? row.usage, usage: null } : row);
const accountingFields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'uncachedInputTokens'];
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), protocolHash,
  reviewPolicyHash: compactionReviewPolicy?.authorizationHash ?? null,
  model: manifest.model, effort: manifest.effort, budgetMode: manifest.budgetMode ?? 'capped', maxTokens: manifest.maxTokens, maxWeightedTokens: manifest.maxWeightedTokens, status: state.status,
  provenance: { pointer: pointerPath, manifest: pointer.protocol, state: statePath, stateHash: sha(statePath), auditHash: audit ? sha(auditPath) : null, reviewHash: reviews ? sha(reviewPath) : null,
    finalizedReviewHash: finalized ? sha(finalizedPath) : null,
    reporterHash: sha(fileURLToPath(import.meta.url)), calculatorHash: sha(join(dirname(fileURLToPath(import.meta.url)), 'comparison.mjs')) },
  ...metrics,
  observedLogicalSlots: new Set(rows.map(slotIdentity)).size,
  observedImplementationAttempts: rows.length,
  retryInvocations: rows.filter(row => (row.attempt ?? 1) > 1).length,
  finalizedReviewPassed,
  telemetryIntegrityProblems: [...telemetry].filter(([,value])=>value.error).map(([id,value])=>({id,error:value.error})),
  telemetryFinalMeasurementInvocations: [...telemetry.values()].filter(value=>value.value?.finalMeasurementPassed).length,
  measurementComplete: finalizedReviewPassed && [...telemetry.values()].every(value=>value.value?.finalMeasurementPassed===true),
  releasePassed: metrics.releasePassed && finalizedReviewPassed && state.status === 'formal-completed' && state.failures.length === 0,
  infrastructureFailures: state.failures,
  infrastructureIncident: incident,
  experimentAccounting: { providerInvocations: launched.length,
    smokeInvocations: launched.filter(row => row.phase === 'smoke').length,
    formalInvocations: launched.filter(row => row.phase === 'formal').length,
    usage: Object.fromEntries(accountingFields.map(field => [field, launched.length && launched.every(row => Number.isFinite(row.usage?.[field])) ? launched.reduce((sum, row) => sum + row.usage[field], 0) : null])),
    observedUsageLowerBound: Object.fromEntries(accountingFields.map(field => [field, launched.some(row => Number.isFinite((row.usage ?? row.observedUsage)?.[field])) ? launched.reduce((sum, row) => sum + (Number.isFinite((row.usage ?? row.observedUsage)?.[field]) ? (row.usage ?? row.observedUsage)[field] : 0), 0) : null])),
    missingUsageInvocations: launched.filter(row => !row.usage).map(row => row.id),
    partialUsage: launched.filter(row => !row.usage).map(row => ({ id: row.id, usage: null, observedUsage: row.observedUsage ?? null, rawProtocol: row.rawProtocol ?? null })), monetaryCost: null },
};
const output = containedPath((process.argv.includes('--pointer') ? null : process.argv[3]) ?? join(pointer.directory, 'comparison-report.json'));
if (capacityRecovery) {
  report.capacityRecovery = { authorizationHash: capacityRecovery.authorizationHash, retainedFailures: capacityRecovery.predecessorIds, historicalUsage: null };
  report.measurementComplete = false;
  report.releasePassed = false;
  if (capacityRecovery.formalDisconnectRecovery) report.formalDisconnectRecovery = { authorizationHash: capacityRecovery.formalDisconnectRecovery.authorizationHash, retainedFailure: capacityRecovery.formalDisconnectRecovery.predecessorId, finalUsage: null, observedUsage: phaseRows.find(row => row.id === capacityRecovery.formalDisconnectRecovery.predecessorId)?.usage, accountingComplete: false, latestRetryRequiresCompleteMetrics: true };
  if (capacityRecovery.formalDisconnectRecovery?.entries) report.formalDisconnectRecoveries = Object.values(capacityRecovery.formalDisconnectRecovery.entries).map(entry => ({ retainedFailure: entry.predecessorId, authorizationHash: entry.authorizationHash, finalUsage: entry.completedIncompleteWorkflow || entry.completedCompaction ? phaseRows.find(row => row.id === entry.predecessorId)?.usage : null, observedUsage: phaseRows.find(row => row.id === entry.predecessorId)?.observedUsage ?? phaseRows.find(row => row.id === entry.predecessorId)?.usage, accountingComplete: entry.completedIncompleteWorkflow === true || entry.completedCompaction === true, latestRetryRequiresCompleteMetrics: true }));
  if (capacityRecovery.interruptedRecovery) report.interruptedRecovery = {
    authorizationHash: capacityRecovery.interruptedRecovery.authorizationHash,
    retainedFailure: capacityRecovery.interruptedRecovery.predecessorId, finalUsage: null, finalTimings: null,
    accountingComplete: false, observedUsageIsIncomplete: true };
  if (capacityRecovery.cancelledRecovery) report.cancelledRecovery = {
    authorizationHash: capacityRecovery.cancelledRecovery.authorizationHash, retainedFailure: capacityRecovery.cancelledRecovery.predecessorId,
    finalUsage: null, originalObservations: capacityRecovery.cancelledRecovery.accounting, accountingComplete: false,
    canonicalPublicationAvailable: false, hostReview: 'blocked', latestRetryRequiresCompleteMetrics: true };
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, formalInvocations: report.observedInvocations, releasePassed: report.releasePassed, thresholds: report.thresholds }));
