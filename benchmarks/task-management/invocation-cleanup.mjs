import { lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, constants, statfsSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, containedPath } from './remediation-policy.mjs';
import { captureCommand } from './command-evidence.mjs';

const registryName = 'invocation-scratch.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return rel === '' || rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
};
const overlaps = (left, right) => inside(left, right) || inside(right, left);
const stat = path => {
  try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};

function checkedPath(path) {
  const absolute = containedPath(path);
  for (let current = absolute; ; current = dirname(current)) {
    const info = stat(current);
    if (info?.isSymbolicLink() || info?.isFile() && info.nlink > 1) throw Error('Cleanup forbids links: ' + current);
    if (relative(projectRoot, current) === '') break;
  }
  return absolute;
}

function identity({ evidence, workspace, owner }) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(owner)) throw Error('Cleanup requires an invocation owner ID');
  evidence = checkedPath(evidence);
  workspace = checkedPath(workspace);
  if (overlaps(evidence, workspace) || evidence === projectRoot || workspace === projectRoot) throw Error('Cleanup evidence and workspace must be disjoint below the project root');
  return { evidence, workspace, owner };
}

function targetsFor({ evidence, workspace }, scratchPaths) {
  if (!Array.isArray(scratchPaths)) throw Error('Cleanup scratchPaths must be an array');
  const targets = scratchPaths.map(path => {
    path = checkedPath(path);
    const name = relative(evidence, path);
    if (!/^(scratch(?:-[A-Za-z0-9_-]+)?|provider)$/.test(name)) throw Error('Cleanup scratch must be a dedicated scratch/provider directory directly under evidence');
    return { path, kind: 'scratch' };
  });
  targets.push(...['.bridge-tmp', '.bridge-home'].map(name => ({ path: checkedPath(join(workspace, name)), kind: 'workspace-cache' })));
  if (new Set(targets.map(target => target.path.toLowerCase())).size !== targets.length) throw Error('Duplicate cleanup target');
  return targets;
}

function artifactPaths(paths, context) {
  if (!Array.isArray(paths)) throw Error('Cleanup requiredArtifacts must be an array');
  return paths.map(path => {
    path = checkedPath(path);
    if (path === context.evidence || path === context.workspace ||
      !inside(context.evidence, path) && !inside(context.workspace, path) ||
      inside(join(context.evidence, 'invocation-cleanup'), path)) throw Error('Required artifact must be within invocation evidence or workspace, outside cleanup logs');
    return path;
  });
}

function save(path, value) {
  writeFileSync(checkedPath(path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

export function registerInvocationTemps({ evidence, workspace, owner, scratchPaths, requiredArtifacts = [] }) {
  const context = identity({ evidence, workspace, owner });
  const targets = targetsFor(context, scratchPaths ?? [join(context.evidence, 'scratch'), join(context.evidence, 'provider')]);
  requiredArtifacts = artifactPaths(requiredArtifacts, context);
  for (const target of targets) {
    if (target.kind === 'scratch' && stat(target.path)) throw Error('Register scratch before creating it: ' + target.path);
  }
  mkdirSync(context.evidence, { recursive: true });
  checkedPath(context.evidence);
  const registration = { schemaVersion: 1, ...context, root: projectRoot, registeredAt: new Date().toISOString(), targets, requiredArtifacts };
  const path = join(context.evidence, registryName);
  save(path, registration);
  return { ...registration, path, hash: hash(readFileSync(path)) };
}

export const registerInvocationScratch = registerInvocationTemps;

function walk(path, visit, parentChecked = false) {
  if (!parentChecked) path = checkedPath(path);
  const info = stat(path);
  if (!info) return;
  if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw Error('Cleanup forbids links: ' + path);
  if (!info.isDirectory() && !info.isFile()) throw Error('Unsupported cleanup entry: ' + path);
  visit(path, info);
  if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), visit, true);
}

function size(path) {
  const result = { bytes: 0, files: 0, directories: 0, exists: stat(checkedPath(path)) !== null };
  walk(path, (_path, info) => {
    if (info.isDirectory()) result.directories++;
    else { result.files++; result.bytes += info.size; }
  });
  return result;
}

function measured(path) {
  try { return size(path); } catch (error) { return { error: error.message }; }
}

function free(path) {
  try { const info = statfsSync(path); return { bytes: info.bavail * info.bsize }; }
  catch (error) { return { bytes: null, error: error.message }; }
}

function archive(source, destination) {
  const files = [];
  walk(source, (path, info) => {
    const target = checkedPath(join(destination, relative(source, path)));
    if (info.isDirectory()) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      const before = hash(readFileSync(path));
      copyFileSync(path, target, constants.COPYFILE_EXCL);
      const after = hash(readFileSync(target));
      if (before !== after || before !== hash(readFileSync(path))) throw Error('Cleanup artifact changed during archive: ' + path);
      files.push({ source: path, path: target, bytes: info.size, hash: after });
    }
  });
  return { source, path: destination, files };
}

function priorArchive(context, source, currentLog) {
  const logs = checkedPath(join(context.evidence, 'invocation-cleanup'));
  for (const name of readdirSync(logs).sort()) {
    const previous = checkedPath(join(logs, name));
    if (previous === currentLog || !stat(previous)?.isDirectory()) continue;
    const manifestPath = checkedPath(join(previous, 'archive-manifest.json'));
    if (!stat(manifestPath)?.isFile()) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.owner !== context.owner || manifest.workspace !== context.workspace) continue;
    for (const entry of manifest.archives ?? []) {
      if (entry.source !== source || !Array.isArray(entry.files) || !inside(join(previous, 'archive'), checkedPath(entry.path)) || !stat(entry.path)) continue;
      if (entry.files.every(file => inside(entry.path, checkedPath(file.path)) && stat(file.path)?.isFile() &&
        stat(file.path).size === file.bytes && hash(readFileSync(file.path)) === file.hash)) return { ...entry, reusedManifest: manifestPath };
    }
  }
  return null;
}

function sessionRelease(context) {
  const memory = checkedPath(join(context.workspace, '.agent-memory'));
  walk(memory, () => {});
  const configPath = join(memory, 'config.json'), databasePath = join(memory, 'memories.db'), runtimePath = join(memory, 'runtime.db');
  for (const path of [configPath, databasePath]) if (!stat(path)?.isFile()) throw Error('Session release evidence missing: ' + path);
  let config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid session config');
  if (stat(runtimePath)) {
    const runtime = new DatabaseSync(runtimePath, { readOnly: true });
    try {
      const row = runtime.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get();
      const payload = JSON.parse(row?.payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid runtime session state');
      config = payload;
    } finally { runtime.close(); }
  }
  const counts = ['activeSessions', 'currentSessions'].map(key => {
    const value = config[key] ?? {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string' || !item)) throw Error('Invalid session map: ' + key);
    return Object.keys(value).length;
  });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let unreleasedLeases;
  try { unreleasedLeases = database.prepare('SELECT COUNT(*) AS count FROM file_leases WHERE released_at IS NULL').get().count; }
  finally { database.close(); }
  return { verified: counts.every(count => count === 0) && unreleasedLeases === 0, source: 'workspace-databases',
    configPath, runtimePath: stat(runtimePath) ? runtimePath : null, databasePath, activeSessions: counts[0], currentSessions: counts[1], unreleasedLeases };
}

const removeCommand = `$ErrorActionPreference = 'Stop'
$cleanupRoot = [IO.Path]::GetFullPath($env:INVOCATION_CLEANUP_ROOT).TrimEnd([IO.Path]::DirectorySeparatorChar)
$cleanupTarget = [IO.Path]::GetFullPath($env:INVOCATION_CLEANUP_TARGET)
if (!$cleanupTarget.StartsWith($cleanupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup target outside project root' }
for ($cleanupAncestor = $cleanupTarget; $cleanupAncestor; $cleanupAncestor = [IO.Path]::GetDirectoryName($cleanupAncestor)) {
  if (Test-Path -LiteralPath $cleanupAncestor) {
    if ((Get-Item -LiteralPath $cleanupAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup ancestor is a reparse point' }
  }
  if ($cleanupAncestor.Equals($cleanupRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
}
$cleanupQueue = [Collections.Generic.Stack[string]]::new()
$cleanupQueue.Push($cleanupTarget)
while ($cleanupQueue.Count -gt 0) {
  $cleanupEntry = Get-Item -LiteralPath $cleanupQueue.Pop() -Force
  if ($cleanupEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup entry is a reparse point' }
  if ($cleanupEntry.PSIsContainer) { foreach ($cleanupChild in Get-ChildItem -LiteralPath $cleanupEntry.FullName -Force) { $cleanupQueue.Push($cleanupChild.FullName) } }
}
Remove-Item -LiteralPath $cleanupTarget -Recurse -Force`;

export function cleanupInvocation({ evidence, workspace, owner, nativeStop, preserveContinuation = true, dependencies = [], requiredArtifacts = [],
  capture = captureCommand, powershell = 'pwsh.exe' }) {
  const context = identity({ evidence, workspace, owner });
  if (typeof preserveContinuation !== 'boolean' || !Array.isArray(dependencies)) throw Error('Cleanup requires a boolean continuation flag and dependency array');
  const registryPath = checkedPath(join(context.evidence, registryName));
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.schemaVersion !== 1 || registry.root !== projectRoot || registry.owner !== context.owner ||
    registry.evidence !== context.evidence || registry.workspace !== context.workspace || !Array.isArray(registry.targets)) throw Error('Cleanup registration identity mismatch');
  const targets = targetsFor(context, registry.targets.filter(target => target.kind === 'scratch').map(target => target.path));
  if (JSON.stringify(targets) !== JSON.stringify(registry.targets)) throw Error('Cleanup registered targets changed');
  const artifacts = [...new Set(artifactPaths([...registry.requiredArtifacts, ...requiredArtifacts], context))];
  const dependencyPaths = dependencies.map(dependency => {
    if (!dependency || typeof dependency.reason !== 'string' || !dependency.reason.trim()) throw Error('Cleanup dependency requires a path and reason');
    return { path: checkedPath(dependency.path), reason: dependency.reason };
  });
  const logDirectory = checkedPath(join(context.evidence, 'invocation-cleanup', randomUUID()));
  mkdirSync(logDirectory, { recursive: true });
  const reportPath = join(logDirectory, 'cleanup.json');
  const stopVerified = nativeStop?.appContainer === true && nativeStop.writersStopped === true && nativeStop.activeProcesses === 0 &&
    (!nativeStop.workspace || resolve(nativeStop.workspace) === context.workspace);
  const report = { schemaVersion: 1, ...context, registry: { path: registryPath, hash: hash(readFileSync(registryPath)) },
    startedAt: new Date().toISOString(), nativeStopVerified: stopVerified, nativeStop: nativeStop ? {
      appContainer: nativeStop.appContainer, writersStopped: nativeStop.writersStopped, activeProcesses: nativeStop.activeProcesses,
      runId: nativeStop.runId ?? null } : null,
    preserveContinuation, dependencies: dependencyPaths, status: 'pending', passed: false, freeBefore: free(context.evidence), archives: [],
    targets: targets.map(target => ({ ...target, before: measured(target.path), deleted: false, keptReason: null })) };
  try {
    for (const target of report.targets) {
      target.keptReason = !stopVerified ? 'native-stop-unverified' : preserveContinuation && target.kind === 'workspace-cache' ? 'continuation-dependency' :
        dependencyPaths.filter(dependency => overlaps(target.path, dependency.path)).map(dependency => dependency.reason).join('; ') || null;
      if (!target.keptReason && target.before.error) throw Error(target.before.error);
    }
    if (!stopVerified) return finish();
    report.sessionRelease = sessionRelease(context);
    if (!report.sessionRelease.verified) {
      for (const target of report.targets) target.keptReason = 'bridge-session-or-leases-unreleased';
      return finish();
    }
    const eligible = report.targets.filter(target => !target.keptReason && target.before.exists);
    if (!eligible.length) { report.status = report.targets.some(target => target.keptReason) ? 'retained' : 'complete'; report.passed = true; return finish(); }
    for (const target of eligible) walk(target.path, () => {});
    const presentArtifacts = [];
    for (const path of artifacts) {
      if (stat(path)) presentArtifacts.push(path);
      else {
        const previous = priorArchive(context, path, logDirectory);
        if (!previous) throw Error('Required cleanup artifact missing: ' + path);
        report.archives.push(previous);
      }
    }
    const snapshots = ['src', 'RESULT.md', '.agent-memory', '.handoff'].map(name => join(context.workspace, name)).filter(path => stat(checkedPath(path)));
    const scratchEvidence = eligible.filter(target => target.kind === 'scratch' && relative(context.evidence, target.path) !== 'provider' ||
      target.path === join(context.workspace, '.bridge-tmp')).map(target => target.path);
    const sources = [...new Set([...snapshots, ...scratchEvidence, ...presentArtifacts])];
    for (const path of sources) walk(path, () => {});
    sources.forEach((path, index) => report.archives.push(archive(path, join(logDirectory, 'archive', String(index)))));
    save(join(logDirectory, 'archive-manifest.json'), { owner, workspace: context.workspace, archives: report.archives });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE)$/i.test(key)));
    for (const [index, target] of report.targets.entries()) {
      if (target.keptReason || !target.before.exists) continue;
      walk(target.path, () => {});
      if (!stat(target.path)?.isDirectory()) throw Error('Cleanup target must be a directory: ' + target.path);
      target.command = capture({ directory: logDirectory, id: 'remove-' + index, executable: powershell,
        argv: ['-NoProfile', '-NonInteractive', '-Command', removeCommand], cwd: realpathSync(projectRoot),
        env: { ...inherited, INVOCATION_CLEANUP_ROOT: projectRoot, INVOCATION_CLEANUP_TARGET: target.path }, timeout: 120000 });
      target.deleted = !stat(checkedPath(target.path));
      if (target.command.exitCode !== 0 || target.command.signal || target.command.error || !target.deleted) {
        target.keptReason = 'remove-failed';
        throw Error('Invocation cleanup removal failed: ' + target.path);
      }
    }
    report.status = report.targets.some(target => target.keptReason) ? 'retained' : 'complete';
    report.passed = true;
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    for (const target of report.targets) if (!target.deleted && !target.keptReason) target.keptReason = 'cleanup-failed';
  }
  return finish();

  function finish() {
    for (const target of report.targets) target.after = measured(target.path);
    report.freeAfter = free(context.evidence);
    report.finishedAt = new Date().toISOString();
    save(reportPath, report);
    return { ...report, reportPath };
  }
}
