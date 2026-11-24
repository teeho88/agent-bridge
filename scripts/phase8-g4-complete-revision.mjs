import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectRoot, campaignRoot, containedPath, childEnvironment, requireRootConfinement, webHighPreflightAdmission } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { diagnosticSchedules } from '../benchmarks/task-management/diagnostic-plan.mjs';
import { validateIdentityPool } from '../benchmarks/task-management/identity-pool.mjs';
import { validateCampaignBuild } from '../benchmarks/task-management/campaign-build.mjs';
import { resolveRunWorkspace, validateWorkspaceStartup } from '../benchmarks/task-management/run-workspace.mjs';
import { requireRevisionRoundPointer } from './phase8-g4-round-binding.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const ref = path => ({ path, sha256: hash(path) });
const bound = item => item?.path && hash(item.path) === (item.sha256 ?? item.hash);
const revision = containedPath(resolve(process.argv[2] ?? ''), join(campaignRoot, 'diagnostics'));
const preflightPath = containedPath(resolve(process.argv[3] ?? ''), join(campaignRoot, 'offline'));
const preflight = read(preflightPath);
if (preflight.passed !== true || !webHighPreflightAdmission(preflight) || preflight.inferenceStarted !== false ||
    preflight.providerInvocations !== 0)
  throw Error('G4 R2 blocked: fresh GPT-6 Web High selector, actual thread settings and quota admission must PASS');
const shellPath = join(dirname(preflightPath), 'shell-preflight.json');
const shell = read(shellPath);
const original = read(join(revision, 'diagnostic-ready.json'));
const registration = read(join(revision, 'identity-registration.json'));
const plan = read(join(revision, 'diagnostic-plan.json'));
const policy = read(join(revision, 'execution-plan.json'));
const pool = validateIdentityPool(read(registration.pool.path), diagnosticSchedules(plan));
const buildProof = read(join(revision, 'build-validation.json'));
const offline = read(join(revision, 'offline-results.json'));
const nativeCli = read(join(revision, 'native-results.json'));
const historicalInputs = read(join(revision, 'historical-inputs.json'));
const sourceHash = () => createHash('sha256');
let roundPointerHash = null;
const requireBound = (item, name) => { if (!bound(item)) throw Error('Unbound evidence: ' + name); };
function checkInputs() {
  for (const [path, digest] of Object.entries({ ...historicalInputs.files, ...historicalInputs.sources }))
    if (hash(join(projectRoot, path)) !== digest) throw Error('Historical or source drift: ' + path);
  for (const item of historicalInputs.references) requireBound(item, 'historical reference');
  if (!Array.isArray(original.evidence) || original.evidence.some(item => !bound(item)))
    throw Error('Bootstrap evidence changed before R2');
  if (original.owner !== original.revision || original.gates?.R0?.status !== 'PASS' || original.gates?.R1?.status !== 'PASS' ||
      original.readyForFirstSlot !== false || original.modelTurns !== 0 ||
      policy.owner !== original.owner || policy.model !== plan.model || policy.effort !== plan.effort ||
      !registration.passed || !offline.passed || !nativeCli.offlineCliPassed ||
      !buildProof.passed || !existsSync(join(revision, 'manifest.json'))) throw Error('Initial R0/R1 or identity/build proof not complete');
  requireBound(registration.report, 'identity registration');
  requireBound(registration.pool, 'identity pool');
  requireBound(buildProof.manifest, 'independent build');
  requireBound(offline.receipt, 'offline command');
  requireBound(nativeCli.cliReceipt, 'native CLI command');
  validateCampaignBuild(read(buildProof.manifest.path));
  requireRevisionRoundPointer(join(revision, 'round.json'), roundPointerHash);
}
function checkProvider() {
  const first = pool.entries.find(entry => entry.key === 'smoke-B-0-small');
  if (!first || first.sid !== preflight.sid || first.profileName !== preflight.profileName ||
      preflight.passed !== true || !webHighPreflightAdmission(preflight) ||
      preflight.inferenceStarted !== false || preflight.providerInvocations !== 0 ||
      shell.passed !== true || preflight.shellPreflight?.hash !== hash(shellPath) ||
      shell.bootstrapHash !== hash(join(projectRoot, 'benchmarks/task-management/powershell-cwd.mjs')) ||
      preflight.nodeHash !== hash(process.execPath) || preflight.providerHash !== hash(preflight.executable) ||
      preflight.codeModeHostHash !== hash(join(dirname(preflight.executable), 'codex-code-mode-host.exe')))
    throw Error('Fresh GPT-6 Web High actual selector, quota, shell or identity preflight FAILED; no campaign side effects');
  requireRootConfinement(preflight);
  const audit = read(preflight.scopeAudit.path);
  const scope = read(audit.stdout.path);
  if (hash(preflight.scopeAudit.path) !== preflight.scopeAudit.hash ||
      hash(audit.stdout.path) !== audit.stdout.hash || audit.exitCode !== 0 ||
      scope.sid !== first.sid || scope.passed !== true || scope.matches?.length || scope.failures?.length)
    throw Error('Bound fresh SID scope audit missing');
}

checkInputs();
checkProvider();
const id = 'g4-completion-' + randomUUID().slice(0, 12);
const directory = containedPath(join(revision, id));
mkdirSync(directory);
const scratch = join(directory, 'scratch');
const env = { ...childEnvironment(scratch), PHASE8_HOST_LOCALAPPDATA: process.env.LOCALAPPDATA,
  G4_OWNER_PID: String(process.pid), G4_LAUNCHER_PID: String(process.ppid), G4_REVISION_ROOT: revision };
const save = (name, value) => {
  const file = containedPath(join(directory, name), directory);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return ref(file);
};
save('manifest.json', { schemaVersion: 1, id, owner: original.owner, registeredTemporary: [
  { owner: id, path: scratch, purpose: 'No-inference G4 revision completion command environment' },
] });
const gates = { ...original.gates, R2: { status: 'NOT_RUN' }, R3: { status: 'NOT_RUN' },
  R4: { status: 'NOT_RUN' }, R5: { status: 'NOT_RUN' } };
const blockers = [], receipts = [];
let stage = 'R2', location = null, manifest = null, startupPreflightHash = null;
function run(name, argv, executable = process.execPath, timeout = 3600000) {
  console.log(JSON.stringify({ revision, stage, command: name, status: 'running' }));
  const command = captureCommand({ directory, id: name, argv, executable, timeout, cwd: projectRoot, env });
  receipts.push(command);
  if (command.exitCode !== 0 || command.signal || command.error)
    throw Error(name + ' failed; inspect ' + join(directory, name, 'command.json'));
  return command;
}
const output = command => {
  const lines = readFileSync(command.stdout.path, 'utf8').trim().split(/\r?\n/);
  for (const line of lines.reverse()) { try { return JSON.parse(line); } catch {} }
  throw Error('Command JSON receipt missing: ' + command.id);
};
const record = (name, value) => save(name, value);
function receiptInventory(path) {
  const entries = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'scratch') continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) entries.push(...receiptInventory(full));
    else if (entry.isFile()) entries.push(ref(full));
    else throw Error('Completion evidence contains an unsupported link');
  }
  return entries;
}
const revoke = (target, identities, prefix) =>
  identities.map((identity, index) => ref(join(directory,
    run(prefix + '-' + index, [target, '/remove:g', '*' + identity.sid, '/T', '/C'], 'icacls.exe', 180000).id, 'command.json')));

try {
  checkInputs();
  checkProvider();
  const native = run('native-built-bs', ['scripts/phase8-native-evidence-check.mjs',
    '--identity-pool', registration.pool.path, '--build-manifest', buildProof.manifest.path]);
  const nativeSummary = output(native);
  const nativeReportPath = join(nativeSummary.directory, 'result.json');
  if (read(nativeReportPath).passed !== true) throw Error('Native B/S proof did not PASS');
  record('native-results-final.json', { passed: true, report: ref(nativeReportPath), receipt: ref(join(directory, 'native-built-bs/command.json')) });
  const nativeIdentities = ['smoke-B-0-small', 'smoke-S-0-small'].map(key => pool.entries.find(entry => entry.key === key));
  record('native-grants-cleanup.json', { revocations: revoke(nativeSummary.directory, nativeIdentities, 'native-grants') });
  gates.R2 = { status: 'PASS', evidence: ['native-results-final.json', 'native-grants-cleanup.json',
    'identity-registration.json', preflightPath, shellPath, preflight.scopeAudit.path] };

  stage = 'R3';
  checkInputs();
  const prepared = run('campaign-prepare', ['benchmarks/task-management/compare-run.mjs', 'prepare',
    '--pointer', join(revision, 'round.json'), '--budget-mode', 'unbounded',
    '--diagnostic-plan', join(revision, 'diagnostic-plan.json'),
    '--identity-pool', registration.pool.path, '--build-manifest', buildProof.manifest.path,
    '--confinement-proof', preflightPath, '--shell-preflight', shellPath,
    '--provider-preflight', preflightPath,
    '--baseline-pointer', join(projectRoot, 'docs/phase8-recovery-20261019/validated/baseline.json'),
    '--run-workspace-root', join(projectRoot, 'r')]);
  location = read(join(revision, 'round.json'));
  manifest = read(location.protocol);
  if (manifest.id === historicalInputs.round || manifest.model !== plan.model || manifest.effort !== plan.effort ||
      manifest.kind !== 'diagnostic-only' || manifest.formalPermitted !== false ||
      manifest.workspaceLayout?.entries?.length !== 6 ||
      !existsSync(join(location.directory, 'provider-observation-private.pem')))
    throw Error('Fresh B/S G4 protocol freeze contract failed');
  const { protocolHash, ...body } = manifest;
  if (hashString(JSON.stringify(body)) !== protocolHash) throw Error('Frozen protocol hash mismatch');
  const frozen = join(location.directory, 'protocol');
  const agentsB = readFileSync(join(frozen, 'B-WORKFLOW-AGENTS.md'), 'utf8');
  const agentsS = readFileSync(join(frozen, 'AGENTS.md'), 'utf8');
  if (!agentsB.includes('## Protected Workflow') || !agentsS.includes('## Protected Workflow'))
    throw Error('Frozen B/S protected workflow marker absent');
  const prefix = content => content.slice(0, content.indexOf('## Protected Workflow'));
  if (prefix(agentsB) !== prefix(agentsS)) throw Error('B/S manual lifecycle mismatch');
  record('freeze-review.json', { passed: true, round: manifest.id, protocolHash: manifest.protocolHash,
    manifest: ref(location.protocol), reservation: ref(manifest.workspaceLayout.reservation),
    build: buildProof.manifest, pool: registration.pool,
    agentsB: ref(join(frozen, 'B-WORKFLOW-AGENTS.md')), agentsS: ref(join(frozen, 'AGENTS.md')),
    prepareReceipt: ref(join(directory, prepared.id, 'command.json')), modelTurns: 0 });
  gates.R3 = { status: 'PASS', evidence: ['freeze-review.json', 'round.json'] };
  roundPointerHash = hash(join(revision, 'round.json'));

  stage = 'R4';
  checkInputs();
  const probeDirectory = join(directory, 'startup-probe');
  const probe = run('campaign-startup', ['benchmarks/task-management/sqlite-startup-probe.mjs',
    dirname(preflightPath), probeDirectory, location.directory], process.execPath, 3600000);
  const probeReport = read(join(probeDirectory, 'report.json'));
  if (!probeReport.passed || probeReport.modelTurns !== 0 || probeReport.cases?.length !== 6 ||
      probeReport.cases.some(item => !item.passed || !item.nativeStopVerified || !item.cleanupVerified))
    throw Error('Fresh provider exact-layout SQLite 6/6 startup failed');
  const startupPath = join(location.directory, 'workspace-startup-preflight.json');
  const startup = read(startupPath);
  const verified = manifest.workspaceLayout.entries.map(entry => {
    const identity = pool.entries.find(item => item.key === entry.key);
    const [phase, branch, repetition, taskId] = entry.key.split('-');
    const workspace = resolveRunWorkspace(manifest.workspaceLayout, location.directory, phase,
      { branch, repetition: Number(repetition), taskId }, manifest.id);
    validateWorkspaceStartup(startup.entries.find(item => item.workspace === workspace),
      { layout: manifest.workspaceLayout, workspace, identity,
        providerHash: manifest.providerHash, codeModeHostHash: manifest.codeModeHostHash, nodeHash: manifest.nodeHash });
    if (existsSync(workspace)) throw Error('Native probe left seeded workspace: ' + workspace);
    return { key: entry.key, workspace, passed: true };
  });
  startupPreflightHash = hash(startupPath);
  record('startup-verification.json', { passed: true, cases: verified, proof: ref(startupPath),
    report: ref(join(probeDirectory, 'report.json')) });
  const grants = revoke(join(probeDirectory, 'provider'), pool.entries, 'startup-grants');
  const extraRoot = containedPath(join(projectRoot, 'r', probeReport.id.replaceAll('-', '').slice(0, 16)));
  const extraOwner = read(join(extraRoot, 'owner.json'));
  if (extraOwner.owner !== probeReport.id || extraOwner.evidence !== probeDirectory ||
      readdirSync(extraRoot).some(name => name !== 'owner.json')) throw Error('Auxiliary probe root owner mismatch');
  const auxiliaryReservation = ref(join(extraRoot, 'owner.json'));
  rmSync(extraRoot, { recursive: true });
  if (existsSync(extraRoot)) throw Error('Auxiliary probe root cleanup failed');
  const scopes = pool.entries.map((identity, index) => {
    const receipt = run('final-scope-' + index, ['scripts/phase8-sid-scope.mjs', identity.sid],
      process.execPath, 900000);
    const report = output(receipt);
    if (report.scope?.passed !== true || report.scope.matches?.length || report.scope.failures?.length)
      throw Error('Final SID scope failed: ' + identity.key);
    return { key: identity.key, proof: ref(join(report.directory, 'acl/command.json')) };
  });
  record('probe-cleanup.json', { passed: true, grants, scopes,
    auxiliary: { path: extraRoot, reservation: auxiliaryReservation, removed: true } });
  gates.R4 = { status: 'PASS', evidence: ['startup-verification.json', 'probe-cleanup.json'] };

  stage = 'R5';
  checkInputs();
  for (const [name, digest] of Object.entries(manifest.frozen))
    if (hash(join(frozen, name)) !== digest) throw Error('Frozen file drift: ' + name);
  if (hash(location.protocol) !== hash(join(location.directory, 'protocol.json')))
    throw Error('Protocol path changed during preparation');
  const scan = run('final-process-scan', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $hits=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne [int]$env:G4_OWNER_PID -and $_.ProcessId -ne [int]$env:G4_LAUNCHER_PID -and $_.CommandLine -and $_.CommandLine.Contains($env:G4_REVISION_ROOT) } | Select-Object ProcessId,ParentProcessId,Name); [ordered]@{scanComplete=$true;matchingProcesses=$hits}|ConvertTo-Json -Depth 4 -Compress'],
    'pwsh.exe', 60000);
  const processes = output(scan);
  if (!processes.scanComplete || processes.matchingProcesses?.length)
    throw Error('Native preparation process cleanup not verified');
  gates.R5 = { status: 'PASS', evidence: ['final-review.json'] };
} catch (error) {
  blockers.push({ gate: stage, reason: error.message, evidence: join(directory, 'error.json') });
  if (gates[stage]) gates[stage].status = 'BLOCKED';
  record('error.json', { name: error.name, message: error.message, stack: error.stack });
} finally {
  try { checkInputs(); } catch (error) { blockers.push({ gate: 'R5', reason: error.message }); }
  const unsafe = receipts.filter(item => item.signal || item.error || !Number.isInteger(item.exitCode));
  if (unsafe.length) blockers.push({ gate: 'R5', reason: 'Native process stop unverified', ids: unsafe.map(item => item.id) });
  else {
    const cleanup = captureCommand({ directory, id: 'completion-cleanup', executable: process.execPath,
      argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env, timeout: 180000 });
    if (cleanup.exitCode !== 0 || existsSync(scratch)) blockers.push({ gate: 'R5', reason: 'Completion scratch cleanup incomplete' });
  }
  record('final-review.json', { gates, blockers, commands: receipts.map(item => ({
    id: item.id, exitCode: item.exitCode, signal: item.signal, error: item.error })) });
  const ready = blockers.length === 0 && ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'].every(gate => gates[gate]?.status === 'PASS');
  const initialPlan = join(revision, 'execution-plan.json');
  const archivePlan = join(revision, 'execution-plan.before-' + id + '.json');
  copyFileSync(initialPlan, archivePlan, constants.COPYFILE_EXCL);
  writeFileSync(initialPlan, JSON.stringify({ ...policy, status: ready ? 'ready-for-first-slot' : 'preparation-blocked',
    round: manifest?.id ?? null, protocolHash: manifest?.protocolHash ?? null,
    readyForFirstSlot: ready, runtimePrelaunchRequired: ['web-high-no-local-quota', 'actual-thread-model', 'actual-thread-effort', 'noPaidFallback'],
    launchAuthorizedByPreparation: false }, null, 2) + '\n');
  const updated = { ...original, createdAt: new Date().toISOString(), round: manifest?.id ?? null,
    protocolHash: manifest?.protocolHash ?? null, status: ready ? 'READY' : 'BLOCKED',
    readyForFirstSlot: ready, launchPermitted: ready, gates, blockers,
    startupPreflightHash, providerStartups: preflight.providerProcessInvocations + (manifest ? 6 : 0),
    providerStartupAccounting: { capabilityProcesses: preflight.providerProcessInvocations,
      startupProbeProcesses: manifest ? 6 : 0,
      nativeBSProcesses: 'See native-results-final.json and native command receipts' },
    providerThreads: 1, modelTurns: 0, usage: null, cost: null,
    evidence: [...original.evidence.map(item => item.path === initialPlan ? ref(initialPlan) : item),
      ref(preflightPath), ref(shellPath), ...receiptInventory(directory)],
    g4: 'BLOCKED', g5ToG7: 'CLOSED', measurementComplete: false, releasePassed: false };
  const archive = join(revision, 'diagnostic-ready.before-' + id + '.json');
  copyFileSync(join(revision, 'diagnostic-ready.json'), archive, constants.COPYFILE_EXCL);
  writeFileSync(join(revision, 'diagnostic-ready.json'), JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify({ revision, completion: directory, readyForFirstSlot: ready, gates, blockers }));
  process.exitCode = ready ? 0 : 2;
}

function hashString(value) { return sourceHash().update(value).digest('hex'); }
