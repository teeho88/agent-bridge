import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { containedPath, projectRoot } from './remediation-policy.mjs';
import { workspaceKey } from './identity-pool.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const scheme = 'short-workspace-v1';
export const nativePathLimit = 240;

function checked(path) {
  path = containedPath(path);
  for (let current = path; current !== projectRoot; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw Error('Workspace layout forbids links: ' + current);
      if (realpathSync(current) !== current) throw Error('Workspace layout requires canonical paths: ' + current);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

function disjoint(left, right) {
  const inside = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
  };
  if (inside(left, right) || inside(right, left)) throw Error('Workspace and evidence roots must be disjoint');
}

export function nativePaths(workspace, profileName) {
  if (typeof profileName !== 'string' || !/^BridgeV2\.[A-Za-z0-9.-]{1,100}$/.test(profileName)) throw Error('Native path preflight requires a profile name');
  workspace = checked(workspace);
  const home = join(workspace, '.bridge-home');
  const codex = join(home, 'codex');
  const local = join(home, 'Packages', profileName.toLowerCase(), 'AC');
  const paths = { CODEX_HOME: codex, LOCALAPPDATA: local, TEMP: join(local, 'Temp'), TMP: join(local, 'Temp'),
    stateWal: join(codex, 'state_5.sqlite-wal'), historyShm: join(codex, 'thread_history_1.sqlite-shm'),
    profileHeadroom: join(local, 'Temp', 'startup-' + 'x'.repeat(32) + '.tmp') };
  for (const [name, path] of Object.entries(paths)) if (path.length > nativePathLimit) throw Error('Native path budget exceeded: ' + name + ' (' + path.length + ' > ' + nativePathLimit + ')');
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { path, length: path.length }]));
}

export function createWorkspaceLayout({ root = join(projectRoot, 'r'), directory, roundId, owner = randomUUID(), schedules, identities }) {
  root = checked(root); directory = checked(directory);
  if (root === projectRoot || typeof roundId !== 'string' || !roundId || !/^[a-f0-9-]{36}$/i.test(owner)) throw Error('Invalid workspace layout owner/root/round');
  disjoint(root, directory);
  const roundRoot = checked(join(root, owner.replaceAll('-', '').slice(0, 16)));
  const entries = [...new Map(Object.entries(schedules).flatMap(([phase, slots]) => slots.map(slot => {
    const key = workspaceKey(phase, slot);
    const workspace = checked(join(roundRoot, hash(key).slice(0, 12), 'project'));
    const identity = identities?.entries.find(entry => entry.key === key);
    const pathBudget = nativePaths(workspace, identity?.profileName ?? 'BridgeV2.' + 'x'.repeat(100));
    return [key, { key, workspace, pathBudget }];
  }))).values()];
  if (!entries.length || new Set(entries.map(entry => entry.workspace)).size !== entries.length) throw Error('Workspace layout collision or empty schedule');
  mkdirSync(root, { recursive: true }); checked(root);
  mkdirSync(roundRoot); checked(roundRoot);
  const layout = { schemaVersion: 1, scheme, root: roundRoot, directory, roundId, owner, entries };
  const bytes = JSON.stringify(layout, null, 2) + '\n';
  const reservation = join(roundRoot, 'owner.json');
  writeFileSync(reservation, bytes, { flag: 'wx' });
  return { ...layout, reservation, reservationHash: hash(bytes) };
}

export function resolveRunWorkspace(layout, directory, phase, slot, roundId) {
  directory = checked(directory);
  if (!layout) return checked(join(directory, 'runs', workspaceKey(phase, slot), 'project'));
  if (layout.schemaVersion !== 1 || layout.scheme !== scheme || layout.directory !== directory || layout.roundId !== roundId ||
      checked(layout.reservation) !== join(checked(layout.root), 'owner.json')) throw Error('Workspace layout binding mismatch');
  disjoint(layout.root, directory);
  const bytes = readFileSync(layout.reservation);
  const { reservation, reservationHash, ...body } = layout;
  if (hash(bytes) !== reservationHash || bytes.toString() !== JSON.stringify(body, null, 2) + '\n') throw Error('Workspace owner reservation changed');
  const key = workspaceKey(phase, slot);
  const entry = layout.entries.find(entry => entry.key === key);
  if (!entry || checked(entry.workspace) !== join(layout.root, hash(key).slice(0, 12), 'project')) throw Error('Workspace slot binding mismatch');
  return entry.workspace;
}

export function validateWorkspaceStartup(proof, { layout, workspace, identity, providerHash, codeModeHostHash, nodeHash }) {
  if (proof?.schemaVersion !== 1 || proof.workspace !== workspace || proof.layoutHash !== layout.reservationHash ||
      proof.providerHash !== providerHash || proof.codeModeHostHash !== codeModeHostHash || proof.nodeHash !== nodeHash || proof.sid !== identity?.sid ||
      proof.profileName !== identity?.profileName || proof.initialized !== true || proof.modelTurns !== 0 ||
      proof.inferenceStarted !== false || proof.nativeFileOperationsPassed !== true || proof.environmentConfined !== true ||
      proof.nativeStopVerified !== true || proof.cleanupVerified !== true || proof.profileStorage?.privateStorageAllowedVerified !== true)
    throw Error('Exact-layout SQLite startup preflight required before inference');
  const expectedPaths = nativePaths(workspace, identity.profileName);
  const artifacts = {};
  for (const name of ['boundary', 'environment', 'initialize', 'stop']) {
    const artifact = proof.artifacts?.[name];
    if (!artifact || typeof artifact.hash !== 'string' || hash(readFileSync(checked(artifact.path))) !== artifact.hash)
      throw Error('SQLite startup artifact hash mismatch: ' + name);
    artifacts[name] = JSON.parse(readFileSync(artifact.path, 'utf8'));
  }
  const environment = JSON.parse(artifacts.environment.stdout);
  const helperHash = hash(Buffer.concat(['windows-sandbox.cs', 'windows-sandbox.ps1', 'canary-worker.cjs']
    .map(name => readFileSync(new URL('../../next/runtime/src/' + name, import.meta.url)))));
  if (!artifacts.boundary.writerEnabled || artifacts.boundary.workspace !== workspace || artifacts.boundary.profileName !== identity.profileName ||
      artifacts.boundary.helperHash !== helperHash || typeof artifacts.initialize.userAgent !== 'string' || !artifacts.initialize.userAgent ||
      artifacts.stop.appContainer !== true || artifacts.stop.writersStopped !== true || artifacts.stop.activeProcesses !== 0 ||
      artifacts.environment.exitStatus !== 0 || artifacts.environment.writersStopped !== true || artifacts.environment.activeProcesses !== 0 ||
      environment.cwd !== workspace || environment.operations?.length !== 9 || !environment.operations.every(item => item.passed === true))
    throw Error('SQLite startup native evidence mismatch');
  for (const key of ['CODEX_HOME', 'TEMP', 'LOCALAPPDATA']) {
    const path = checked(environment.env?.[key]);
    const rel = relative(workspace, path);
    if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw Error('Native environment outside workspace: ' + key);
    if (path.toLowerCase() !== expectedPaths[key].path.toLowerCase()) throw Error('Native environment mapping changed: ' + key);
    if (environment.env[key].length > nativePathLimit) throw Error('Native environment exceeds path budget: ' + key);
  }
  return proof;
}
