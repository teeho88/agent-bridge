import { readFileSync, readdirSync, createWriteStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { containedPath, projectRoot, requireRootConfinement } from './remediation-policy.mjs';
import { profileStorageLocation, assessAllowedProfileStorage } from './profile-storage.mjs';
import { captureCommand } from './command-evidence.mjs';

export function workspaceKey(phase, slot) {
  if (!['smoke', 'formal'].includes(phase) || !['B', 'S'].includes(slot.branch) ||
    !Number.isSafeInteger(slot.repetition) || slot.repetition < 0 || !['small', 'debug', 'multi', 'handoff'].includes(slot.taskId))
    throw Error('Invalid identity pool workspace key');
  return phase + '-' + slot.branch + '-' + slot.repetition + '-' + slot.taskId;
}

export function validateIdentityPool(pool, schedules) {
  if (pool?.schemaVersion !== 1 || !Array.isArray(pool.entries)) throw Error('Registered identity pool required');
  const keys = new Set(), profiles = new Set(), sids = new Set();
  for (const entry of pool.entries) {
    profileStorageLocation(entry.profileName, entry.sid);
    if (typeof entry.key !== 'string' || keys.has(entry.key) || profiles.has(entry.profileName.toLowerCase()) || sids.has(entry.sid))
      throw Error('Identity pool requires a unique workspace, profile and SID');
    keys.add(entry.key); profiles.add(entry.profileName.toLowerCase()); sids.add(entry.sid);
  }
  const expected = new Set(Object.entries(schedules).flatMap(([phase, slots]) => slots.map(slot => workspaceKey(phase, slot))));
  if (keys.size !== expected.size || [...expected].some(key => !keys.has(key))) throw Error('Identity pool must cover exactly the campaign workspaces');
  return pool;
}

export function pooledIdentity(pool, phase, slot) {
  const entry = pool.entries.find(entry => entry.key === workspaceKey(phase, slot));
  if (!entry) throw Error('Missing registered workspace identity');
  return entry;
}

export function profileSnapshot({ directory, id, identity, env }) {
  const receipt = captureCommand({ directory, id, executable: 'powershell.exe',
    argv: ['-NoProfile', '-NonInteractive', '-File', join(projectRoot, 'scripts/phase8-profile-snapshot.ps1')], cwd: projectRoot,
    env: { ...env, PHASE8_PROFILE_NAME: identity.profileName, PHASE8_PROFILE_SID: identity.sid,
      PHASE8_HOST_LOCALAPPDATA: identity.localAppData ?? process.env.PHASE8_HOST_LOCALAPPDATA ?? process.env.LOCALAPPDATA } });
  if (receipt.exitCode !== 0) throw Error('Registered profile snapshot failed: ' + id);
  return JSON.parse(readFileSync(receipt.stdout.path, 'utf8'));
}

export function scopeEntries(workspace, readOnlyExecutables = []) {
  workspace = containedPath(workspace);
  const allowed = new Set(readOnlyExecutables.map(path => containedPath(path)));
  const entries = [], links = [];
  function walk(path) {
    if (resolve(path) === workspace) return;
    entries.push({ path, directory: true });
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (file === workspace) continue;
      if (entry.isSymbolicLink()) { links.push(file); continue; }
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) entries.push({ path: file, directory: false });
    }
  }
  walk(projectRoot);
  return { root: projectRoot, workspace, entries, links, readOnlyExecutables: [...allowed] };
}

export async function writeCompressedScopeInput(path, scope) {
  path = containedPath(path);
  if (!path.endsWith('.json.gz') || !Array.isArray(scope.entries)) throw Error('Expected gzip JSON scope input');
  const digest = createHash('sha256');
  let uncompressedBytes = 0;
  function* chunks() {
    const { entries, ...metadata } = scope;
    let buffer = JSON.stringify(metadata).slice(0, -1) + ',"entries":[';
    for (let index = 0; index < entries.length; index++) {
      buffer += (index ? ',' : '') + JSON.stringify(entries[index]);
      if (buffer.length >= 65536) { yield buffer; buffer = ''; }
    }
    yield buffer + ']}';
  }
  function* measured() {
    for (const text of chunks()) {
      const bytes = Buffer.from(text);
      digest.update(bytes); uncompressedBytes += bytes.length;
      yield bytes;
    }
  }
  await pipeline(Readable.from(measured()), createGzip({ level: 9 }), createWriteStream(path, { flags: 'wx' }));
  return { path, format: 'gzip-json-v1', entries: scope.entries.length,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), uncompressedSha256: digest.digest('hex'),
    bytes: statSync(path).size, uncompressedBytes };
}

export function workspaceConfinement({ identity, workspace, boundary, before, after, environment, scopeVerified }) {
  const storage = assessAllowedProfileStorage(before, after, identity);
  const envKeys = ['TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME', 'XDG_CACHE_HOME', 'npm_config_cache'];
  const providerEnvironmentVerified = environment?.cwd === workspace && envKeys.every(key => {
    try { containedPath(environment.env?.[key], workspace); return true; } catch { return false; }
  });
  const proof = { ...storage, root: projectRoot, workspace, profileName: identity.profileName, sid: identity.sid,
    nativeBoundaryVerified: boundary?.writerEnabled === true && boundary.verifiedWriteBoundary === true && boundary.verifiedChildStop === true,
    nativeStopVerified: environment?.writersStopped === true && environment.activeProcesses === 0,
    provisioningBoundaryVerified: boundary?.profileExisting === true && boundary.profileProvisioningSkipped === true,
    providerEnvironmentVerified, scopeVerified: scopeVerified === true, rootConfinementVerified: false };
  proof.boundaryVerified = proof.nativeBoundaryVerified && storage.privateStorageAllowedVerified;
  proof.passed = proof.boundaryVerified && proof.nativeStopVerified && proof.provisioningBoundaryVerified && providerEnvironmentVerified && proof.scopeVerified;
  requireRootConfinement(proof, { workspace, ...identity });
  return proof;
}
