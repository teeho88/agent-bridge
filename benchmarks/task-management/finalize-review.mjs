import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pointer = read(join(root, 'docs/phase0-20261016/round.json'));
const protocol = read(pointer.protocol);
const state = read(join(pointer.directory, 'state.json'));
const auditPath = join(pointer.directory, 'formal-audit.json');
const reviewPath = join(pointer.directory, 'formal-content-review.partial.json');
const audit = read(auditPath), ledger = read(reviewPath);
const expectedIds = protocol.schedule.map(slot => slot.id);
const rows = state.slots.filter(slot => slot.phase === 'formal');
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };

requireCheck([state.protocolHash, audit.protocolHash, ledger.protocolHash].every(hash => hash === pointer.protocolHash), 'Protocol binding mismatch');
requireCheck(state.status === 'formal-completed' && audit.mechanicalIntegrityPassed && audit.mismatches.length === 0, 'Formal run or mechanical audit incomplete');
requireCheck(expectedIds.length === 25 && new Set(expectedIds).size === 25, 'Unexpected formal schedule');
requireCheck(rows.length === 25 && ledger.rows.length === 25 && audit.details.length === 25, 'Missing formal observation or review');
requireCheck(new Set(rows.map(row => row.id)).size === 25 && new Set(ledger.rows.map(row => row.id)).size === 25, 'Duplicate formal or review slot');

const reviewed = expectedIds.map(id => {
  const row = rows.find(item => item.id === id);
  const item = ledger.rows.find(value => value.id === id);
  const audited = audit.details.find(value => value.id === id);
  requireCheck(row && item && audited, 'Slot missing: ' + id);
  requireCheck(row.status === 'finished' && row.acceptance?.passed && row.acceptance.cases === 2 && row.acceptance.failures === 0 && !row.failureClass, 'Acceptance mismatch: ' + id);
  requireCheck(['pass', 'rework', 'blocked'].includes(item.verdict) && item.reason?.trim(), 'Invalid content verdict: ' + id);
  requireCheck(audited.acceptancePassed && audited.actualModel === protocol.model && audited.actualEffort === protocol.effort, 'Audit provenance mismatch: ' + id);
  requireCheck(row.launch?.model === protocol.model && row.launch.effort === protocol.effort, 'Invocation model mismatch: ' + id);
  requireCheck(item.sourceManifestHash === sha(readFileSync(join(row.evidence, 'source-after.json'))), 'Source evidence changed: ' + id);
  requireCheck(item.resultHash === sha(readFileSync(join(row.evidence, 'RESULT.md'))), 'RESULT evidence changed: ' + id);
  return item;
});

const counts = Object.fromEntries(['pass', 'rework', 'blocked'].map(value => [value, reviewed.filter(item => item.verdict === value).length]));
const final = {
  schemaVersion: 1,
  protocolHash: pointer.protocolHash,
  phase: 'formal',
  completedAt: new Date().toISOString(),
  dataComplete: true,
  qualityPassed: counts.rework === 0 && counts.blocked === 0,
  mechanicalIntegrityPassed: true,
  observedInvocations: rows.length,
  nativeAcceptanceTestsPassed: rows.reduce((sum, row) => sum + row.acceptance.cases, 0),
  acceptancePassed: rows.filter(row => row.acceptance.passed).length,
  completionRate: rows.filter(row => row.acceptance.passed).length / expectedIds.length,
  contentPassRate: counts.pass / expectedIds.length,
  reviewCounts: counts,
  pendingRework: reviewed.filter(item => item.verdict === 'rework').map(item => item.id),
  reviewLedgerHash: sha(readFileSync(reviewPath)),
  mechanicalAuditHash: sha(readFileSync(auditPath)),
  reviewer: ledger.reviewer,
  rows: reviewed,
};
writeFileSync(join(pointer.directory, 'formal-review.json'), JSON.stringify(final, null, 2) + '\n');
console.log(JSON.stringify({ dataComplete: final.dataComplete, qualityPassed: final.qualityPassed,
  acceptancePassed: final.acceptancePassed, reviewCounts: counts, pendingRework: final.pendingRework }));
