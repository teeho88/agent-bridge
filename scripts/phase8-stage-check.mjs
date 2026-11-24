import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectRoot, campaignRoot, createDirectory, childEnvironment, containedPath } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';

const [label, ...tests] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label ?? '') || !tests.length) throw Error('Expected label and test paths');
const id = label + '-' + randomUUID(), directory = createDirectory(join(campaignRoot, 'offline', id));
const scratch = join(directory, 'scratch'), env = childEnvironment(scratch);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sources = {};
for (const folder of ['benchmarks/task-management', 'next/runtime/src'])
  for (const item of readdirSync(join(projectRoot, folder), { withFileTypes: true }))
    if (item.isFile()) sources[folder + '/' + item.name] = hash(join(projectRoot, folder, item.name));
for (const path of tests) sources[path] = hash(containedPath(path));
const protectedEvidence = {};
for (const path of ['docs/phase8-recovery-20261019/validated/baseline.json', 'docs/phase8-recovery-20261019/validated/comparison-report.json'])
  if (existsSync(join(projectRoot, path))) protectedEvidence[path] = hash(join(projectRoot, path));
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ id, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Unit/integration scratch and compiler caches' }], sources, protectedEvidence }, null, 2) + '\n', { flag: 'wx' });
const result = captureCommand({ directory, id: 'tests', executable: process.execPath,
  argv: ['--test', ...tests.map(path => containedPath(path))], cwd: projectRoot, env, timeout: 180000 });
const integrity = Object.entries(protectedEvidence).every(([path, digest]) => hash(join(projectRoot, path)) === digest);
writeFileSync(join(directory, 'integrity.json'), JSON.stringify({ protectedEvidenceUnchanged: integrity }) + '\n', { flag: 'wx' });
const cleanup = !result.error && !result.signal ? captureCommand({ directory, id: 'cleanup', executable: process.execPath,
  argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env }) : null;
console.log(JSON.stringify({ directory, exitCode: result.exitCode, protectedEvidenceUnchanged: integrity, cleanupExitCode: cleanup?.exitCode ?? null }));
if (result.exitCode !== 0) {
  process.stderr.write(readFileSync(result.stdout.path));
  process.stderr.write(readFileSync(result.stderr.path));
}
process.exitCode = result.exitCode === 0 && integrity && cleanup?.exitCode === 0 ? 0 : 2;
