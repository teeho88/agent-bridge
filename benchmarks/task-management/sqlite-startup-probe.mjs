import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WindowsSandbox } from '../../next/runtime/src/index.mjs';
import { CodexRpc } from '../../next/adapter-codex/src/rpc.mjs';
import { projectRoot, containedPath, childEnvironment, webHighPreflightAdmission } from './remediation-policy.mjs';
import { profileSnapshot } from './identity-pool.mjs';
import { assessAllowedProfileStorage } from './profile-storage.mjs';
import { resolveRunWorkspace, nativePaths } from './run-workspace.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = containedPath(process.argv[2]);
const freshProvider = existsSync(join(source, 'preflight.json'));
const providerPreflight = freshProvider ? JSON.parse(readFileSync(join(source, 'preflight.json'), 'utf8')) : null;
if (freshProvider && (providerPreflight.passed !== true || providerPreflight.providerInvocations !== 0 ||
    providerPreflight.inferenceStarted !== false || !webHighPreflightAdmission(providerPreflight) ||
    !providerPreflight.nativeStop?.runId)) throw Error('Fresh no-inference provider evidence must PASS before SQLite probe');
const original = freshProvider ? { workspace: providerPreflight.workspace, nativeStop: providerPreflight.nativeStop } :
  JSON.parse(readFileSync(join(source, 'e/001/result.json'), 'utf8'));
const launchPath = freshProvider ? join(source, 'supervisor', original.nativeStop.runId + '.json') :
  join(source, 'e/001/supervisor', original.nativeStop.runId + '.json');
const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
const manifest = freshProvider ? providerPreflight : JSON.parse(readFileSync(join(source, 'protocol.json'), 'utf8'));
const layoutDirectory = process.argv[4] ? containedPath(process.argv[4]) : null;
if (freshProvider && !layoutDirectory) throw Error('Fresh provider SQLite probe requires exact campaign layout');
const layoutManifest = layoutDirectory ? JSON.parse(readFileSync(join(layoutDirectory, 'protocol.json'), 'utf8')) : null;
const pool = layoutDirectory ? JSON.parse(readFileSync(join(layoutDirectory, 'protocol/identity-pool.json'), 'utf8')) : null;
if (layoutManifest && (!layoutManifest.workspaceLayout || layoutManifest.providerHash !== manifest.providerHash ||
    freshProvider && layoutManifest.proxyRoute?.baseUrl !== manifest.proxyRoute?.baseUrl ||
    layoutManifest.codeModeHostHash !== manifest.codeModeHostHash || layoutManifest.nodeHash !== hash(readFileSync(process.execPath))))
  throw Error('Exact-layout probe requires the same frozen provider and Node binaries');
const identities = pool?.entries ?? [original.identity];
const directory = containedPath(process.argv[3]);
mkdirSync(directory);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const report = { schemaVersion: 1, id: randomUUID(), source, directory, startedAt: new Date().toISOString(),
  modelTurns: 0, completedAgentCommands: 0, usage: null, cost: null, inferenceStarted: false, cases: [],
  sources: {}, hashes: {}, passed: false, measurementComplete: false, releasePassed: false };
const boundSources = freshProvider ? ['preflight.json', 'shell-preflight.json',
  'supervisor/' + original.nativeStop.runId + '.json', 'supervisor/' + original.nativeStop.runId + '.receipt'] :
  ['protocol.json', 'e/001/result.json', 'e/001/environment.json',
    'e/001/supervisor/' + original.nativeStop.runId + '.stderr'];
for (const path of boundSources) report.sources[path] = hash(readFileSync(join(source, path)));
for (const path of ['benchmarks/task-management/sqlite-startup-probe.mjs', 'next/runtime/src/sandbox.mjs',
  'next/runtime/src/windows-sandbox.cs', 'next/runtime/src/windows-sandbox.ps1', 'next/adapter-codex/src/rpc.mjs'])
  report.hashes[path] = hash(readFileSync(join(projectRoot, path)));
const provider = join(directory, 'provider');
mkdirSync(provider);
for (const [name, expected] of [['codex.exe', manifest.providerHash], ['codex-code-mode-host.exe', manifest.codeModeHostHash]]) {
  const binaryPath = freshProvider ? join(dirname(providerPreflight.executable), name) : join(source, 'protocol/provider', name);
  const bytes = readFileSync(binaryPath);
  if (hash(bytes) !== expected) throw Error('Historical provider hash mismatch: ' + name);
  copyFileSync(binaryPath, join(provider, name));
  report.hashes[name] = expected;
  for (const identity of identities) {
    const grant = spawnSync('icacls.exe', [join(provider, name), '/grant', '*' + identity.sid + ':RX'], { encoding: 'utf8', windowsHide: true });
    if (grant.status !== 0) throw Error('Probe binary RX grant failed: ' + grant.stderr);
  }
}
const sentinel = join(directory, 'sentinel.txt');
writeFileSync(sentinel, 'SQLite startup probe protected evidence', { flag: 'wx' });
const guard = ['authoritative', 'state', 'evidence', 'evaluator', 'other-workspace'].map(kind => ({ kind, path: sentinel }));
const workspaceRoot = containedPath(join(projectRoot, 'r', report.id.replaceAll('-', '').slice(0, 16)));
mkdirSync(dirname(workspaceRoot), { recursive: true });
mkdirSync(workspaceRoot);
save(join(workspaceRoot, 'owner.json'), { owner: report.id, evidence: directory });
const short = join(workspaceRoot, 'a');
const prefix = join(workspaceRoot, 'deep');
const deep = join(prefix, 'x'.repeat(original.workspace.length - prefix.length - 1));
const cases = layoutManifest ? layoutManifest.workspaceLayout.entries.map(entry => {
  const identity = identities.find(identity => identity.key === entry.key);
  if (!identity) throw Error('Exact-layout probe identity unavailable');
  const [phase, branch, repetition, taskId] = entry.key.split('-');
  const workspace = resolveRunWorkspace(layoutManifest.workspaceLayout, layoutDirectory, phase,
    { branch, repetition: Number(repetition), taskId }, layoutManifest.id);
  nativePaths(workspace, identity.profileName);
  return [entry.key, workspace, identity];
}) : [['short', short, original.identity], ['deep', deep, original.identity]];
try {
  for (const [id, workspace, identity] of cases) {
    const evidence = join(directory, id);
    mkdirSync(evidence);
    const owner = randomUUID();
    if (existsSync(workspace)) throw Error('Refuse to probe an existing workspace');
    save(join(evidence, 'registration.json'), { owner, workspace, evidence, identity, argv: launch.arguments });
    mkdirSync(join(workspace, '.bridge-home/codex'), { recursive: true });
    const runtime = join(workspace, '.bridge-runtime'); mkdirSync(runtime);
    copyFileSync(join(projectRoot, 'benchmarks/task-management/native-stdio.cjs'), join(runtime, 'native-stdio.cjs'));
    const preload = join(runtime, 'native-stdio.cjs').replaceAll('\\', '/');
    const config = '[shell_environment_policy]\ninherit = "all"\n[shell_environment_policy.set]\nNODE_OPTIONS = ' +
      JSON.stringify('--preserve-symlinks --preserve-symlinks-main --require="' + preload + '"') + '\n';
    writeFileSync(join(workspace, '.bridge-home/codex/config.toml'), config, { flag: 'wx' });
    const env = childEnvironment(join(evidence, 'scratch'));
    const sandbox = new WindowsSandbox({ control: join(evidence, 'supervisor'), profileName: identity.profileName,
      profileMode: 'existing', environment: env });
    const row = { id, owner, workspace, workspaceLength: workspace.length, codeHomeLength: join(workspace, '.bridge-home/codex').length,
      identity, sid: identity.sid, profileName: identity.profileName, passed: false, initialized: false, cleanupVerified: false,
      schemaVersion: 1, providerHash: manifest.providerHash, codeModeHostHash: manifest.codeModeHostHash,
      nodeHash: hash(readFileSync(process.execPath)), layoutHash: layoutManifest?.workspaceLayout.reservationHash ?? null,
      modelTurns: 0, inferenceStarted: false };
    report.cases.push(row);
    let transport, rpc, before;
    try {
      before = profileSnapshot({ directory: evidence, id: 'profile-before', identity, env });
      const proof = sandbox.verify({ workspace, protectedFiles: guard, internetClient: launch.internetClient });
      save(join(evidence, 'boundary.json'), proof);
      if (!proof.writerEnabled || proof.steps[0].receipt?.sid !== identity.sid) throw Error('Same-SID native boundary failed');
      const io = sandbox.run({ workspace, arguments: ['-e', `const fs=require('node:fs'),p=require('node:path');const result={cwd:process.cwd(),env:process.env,operations:[]};for(const key of ['CODEX_HOME','TEMP','LOCALAPPDATA']){const root=process.env[key];for(const name of ['startup-probe.sqlite','startup-probe.sqlite-wal','startup-probe.sqlite-shm']){const file=p.join(root,name);try{fs.mkdirSync(root,{recursive:true});fs.writeFileSync(file,'probe',{flag:'wx'});const fd=fs.openSync(file,'r+');fs.ftruncateSync(fd,0);fs.closeSync(fd);fs.renameSync(file,file+'.renamed');fs.unlinkSync(file+'.renamed');result.operations.push({key,file,passed:true});}catch(e){result.operations.push({key,file,passed:false,code:e.code,errno:e.errno,message:e.message});}}}console.log(JSON.stringify(result))`], timeoutMs: 10000 });
      save(join(evidence, 'environment.json'), io);
      if (io.exitStatus !== 0 || !io.writersStopped || io.activeProcesses !== 0) throw Error('Native file probe failed');
      const actual = JSON.parse(io.stdout);
      row.nativeFileOperationsPassed = actual.operations.every(op => op.passed);
      row.pathLengths = Object.fromEntries(['CODEX_HOME', 'TEMP', 'LOCALAPPDATA'].map(key => [key, actual.env[key]?.length]));
      row.environmentConfined = actual.cwd === workspace && ['CODEX_HOME', 'TEMP', 'LOCALAPPDATA'].every(key => {
        try { containedPath(actual.env[key], workspace); return true; } catch { return false; }
      });
      transport = sandbox.start({ workspace, executable: join(provider, 'codex.exe'), arguments: launch.arguments,
        maxSessionMs: 30000, readOnlyExecutable: true });
      rpc = new CodexRpc(transport, { requestTimeoutMs: 15000 });
      rpc.on('failure', () => {});
      save(join(evidence, 'initialize.json'), await rpc.request('initialize', {
        clientInfo: { name: 'phase0_baseline', title: 'Phase 0 baseline', version: '1.0.0' }, capabilities: { experimentalApi: true } }));
      rpc.notify('initialized');
      row.initialized = true;
    } catch (error) { row.error = { name: error.name, code: error.code ?? null, message: error.message, stack: error.stack }; }
    finally {
      if (transport) row.stop = rpc ? await rpc.close() : await transport.stop();
      row.nativeStopVerified = row.stop?.appContainer === true && row.stop.writersStopped === true && row.stop.activeProcesses === 0;
      if (before) {
        try {
          const after = profileSnapshot({ directory: evidence, id: 'profile-after', identity, env });
          row.profileStorage = assessAllowedProfileStorage(before, after, identity);
        } catch (error) { row.profileStorageError = { message: error.message, stack: error.stack }; }
      }
      if (row.stop) {
        row.stderr = readFileSync(row.stop.stderrPath, 'utf8');
        row.stderrHash = hash(readFileSync(row.stop.stderrPath));
        save(join(evidence, 'stop.json'), row.stop);
      }
      if (row.initialized && row.nativeStopVerified) {
        row.artifacts = Object.fromEntries(['boundary', 'environment', 'initialize', 'stop'].map(name => {
          const path = join(evidence, name + '.json');
          return [name, { path, hash: hash(readFileSync(path)) }];
        }));
      }
      if (row.nativeStopVerified || !before) {
        const home = containedPath(join(workspace, '.bridge-home'));
        const files = {};
        const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = containedPath(join(dir, entry.name), workspace);
          if (entry.isSymbolicLink()) throw Error('Probe cleanup forbids links');
          if (entry.isDirectory()) walk(path); else files[relative(workspace, path)] = hash(readFileSync(path));
        } };
        walk(workspace);
        save(join(evidence, 'runtime-files.json'), files);
        for (const name of ['.bridge-home', '.bridge-tmp']) {
          const target = containedPath(join(workspace, name), workspace);
          if (resolve(target) !== join(workspace, name)) throw Error('Probe cleanup target mismatch');
          rmSync(target, { recursive: true, force: true });
        }
        row.cleanupVerified = ['.bridge-home', '.bridge-tmp'].every(name => !existsSync(join(workspace, name)));
        if (layoutManifest) {
          const target = containedPath(workspace);
          if (target !== workspace || !target.startsWith(layoutManifest.workspaceLayout.root + sep)) throw Error('Exact-layout cleanup outside reservation');
          rmSync(target, { recursive: true });
          row.cleanupVerified &&= !existsSync(target);
        }
      }
      row.passed = row.initialized && row.nativeFileOperationsPassed && row.environmentConfined && row.nativeStopVerified &&
        row.cleanupVerified && row.profileStorage?.privateStorageAllowedVerified === true;
      save(join(evidence, 'result.json'), row);
      console.log(JSON.stringify({ id, passed: row.passed, initialized: row.initialized, error: row.error?.message, stderr: row.stderr }));
    }
    if (!row.nativeStopVerified || !row.cleanupVerified || !row.profileStorage?.privateStorageAllowedVerified) throw Error('Probe stop/cleanup/profile hard stop');
  }
  report.pathDifferentialObserved = !layoutManifest && report.cases[0].passed && !report.cases[1].initialized;
  report.passed = layoutManifest ? report.cases.every(row => row.passed) :
    report.cases[0].passed && report.cases.every(row => row.nativeStopVerified && row.cleanupVerified);
} catch (error) { report.error = { message: error.message, stack: error.stack }; }
finally {
  report.historicalEvidenceUnchanged = Object.entries(report.sources).every(([path, expected]) => hash(readFileSync(join(source, path))) === expected);
  report.passed &&= report.historicalEvidenceUnchanged;
  report.finishedAt = new Date().toISOString();
  save(join(directory, 'report.json'), report);
  if (layoutManifest && report.passed) save(join(layoutDirectory, 'workspace-startup-preflight.json'), { schemaVersion: 1, entries: report.cases });
}
process.exitCode = report.passed ? 0 : 2;
