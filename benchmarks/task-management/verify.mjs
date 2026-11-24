import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { controlOutcome } from './control-outcome.mjs';
import { containedPath } from './remediation-policy.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const output = containedPath(process.argv[2] ?? join(root, '../../docs/phase0-20261016/protocol-verification'));
if (existsSync(output)) throw new Error('Evidence directory already exists: ' + output);
mkdirSync(output, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const inventory = {};
function copy(source, target, record = null) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copy(from, to, record === null ? null : record + '/' + entry.name);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      if (record !== null) inventory[record + '/' + entry.name] = hash(readFileSync(to));
    }
  }
}
for (const name of ['fixtures', 'controls']) copy(join(root, name), join(output, 'snapshot', name), name);
for (const name of ['verify.mjs', 'control-outcome.mjs', 'remediation-policy.mjs', 'profile-storage.mjs', 'comparison-attempts.mjs', 'PROTOCOL.md', 'run.mjs', 'provider-preflight.mjs', 'native-stdio.cjs', 'native-stdio.test.cjs']) {
  copyFileSync(join(root, name), join(output, 'snapshot', name));
  inventory[name] = hash(readFileSync(join(root, name)));
}
const rows = [];
for (const id of ['small', 'debug', 'multi', 'handoff-1', 'handoff-2']) {
  const fixture = id.startsWith('handoff') ? 'handoff' : id;
  const testFile = id.startsWith('handoff') ? 'acceptance-' + id.at(-1) + '.test.mjs' : 'acceptance.test.mjs';
  for (const control of ['negative', 'positive']) {
    const target = join(output, 'runs', id + '-' + control);
    copy(join(root, 'fixtures', fixture), target);
    if (id === 'handoff-2') copy(join(root, 'controls/handoff-1'), target);
    if (control === 'positive') copy(join(root, 'controls', id), target);
    const start = performance.now();
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
      cwd: target, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    const prefix = id + '-' + control;
    writeFileSync(join(output, prefix + '.stdout.log'), result.stdout ?? '');
    writeFileSync(join(output, prefix + '.stderr.log'), result.stderr ?? '');
    const outcome = controlOutcome({ id, control, status: result.status, signal: result.signal, error: result.error, stdout: result.stdout, stderr: result.stderr });
    const { tests, failures, passed } = outcome;
    rows.push({ id, control, args: ['--test', '--test-reporter=tap', testFile], cwd: 'runs/' + prefix,
      elapsedMs: performance.now() - start, exitStatus: result.status, tests, failures, passed, outcome,
      error: result.error?.message ?? null, stdout: prefix + '.stdout.log', stderr: prefix + '.stderr.log' });
  }
}
const protocolHash = hash(JSON.stringify(Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b)))));
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), node: process.version,
  kind: 'acceptance-controls-not-agent-baseline', protocolHash, inventory, rows,
  passed: rows.every(row => row.passed), providerInvocations: 0, providerUsage: null };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, controls: rows.length, protocolHash, report: join(output, 'report.json') }));
process.exitCode = report.passed ? 0 : 1;
