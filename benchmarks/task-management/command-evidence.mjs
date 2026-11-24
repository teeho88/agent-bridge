import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containedPath } from './remediation-policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function captureCommand({ directory, id, executable, argv, cwd, env, timeout = 30000 }) {
  containedPath(directory); containedPath(cwd);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new Error('Invalid command ID/argv');
  const output = containedPath(join(directory, id));
  mkdirSync(output);
  const stdoutPath = join(output, 'stdout.log'), stderrPath = join(output, 'stderr.log');
  const stdout = openSync(stdoutPath, 'wx'), stderr = openSync(stderrPath, 'wx');
  const startedAt = new Date().toISOString();
  let result;
  try { result = spawnSync(executable, argv, { cwd, env, timeout, windowsHide: true, stdio: ['ignore', stdout, stderr] }); }
  finally { closeSync(stdout); closeSync(stderr); }
  const receipt = { schemaVersion: 1, id, executable, argv, cwd, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.stack ?? null,
    stdout: { path: stdoutPath, hash: hash(readFileSync(stdoutPath)) }, stderr: { path: stderrPath, hash: hash(readFileSync(stderrPath)) } };
  writeFileSync(join(output, 'command.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

export function verifyFailureArtifact(receipt, reference) {
  if (receipt.id !== reference.commandId || receipt.exitCode === 0 || receipt.exitCode === null || receipt.signal || receipt.error) throw new Error('Expected completed failed command');
  const artifact = [receipt.stdout, receipt.stderr].find(item => item.path === reference.path);
  if (!artifact || artifact.hash !== reference.hash || hash(readFileSync(containedPath(reference.path))) !== reference.hash) throw new Error('Failure artifact binding mismatch');
  return true;
}

export function saveVerification(directory, id, report) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid verification ID');
  const path = containedPath(join(directory, id + '.json'));
  const bytes = Buffer.from(JSON.stringify({ ...report, id }, null, 2) + '\n');
  writeFileSync(path, bytes, { flag: 'wx' });
  return { id, path, hash: hash(bytes) };
}
