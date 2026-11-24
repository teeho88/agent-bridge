import { allowTimeoutBlockedReview, validateB2Handoff2Cap3Findings } from './formal-disconnect-recovery.mjs';
import { comparisonPointer, validateBudget } from './remediation-policy.mjs';
import { requireFormalPermission } from './diagnostic-plan.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { nextInvocation } from './comparison-attempts.mjs';
import { loadCapacityRecovery } from './capacity-recovery.mjs';
import { activeCompactionReviewPolicy, acceptsCompactionFailure, ignoresReviewFinding, allowsIncompleteBlockedReview } from './compaction-review-policy.mjs';
import { validateB2Handoff2Cap4History } from './b2-handoff2-cap4-recovery.mjs';
import { loadTargetedRecovery, recoverySourceHash, recoveryReviews, recoveryAttemptLimits } from './g4-targeted-recovery.mjs';

import { canonicalEvidence, validateEvidenceAssessment, validatePublishedIssues, verifySourceEvidence, validateCommandCaptures, validateWorkflowChain } from './comparison-evidence.mjs';
import { providerObservationBinding, providerObservationAncestors } from './provider-observations.mjs';

const [action, phase, id, verdict, reason] = process.argv.slice(2);
if (!['start', 'finish', 'finalize'].includes(action) || !['smoke', 'formal'].includes(phase) || action !== 'finalize' && !id) throw new Error('Usage: compare-review.mjs start|finish|finalize smoke|formal [slot-id] [pass|rework|blocked] [reason]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pointer = read(comparisonPointer());
const state = read(join(pointer.directory, 'state.json')), manifest = read(pointer.protocol);
if (manifest.frozen?.['diagnostic-plan.mjs'] && manifest.frozen['diagnostic-plan.mjs'] !== sha(new URL('./diagnostic-plan.mjs', import.meta.url))) throw Error('Frozen diagnostic policy helper mismatch');
if (phase === 'formal') requireFormalPermission(manifest);
validateBudget(manifest);
const strict = manifest.budgetMode === 'unbounded';
const { protocolHash, ...body } = manifest;
if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== protocolHash || pointer.protocolHash !== protocolHash || state.protocolHash !== protocolHash) throw new Error('Protocol/state binding mismatch');
const capacityRecovery = loadCapacityRecovery(pointer.directory, manifest, root);
const compactionReviewPolicy = activeCompactionReviewPolicy(capacityRecovery);
const acceptCompaction = compactionReviewPolicy?.acceptCompaction === true;
const recovery = loadTargetedRecovery(pointer.directory, manifest, root) ?? capacityRecovery;
if ((strict || manifest.nodeHash !== undefined) && manifest.nodeHash !== sha(process.execPath)) throw new Error('Frozen Node binary mismatch');
for (const name of ['compare-review.mjs', 'remediation-policy.mjs', 'profile-storage.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs']) {
  const expected = recoverySourceHash(name, manifest.frozen[name], recovery);
  if ((strict || expected !== undefined) && expected !== sha(new URL(name, import.meta.url))) throw new Error('Frozen executing code mismatch: ' + name);
}
for (const [path, expected] of Object.entries(manifest.frozen)) if (sha(join(pointer.directory, 'protocol', path)) !== expected) throw new Error('Frozen file mismatch: ' + path);
const auditPath = join(pointer.directory, phase + '-audit.json');
const selectedAuditPath = existsSync(auditPath) ? auditPath : join(pointer.directory, phase + '-audit.partial.json');
const audit = read(selectedAuditPath);
const phaseRows = state.slots.filter(row => row.phase === phase);
const phaseStateHash = createHash('sha256').update(JSON.stringify(phaseRows)).digest('hex');
if ((strict || audit.phaseStateHash !== undefined) && audit.phaseStateHash !== phaseStateHash) throw new Error('Audit phase state changed');
if ((strict || audit.auditSourceHash !== undefined) && (!/^[a-f0-9]{64}$/.test(audit.auditSourceHash ?? '') || audit.auditSourceHash !== recoverySourceHash('compare-audit.mjs', manifest.frozen['compare-audit.mjs'], recovery))) throw new Error('Audit source binding mismatch');
if (audit.phase !== phase) throw new Error('Audit phase mismatch');
const ledgerPath = join(pointer.directory, phase === 'formal' ? 'content-review.json' : 'smoke-content-review.json');
const ledger = existsSync(ledgerPath) ? read(ledgerPath) : { protocolHash: pointer.protocolHash, reviewer: 'Codex host content review', rows: [] };
if ([state, manifest, audit, ledger].some(value => value.protocolHash !== pointer.protocolHash)) throw new Error('Review binding mismatch');
if (action === 'finalize') {
  const schedule = phase === 'smoke' ? manifest.smoke : manifest.schedule;
  const completeCoverage = ledger.rows.length === phaseRows.length && new Set(ledger.rows.map(row => row.id)).size === phaseRows.length &&
    audit.details.length === phaseRows.length && new Set(audit.details.map(row => row.id)).size === phaseRows.length &&
    phaseRows.every(row => audit.details.some(detail => detail.id === row.id && detail.integrityPassed === true));
  if (audit.mechanicalIntegrityPassed !== true || audit.partial !== false || !completeCoverage || nextInvocation(schedule, phaseRows, recoveryReviews(ledger.rows, recovery), recoveryAttemptLimits(manifest.maxAttempts, recovery)).action !== 'complete') throw new Error('Complete audited PASS latest-attempt content review required');
  for (const item of ledger.rows) {
    const slot = phaseRows.find(row => row.id === item.id);
    if (capacityRecovery?.formalDisconnectRecovery?.entries?.[item.id]) {
      const entry = capacityRecovery.formalDisconnectRecovery.entries[item.id];
      const expectedCanonicalHash = entry.preserveAbsentReviewCanonicalHash === true ? undefined : entry.canonicalHash ?? null;
      if (item.verdict !== (entry.completedCompaction ? 'rework' : 'blocked') || item.assessment?.canonicalHash !== expectedCanonicalHash || item.assessment?.eventsHash !== sha(join(slot.evidence, 'events.jsonl')) ||
          item.sourceManifestHash !== sha(join(slot.evidence, 'source-after.json')) || item.resultHash !== (existsSync(join(slot.evidence, 'RESULT.md')) ? sha(join(slot.evidence, 'RESULT.md')) : null)) throw Error('Retained formal disconnect review changed');
      continue;
    }
    if (capacityRecovery?.cancelledRecovery?.predecessorId === item.id) {
      if (item.verdict !== 'blocked' || item.assessment?.canonicalHash !== null || item.assessment?.eventsHash !== sha(join(slot.evidence, 'events.jsonl')) ||
          item.sourceManifestHash !== sha(join(slot.evidence, 'source-after.json')) || item.resultHash !== sha(join(slot.evidence, 'RESULT.md')))
        throw Error('Retained cancelled S-handoff review changed');
      continue;
    }
    if (capacityRecovery?.interruptedRecovery?.predecessorId === item.id) {
      if (item.verdict !== 'blocked' || item.assessment?.eventsHash !== sha(join(slot.evidence, 'events.jsonl')) ||
          item.assessment?.canonicalHash !== canonicalEvidence(slot.evidence).hash ||
          item.sourceManifestHash !== sha(join(slot.evidence, 'source-after.json')) || item.resultHash !== sha(join(slot.evidence, 'RESULT.md')))
        throw Error('Retained interrupted incident review changed');
      continue;
    }
    if (capacityRecovery?.predecessorIds.includes(item.id)) {
      if (item.verdict !== 'blocked' || item.assessment?.eventsHash !== sha(join(slot.evidence, 'events.jsonl')) ||
          item.sourceManifestHash !== sha(join(slot.evidence, 'source-after.json')) || item.resultHash !== null)
        throw Error('Retained capacity incident review changed');
      continue;
    }
    const historicalInterruption = Boolean(recovery?.transportContinuation && audit.details.find(detail => detail.id === item.id)?.supersededBy) || recovery?.fourthAttempt &&
      [recovery.thirdAttempt?.predecessorId, recovery.fourthAttempt.predecessorId].includes(item.id) &&
      ledger.rows.some(review => review.id === 'S-0-handoff-2-attempt-4' && review.verdict === 'pass');
    const previousInterruption = !recovery?.fourthAttempt && item.id === recovery?.thirdAttempt?.predecessorId;
    if (slot && manifest.workflowContract === 'g4-lifecycle-report-history-v1' && !historicalInterruption && !previousInterruption) validateWorkflowChain(state.slots, slot, { requireFinalPass: item.verdict === 'pass', recovery });
    const resultPath = slot ? join(slot.evidence, 'RESULT.md') : '';
    if (slot && !historicalInterruption && !previousInterruption && (item.verdict === 'pass' || manifest.providerObservations) && (item.assessment?.canonicalHash !== canonicalEvidence(slot.evidence).hash || item.assessment?.eventsHash !== sha(join(slot.evidence, 'events.jsonl')))) throw new Error('Canonical/raw evidence changed');
    if (!slot || item.sourceManifestHash !== sha(join(slot.evidence, 'source-after.json')) || item.resultHash !== (existsSync(resultPath) ? sha(resultPath) : null)) throw new Error('Final review evidence changed');
  }
  const output = join(pointer.directory, phase + '-review.json');
  writeFileSync(output, JSON.stringify({ protocolHash: pointer.protocolHash, verdict: 'pass', reviewedAt: new Date().toISOString(), reviewLedgerHash: sha(ledgerPath), auditHash: sha(selectedAuditPath), phaseStateHash, rows: ledger.rows }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, verdict: 'pass', reviewed: ledger.rows.length }));
  process.exit(0);
}
const row = state.slots.find(slot => slot.id === id && slot.phase === phase);
const capacityIncident = capacityRecovery?.predecessorIds.includes(id) || capacityRecovery?.formalDisconnectRecovery?.entries?.[id]?.capacityFailure === true;
const startupIncident = capacityRecovery?.formalDisconnectRecovery?.entries?.[id]?.startupFailure === true;
const hostInterruptedIncident = capacityRecovery?.formalDisconnectRecovery?.entries?.[id]?.hostInterruptedFailure === true;
const interruptedIncident = capacityRecovery?.interruptedRecovery?.predecessorId === id;
const audited = audit.details.find(slot => slot.id === id);
const workflowBlocked = audited?.problems?.length > 0 && audited.problems.every(problem => problem.startsWith('Workflow history:'));
const quotaBlocked = row?.failureClass === 'provider_quota_exhausted' && row.turn?.status === 'failed' &&
  row.turn.error?.codexErrorInfo === 'usageLimitExceeded' && row.nativeStop?.appContainer === true &&
  row.nativeStop.writersStopped === true && row.nativeStop.activeProcesses === 0 && row.cleanup?.passed === true &&
  audited?.problems?.includes('Final turn usage ordering/binding') &&
  audited.problems.every(problem => problem === 'Final turn usage ordering/binding' || problem.startsWith('Workflow history:'));
const controlledCompactionBlocked = row?.id === recovery?.fourthAttempt?.predecessorId &&
  row.failureClass === 'controlled_input_compaction' && row.turn?.status === 'failed' &&
  row.turn.error?.message?.includes('stream disconnected before completion') &&
  row.nativeStop?.appContainer === true && row.nativeStop.writersStopped === true &&
  row.nativeStop.activeProcesses === 0 && row.cleanup?.passed === true &&
  audited?.problems?.includes('Final turn usage ordering/binding') &&
  audited.problems.every(problem => problem === 'Final turn usage ordering/binding' ||
    problem === 'Workflow history: canonical publication unavailable: Final full evidence reference missing');
const transportBlocked = Boolean(recovery?.transportContinuation) && (row?.slotId ?? row?.id) === 'S-0-handoff-2' &&
  row.attempt >= 4 && row.turn?.status === 'failed' && row.turn.error?.message?.includes('stream disconnected before completion') &&
  row.nativeStop?.writersStopped === true && row.nativeStop.activeProcesses === 0 && row.cleanup?.passed === true &&
  audited?.problems?.every(problem => problem === 'Final turn usage ordering/binding' ||
    problem === 'Workflow history: canonical publication unavailable: Final full evidence reference missing');
const timeoutBlocked = allowTimeoutBlockedReview(row, audited, recovery) || allowsIncompleteBlockedReview(compactionReviewPolicy, row, audited);
if (row?.status !== 'finished' && !capacityIncident && !startupIncident && !interruptedIncident && !hostInterruptedIncident || !audited || !audited.integrityPassed && !workflowBlocked && !quotaBlocked && !controlledCompactionBlocked && !transportBlocked && !timeoutBlocked) throw new Error('Completed mechanically audited slot required');
const previousReviewIndex = ledger.rows.findIndex(item => item.id === id);
const supersede = process.argv.includes('--supersede') && capacityRecovery?.receiptRecovery?.targetId === id;
if (previousReviewIndex >= 0 && !supersede) throw new Error('Slot already reviewed');
if (supersede && (previousReviewIndex < 0 || ledger.rows[previousReviewIndex].verdict !== 'blocked' ||
    createHash('sha256').update(JSON.stringify(ledger.rows[previousReviewIndex])).digest('hex') !== capacityRecovery.receiptRecovery.originalReviewHash))
  throw Error('Only the archived blocked receipt review can be superseded');
const reviewDirectory = join(pointer.directory, 'reviews');
mkdirSync(reviewDirectory, { recursive: true });
const startPath = join(reviewDirectory, phase + '-' + id + (supersede ? '.receipt-correction' : '') + '.start.json');
const sourceManifestHash = sha(join(row.evidence, 'source-after.json'));
const resultPath = join(row.evidence, 'RESULT.md');
const resultHash = existsSync(resultPath) ? sha(resultPath) : null;
if (action === 'start') {
  writeFileSync(startPath, JSON.stringify({ startedAt: new Date().toISOString(), sourceManifestHash, resultHash }) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, evidence: row.evidence, workspace: row.workspace, taskId: row.taskId, stage: row.stage,
    acceptance: row.acceptance, failureClass: row.failureClass, unexpectedFiles: row.unexpectedFiles, audited }, null, 2));
} else {
  if (!['pass', 'rework', 'blocked'].includes(verdict) || !reason?.trim()) throw new Error('Content verdict and reason required');
  if (supersede && verdict !== 'pass') throw Error('Receipt correction requires a fresh full PASS assessment');
  if (timeoutBlocked && verdict !== 'blocked') throw Error('Timed-out incomplete turn allows only BLOCKED review; no retry/PASS permission');
  if (startupIncident && (verdict !== 'blocked')) throw Error('Startup incident requires BLOCKED');
  if (hostInterruptedIncident && verdict !== 'blocked') throw Error('Host interrupted attempt must remain BLOCKED with unknown final usage');
  if (capacityIncident && verdict !== 'blocked') throw Error('Capacity incident must remain BLOCKED with unknown usage');
  if (interruptedIncident && verdict !== 'blocked') throw Error('Interrupted incident must remain BLOCKED with unknown final measurements');
  if (quotaBlocked && verdict !== 'blocked') throw Error('Provider quota stop requires BLOCKED; same-round rework is forbidden');
  if (controlledCompactionBlocked && verdict !== 'blocked') throw Error('Disconnected compaction requires BLOCKED');
  if (transportBlocked && verdict !== 'blocked') throw Error('Interrupted transport requires BLOCKED');
  if (workflowBlocked && verdict !== 'blocked') throw Error('Workflow history violation requires BLOCKED');
  if (verdict !== 'blocked' && manifest.workflowContract === 'g4-lifecycle-report-history-v1') validateWorkflowChain(state.slots, row, { requireFinalPass: verdict === 'pass', recovery });
  if (verdict === 'rework' && audited.problems?.some(problem => problem.startsWith('Workflow history:'))) throw Error('Workflow history violation requires BLOCKED; same-round rework is forbidden');
  if (verdict === 'pass' && (!row.acceptance?.passed || row.failureClass && !acceptsCompactionFailure(compactionReviewPolicy, row) || row.unexpectedFiles?.length || !resultHash)) throw new Error('Cannot pass failed acceptance/scope/result');
  if (verdict === 'pass' && audited.sourceRevisionEvidence?.passed !== true) throw new Error('Cannot pass handoff without actual source revision hashes');
  const start = read(startPath), reviewedAt = new Date().toISOString();
  if (start.sourceManifestHash !== sourceManifestHash || start.resultHash !== resultHash) throw new Error('Review evidence changed');
  const assessmentOption = process.argv.indexOf('--assessment');
  const assessment = assessmentOption >= 0 ? read(resolve(process.argv[assessmentOption + 1])) : null;
  if (startupIncident && (assessment?.eventsHash !== sha(join(row.evidence, 'events.jsonl')) || assessment?.rawTraceReviewed !== true || assessment?.commands?.length !== 0)) throw Error('Startup incident requires zero-command raw-bound assessment');
  if (interruptedIncident && (assessment?.eventsHash !== sha(join(row.evidence, 'events.jsonl')) ||
      assessment?.canonicalHash !== canonicalEvidence(row.evidence).hash || assessment?.rawTraceReviewed !== true ||
      assessment?.commands?.length !== row.toolCalls || !assessment?.issues?.some(issue => issue.id === 'G6-HOST-CANCEL-001')))
    throw Error('Interrupted incident requires a complete raw-bound blocked assessment');
  if (hostInterruptedIncident && (assessment?.eventsHash !== sha(join(row.evidence, 'events.jsonl')) || assessment?.canonicalHash !== null || assessment?.rawTraceReviewed !== true || assessment?.commands?.length !== row.toolCalls)) throw Error('Host interruption requires a complete raw-bound BLOCKED assessment');
  if (capacityIncident && assessment?.eventsHash !== sha(join(row.evidence, 'events.jsonl'))) throw Error('Capacity incident raw trace binding required');
  if (verdict === 'pass') {
    const canonical = canonicalEvidence(row.evidence);
    let providerObservations = null;
    if (manifest.providerObservations) {
      const publicKeyPath = join(pointer.directory, 'protocol/provider-observation-public.pem');
      if (!['ed25519-provider-launch-v1', 'ed25519-completed-command-v2'].includes(manifest.providerObservations.scheme) ||
          sha(publicKeyPath) !== manifest.providerObservations.publicKeyHash) {
        throw Error('Frozen provider observation policy/key mismatch');
      }
      providerObservations = { scheme: manifest.providerObservations.scheme, publicKey: readFileSync(publicKeyPath, 'utf8'), binding: { protocolHash }, requireRawTrace: true,
        records: [...providerObservationAncestors(state.slots, row),
          ...(recovery ? (state.infrastructureFailures ?? []).filter(failure =>
            failure.kind === 'provider-disconnect-after-startup' && failure.record.workspace === row.workspace &&
            failure.record.binding?.taskId === row.binding?.taskId && Date.parse(failure.record.startedAt) < Date.parse(row.startedAt))
            .map(failure => failure.record) : [])]
          .map(prior => ({ binding: providerObservationBinding(protocolHash, prior),
            envelopes: readFileSync(join(prior.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) })) };
    }
    const previous = recoveryReviews(ledger.rows, recovery).find(item => item.id === row.reworkFeedback?.from);
    if (previous?.hostInfrastructureIssues) {
      const result = readFileSync(join(row.evidence, 'RESULT.md'), 'utf8');
      for (const issue of previous.issues ?? []) if (!ignoresReviewFinding(compactionReviewPolicy, issue.id) && (!result.includes(issue.id) ||
        !(canonical.current + canonical.full).includes(issue.id))) throw Error('Host recovery finding omitted: ' + issue.id);
    }
    const b2Handoff2Compatibility = capacityRecovery?.formalDisconnectRecovery?.b2Handoff2ReviewCompatibility;
    const b2Handoff2Match = b2Handoff2Compatibility?.predecessorId === previous?.id &&
      b2Handoff2Compatibility?.currentId === row.id && row.continuationFrom === previous?.id;
    if (b2Handoff2Match && !acceptCompaction) {
      const proof = b2Handoff2Compatibility;
      if (!readFileSync(resultPath, 'utf8').includes(proof.findingId) ||
          !(canonical.current + canonical.full).includes(proof.findingId) ||
          !assessment.hostFindings?.some(finding => finding.id === proof.findingId && finding.verified === true &&
            finding.priorVerdict === 'rework' && finding.authorizationHash === proof.authorizationHash &&
            finding.rawReference?.includes(proof.eventsHash)) ||
          assessment.issues?.some(issue => issue.id === proof.findingId))
        throw Error('Historical B2 handoff2 host compaction finding missing or misclassified');
    }
    const b2Handoff2Cap3Proof = capacityRecovery?.formalDisconnectRecovery?.b2Handoff2Cap3Recovery;
    const b2Handoff2Cap3Match = !acceptCompaction && validateB2Handoff2Cap3Findings(b2Handoff2Cap3Proof, row, previous, assessment, readFileSync(resultPath, 'utf8'), canonical);
    if (capacityRecovery?.formalDisconnectRecovery?.b2Handoff2Cap4Recovery?.currentId === row.id) validateB2Handoff2Cap4History(capacityRecovery?.formalDisconnectRecovery?.b2Handoff2Cap4Recovery, row, previous, assessment, readFileSync(resultPath, 'utf8'), canonical, JSON.parse(readFileSync(join(row.evidence, 'handoff/errors.json'), 'utf8')));
    const inheritedIssues = (previous?.hostInfrastructureIssues ? [] : previous?.issues ?? []).filter(issue =>
      !ignoresReviewFinding(compactionReviewPolicy, issue.id) &&
      !(b2Handoff2Cap3Match && b2Handoff2Cap3Proof.hostFindingIds.includes(issue.id)) &&
      !(b2Handoff2Match && issue.id === b2Handoff2Compatibility.findingId) &&
      !(recovery?.compactionRecovery?.predecessorId === previous?.id &&
        row.id === 'S-0-handoff-1-attempt-3' && issue.id === 'G6-S-HANDOFF1-A2-COMPACTION') &&
      !(capacityRecovery?.formalDisconnectRecovery?.entries?.[previous?.id]?.completedCompaction &&
        row.id === 'S-2-handoff-1-attempt-3' && row.continuationFrom === previous.id &&
        issue.id === 'G6-S2-HANDOFF1-A2-COMPACTION-001') &&
      !(capacityRecovery?.formalDisconnectRecovery?.b2DebugReviewCompatibility?.predecessorId === previous?.id &&
        capacityRecovery.formalDisconnectRecovery.b2DebugReviewCompatibility.currentId === row.id &&
        issue.id === capacityRecovery.formalDisconnectRecovery.b2DebugReviewCompatibility.findingId) &&
      !(capacityRecovery?.formalDisconnectRecovery?.b2HandoffCompactionRecovery?.predecessorId === previous?.id &&
        capacityRecovery.formalDisconnectRecovery.b2HandoffCompactionRecovery.nextInvocationId === row.id &&
        issue.id === capacityRecovery.formalDisconnectRecovery.b2HandoffCompactionRecovery.compactionFindingId) &&
      !(capacityRecovery?.formalDisconnectRecovery?.entries?.[previous?.id]?.cap5Authorized &&
        capacityRecovery.formalDisconnectRecovery.entries[previous.id].nextInvocationId === row.id &&
        issue.id === capacityRecovery.formalDisconnectRecovery.entries[previous.id].compactionFindingId));
    const cap5Predecessor = capacityRecovery?.formalDisconnectRecovery?.entries?.[previous?.id];
    if (!acceptCompaction && cap5Predecessor?.cap5Authorized && cap5Predecessor.nextInvocationId === row.id) {
      for (const findingId of cap5Predecessor.historicalFindingIds) {
        if (!readFileSync(resultPath, 'utf8').includes(findingId) || !(canonical.current + canonical.full).includes(findingId) ||
          !assessment.hostFindings?.some(finding => finding.id === findingId && finding.verified === true &&
            finding.priorVerdict === 'rework' && finding.authorizationHash === cap5Predecessor.authorizationHash))
          throw Error('Historical cap5 compaction finding omitted');
      }
    }
    const b2HandoffRecovery = capacityRecovery?.formalDisconnectRecovery?.b2HandoffCompactionRecovery;
    if (!acceptCompaction && b2HandoffRecovery?.nextInvocationId === row.id) {
      for (const findingId of b2HandoffRecovery.historicalFindingIds) {
        if (!readFileSync(resultPath, 'utf8').includes(findingId) || !(canonical.current + canonical.full).includes(findingId) ||
          !assessment.hostFindings?.some(finding => finding.id === findingId && finding.verified === true &&
            finding.priorVerdict === 'rework' && finding.authorizationHash === b2HandoffRecovery.authorizationHash))
          throw Error('Historical B2 handoff compaction finding omitted');
      }
    }
    const b2Compatibility = capacityRecovery?.formalDisconnectRecovery?.b2DebugReviewCompatibility;
    if (!acceptCompaction && b2Compatibility?.currentId === row.id && !assessment.hostFindings?.some(finding =>
      finding.id === b2Compatibility.findingId && finding.verified === true && finding.priorVerdict === 'rework' &&
      finding.authorizationHash === b2Compatibility.authorizationHash && finding.rawReference?.includes('events.jsonl')))
      throw Error('Historical B2 compaction host finding assessment missing');
    if (!acceptCompaction && previous?.id === 'S-2-handoff-1-attempt-2' && capacityRecovery?.formalDisconnectRecovery?.entries?.[previous?.id]?.completedCompaction) {
      const findingId = 'G6-S2-HANDOFF1-A2-COMPACTION-001';
      const findings = read(join(row.evidence, 'handoff/host-findings.json'));
      if (!findings.some(finding => finding.id === findingId) || !readFileSync(resultPath, 'utf8').includes(findingId) ||
          !(canonical.current + canonical.full).includes(findingId)) throw Error('Historical compaction finding omitted');
    }
    validateEvidenceAssessment(assessment, { canonicalHash: canonical.hash, eventsHash: sha(join(row.evidence, 'events.jsonl')), resultHash }, inheritedIssues.map(issue => issue.id), readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).message).filter(event => event.method === 'item/completed' && event.params?.item?.type === 'commandExecution').map(event => event.params.item));
    validatePublishedIssues(row.evidence, assessment.issues, canonical, { strict: manifest.evidenceContract === 'immutable-command-v1', providerObservations });
    if (manifest.evidenceContract === 'immutable-command-v1') validateCommandCaptures(row.evidence, readFileSync(join(row.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).message).filter(event => event.method === 'item/completed' && event.params?.item?.type === 'commandExecution').map(event => event.params.item));
    const predecessor = state.slots.find(item => item.id === row.continuationFrom);
    if (row.continuationFrom && !predecessor) throw new Error('Missing bound predecessor');
    if (predecessor) {
      const reviewed = ledger.rows.find(item => item.id === predecessor.id);
      if (!reviewed || reviewed.sourceManifestHash !== sha(join(predecessor.evidence, 'source-after.json'))) throw new Error('Predecessor manifest binding mismatch');
    }
    let original = row;
    const ancestry = new Set([row.id]);
    while (original.continuationFrom) {
      const parent = state.slots.find(item => item.id === original.continuationFrom);
      if (!parent || ancestry.has(parent.id)) throw new Error('Invalid source ancestry');
      ancestry.add(parent.id);
      original = parent;
    }
    verifySourceEvidence(row.evidence, { original: read(join(original.evidence, 'source-before.json')), before: read(join(row.evidence, 'source-before.json')), final: read(join(row.evidence, 'source-after.json')), predecessor: predecessor ? read(join(predecessor.evidence, 'source-after.json')) : null }, canonical);
  } else if (!Array.isArray(assessment?.issues) || !assessment.issues.length || assessment.issues.some(issue => !issue.id || !issue.rawReference)) {
    throw new Error('REWORK/blocked requires issue IDs and raw references via --assessment');
  }
  const reviewed = { id, verdict, reason, assessment, issues: assessment.issues, sourceManifestHash, resultHash, reviewedAt,
    ...(acceptCompaction ? { reviewPolicyHash: compactionReviewPolicy.authorizationHash, effectiveMeasurementEligible: verdict === 'pass' } : {}),
    activeReviewMs: Date.parse(reviewedAt) - Date.parse(start.startedAt), endToEndMs: Date.parse(reviewedAt) - Date.parse(row.startedAt) };
  if (supersede) ledger.rows[previousReviewIndex] = { ...reviewed, supersedes: { archive: capacityRecovery.receiptRecovery.archive,
    originalReviewHash: capacityRecovery.receiptRecovery.originalReviewHash, authorizationHash: capacityRecovery.receiptRecovery.authorizationHash } };
  else ledger.rows.push(reviewed);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  console.log(JSON.stringify({ id, verdict, reviewed: ledger.rows.length }));
}
