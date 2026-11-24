import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statfsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, campaignRoot, containedPath, childEnvironment } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { diagnosticSchedules } from '../benchmarks/task-management/diagnostic-plan.mjs';
import { validateCampaignBuild } from '../benchmarks/task-management/campaign-build.mjs';
import { validateIdentityPool } from '../benchmarks/task-management/identity-pool.mjs';

if (process.argv.length !== 2 && (process.argv.length !== 4 || process.argv[2] !== '--reuse-identity-registration'))
  throw Error('Usage: node scripts/phase8-g4-new-revision.mjs [--reuse-identity-registration diagnostic/identity-registration.json]');
const reuseRegistration = process.argv[2] ? containedPath(resolve(process.argv[3]), join(campaignRoot, 'diagnostics')) : null;

const id = 'g4-web-high-20261024-' + randomUUID().slice(0, 8);
const directory = containedPath(join(campaignRoot, 'diagnostics', id));
mkdirSync(directory);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const ref = path => ({ path, sha256: hash(path) });
function inventory(root, skip = []) {
  const files = {};
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files[relative(projectRoot, file).replaceAll('\\', '/')] = hash(file);
      else throw Error('Inventory refuses links: ' + file);
    }
  }
  walk(root);
  return files;
}
const historical = join(campaignRoot, 'diagnostics/g4-detached-recovery-20261024-920a7f1c/quota-stop-closure');
const assessment = read(join(historical, 'terminal-assessment.json'));
const protectedFiles = inventory(historical);
const sourceRoots = ['scripts', 'benchmarks/task-management', 'next/runtime/src', 'next/adapter-codex/src', 'packages'];
const sourceInventory = () => Object.assign({}, ...sourceRoots.map(path => inventory(join(projectRoot, path), ['node_modules', 'dist', '.local'])));
const sources = sourceInventory();
const scratch = join(directory, 'scratch');
const plan = { schemaVersion: 1, kind: 'diagnostic-only', formalPermitted: false, includeInFormalMetrics: false,
  provider: 'codex', model: 'chatgpt-web/gpt-6-sol', effort: 'high', budgetMode: 'unbounded', maxTokens: null, maxWeightedTokens: null,
  maxAttemptsPerLogicalSlot: 2, maximumProviderInvocations: 16, watchdogMs: 3600000, stopGraceMs: 60000,
  slots: ['B', 'S'].flatMap(branch => [['small', 1], ['handoff', 1], ['handoff', 2], ['debug', 1]]
    .map(([taskId, stage]) => ({ id: `${branch}-0-${taskId}-${stage}`, branch, repetition: 0, taskId, stage }))) };
diagnosticSchedules(plan);
save('manifest.json', { schemaVersion: 1, id, owner: id, directory, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Preparation command environment only' }] });
save('revision-intent.json', { schemaVersion: 1, id, owner: id, createdAt: new Date().toISOString(),
  purpose: 'Independent G4 diagnostic preparation after SQLite short-workspace remediation',
  plan: ref(join(projectRoot, 'docs/phase8-2-gpt6-web-high-test-plan-20261024.md')),
  acceptance: ref(join(projectRoot, 'docs/phase8-2-g4-preparation-comprehensive-report-20261024.md')),
  historicalReference: { ...ref(join(historical, 'terminal-assessment.json')), round: assessment.round, protocolHash: assessment.protocolHash },
  schedulerAncestry: null, pointer: join(directory, 'round.json'), workspaceRoot: join(projectRoot, 'r'),
  launchPermitted: false, inferencePermitted: false, measurementComplete: false, releasePassed: false, policy: plan });
save('historical-inputs.json', { round: assessment.round, attemptId: assessment.attemptId, protocolHash: assessment.protocolHash,
  files: protectedFiles, references: ['docs/sqlite-startup-layout-20261023-a/protocol.json',
    'docs/sqlite-startup-layout-20261023-a/verification.json', 'docs/phase8-2-g4-sqlite-startup-retry-20261023.md']
    .map(path => ref(join(projectRoot, path))), sources });
save('diagnostic-plan.json', plan);
save('execution-plan.json', { ...plan, owner: id, pointer: join(directory, 'round.json'), status: 'preparation',
  schedulerAncestry: null, automaticSlotLoopPermitted: false, firstSlot: 'B-0-small-1',
  workspaceMapping: plan.slots.map(slot => ({ slot: slot.id, key: `smoke-${slot.branch}-0-${slot.taskId}` })),
  firstTask: 'Use the initial session created by exactly one task start; no duplicate session start.',
  continuation: 'Handoff and rework retain task/workspace/identity and predecessor source; use a fresh session/thread after stop and close.',
  rework: 'Only actual hash-bound host REWORK permits attempt 2. Preserve all FAIL reports, signed observations and publication history. No manufactured failures.',
  stop: 'BLOCKED, infrastructure failure, duplicate initial session, missing FAIL history or unsuccessful attempt 2 stops dependent slots; no replay, attempt 3 or automatic successor.',
  afterEveryAttempt: ['Archive raw/events/settings/usage/source/ledger/verification history/canonical publication',
    'Verify native stop and session/lease release', 'Run fresh acceptance and mechanical audit',
    'Require hash-bound host content review before the next attempt or slot'],
  accounting: { providerStartupsSeparateFromModelTurns: true, usageWithoutEvents: null, costWithoutEvents: null },
  reworkProven: false, g4: 'BLOCKED', g5ToG7: 'CLOSED', measurementComplete: false, releasePassed: false });
const env = childEnvironment(scratch);
const commands = [];
function run(name, argv, timeout = 3600000, executable = process.execPath, extraEnv = {}) {
  console.log(JSON.stringify({ directory, stage: name, status: 'running' }));
  const receipt = captureCommand({ directory, id: name, executable, argv, cwd: projectRoot, env: { ...env, ...extraEnv }, timeout });
  commands.push(receipt);
  console.log(JSON.stringify({ directory, stage: name, exitCode: receipt.exitCode }));
  return receipt;
}
const blockers = [];
const gates = Object.fromEntries(['R0', 'R1', 'R2', 'R3', 'R4', 'R5'].map(key => [key, { status: 'NOT_RUN' }]));
try {
  const scan = run('initial-process-scan', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $owner=[int]$env:G4_OWNER_PID; $caller=Get-CimInstance Win32_Process -Filter "ProcessId=$owner"; if(-not $caller){throw "Missing preparation owner"}; $launcher=[int]$caller.ParentProcessId; $hits=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $owner -and $_.ProcessId -ne $launcher -and $_.CommandLine -and ($_.CommandLine.Contains($env:G4_SCAN_ROOT) -or $_.CommandLine.Contains($env:G4_SCAN_SHORT)) } | Select-Object ProcessId,ParentProcessId,Name); [ordered]@{scanComplete=$true;checkedAt=[DateTimeOffset]::UtcNow.ToString("o");preparationOwner=$owner;preparationLauncher=$launcher;matchingProcesses=$hits}|ConvertTo-Json -Depth 4 -Compress'],
    60000, 'pwsh.exe', { G4_OWNER_PID: String(process.pid), G4_SCAN_ROOT: join(campaignRoot, 'diagnostics'), G4_SCAN_SHORT: join(projectRoot, 'r') + '\\' });
  const processState = scan.exitCode === 0 ? read(scan.stdout.path) : null;
  const databases = [];
  for (const path of Object.keys(protectedFiles).filter(path => path.endsWith('/.agent-memory/memories.db'))) {
    const file = join(projectRoot, path), configPath = join(file, '../config.json'), runtimePath = join(file, '../runtime.db');
    let config = read(configPath);
    if (existsSync(runtimePath)) {
      const db = new DatabaseSync(runtimePath, { readOnly: true });
      try { config = JSON.parse(db.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload); } finally { db.close(); }
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try { databases.push({ path: file, activeSessions: Object.keys(config.activeSessions ?? {}).length,
      currentSessions: Object.keys(config.currentSessions ?? {}).length,
      unreleasedLeases: db.prepare('SELECT COUNT(*) AS count FROM file_leases WHERE released_at IS NULL').get().count }); } finally { db.close(); }
  }
  const fs = statfsSync(directory);
  save('initial-state.json', { checkedAt: new Date().toISOString(), processScan: ref(join(directory, 'initial-process-scan/command.json')),
    processState, databases, historicalWorkspacePresent: databases.length > 0,
    historicalReleaseReceipt: assessment.sessionRelease, currentRevisionSessions: 0, currentRevisionLeases: 0,
    currentRevisionExplanation: 'No campaign or Bridge task has been created.', freeBytes: fs.bavail * fs.bsize,
    retainedProbeFiles: inventory(join(projectRoot, 'docs/sqlite-startup-probe-20261023-a')),
    providerStartups: 0, modelTurns: 0, usage: null, cost: null });
  const clear = processState?.scanComplete && processState.matchingProcesses.length === 0 &&
    databases.every(item => item.activeSessions === 0 && item.currentSessions === 0 && item.unreleasedLeases === 0);
  gates.R0 = { status: clear ? 'PASS' : 'BLOCKED', evidence: ['revision-intent.json', 'historical-inputs.json', 'initial-state.json'] };
  if (!clear) throw Error('Fresh process/database state is not clear; inspect initial-state.json');
  const offline = run('offline-regression', ['scripts/phase8-remediation-check.mjs']);
  const offlineSummary = readFileSync(offline.stdout.path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).at(-1);
  save('offline-results.json', { ...offlineSummary, receipt: ref(join(directory, 'offline-regression/command.json')),
    result: offlineSummary?.directory ? ref(join(offlineSummary.directory, 'result.json')) : null, passed: offline.exitCode === 0 });
  if (offline.exitCode !== 0) blockers.push({ gate: 'R1', reason: 'Fresh offline regression failed', evidence: 'offline-results.json' });
  const build = run('independent-build', ['scripts/phase8-build-inputs.mjs']);
  const summary = JSON.parse(readFileSync(build.stdout.path, 'utf8').trim().split(/\r?\n/).at(-1));
  const buildPath = join(summary.frozen, 'build-manifest.json');
  validateCampaignBuild(read(buildPath));
  save('build-validation.json', { passed: build.exitCode === 0, manifest: ref(buildPath), receipt: ref(join(directory, 'independent-build/command.json')) });
  if (build.exitCode !== 0) throw Error('Independent build or cleanup failed');
  const cli = run('built-cli-integration', ['scripts/phase8-remediation-cli.mjs', directory, '--build-manifest', buildPath]);
  save('native-results.json', { passed: false, offlineCliPassed: cli.exitCode === 0,
    cliReceipt: ref(join(directory, 'built-cli-integration/command.json')), nativeCampaignChecksRun: false,
    reason: 'Native identity, confinement and campaign-layout startup proofs are separate gates.' });
  if (cli.exitCode !== 0) blockers.push({ gate: 'R1', reason: 'Fresh B/S lifecycle integration failed', evidence: 'native-results.json' });
  gates.R1 = { status: blockers.length ? 'BLOCKED' : 'PASS', evidence: ['offline-results.json', 'build-validation.json', 'native-results.json'] };
  if (blockers.length) throw Error('R1 failed; no campaign freeze or provider launch permitted');
  if (reuseRegistration) {
    const previous = read(reuseRegistration);
    if (previous.passed !== true || !previous.report?.path || !previous.pool?.path ||
        hash(previous.report.path) !== previous.report.sha256 ||
        hash(previous.pool.path) !== (previous.pool.hash ?? previous.pool.sha256))
      throw Error('Previous identity registration receipt is missing or changed');
    const report = read(previous.report.path), reusedPool = read(previous.pool.path);
    const provenance = reusedPool.provenance?.path ? read(reusedPool.provenance.path) : null;
    if (report.passed !== true || report.error || report.output?.path !== previous.pool.path ||
        !reusedPool.provenance?.path || hash(reusedPool.provenance.path) !== reusedPool.provenance.hash ||
        !provenance?.diagnosticPlan?.path || hash(provenance.diagnosticPlan.path) !== provenance.diagnosticPlan.hash ||
        JSON.stringify(read(provenance.diagnosticPlan.path)) !== JSON.stringify(plan) ||
        !report.receipts?.some(item => item.id === 'audit' && item.exitCode === 0) ||
        !report.receipts?.some(item => item.id === 'cleanup' && item.exitCode === 0) ||
        Object.entries(report.sourceHashes ?? {}).some(([path, digest]) => hash(path) !== digest))
      throw Error('Reused identity audit, cleanup, plan or sources do not match');
    validateIdentityPool(reusedPool, diagnosticSchedules(plan));
    save('identity-registration.json', { ...previous, reusedFrom: ref(reuseRegistration) });
  } else {
    const pool = run('identity-registration', ['scripts/phase8-register-identity-pool.mjs', '--diagnostic-plan', join(directory, 'diagnostic-plan.json')], 3600000, process.execPath,
      { PHASE8_HOST_LOCALAPPDATA: process.env.LOCALAPPDATA });
    const registration = JSON.parse(readFileSync(pool.stdout.path, 'utf8').trim());
    save('identity-registration.json', { passed: pool.exitCode === 0, report: ref(join(registration.directory, 'registration-report.json')), pool: registration.output });
    if (pool.exitCode !== 0) throw Error('Identity registration failed: ' + registration.error);
  }
  gates.R2 = { status: 'BLOCKED', evidence: ['identity-registration.json'] };
  blockers.push({ gate: 'R2', reason: 'Identity pool registered; fresh confinement/shell/provider proofs still required', evidence: 'identity-registration.json' });
} catch (error) {
  save('preparation-error.json', { message: error.message, stack: error.stack });
  if (!blockers.length) blockers.push({ gate: Object.entries(gates).find(([, value]) => value.status !== 'PASS')?.[0] ?? 'R5', reason: error.message, evidence: 'preparation-error.json' });
} finally {
  const drift = Object.entries(protectedFiles).filter(([path, digest]) => hash(join(projectRoot, path)) !== digest).map(([path]) => path);
  const finalSources = sourceInventory();
  const sourceDrift = [...new Set([...Object.keys(sources), ...Object.keys(finalSources)])].filter(path => sources[path] !== finalSources[path]);
  if (drift.length || sourceDrift.length) blockers.push({ gate: 'R5', reason: 'Input drift detected', evidence: 'final-drift.json' });
  save('final-drift.json', { historicalUnchanged: drift.length === 0, historicalDrift: drift, sourceUnchanged: sourceDrift.length === 0, sourceDrift });
  const cleanup = run('preparation-cleanup', ['scripts/phase8-cleanup-retry.mjs', directory], 180000);
  if (cleanup.exitCode !== 0 || existsSync(scratch)) blockers.push({ gate: 'R5', reason: 'Preparation scratch cleanup incomplete', evidence: 'preparation-cleanup/command.json' });
  const evidence = Object.keys(inventory(directory)).filter(path => !path.endsWith('/diagnostic-ready.json')).map(path => ref(join(projectRoot, path)));
  save('diagnostic-ready.json', { schemaVersion: 1, revision: id, owner: id, createdAt: new Date().toISOString(),
    round: null, protocolHash: null, status: 'BLOCKED', readyForFirstSlot: false, launchPermitted: false,
    gates, blockers, evidence, startupPreflightHash: null, providerStartups: 0, providerThreads: 0, modelTurns: 0,
    usage: null, cost: null, reworkProven: false, g4: 'BLOCKED', g5ToG7: 'CLOSED', measurementComplete: false, releasePassed: false });
  console.log(JSON.stringify({ directory, readyForFirstSlot: false, gates, blockers }));
  process.exitCode = 2;
}
