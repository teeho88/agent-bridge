import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, existsSync, realpathSync, symlinkSync, unlinkSync, statfsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { projectRoot, campaignRoot, containedPath, createDirectory, childEnvironment } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';

const id = 'build-' + randomUUID().replaceAll('-', '').slice(0, 16), directory = createDirectory(join(campaignRoot, 'offline', id));
const scratch = createDirectory(join(directory, 'scratch')), env = childEnvironment(scratch);
const frozen = createDirectory(join(campaignRoot, 'frozen', id)), packages = ['memory', 'core', 'adapters', 'cli'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = path => sha(readFileSync(path));
const save = (path, value) => writeFileSync(containedPath(path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const free = () => { const fs = statfsSync(directory); return fs.bavail * fs.bsize; };
function inventory(path, prefix = '', result = {}) {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (item.name === 'node_modules') continue;
    const name = prefix + item.name, file = join(path, item.name);
    if (item.isDirectory()) inventory(file, name + '/', result);
    else if (item.isFile()) result[name] = hash(file);
    else throw Error('Unexpected source/build link: ' + file);
  }
  return result;
}
const baselinePointerPath = join(projectRoot, 'docs/phase8-recovery-20261019/validated/baseline.json');
const baselinePointer = json(baselinePointerPath), baselineManifest = json(baselinePointer.protocol);
const baselineFrozen = join(baselinePointer.directory, 'protocol');
function protectedInventory() {
  const result = { baselinePointer: hash(baselinePointerPath), baselineProtocol: hash(baselinePointer.protocol) };
  for (const [path, expected] of Object.entries(baselineManifest.frozen)) {
    const actual = hash(join(baselineFrozen, path));
    if (actual !== expected) throw Error('Protected baseline hash mismatch: ' + path);
    result[path] = actual;
  }
  return result;
}
const protectedBefore = protectedInventory(), links = [], branches = {}, checks = [];
const retained = { owner: id, path: frozen, purpose: 'Independent B/S built runtimes, source snapshots and build provenance for the next freeze; not an operational cohort freeze' };
save(join(directory, 'manifest.json'), { id, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Build sources, temporary dependency junctions and compiler caches' }],
  retained, protectedBefore, node: process.version, nodeHash: hash(process.execPath), compilerHash: hash(join(projectRoot, 'node_modules/typescript/bin/tsc')), freeBefore: free() });
function link(target, destination) {
  containedPath(target); containedPath(destination); mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) throw Error('Dependency junction already exists');
  symlinkSync(realpathSync(target), destination, 'junction'); links.push(destination);
}
function packageRoot(require, name) {
  let entry; try { entry = require.resolve(name + '/package.json'); } catch { entry = require.resolve(name); }
  let location = dirname(entry);
  while (!existsSync(join(location, 'package.json')) || json(join(location, 'package.json')).name !== name) {
    const parent = dirname(location); if (parent === location) throw Error('Cannot resolve installed dependency: ' + name); location = parent;
  }
  return realpathSync(location);
}
function pack(source, destination, visited) {
  source = realpathSync(source);
  const pkg = json(join(source, 'package.json'));
  if (visited.has(pkg.name)) return;
  visited.set(pkg.name, { source, packageHash: hash(join(source, 'package.json')) });
  cpSync(source, join(destination, pkg.name), { recursive: true, dereference: true, filter: path => {
    const parts = relative(source, path).split(/[\\/]/);
    return !parts.includes('node_modules') && (!pkg.name.startsWith('@agent-bridge/') || !parts[0] || ['dist', 'package.json'].includes(parts[0]));
  } });
  const require = createRequire(join(source, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) pack(packageRoot(require, dependency), destination, visited);
}
let error = null;
try {
  for (const branch of ['B', 'S']) {
    const origin = branch === 'B' ? join(projectRoot, 'docs/phase8-recovery-20261019/validated/baseline-source') : projectRoot;
    const stage = createDirectory(join(scratch, branch)), output = createDirectory(join(frozen, branch));
    for (const name of ['package.json', 'tsconfig.base.json']) cpSync(join(origin, name), join(stage, name));
    for (const name of packages) cpSync(join(origin, 'packages', name), join(stage, 'packages', name), { recursive: true, filter: path => {
      const parts = relative(join(origin, 'packages', name), path).split(/[\\/]/);
      return !parts.includes('node_modules') && !parts.includes('dist') && !path.endsWith('.tsbuildinfo');
    } });
    const sourceBefore = inventory(stage);
    cpSync(stage, join(output, 'source'), { recursive: true });
    link(join(projectRoot, 'node_modules'), join(stage, 'node_modules'));
    for (const name of packages) {
      const source = join(stage, 'packages', name), require = createRequire(join(projectRoot, 'packages', name, 'package.json'));
      const pkg = json(join(source, 'package.json'));
      for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const target = dependency.startsWith('@agent-bridge/') ? join(stage, 'packages', dependency.split('/')[1]) : packageRoot(require, dependency);
        link(target, join(source, 'node_modules', dependency));
      }
    }
    for (const name of packages) {
      for (const config of ['tsconfig.json']) {
        const receipt = captureCommand({ directory, id: branch + '-' + name + '-' + config.replaceAll('.', '-'), executable: process.execPath,
          argv: [join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', join(stage, 'packages', name, config)], cwd: stage, env, timeout: 180000 });
        checks.push(receipt); if (receipt.exitCode !== 0) throw Error('Independent build failed: ' + branch + '/' + name + '/' + config);
      }
    }
    const visited = new Map(), runtime = createDirectory(join(output, 'runtime'));
    pack(join(stage, 'packages/cli'), join(runtime, 'node_modules'), visited);
    cpSync(join(projectRoot, 'benchmarks/task-management/native-stdio.cjs'), join(runtime, 'native-stdio.cjs'));
    createDirectory(join(runtime, 'evidence'));
    for (const name of ['agent-evidence-command.cjs', 'agent-verify.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs']) cpSync(join(projectRoot, 'benchmarks/task-management', name), join(runtime, 'evidence', name));
    const runtimeHashes = {};
    function runtimeInventory(path, prefix = '') {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, item.name), name = prefix + item.name;
        if (item.isDirectory()) runtimeInventory(file, name + '/'); else if (item.isFile()) runtimeHashes[name] = hash(file); else throw Error('Packed runtime contains link');
      }
    }
    runtimeInventory(runtime);
    const cliCheck = captureCommand({ directory, id: branch + '-cli-version', executable: process.execPath,
      argv: [join(runtime, 'node_modules/@agent-bridge/cli/dist/index.js'), '--version'], cwd: stage, env });
    checks.push(cliCheck); if (cliCheck.exitCode !== 0) throw Error('Fresh packed CLI did not start: ' + branch);
    branches[branch] = { origin, source: sourceBefore, sourceSnapshot: join(output, 'source'), runtime, runtimeHashes,
      dependencies: Object.fromEntries(visited), provenance: branch === 'B' ? 'Rebuilt from recovered validated/baseline-source; historical revision-5 byte identity is unverified' : 'Fresh build from current package sources' };
  }
} catch (failure) { error = failure.stack; }
finally {
  const protectedAfter = protectedInventory();
  const integrityPassed = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
  const report = { id, passed: !error && integrityPassed && Object.keys(branches).length === 2, error, frozen, branches, checks, protectedEvidenceUnchanged: integrityPassed,
    providerInferenceInvocations: 0, operationalFreeze: false, retained, freeAfterBuild: free() };
  save(join(directory, 'build-report.json'), report);
  save(join(frozen, 'build-manifest.json'), report);
  for (const destination of links.reverse()) { containedPath(destination); unlinkSync(destination); }
  const cleanup = captureCommand({ directory, id: 'cleanup', executable: process.execPath, argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env });
  console.log(JSON.stringify({ directory, frozen, passed: report.passed, cleanupExitCode: cleanup.exitCode, error }));
  process.exitCode = report.passed && cleanup.exitCode === 0 ? 0 : 2;
}
