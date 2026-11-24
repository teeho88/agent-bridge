import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { containedPath, projectRoot } from './remediation-policy.mjs';
import { validateIdentityPool } from './identity-pool.mjs';
import { createWorkspaceLayout } from './run-workspace.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = containedPath(process.argv[2]);
const directory = containedPath(process.argv[3]);
const historicalBytes = readFileSync(join(source, 'protocol.json'));
const historical = JSON.parse(historicalBytes);
const { protocolHash, ...body } = historical;
if (hash(JSON.stringify(body)) !== protocolHash || historical.nodeHash !== hash(readFileSync(process.execPath)))
  throw Error('Historical fingerprint or Node binary mismatch');
const schedules = { smoke: historical.smoke, formal: [] };
const identityPool = validateIdentityPool(JSON.parse(readFileSync(join(source, 'protocol/identity-pool.json'), 'utf8')), schedules);
mkdirSync(directory);
const frozen = join(directory, 'protocol'); mkdirSync(frozen);
copyFileSync(join(source, 'protocol/identity-pool.json'), join(frozen, 'identity-pool.json'));
const files = ['benchmarks/task-management/sqlite-startup-layout.mjs', 'benchmarks/task-management/sqlite-startup-probe.mjs',
  'benchmarks/task-management/run-workspace.mjs', 'benchmarks/task-management/native-stdio.cjs',
  'next/runtime/src/sandbox.mjs', 'next/runtime/src/windows-sandbox.cs', 'next/runtime/src/windows-sandbox.ps1',
  'next/runtime/src/canary-worker.cjs', 'next/adapter-codex/src/rpc.mjs'];
const sources = {};
for (const path of files) {
  const bytes = readFileSync(join(projectRoot, path));
  sources[path] = hash(bytes);
  const destination = join(frozen, path.replaceAll('/', '_'));
  writeFileSync(destination, bytes, { flag: 'wx' });
}
const id = randomUUID();
const workspaceLayout = createWorkspaceLayout({ directory, roundId: id, schedules, identities: identityPool });
const manifest = { schemaVersion: 1, id, kind: 'sqlite-startup-only', createdAt: new Date().toISOString(),
  directory, source, sourceManifestHash: hash(historicalBytes), sourceProtocolHash: protocolHash,
  formalPermitted: false, inferencePermitted: false, measurementComplete: false, releasePassed: false,
  providerHash: historical.providerHash, codeModeHostHash: historical.codeModeHostHash, nodeHash: historical.nodeHash,
  smoke: schedules.smoke, schedule: [], workspaceLayout, sources,
  identityPoolHash: hash(readFileSync(join(frozen, 'identity-pool.json'))) };
manifest.protocolHash = hash(JSON.stringify(manifest));
writeFileSync(join(directory, 'protocol.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, protocolHash: manifest.protocolHash, workspaces: workspaceLayout.entries.length,
  inferencePermitted: false }));
