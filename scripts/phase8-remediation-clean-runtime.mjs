import { completedIntegrationProfiles } from '../benchmarks/task-management/remediation-scope.mjs';
import { readFileSync, writeFileSync, readdirSync, statSync, statfsSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containedPath, projectRoot } from '../benchmarks/task-management/remediation-policy.mjs';

const run = containedPath(process.argv[2]);
const report = JSON.parse(readFileSync(join(run, 'cli-integration.json'), 'utf8'));
if (report.passed !== true || report.commands.some(command => !Number.isInteger(command.exitCode) || command.signal || command.error)) throw new Error('CLI commands must finish before runtime cleanup');
const free = () => { const fs = statfsSync(run); return fs.bavail * fs.bsize; };
const profiles = completedIntegrationProfiles(report);
const targets = profiles.flatMap(profile => ['B', 'S'].map(branch => ({ owner: profile + '-' + branch, path: containedPath(join(run, 'cli-integration', profile, branch, '.bridge-runtime')) })));
for (const target of targets) {
  target.inventory = {};
  function inventory(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = containedPath(join(path, entry.name)), key = prefix + entry.name;
      if (entry.isDirectory()) inventory(file, key + '/');
      else if (entry.isFile()) target.inventory[key] = { bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
      else throw new Error('Runtime cleanup rejects links');
    }
  }
  inventory(target.path);
}
writeFileSync(join(run, 'runtime-cleanup-registration.json'), JSON.stringify({ targets, purpose: 'Redundant per-workspace copies; shared candidate build and immutable baseline retained' }, null, 2) + '\n', { flag: 'wx' });
const logs = [];
for (const target of targets) {
  containedPath(target.path);
  const before = free(), started = Date.now();
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Remove-Item -LiteralPath $env:PHASE8_CLEANUP_TARGET -Recurse -Force'], { cwd: projectRoot, env: { ...process.env, PHASE8_CLEANUP_TARGET: target.path }, windowsHide: true, encoding: 'utf8' });
  logs.push({ owner: target.owner, path: target.path, deleted: !existsSync(target.path), bytes: Object.values(target.inventory).reduce((sum, item) => sum + item.bytes, 0), freeBefore: before, freeAfter: free(), cleanupMs: Date.now() - started, exitCode: result.status, error: result.stderr || result.error?.stack || null });
}
writeFileSync(join(run, 'runtime-cleanup.json'), JSON.stringify(logs, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ deleted: logs.filter(item => item.deleted).length, bytes: logs.reduce((sum, item) => sum + (item.deleted ? item.bytes : 0), 0) }));
process.exitCode = logs.every(item => item.deleted) ? 0 : 2;
