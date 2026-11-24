import { readFileSync, writeFileSync, mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyProviderObservation } from '../benchmarks/task-management/provider-observations.mjs';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'docs/phase8-2-remediation-20261019/diagnostics/g4-unblock-20261022-873bf6eb');
const round = '72d4d408-ac61-454c-889f-571f4cd833e6';
const attempt = join(source, 'rounds', round, 'e/001');
const out = join(root, 'docs/phase8-2-remediation-20261019/offline', `g4-873bf6eb-${randomUUID()}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
mkdirSync(out);
const files = {};
function inventory(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) inventory(path);
    else if (item.isFile()) files[relative(root, path).replaceAll('\\', '/')] = hash(readFileSync(path));
    else throw Error('Historical inventory rejects links');
  }
}
inventory(source);
const review = load(join(source, 'raw-review.json'));
const calls = load(join(attempt, 'tool-calls.json'));
const events = readFileSync(join(attempt, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const completed = new Map(events.filter(e => e.message?.method === 'item/completed' && e.message.params?.item?.type === 'commandExecution').map(e => [e.message.params.item.id, e]));
const ledger = load(join(attempt, 'handoff/errors.json'));
const protocol = load(join(source, 'rounds', round, 'protocol.json'));
const publicKey = readFileSync(join(source, 'rounds', round, 'protocol/provider-observation-public.pem'), 'utf8');
if (hash(publicKey) !== protocol.providerObservations.publicKeyHash || protocol.protocolHash !== review.protocolHash) throw Error('Baseline public key/protocol mismatch');
if (calls.length !== 44 || new Set(calls.map(c => c.id)).size !== 44 || review.completedCommands !== 44 || review.signedObservations !== 44) throw Error('Expected 44 unique reviewed commands');
const mapping = calls.map(call => {
  const raw = completed.get(call.id), reviewed = review.commands.find(c => c.id === call.id);
  if (!raw || JSON.stringify(raw.message.params.item) !== JSON.stringify(call) || !reviewed) throw Error('Raw/review mismatch: ' + call.id);
  const observationPath = join(attempt, 'handoff/provider-observations', call.id + '.json');
  verifyProviderObservation(load(observationPath), publicKey, { binding: { protocolHash: review.protocolHash, attemptId: review.attemptId, attempt: 1 }, envelope: raw });
  return { ...reviewed, rawEnvelopeHash: hash(JSON.stringify(raw)), signedObservation: { path: relative(root, observationPath), sha256: hash(readFileSync(observationPath)), verified: true }, issues: (Array.isArray(ledger) ? ledger : ledger.issues).filter(i => JSON.stringify(i).includes(call.id)) };
});
if (mapping.filter(c => c.failed).length !== 8) throw Error('Expected eight reviewed execution/inner failures');
const expected = ['2c621ea6ebbe7fdf81a448ba7550b86d5eef1aac603fbc50b635db9eee2a214d', '575d7da6be2f03c3e09b59e25a2ceddddce41be0a11dcdc69c40784e42cc5d8d', 'b2e52b808cbfa433a22b010a4094aff40f3a3862f92bba3c3be32001cdb2c0dc'];
const reports = expected.map((sha256, i) => {
  const artifact = `.handoff/verifications/rev-clamp-equal-bounds-final-0${i + 1}.json`;
  const bytes = readFileSync(join(attempt, artifact.replace('.handoff/', 'handoff/')));
  if (hash(bytes) !== sha256 || JSON.parse(bytes).passed !== false) throw Error('Historical FAIL report mismatch');
  return { artifact, sha256, report: JSON.parse(bytes) };
});
const scan = spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:G4_BASELINE_ROUND) } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, G4_BASELINE_ROUND: join(source, 'rounds', round) } });
save('resume-inventory.json', { owner: relative(root, out), createdAt: new Date().toISOString(), round, attemptId: review.attemptId, slot: 'B-0-small-1', protocolHash: review.protocolHash, historicalHashes: files, scratch: [], providerInvocations: 0, capacity: statfsSync(root), processScan: { status: scan.status, stdout: scan.stdout, stderr: scan.stderr, error: scan.error?.message ?? null }, sessionLeaseStatus: 'Not freshly proven; historical cleanup is insufficient for launch' });
save('baseline-review-map.json', { round, attemptId: review.attemptId, commands: mapping, failureReports: reports, lifecycleReceipts: calls.filter(c => ['exec-59618d6b-a4b3-4525-9b7b-f59cfd7c1c98', 'exec-8840b4b1-8d92-41f3-bb6e-b2a7bd74b804'].includes(c.id)), workflowFindings: ['G4-first-task-extra-session', 'G4-canonical-fail-report-history'] });
console.log(out);
