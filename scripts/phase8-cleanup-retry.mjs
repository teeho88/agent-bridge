import { readFileSync, readdirSync, existsSync, writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { containedPath, projectRoot } from '../benchmarks/task-management/remediation-policy.mjs';

const run = containedPath(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
const targets = manifest.registeredTemporary;
if (!Array.isArray(targets) || targets.length !== 1 || targets[0].owner !== manifest.id || targets[0].path !== join(run, 'scratch')) throw new Error('Unregistered cleanup target');
const target = containedPath(targets[0].path);
function verify(path) {
  containedPath(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Cleanup contains link');
    if (entry.isDirectory()) verify(join(path, entry.name));
  }
}
verify(target);
const free = () => { const fs = statfsSync(run); return fs.bavail * fs.bsize; };
const before = free();
const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Remove-Item -LiteralPath $env:PHASE8_CLEANUP_TARGET -Recurse -Force'], { cwd: projectRoot, env: { ...process.env, PHASE8_CLEANUP_TARGET: target }, windowsHide: true, encoding: 'utf8' });
writeFileSync(join(run, 'cleanup-retry.json'), JSON.stringify({ path: target, deleted: !existsSync(target), exitCode: result.status, error: result.stderr || result.error?.stack || null, freeBefore: before, freeAfter: free(), reason: 'PowerShell 7 retry after Windows PowerShell long-path failure' }, null, 2) + '\n', { flag: 'wx' });
process.exitCode = result.status ?? 2;
