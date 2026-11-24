import { readFileSync, writeFileSync, readdirSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence, verifySourceEvidence, validatePublishedIssues, validateFailureReportHistory, publicationHash } from './comparison-evidence.mjs';

const workspace = realpathSync.native(process.cwd()), [manifestName, revision] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]+$/.test(revision ?? '')) throw Error('Expected manifests path and unique verification revision');
const inside = path => {
  if (typeof path !== 'string' || path.split(/[\\/]/).includes('..')) throw Error('Invalid verification path');
  const target = resolve(workspace, path), rel = relative(workspace, target);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw Error('Verification path outside workspace');
  if (existsSync(target)) { const actual = relative(workspace, realpathSync.native(target)); if (actual.startsWith('..') || isAbsolute(actual)) throw Error('Verification path outside workspace'); }
  return target;
};
const directory = inside('.handoff/verifications'); mkdirSync(directory, { recursive: true }); inside(directory);
const output = inside(join(directory, revision + '.json'));
if (existsSync(output)) throw Error('Verification revision already exists');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let report;
try {
  const manifests = JSON.parse(readFileSync(inside(manifestName), 'utf8')), final = {};
  function inventory(path, prefix) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const file = inside(join(path, item.name)), name = prefix + item.name;
      if (item.isDirectory()) inventory(file, name + '/');
      else if (item.isFile()) final[name] = hash(readFileSync(file));
      else throw Error('Source inventory rejects links');
    }
  }
  inventory(inside('src'), 'src/');
  if (JSON.stringify(Object.entries(final).sort()) !== JSON.stringify(Object.entries(manifests.final).filter(([name]) => name.startsWith('src/')).sort())) throw Error('Final source differs from bytes on disk');
  const canonical = canonicalEvidence(workspace, { handoffDirectory: '.handoff' });
  const history = validateFailureReportHistory(workspace, canonical);
  const verified = verifySourceEvidence(workspace, manifests, canonical);
  const ledger = JSON.parse(readFileSync(inside('.handoff/errors.json'), 'utf8'));
  const issues = Array.isArray(ledger) ? ledger : ledger.issues;
  const publicKeyPath = inside('.bridge-runtime/evidence/provider-observation-public.pem');
  const providerObservations = existsSync(publicKeyPath) ? { publicKey: readFileSync(publicKeyPath, 'utf8') } : null;
  validatePublishedIssues(workspace, issues, canonical, { strict: true, providerObservations });
  report = { passed: true, revision, ...verified, ...history, publicationHash: publicationHash(workspace, canonical), resultHash: hash(readFileSync(inside('RESULT.md'))), sourceManifestsHash: hash(readFileSync(inside(manifestName))) };
} catch (error) { report = { passed: false, revision, error: error.message, stack: error.stack }; }
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, artifact: relative(workspace, output).replaceAll('\\', '/'), sha256: hash(readFileSync(output)), error: report.error ?? null }));
process.exitCode = report.passed ? 0 : 1;
