import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const [id, verdict, reason] = process.argv.slice(2);
if (!id || !['pass', 'rework', 'blocked'].includes(verdict) || !reason?.trim()) throw new Error('Usage: record-review.mjs <slot-id> <pass|rework|blocked> <content-review-reason>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const pointer = read(join(root, 'docs/phase0-20261016/round.json'));
const state = read(join(pointer.directory, 'state.json'));
const fullAudit = join(pointer.directory, 'formal-audit.json');
const audit = read(existsSync(fullAudit) ? fullAudit : join(pointer.directory, 'formal-audit.partial.json'));
const row = state.slots.find(slot => slot.id === id && slot.phase === 'formal');
if (row?.status !== 'finished' || audit.protocolHash !== pointer.protocolHash || !audit.details.some(slot => slot.id === id && slot.integrityPassed)) throw new Error('Completed mechanically audited slot required');
if (verdict === 'pass' && (!row.acceptance?.passed || row.failureClass || row.unexpectedFiles?.length)) throw new Error('Cannot pass failed acceptance or scope');
const path = join(pointer.directory, 'formal-content-review.partial.json'), review = read(path);
if (review.protocolHash !== pointer.protocolHash || review.rows.some(slot => slot.id === id)) throw new Error('Review binding mismatch or duplicate review');
const reviewedAt = new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
review.rows.push({ id, verdict, reviewedAt, endToEndMs: Date.parse(reviewedAt) - Date.parse(row.startedAt),
  sourceManifestHash: hash(readFileSync(join(row.evidence, 'source-after.json'))),
  resultHash: hash(readFileSync(join(row.evidence, 'RESULT.md'))), reason });
writeFileSync(path, JSON.stringify(review, null, 2) + '\n');
console.log(JSON.stringify({ id, verdict, reviewed: review.rows.length }));
