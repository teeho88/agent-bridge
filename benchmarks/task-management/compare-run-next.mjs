import { comparisonPointer, validateBudget, tokenBudgetExceeded, validateModel, requireActualThreadSettings, requireProviderTurnCompletion, campaignRoot, containedPath, requireRootConfinement, childEnvironment, assessProviderQuota, webHighPreflightAdmission } from './remediation-policy.mjs';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { WindowsSandbox } from '../../next/runtime/src/index.mjs';
import { CodexRpc } from '../../next/adapter-codex/src/rpc.mjs';
import { codexManagedSection } from '../../packages/adapters/dist/codex.js';
import { powershellWorkspaceInstruction, missingPowerShellBootstrap } from './powershell-cwd.mjs';
import { nextInvocation, latestAttempt, slotIdentity, invocationIdentity, evidenceInstruction, lifecycleInstruction, sharedLifecycleAgents } from './comparison-attempts.mjs';

import { canonicalEvidence, validateWorkflowChain } from './comparison-evidence.mjs';
import { validateRollover } from './comparison-rollover.mjs';
import { validateIdentityPool, pooledIdentity, profileSnapshot, scopeEntries, workspaceConfinement, writeCompressedScopeInput } from './identity-pool.mjs';
import { captureCommand } from './command-evidence.mjs';
import { assessAllowedProfileStorage } from './profile-storage.mjs';
import { registerInvocationScratch, cleanupInvocation } from './invocation-cleanup.mjs';
import { validateCampaignBuild } from './campaign-build.mjs';
import { diagnosticSchedules, requireFormalPermission } from './diagnostic-plan.mjs';
import { createWorkspaceLayout, resolveRunWorkspace, validateWorkspaceStartup, nativePaths } from './run-workspace.mjs';
import { proxyConfigArgs } from './provider-route.mjs';
import { campaignRecoveryPolicy, assessCampaignResources, campaignResumeAction } from './campaign-admission.mjs';
import { loadCapacityRecovery } from './capacity-recovery.mjs';
import { activeCompactionReviewPolicy } from './compaction-review-policy.mjs';
import { loadTargetedRecovery, recoverySourceHash, recoveryReviews, recoveryAttemptLimits, applyRecoveryRuntime, writeRecoveryScope } from './g4-targeted-recovery.mjs';
import { createProviderObservationKeys, isProviderLaunchFailure, isCompletedCommandEvent, providerObservationKind,
  signProviderObservation, signCompletedCommandObservation, providerObservationBinding, verifyProviderObservation } from './provider-observations.mjs';

const revisionSources = { 'compare-run.mjs': 'compare-run-next.mjs', 'compare-audit.mjs': 'compare-audit-next.mjs' };
import { createInvocationTelemetry } from './invocation-telemetry.mjs';
const base = dirname(fileURLToPath(import.meta.url)), root = resolve(base, '../..');
const pointer = comparisonPointer();
const phase = process.argv[2];
const option = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + name);
  return resolve(process.argv[index + 1]);
};
const budgetIndex = process.argv.indexOf('--budget-mode');
const budgetMode = budgetIndex < 0 ? 'capped' : process.argv[budgetIndex + 1];
if (!['capped', 'unbounded'].includes(budgetMode)) throw new Error('Expected --budget-mode capped|unbounded');
let confinementProofPath = null;
if (phase === 'prepare' && budgetMode === 'unbounded') {
  containedPath(pointer, campaignRoot);
  if (!process.argv.includes('--pointer')) throw new Error('Unbounded runs require a separate cohort --pointer');
  const proofPath = option('--confinement-proof');
  const proof = proofPath ? JSON.parse(readFileSync(proofPath, 'utf8')) : null;
  if (proof?.passed !== true || proof.root !== root || !(proof.provisioningWritesConfined === true || proof.provisioningBoundaryVerified === true) || proof.providerEnvironmentVerified !== true || proof.nativeStopVerified !== true) throw new Error('Current root confinement and provisioning proof required before unbounded freeze');
  requireRootConfinement(proof);
  confinementProofPath = proofPath;
}
if (!['prepare', 'smoke', 'formal', 'report'].includes(phase)) throw new Error('Usage: compare-run.mjs prepare|smoke|formal|report');
if (process.argv.includes('--run-workspace-root') && phase !== 'prepare') throw Error('--run-workspace-root is accepted only at prepare');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
function inventory(directory, exclude = []) {
  const result = {};
  function walk(path) {
    for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
      const name = path ? path + '/' + entry.name : entry.name;
      if (exclude.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) result[name] = hash(readFileSync(join(directory, name)));
      else throw new Error('Unexpected link in snapshot: ' + name);
    }
  }
  walk(''); return result;
}
function verify(directory, expected) {
  const actual = inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Frozen inventory differs: ' + directory);
}
function command(args, cwd, prefix, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (prefix) { writeFileSync(prefix + '.stdout.log', result.stdout ?? ''); writeFileSync(prefix + '.stderr.log', result.stderr ?? ''); }
  return { exitStatus: result.status, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function acl(file, sid, owner, env, inherit = false) {
  const flags = inherit ? '(OI)(CI)' : '';
  const target = process.platform === 'win32' && !file.startsWith('\\\\?\\') ? '\\\\?\\' + resolve(file) : file;
  const result = spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', '*' + owner + ':' + flags + 'F', '*' + sid + ':' + flags + 'RX'], { cwd: dirname(file), env, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Read-only input ACL failed: ' + (result.error?.stack ?? result.stderr ?? result.stdout ?? 'exit ' + result.status));
}
function nativeReceipt(evidence, runId) {
  const prefix = join(evidence, 'supervisor', runId), request = json(prefix + '.json');
  if (request.receipt !== prefix + '.receipt' || request.stdout !== prefix + '.stdout') throw new Error('Native receipt path binding mismatch');
  if (!existsSync(prefix + '.receipt')) return null;
  const receipt = json(prefix + '.receipt');
  if (receipt.appContainer !== true || receipt.writersStopped !== true || receipt.activeProcesses !== 0) return null;
  return { ...receipt, runId, stdoutPath: prefix + '.stdout', stderrPath: prefix + '.stderr' };
}
const cli = '.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js';
const slotSchedule = (repetition, branch = 'B') => [['small', 1], ['debug', 1], ['multi', 1], ['handoff', 1], ['handoff', 2]]
  .map(([taskId, stage]) => ({ id: branch + '-' + repetition + '-' + taskId + '-' + stage, branch, repetition, taskId, stage }));
const schedules = {
  smoke: ['B', 'S'].flatMap(branch => [slotSchedule(0, branch)[0], ...slotSchedule(0, branch).filter(slot => slot.taskId === 'handoff')]),
  formal: [1, 2, 3, 4, 5].flatMap(repetition => (repetition % 2 ? ['B', 'S'] : ['S', 'B']).flatMap(branch => slotSchedule(repetition, branch))),
};
if (phase === 'smoke' || phase === 'formal') {
  const shellPath = join(json(pointer).directory, 'protocol/shell-preflight.json');
  const shell = existsSync(shellPath) ? json(shellPath) : null;
  if (shell?.passed !== true || shell.compatibility !== 'powershell-workspace-psdrive-v1' || shell.bootstrapHash !== hash(readFileSync(join(base, 'powershell-cwd.mjs')))) throw new Error('Native shell cwd preflight must pass for the current bootstrap before any inference; diagnose infrastructure in a new evidence file/round');
}
const diagnosticPlanPath = option('--diagnostic-plan');
if (diagnosticPlanPath && phase !== 'prepare') throw Error('--diagnostic-plan is accepted only at prepare; subsequent calls use the frozen plan');
const diagnosticPlan = diagnosticPlanPath ? json(containedPath(diagnosticPlanPath, join(campaignRoot, 'diagnostics'))) : null;
if (diagnosticPlan && budgetMode !== 'unbounded') throw Error('Diagnostics require unbounded policy');
if (diagnosticPlan) containedPath(pointer, join(campaignRoot, 'diagnostics'));
const selectedSchedules = diagnosticPlan ? diagnosticSchedules(diagnosticPlan) : schedules;
if (phase === 'prepare') {
  const poolPath = option('--identity-pool');
  const identityPool = budgetMode === 'unbounded' ? validateIdentityPool(poolPath ? json(containedPath(poolPath)) : null, selectedSchedules) : null;
  const buildPath = option('--build-manifest');
  const build = buildPath ? json(containedPath(buildPath)) : null;
  if (budgetMode === 'unbounded' && !build) throw Error('Fresh independent B/S --build-manifest required');
  if (build) {
    validateCampaignBuild(build);
    if (realpathSync(build.branches.B.origin) !== realpathSync(join(root, 'docs/phase8-recovery-20261019/validated/baseline-source')) ||
        realpathSync(build.branches.S.origin) !== root) throw Error('Build origins must remain recovered baseline B and current candidate S');
  }
  const shellProofPath = option('--shell-preflight') ?? join(root, 'docs/phase8-2-20261018/shell-preflight-fixed-v2.json');
  const shellProof = existsSync(shellProofPath) ? json(shellProofPath) : null;
  if (shellProof?.passed !== true || shellProof.bootstrapHash !== hash(readFileSync(join(base, 'powershell-cwd.mjs')))) throw new Error('Current PowerShell cwd preflight required before freeze');
  const providerProofPath = option('--provider-preflight');
  if (!providerProofPath) throw new Error('Fresh GPT-6 Web High --provider-preflight required');
  const preflight = json(providerProofPath);
  if (!preflight.passed || !webHighPreflightAdmission(preflight))
    throw new Error('Verified GPT-6 Web High preflight with actual thread settings required');
  if (preflight.providerInvocations !== 0 || preflight.inferenceStarted !== false || preflight.noPaidFallback !== true || preflight.nodeHash !== hash(readFileSync(process.execPath)) || preflight.providerHash !== hash(readFileSync(preflight.executable)) || preflight.codeModeHostHash !== hash(readFileSync(join(dirname(preflight.executable), 'codex-code-mode-host.exe')))) throw new Error('Provider preflight binary/budget binding mismatch');
  if (existsSync(pointer)) {
    if (process.argv[3] !== '--new-round') throw new Error('Round pointer exists; explicit --new-round required');
    const prior = json(pointer), priorState = json(join(prior.directory, 'state.json'));
    const priorManifest = json(prior.protocol), reviews = {}, ledgerHashes = {};
    const { protocolHash: priorHash, ...priorBody } = priorManifest;
    if (hash(JSON.stringify(priorBody)) !== priorHash) throw new Error('Prior fingerprint mismatch');
    for (const phase of ['smoke', 'formal']) {
      const reviewPath = join(prior.directory, phase + '-review.json');
      const ledgerPath = join(prior.directory, phase === 'formal' ? 'content-review.json' : 'smoke-content-review.json');
      if (existsSync(reviewPath) && existsSync(ledgerPath)) {
        reviews[phase] = { review: json(reviewPath), ledger: json(ledgerPath) };
        ledgerHashes[phase] = hash(readFileSync(ledgerPath));
      }
    }
    validateRollover(prior, priorState, priorManifest, reviews, ledgerHashes, row => nativeReceipt(row.evidence, row.launch.runId));
    for (const row of priorState.slots.filter(row => row.launch)) {
      const receipt = nativeReceipt(row.evidence, row.launch.runId);
      if (!receipt) throw new Error('Prior native receipt missing');
      const memory = join(row.evidence, 'agent-memory/memories.db');
      const db = new DatabaseSync(memory, { readOnly: true });
      try {
        if (db.prepare('SELECT count(*) AS n FROM file_leases WHERE released_at IS NULL').get().n !== 0) throw new Error('Prior leases unresolved');
      } finally { db.close(); }
      const config = json(join(row.workspace, '.agent-memory/config.json'));
      if (config.currentSessions?.codex) throw new Error('Prior session unresolved');
    }
    const history = join(dirname(pointer), 'round-history', prior.protocolHash + '.json');
    mkdirSync(dirname(history), { recursive: true });
    if (existsSync(history)) {
      if (!readFileSync(history).equals(readFileSync(pointer))) throw new Error('Prior round history differs');
    } else writeFileSync(history, readFileSync(pointer), { flag: 'wx' });
  }
  const directory = budgetMode === 'unbounded' ? join(dirname(pointer), 'rounds', randomUUID()) : join(root, 'next/.local/phase8-comparisons', randomUUID()), frozen = join(directory, 'protocol');
  mkdirSync(frozen, { recursive: true });
  const observationKeys = createProviderObservationKeys();
  writeFileSync(join(directory, 'provider-observation-private.pem'), observationKeys.privateKey, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(frozen, 'provider-observation-public.pem'), observationKeys.publicKey, { flag: 'wx' });
  if (confinementProofPath) copyFileSync(confinementProofPath, join(frozen, 'confinement-proof.json'));
  if (identityPool) save(join(frozen, 'identity-pool.json'), identityPool);
  if (diagnosticPlan) copyFileSync(diagnosticPlanPath, join(frozen, 'diagnostic-plan.json'));
  for (const name of ['fixtures', 'controls']) cpSync(join(base, name), join(frozen, name), { recursive: true });
  for (const name of ['PROTOCOL.md', 'verify.mjs', 'control-outcome.mjs', 'compare-run.mjs', 'compare-audit.mjs', 'compare-report.mjs', 'compare-review.mjs', 'comparison.mjs', 'comparison-attempts.mjs', 'comparison-rollover.mjs', 'comparison-evidence.mjs', 'g4-targeted-recovery.mjs', 'provider-observations.mjs', 'remediation-policy.mjs', 'profile-storage.mjs', 'identity-pool.mjs', 'invocation-cleanup.mjs', 'campaign-build.mjs', 'command-evidence.mjs', 'provider-preflight.mjs', 'shell-preflight.mjs', 'native-stdio.cjs', 'powershell-cwd.mjs']) copyFileSync(join(base, revisionSources[name] ?? name), join(frozen, name));
  copyFileSync(join(base, 'invocation-telemetry.mjs'), join(frozen, 'invocation-telemetry.mjs'));
  copyFileSync(join(base, 'diagnostic-plan.mjs'), join(frozen, 'diagnostic-plan.mjs'));
  copyFileSync(join(base, 'run-workspace.mjs'), join(frozen, 'run-workspace.mjs'));
  copyFileSync(join(base, 'provider-route.mjs'), join(frozen, 'provider-route.mjs'));
  copyFileSync(join(base, 'campaign-admission.mjs'), join(frozen, 'campaign-admission.mjs'));
  copyFileSync(join(base, 'capacity-recovery.mjs'), join(frozen, 'capacity-recovery.mjs'));
  copyFileSync(shellProofPath, join(frozen, 'shell-preflight.json'));
  copyFileSync(providerProofPath, join(frozen, 'provider-preflight.json'));
  const baselinePointerPath = option('--baseline-pointer') ?? join(root, 'docs/phase0-20261016/round.json');
  const baselinePointer = json(baselinePointerPath);
  const baselineManifest = json(baselinePointer.protocol);
  const baselineFrozen = join(baselinePointer.directory, 'protocol');
  verify(baselineFrozen, baselineManifest.frozen);
  cpSync(build ? containedPath(build.branches.B.runtime) : join(baselineFrozen, 'bridge-runtime'), join(frozen, 'baseline-runtime'), { recursive: true });
  copyFileSync(join(baselineFrozen, 'AGENTS.md'), join(frozen, 'BASELINE-AGENTS.md'));
  const production = join(frozen, 'bridge-runtime/node_modules'), visited = new Set();
  function pack(source) {
    source = realpathSync(source);
    const pkg = json(join(source, 'package.json'));
    if (visited.has(pkg.name)) return;
    visited.add(pkg.name);
    const destination = join(production, pkg.name);
    cpSync(source, destination, { recursive: true, dereference: true, filter: path => {
      const parts = relative(source, path).split(/[\\/]/);
      return !parts.includes('node_modules') && (!pkg.name.startsWith('@agent-bridge/') || !parts[0] || ['dist', 'package.json'].includes(parts[0]));
    } });
    const require = createRequire(join(source, 'package.json'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      let entry;
      try { entry = require.resolve(dependency + '/package.json'); } catch { entry = require.resolve(dependency); }
      let location = dirname(entry);
      while (!existsSync(join(location, 'package.json')) || json(join(location, 'package.json')).name !== dependency) {
        const parent = dirname(location); if (parent === location) throw new Error('Missing package ' + dependency); location = parent;
      }
      pack(location);
    }
  }
  if (build) {
    cpSync(containedPath(build.branches.S.runtime), join(frozen, 'bridge-runtime'), { recursive: true });
    for (const name of Object.keys(build.branches.S.dependencies)) visited.add(name);
    copyFileSync(buildPath, join(frozen, 'build-manifest.json'));
  } else pack(join(root, 'packages/cli'));
  copyFileSync(join(base, 'native-stdio.cjs'), join(frozen, 'bridge-runtime/native-stdio.cjs'));
  for (const runtime of ['baseline-runtime', 'bridge-runtime']) {
    const helpers = join(frozen, runtime, 'evidence'); mkdirSync(helpers, { recursive: true });
    for (const name of ['agent-evidence-command.cjs', 'agent-verify.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs']) copyFileSync(join(base, name), join(helpers, name));
    writeFileSync(join(helpers, 'provider-observation-public.pem'), observationKeys.publicKey, { flag: 'wx' });
  }
  const provider = join(frozen, 'provider'); mkdirSync(provider);
  for (const name of ['codex.exe', 'codex-code-mode-host.exe']) copyFileSync(join(dirname(preflight.executable), name), join(provider, name));
  writeFileSync(join(frozen, 'AGENTS.md'), codexManagedSection({ hooked: false }).replaceAll('agent-bridge ', 'node ' + cli + ' '));
  writeFileSync(join(frozen, 'B-WORKFLOW-AGENTS.md'), sharedLifecycleAgents(readFileSync(join(frozen, 'BASELINE-AGENTS.md'), 'utf8'), readFileSync(join(frozen, 'AGENTS.md'), 'utf8')));
  copyFileSync(join(root, 'pnpm-lock.yaml'), join(frozen, 'pnpm-lock.yaml'));
  const harnessSources = {};
  for (const folder of ['next/runtime/src', 'next/adapter-codex/src'])
    for (const [path, digest] of Object.entries(inventory(join(root, folder)))) harnessSources[folder + '/' + path] = digest;
  for (const path of ['scripts/phase8-profile-snapshot.ps1', 'scripts/phase8-sid-scope.ps1']) harnessSources[path] = hash(readFileSync(join(root, path)));
  const roundId = randomUUID();
  const workspaceLayout = budgetMode === 'unbounded' ? createWorkspaceLayout({ root: option('--run-workspace-root') ?? join(root, 'r'),
    directory, roundId, schedules: selectedSchedules, identities: identityPool }) : null;
  const manifest = { schemaVersion: 2, id: roundId, createdAt: new Date().toISOString(), directory,
    telemetryContract: { kind: 'durable-invocation-journal-v1', file: 'invocation-telemetry.jsonl', heartbeatMs: 1000,
      usageFinality: 'bound-final-answer-usage-completed-turn', timing: 'monotonic-checkpoints-and-verified-stop' },
    ...(workspaceLayout ? { workspaceLayout } : {}),
    ...(diagnosticPlan ? { kind: 'diagnostic-only', formalPermitted: false, includeInFormalMetrics: false,
      diagnosticPlan: { path: diagnosticPlanPath, hash: hash(readFileSync(diagnosticPlanPath)) } } : {}),
    archiveManifestHash: baselineManifest.archiveManifestHash ?? json(join(root, 'docs/phase0-20261016/recovery.json')).manifestId,
    codeProvenance: 'B: ' + (baselineManifest.codeProvenance ?? 'immutable Phase 0 revision 5 runtime') + '; S: current built runtime',
    baselineProvenance: { pointer: baselinePointerPath, pointerHash: hash(readFileSync(baselinePointerPath)), manifestHash: hash(readFileSync(baselinePointer.protocol)) },
    ...(build ? { buildProvenance: { path: buildPath, hash: hash(readFileSync(buildPath)), id: build.id,
      branches: Object.fromEntries(['B', 'S'].map(branch => [branch, { origin: build.branches[branch].origin, provenance: build.branches[branch].provenance }])) } } : {}),
    baselineProtocolHash: baselineManifest.protocolHash, candidate: 'Phase 1-8.1 current build, full mode/manual lifecycle; routing and reusable-memory opt-ins disabled',
    model: 'chatgpt-web/gpt-6-sol', effort: 'high', node: process.version, nodeHash: hash(readFileSync(process.execPath)),
    providerHash: preflight.providerHash, codeModeHostHash: preflight.codeModeHostHash, proxyRoute: preflight.proxyRoute,
    network: 'appcontainer-internet-client', runtimeMode: 'full', lifecycle: 'manual, hooks disabled', evidenceContract: 'immutable-command-v1', workflowContract: 'g4-lifecycle-report-history-v1',
    providerObservations: { scheme: 'ed25519-completed-command-v2', publicKeyHash: hash(observationKeys.publicKey) },
    cachePolicy: 'Clear provider home/temp and per-attempt scratch after proven stop/session close/lease release; preserve source, Bridge metadata and handoff for continuation',
    frozen: inventory(frozen), harnessSources,
    smoke: selectedSchedules.smoke,
    schedule: selectedSchedules.formal, recoveryPolicy: { ...campaignRecoveryPolicy }, maxAttempts: 2, maxAttemptMs: budgetMode === 'unbounded' ? 3600000 : 600000, nativeStopGraceMs: 60000,
    budgetMode, maxTokens: budgetMode === 'unbounded' ? null : 1000000, maxWeightedTokens: budgetMode === 'unbounded' ? null : 200000, outputTokenWeight: 8, nativeCompatibility: 'file-backed synchronous stdio; test isolation none; powershell-workspace-psdrive-v1 bootstrap in every PowerShell call, both branches' };
  manifest.protocolHash = hash(JSON.stringify(manifest));
  save(join(directory, 'protocol.json'), manifest);
  save(pointer, { directory, protocolHash: manifest.protocolHash, protocol: join(directory, 'protocol.json') });
  console.log(JSON.stringify({ phase, directory, protocolHash: manifest.protocolHash, productionPackages: visited.size }));
  process.exit(0);
}
const location = json(pointer), directory = location.directory, frozen = join(directory, 'protocol'), manifest = json(location.protocol);
const { protocolHash, ...body } = manifest;
if (hash(JSON.stringify(body)) !== protocolHash || protocolHash !== location.protocolHash) throw new Error('Protocol fingerprint mismatch');
const capacityRecovery = loadCapacityRecovery(directory, manifest, root);
const recovery = loadTargetedRecovery(directory, manifest, root) ?? capacityRecovery;
if (manifest.frozen['diagnostic-plan.mjs'] && manifest.frozen['diagnostic-plan.mjs'] !== hash(readFileSync(join(base, 'diagnostic-plan.mjs')))) throw Error('Diagnostic policy helper changed after freeze');
if (phase === 'formal') requireFormalPermission(manifest);
if (manifest.diagnosticPlan) {
  if (manifest.kind !== 'diagnostic-only' || manifest.formalPermitted !== false || manifest.includeInFormalMetrics !== false ||
      manifest.diagnosticPlan.hash !== hash(readFileSync(join(frozen, 'diagnostic-plan.json'))) ||
      manifest.frozen['diagnostic-plan.mjs'] !== hash(readFileSync(join(base, 'diagnostic-plan.mjs')))) throw Error('Diagnostic plan/policy binding mismatch');
  const expected = diagnosticSchedules(json(join(frozen, 'diagnostic-plan.json')));
  if (JSON.stringify({ smoke: manifest.smoke, formal: manifest.schedule }) !== JSON.stringify(expected)) throw Error('Frozen diagnostic schedule differs');
  if (phase === 'smoke') {
    const readinessPath = containedPath(join(dirname(pointer), 'diagnostic-ready.json'), join(campaignRoot, 'diagnostics'));
    const ready = json(readinessPath);
    if (ready.readyForFirstSlot !== true || ready.launchPermitted !== true ||
        ready.status !== 'READY' || ready.round !== manifest.id || ready.protocolHash !== protocolHash ||
        !Array.isArray(ready.blockers) || ready.blockers.length !== 0 ||
        ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'].some(gate => ready.gates?.[gate]?.status !== 'PASS') ||
        !Array.isArray(ready.evidence) || !ready.evidence.length ||
        ready.evidence.some(item => !item.path || hash(readFileSync(containedPath(item.path))) !== item.sha256) ||
        ready.startupPreflightHash !== hash(readFileSync(join(directory, 'workspace-startup-preflight.json'))) ||
        ready.modelTurns !== 0)
      throw Error('Fresh hash-bound G4 diagnostic readiness R0-R5 required before any model turn');
  }
}
if (hash(readFileSync(process.execPath)) !== manifest.nodeHash) throw Error('Executing Node changed after freeze');
if (manifest.telemetryContract?.kind !== 'durable-invocation-journal-v1' || manifest.telemetryContract.heartbeatMs !== 1000 ||
    manifest.telemetryContract.file !== 'invocation-telemetry.jsonl' || manifest.telemetryContract.timing !== 'monotonic-checkpoints-and-verified-stop' ||
    manifest.telemetryContract.usageFinality !== 'bound-final-answer-usage-completed-turn') throw Error('Frozen telemetry contract mismatch');
if (manifest.recoveryPolicy && recoverySourceHash('campaign-admission.mjs', manifest.frozen['campaign-admission.mjs'], recovery) !== hash(readFileSync(join(base, 'campaign-admission.mjs')))) throw Error('Campaign admission helper changed after freeze');
validateBudget(manifest);
if (manifest.budgetMode === 'unbounded') requireRootConfinement(json(join(frozen, 'confinement-proof.json')));
validateModel({ provider: manifest.provider ?? 'codex', model: manifest.model, effort: manifest.effort });
verify(frozen, manifest.frozen);
for (const [path, expected] of Object.entries(manifest.harnessSources)) if (hash(readFileSync(join(root, path))) !== expected) throw new Error('Native harness source drift');
if (hash(readFileSync(fileURLToPath(import.meta.url))) !== recoverySourceHash('compare-run.mjs', manifest.frozen['compare-run.mjs'], recovery)) throw new Error('Runner changed after freeze');
if (manifest.frozen['run-workspace.mjs'] && hash(readFileSync(join(base, 'run-workspace.mjs'))) !== manifest.frozen['run-workspace.mjs']) throw Error('Workspace allocator changed after freeze');
if (manifest.frozen['provider-route.mjs'] !== hash(readFileSync(join(base, 'provider-route.mjs')))) throw Error('Proxy route helper changed after freeze');
for (const name of ['invocation-telemetry.mjs', 'powershell-cwd.mjs', 'comparison-attempts.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs', 'comparison-rollover.mjs', 'remediation-policy.mjs', 'identity-pool.mjs', 'command-evidence.mjs', ...['profile-storage.mjs', 'invocation-cleanup.mjs', 'campaign-build.mjs'].filter(name => manifest.frozen[name])]) if (hash(readFileSync(join(base, name))) !== recoverySourceHash(name, manifest.frozen[name], recovery)) throw new Error('Harness helper changed after freeze: ' + name);
const identityPool = manifest.budgetMode === 'unbounded' ? validateIdentityPool(json(join(frozen, 'identity-pool.json')), { smoke: manifest.smoke, formal: manifest.schedule }) : null;
const statePath = join(directory, 'state.json');
const state = existsSync(statePath) ? json(statePath) : { schemaVersion: 1, protocolHash, status: 'prepared', slots: [], failures: [] };
if (state.protocolHash !== protocolHash) throw new Error('State protocol mismatch');
function summarize() {
  const rows = state.slots.filter(row => row.phase === 'formal');
  const sum = field => rows.length && rows.every(row => Number.isFinite(row.usage?.[field])) ? rows.reduce((total, row) => total + row.usage[field], 0) : null;
  const report = { schemaVersion: 1, protocolHash, directory, status: state.status, formalCompleted: new Set(rows.filter(row => row.status === 'finished').map(slotIdentity)).size,
    expectedFormalInvocations: manifest.diagnosticPlan ? 0 : 50, smokeCompleted: new Set(state.slots.filter(row => row.phase === 'smoke' && row.status === 'finished').map(slotIdentity)).size,
    ...(manifest.diagnosticPlan ? { kind: 'diagnostic-only', formalPermitted: false, measurementComplete: false, releasePassed: false,
      diagnosticCompleted: new Set(state.slots.filter(row => row.phase === 'smoke' && row.status === 'finished').map(slotIdentity)).size,
      expectedDiagnosticSlots: manifest.smoke.length } : {}),
    providerInvocations: state.slots.filter(row => row.launch).length + (state.infrastructureFailures?.length ?? 0) + (state.hostInfrastructureFailures?.length ?? 0),
    retainedInfrastructureFailures: (state.infrastructureFailures?.length ?? 0) + (state.hostInfrastructureFailures?.length ?? 0), acceptancePassed: rows.filter(row => row.acceptance?.passed).length,
    usage: Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'uncachedInputTokens'].map(field => [field, sum(field)])),
    cost: null, baselineComplete: false, reviewStatus: 'pending-host-content-review', failures: state.failures };
  save(join(directory, 'report.json'), report); return report;
}
if (phase === 'report') { console.log(JSON.stringify(summarize())); process.exit(0); }
if (state.slots.some(slot => !['finished', 'preflight_failed'].includes(slot.status) &&
    !capacityRecovery?.predecessorIds.includes(slot.id) && !capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.capacityFailure && !capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.startupFailure && !capacityRecovery?.formalDisconnectRecovery?.entries?.[slot.id]?.hostInterruptedFailure && slot.id !== capacityRecovery?.interruptedRecovery?.predecessorId)) throw new Error('Unresolved invocation; no replay');
if (state.status === 'infrastructure_failed' && !capacityRecovery?.predecessorIds.includes(state.slots.at(-1)?.id) && !capacityRecovery?.formalDisconnectRecovery?.entries?.[state.slots.at(-1)?.id]?.capacityFailure && !capacityRecovery?.formalDisconnectRecovery?.entries?.[state.slots.at(-1)?.id]?.startupFailure && !capacityRecovery?.formalDisconnectRecovery?.entries?.[state.slots.at(-1)?.id]?.hostInterruptedFailure &&
    state.slots.at(-1)?.id !== capacityRecovery?.interruptedRecovery?.predecessorId &&
    state.slots.at(-1)?.id !== capacityRecovery?.cancelledRecovery?.predecessorId) throw new Error('Round stopped by infrastructure failure; no replay');
if (phase === 'formal') {
  const smoke = json(join(directory, 'smoke-review.json'));
  const ledgerPath = join(directory, 'smoke-content-review.json'), ledger = json(ledgerPath);
  const ready = nextInvocation(manifest.smoke, state.slots.filter(row => row.phase === 'smoke'), ledger.rows, recoveryAttemptLimits(manifest.maxAttempts, recovery));
  if (smoke.protocolHash !== protocolHash || ledger.protocolHash !== protocolHash || smoke.reviewLedgerHash !== hash(readFileSync(ledgerPath)) || smoke.verdict !== 'pass' || ready.action !== 'complete') throw new Error('Successful reviewed smoke required');
}
const authPath = join(process.env.USERPROFILE, '.codex/auth.json');
async function invocation(slot, attempt, previous, feedback) {
  const record = { ...slot, id: invocationIdentity(slot.id, attempt), slotId: slot.id, phase, attempt, attemptId: randomUUID(), startedAt: new Date().toISOString(), status: 'reserved', usage: null, launch: null };
  state.slots.push(record); save(statePath, state);
  const start = performance.now(), workspace = resolveRunWorkspace(manifest.workspaceLayout, directory, phase, slot, manifest.id);
  const evidence = join(directory, 'e', String(state.slots.length + (state.preflightFailures?.length ?? 0) + (state.infrastructureFailures?.length ?? 0) + (state.hostInfrastructureFailures?.length ?? 0)).padStart(3, '0'));
  mkdirSync(dirname(evidence), { recursive: true }); mkdirSync(evidence);
  record.evidence = evidence; record.workspace = workspace;
  const identity = identityPool ? pooledIdentity(identityPool, phase, slot) : null;
  if (identity) record.temporaryRegistration = registerInvocationScratch({ evidence, workspace, owner: record.attemptId });
  const env = identity ? childEnvironment(join(evidence, 'scratch')) : process.env;
  const telemetryPath = join(evidence, 'invocation-telemetry.jsonl');
  const telemetry = createInvocationTelemetry({ file: telemetryPath, binding: { protocolHash, attemptId: record.attemptId, slotId: record.slotId }, startMonotonicMs: start });
  let stopTelemetryTurn = null;
  telemetry.startHeartbeat({ intervalMs: 1000, onError: error => { record.telemetryError = { message: error.message, stack: error.stack }; stopTelemetryTurn?.(); } });
  record.telemetry = { path: telemetryPath, ...telemetry.snapshot() };
  try {
  telemetry.checkpoint('workspace-setup');
  if (manifest.workspaceLayout) {
    const binding = { roundId: manifest.id, slotId: slot.id, attemptId: record.attemptId, workspace, owner: manifest.workspaceLayout.owner,
      layoutHash: manifest.workspaceLayout.reservationHash, sid: identity?.sid, pathBudget: nativePaths(workspace, identity.profileName) };
    save(join(evidence, 'workspace-binding.json'), binding);
    record.workspaceBinding = { ...binding, hash: hash(readFileSync(join(evidence, 'workspace-binding.json'))) };
    const preflight = json(join(directory, 'workspace-startup-preflight.json'));
    validateWorkspaceStartup(preflight.entries?.find(entry => entry.workspace === workspace), {
      layout: manifest.workspaceLayout, workspace, identity, providerHash: manifest.providerHash, codeModeHostHash: manifest.codeModeHostHash, nodeHash: manifest.nodeHash });
  }
  if (slot.stage === 1 && attempt === 1) {
    if (existsSync(workspace)) throw new Error('Refuse to reseed existing workspace');
    mkdirSync(workspace, { recursive: true });
    cpSync(join(frozen, 'fixtures', slot.taskId), workspace, { recursive: true, filter: path => !/REQUEST-2\.md$|acceptance-2\.test\.mjs$/.test(path) });
    cpSync(join(frozen, slot.branch === 'B' ? 'baseline-runtime' : 'bridge-runtime'), join(workspace, '.bridge-runtime'), { recursive: true });
    const setup = command([cli, 'init', '--no-claude-hooks', '--no-antigravity-hooks'], workspace, join(evidence, 'init'), env);
    if (setup.exitStatus !== 0) throw new Error('Legacy workspace init failed; see init logs');
    copyFileSync(join(frozen, slot.branch === 'B' ? 'B-WORKFLOW-AGENTS.md' : 'AGENTS.md'), join(workspace, 'AGENTS.md'));
  } else {
    if (!existsSync(workspace)) throw new Error('Missing actual predecessor workspace');
    if (slot.stage === 2 && attempt === 1) {
      copyFileSync(join(frozen, 'fixtures/handoff/acceptance-2.test.mjs'), join(workspace, 'acceptance-2.test.mjs'));
      copyFileSync(join(frozen, 'fixtures/handoff/REQUEST-2.md'), join(workspace, 'REQUEST-2.md'));
    }
  }
  const testFile = slot.taskId === 'handoff' ? 'acceptance-' + slot.stage + '.test.mjs' : 'acceptance.test.mjs';
  const requestFile = slot.taskId === 'handoff' ? 'REQUEST-' + slot.stage + '.md' : 'REQUEST.md';
  const product = () => ({ ...Object.fromEntries(Object.entries(inventory(join(workspace, 'src'))).map(([path, digest]) => ['src/' + path, digest])),
    ...(existsSync(join(workspace, 'RESULT.md')) ? { 'RESULT.md': hash(readFileSync(join(workspace, 'RESULT.md'))) } : {}) });
  const before = product(); save(join(evidence, 'source-before.json'), before);
  record.sourceRevision = hash(JSON.stringify(before));
  const continuation = previous ?? (slot.stage === 2 ? latestAttempt(state.slots.filter(row => row.phase === phase), slot.branch + '-' + slot.repetition + '-handoff-1') : null);
  const capacityPredecessor = attempt > 1 && capacityRecovery?.predecessorIds.includes(continuation?.id);
  if (continuation) {
    if (continuation.nativeStop?.writersStopped !== true || continuation.nativeStop.activeProcesses !== 0) throw new Error('Continuation writer stop unverified');
    if (hash(readFileSync(join(continuation.evidence, 'source-after.json'))) !== hash(JSON.stringify(before, null, 2) + '\n')) throw new Error('Continuation source changed; no reseed or overwrite');
    if (capacityPredecessor) { record.capacityRetryFrom = continuation.id; record.capacityRecoveryHash = capacityRecovery.authorizationHash; }
    else record.continuationFrom = continuation.id;
    if (continuation.id === capacityRecovery?.interruptedRecovery?.predecessorId)
      record.interruptedRecoveryHash = capacityRecovery.interruptedRecovery.authorizationHash;
    if (continuation.id === capacityRecovery?.cancelledRecovery?.predecessorId)
      record.cancelledRecoveryHash = capacityRecovery.cancelledRecovery.authorizationHash;
    if (capacityRecovery?.formalDisconnectRecovery?.entries?.[continuation.id])
      record.formalDisconnectRecoveryHash = capacityRecovery.formalDisconnectRecovery.entries[continuation.id].authorizationHash;
    if (continuation.id === capacityRecovery?.compactionRecovery?.predecessorId)
      record.compactionRecoveryHash = capacityRecovery.compactionRecovery.authorizationHash;
  }
  const boundTaskId = continuation?.binding?.taskId ?? capacityRecovery?.formalDisconnectRecovery?.entries?.[continuation?.id]?.taskId;
  if ((attempt > 1 || slot.stage > 1) && !capacityPredecessor && (typeof boundTaskId !== 'string' || !boundTaskId.trim())) throw Error('Continuation Bridge task identity unavailable');
  if (feedback) record.reworkFeedback = { from: previous.id, reason: feedback.reason, reviewHash: hash(JSON.stringify(feedback)) };
  cpSync(join(workspace, 'src'), join(evidence, 'source-before'), { recursive: true });
  const fixtureInputs = Object.keys(inventory(join(frozen, 'fixtures', slot.taskId), ['src']));
  const readonly = [...new Set([...fixtureInputs, 'AGENTS.md', 'CLAUDE.md'])]
    .filter(path => existsSync(join(workspace, path)));
  const protectedHashes = Object.fromEntries(readonly.map(path => [path, hash(readFileSync(join(workspace, path)))]));
  if (manifest.workflowContract === 'g4-lifecycle-report-history-v1') {
    const transportSuffix = state.infrastructureFailures?.some(failure => failure.kind === 'provider-disconnect-after-startup')
      ? '-transport-' + (state.infrastructureFailures.length + (state.hostInfrastructureFailures?.length ?? 0) + 1) : '';
    const commandId = 'lifecycle-' + record.id + transportSuffix;
    const path = '.bridge-runtime/evidence/' + commandId + '.json';
    const contextId = 'context-startup-' + record.id + transportSuffix;
    const contextPath = '.bridge-runtime/evidence/' + contextId + '.json';
    if (existsSync(join(workspace, path)) || existsSync(join(workspace, contextPath))) throw Error('Lifecycle/context command spec already exists; no startup replay');
    const argv = boundTaskId
      ? [cli, 'session', 'start', '--task', boundTaskId, '--agent', 'codex']
      : [cli, 'task', 'start', 'G4 ' + slot.taskId, '--goal', 'Complete the current request in ' + requestFile, '--agent', 'codex'];
    save(join(workspace, contextPath), { id: contextId, executable: process.execPath, argv: [cli, 'context', 'startup', '--agent', 'codex'], timeoutMs: 30000 });
    const startupContext = { path: contextPath, hash: hash(readFileSync(join(workspace, contextPath))) };
    save(join(workspace, path), { id: commandId, executable: process.execPath, argv, timeoutMs: 30000, startupContext });
    record.lifecycleCommand = { path, hash: hash(readFileSync(join(workspace, path))), context: startupContext, kind: boundTaskId ? 'session' : 'task', taskId: boundTaskId ?? null };
  }
  if (recovery && !recovery.capacityRetry) {
    const runtimeAmendment = applyRecoveryRuntime(workspace, directory, manifest, slot.branch, recovery);
    record.runtimeAmendment = runtimeAmendment; save(join(evidence, 'runtime-amendment.json'), runtimeAmendment);
  }
  const runtimeHashes = inventory(join(workspace, '.bridge-runtime'));
  mkdirSync(join(workspace, '.bridge-home/codex'), { recursive: true });
  const preload = join(workspace, '.bridge-runtime/native-stdio.cjs').replaceAll('\\', '/');
  writeFileSync(join(workspace, '.bridge-home/codex/config.toml'), '[shell_environment_policy]\ninherit = "all"\n[shell_environment_policy.set]\nNODE_OPTIONS = ' +
    JSON.stringify('--preserve-symlinks --preserve-symlinks-main --require="' + preload + '"') + '\n');
  telemetry.checkpoint('workspace-ready');
  const sandbox = new WindowsSandbox({ control: join(evidence, 'supervisor'), profileName: identity?.profileName ?? ('BridgeV2.Baseline.' + randomUUID()),
    profileMode: identity ? 'existing' : 'create', environment: identity ? env : null });
  const owner = sandbox.invoke({ operation: 'workspace-owner', workspace });
  const sid = sandbox.invoke({ operation: 'sid', name: sandbox.profileName });
  if (!owner.receipt?.userSid || !sid.receipt?.sid) throw new Error('Sandbox identity unavailable');
  if (identity && sid.receipt.sid !== identity.sid) throw new Error('Registered identity SID mismatch');
  telemetry.checkpoint('identity-verified');
  let storageBefore;
  if (identity) {
    record.identity = identity;
    const readOnlyExecutables = [];
    for (const prior of state.slots.filter(row => row !== record && row.workspace === workspace && row.identity?.sid === identity.sid)) {
      for (const name of ['codex.exe', 'codex-code-mode-host.exe']) {
        const path = containedPath(join(prior.evidence, 'provider', name));
        if (existsSync(path)) {
          if (hash(readFileSync(path)) !== hash(readFileSync(join(frozen, 'provider', name)))) throw Error('Prior provider binary changed');
          readOnlyExecutables.push(path);
        }
      }
    }
    const legacyScopeRecovery = recovery && !recovery.capacityRetry;
    const input = join(evidence, legacyScopeRecovery ? 'scope-input.json' : 'scope-input.json.gz');
    if (legacyScopeRecovery) record.scopeEnumeration = writeRecoveryScope(input, workspace, identity.sid, readOnlyExecutables, root);
    else record.scopeEnumeration = await writeCompressedScopeInput(input, { ...scopeEntries(workspace, readOnlyExecutables), sid: identity.sid });
    const policyScript = join(root, 'scripts/phase8-sid-scope.ps1');
    const scopeArgs = legacyScopeRecovery ? ['-NoProfile', '-NonInteractive', '-File', join(directory, 'host-recovery/sources/recovery-scope-worker.ps1'),
      '-InputFile', record.scopeEnumeration.streamInput, '-PolicyScript', policyScript, '-PolicyHash', manifest.harnessSources['scripts/phase8-sid-scope.ps1']]
      : ['-NoProfile', '-NonInteractive', '-File', policyScript, '-InputFile', input];
    const scopeRecovery = [
      capacityRecovery?.formalDisconnectRecovery?.b4SmallScopeRecovery,
      capacityRecovery?.formalDisconnectRecovery?.b4DebugScopeRecovery,
      capacityRecovery?.formalDisconnectRecovery?.b4DebugRetry,
      capacityRecovery?.formalDisconnectRecovery?.b4DebugAttempt3,
      capacityRecovery?.formalDisconnectRecovery?.b4DebugAttempt4,
      capacityRecovery?.formalDisconnectRecovery?.b4DebugAttempt5,
      capacityRecovery?.formalDisconnectRecovery?.b5SmallScopeRecovery,
      capacityRecovery?.formalDisconnectRecovery?.b5SmallAttempt2Recovery,
      capacityRecovery?.formalDisconnectRecovery?.s5SmallScopeRecovery,
      capacityRecovery?.formalDisconnectRecovery?.s5SmallTransportRecovery,
      capacityRecovery?.formalDisconnectRecovery?.s5SmallAttempt3Recovery
    ].find(recovery => recovery?.slotId === slot.id && recovery.attempt === attempt);
    const scopeTimeoutMs = phase === 'formal' && slot.id === scopeRecovery?.slotId && attempt === scopeRecovery.attempt
      ? scopeRecovery.scopeTimeoutMs
      : attempt === 2 && continuation?.id === capacityRecovery?.cancelledRecovery?.predecessorId
      ? capacityRecovery.cancelledRecovery.scopeTimeoutMs ?? 120000
      : attempt === 3 && continuation?.id === capacityRecovery?.formalDisconnectRecovery?.b2Handoff2Cap3Recovery?.predecessorId
        ? capacityRecovery.formalDisconnectRecovery.b2Handoff2Cap3Recovery.scopeTimeoutMs ?? 120000
        : attempt === 4 && continuation?.id === capacityRecovery?.formalDisconnectRecovery?.b2Handoff2Cap4Recovery?.predecessorId
          ? capacityRecovery.formalDisconnectRecovery.b2Handoff2Cap4Recovery.scopeTimeoutMs ?? 120000 : 120000;
    telemetry.checkpoint('scope-audit-start');
    const audit = captureCommand({ directory: evidence, id: 'scope-audit', executable: 'pwsh.exe',
      argv: scopeArgs, cwd: root, env, timeout: scopeTimeoutMs });
    if (audit.exitCode !== 0) throw Error('Fresh workspace identity scope audit failed: ' + readFileSync(audit.stderr.path, 'utf8').trim());
    const scope = json(audit.stdout.path);
    if (audit.exitCode !== 0 || scope.passed !== true || scope.sid !== identity.sid || scope.matches?.length !== 0 || scope.failures?.length !== 0)
      throw Error('Fresh workspace identity scope audit failed');
    storageBefore = profileSnapshot({ directory: evidence, id: 'profile-before', identity, env });
  }
  for (const path of readonly) acl(join(workspace, path), sid.receipt.sid, owner.receipt.userSid, env);
  const observationDirectory = join(workspace, '.handoff/provider-observations');
  let observationPrivateKey = null;
  if (manifest.providerObservations) {
    if (!['ed25519-provider-launch-v1', 'ed25519-completed-command-v2'].includes(manifest.providerObservations.scheme) ||
        hash(readFileSync(join(workspace, '.bridge-runtime/evidence/provider-observation-public.pem'))) !== manifest.providerObservations.publicKeyHash) {
      throw Error('Frozen provider observation policy/key mismatch');
    }
    mkdirSync(observationDirectory, { recursive: true });
    acl(observationDirectory, sid.receipt.sid, owner.receipt.userSid, env, true);
    if (recovery) {
      const publicKey = readFileSync(join(workspace, '.bridge-runtime/evidence/provider-observation-public.pem'), 'utf8');
      for (const name of readdirSync(observationDirectory)) {
        if (!name.endsWith('.json')) throw Error('Unexpected provider observation artifact');
        const path = join(observationDirectory, name), before = hash(readFileSync(path));
        verifyProviderObservation(json(path), publicKey, { protocolHash });
        acl(path, sid.receipt.sid, owner.receipt.userSid, env);
        if (hash(readFileSync(path)) !== before) throw Error('Provider observation bytes changed during read restoration');
      }
    }
    acl(join(workspace, '.bridge-runtime'), sid.receipt.sid, owner.receipt.userSid, env, true);
    observationPrivateKey = readFileSync(join(directory, 'provider-observation-private.pem'), 'utf8');
    record.providerObservationEvents = [];
  }
  const other = join(evidence, 'other-workspace.txt'); writeFileSync(other, 'other workspace sentinel');
  const providerDirectory = join(evidence, 'provider'); mkdirSync(providerDirectory);
  for (const name of ['codex.exe', 'codex-code-mode-host.exe']) copyFileSync(join(frozen, 'provider', name), join(providerDirectory, name));
  const helperGrant = spawnSync('icacls.exe', [join(providerDirectory, 'codex-code-mode-host.exe'), '/grant', '*' + sid.receipt.sid + ':RX'], { cwd: workspace, env, windowsHide: true, encoding: 'utf8' });
  if (helperGrant.status !== 0) throw new Error('Code Mode helper grant failed');
  const guard = [{ kind: 'authoritative', path: join(frozen, 'fixtures', slot.taskId, 'src', readdirSync(join(frozen, 'fixtures', slot.taskId, 'src'))[0]) },
    { kind: 'state', path: statePath }, { kind: 'evidence', path: join(directory, 'protocol.json') },
    { kind: 'evaluator', path: join(frozen, 'controls/small/src/clamp.mjs') }, { kind: 'other-workspace', path: other }, { kind: 'auth', path: authPath }];
  if (manifest.providerObservations) guard.push({ kind: 'state', path: join(directory, 'provider-observation-private.pem') });
  telemetry.checkpoint('boundary-verification');
  const proof = sandbox.verify({ workspace, protectedFiles: guard, internetClient: true }); save(join(evidence, 'boundary.json'), proof);
  if (!proof.writerEnabled) throw new Error('Native write boundary failed');
  if (identity) {
    const io = sandbox.run({ workspace, arguments: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),env:process.env}))'], timeoutMs: 10000 });
    save(join(evidence, 'environment.json'), io);
    const environment = io.exitStatus === 0 ? { ...JSON.parse(io.stdout), writersStopped: io.writersStopped, activeProcesses: io.activeProcesses } : null;
    const after = profileSnapshot({ directory: evidence, id: 'profile-after-boundary', identity, env });
    const confinement = workspaceConfinement({ identity, workspace, boundary: proof, before: storageBefore, after, environment, scopeVerified: true });
    save(join(evidence, 'confinement-proof.json'), confinement);
  }
  let transport, rpc, turnId, completion, usage = null, failure = null, tokenLimit = false;
  const calls = new Map(), events = [];
  try {
    telemetry.checkpoint('provider-start');
    transport = sandbox.start({ workspace, executable: join(providerDirectory, 'codex.exe'), readOnlyExecutable: true, maxSessionMs: manifest.maxAttemptMs + (manifest.nativeStopGraceMs ?? 60000),
      arguments: ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'web_search="disabled"',
        ...proxyConfigArgs(manifest.proxyRoute),
        '-c', 'model_auto_compact_token_limit=1000000000', '-c', 'project_doc_max_bytes=0', '--disable', 'hooks', '--disable', 'apps',
        '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'multi_agent_v2_dynamic_tools', '--disable', 'memories',
        '--disable', 'external_agent_memory_import', '--disable', 'skill_search', '--disable', 'in_app_browser', '--disable', 'in_app_chat',
        '--disable', 'standalone_web_search', '--disable', 'browser_use', '--disable', 'computer_use'] });
    telemetry.bind({ runId: transport.runId });
    rpc = new CodexRpc(transport);
    let resolveCompleted;
    const completed = new Promise(resolve => { resolveCompleted = resolve; });
    stopTelemetryTurn = () => { failure = 'Telemetry persistence failed'; resolveCompleted({ status: 'infrastructure_failed' }); };
    let resolveSettings;
    const confirmedSettings = new Promise(resolve => { resolveSettings = resolve; });
    rpc.on('request', async message => {
      if (message.method === 'account/chatgptAuthTokens/refresh') {
        const auth = json(authPath);
        rpc.send({ id: message.id, result: { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id } });
      } else rpc.send({ id: message.id, error: { code: -32600, message: 'No interactive approvals or extra tools in baseline protocol' } });
    });
    rpc.on('failure', error => { failure = error.message; resolveCompleted({ status: 'infrastructure_failed' }); });
    rpc.on('closed', () => { if (!completion) resolveCompleted({ status: 'transport_closed' }); });
    let turnCompletedNotification = false;
    rpc.on('notification', message => {
      const envelope = { at: new Date().toISOString(), message };
      appendFileSync(join(evidence, 'events.jsonl'), JSON.stringify(envelope) + '\n');
      events.push(message);
      try { telemetry.observe(message); record.telemetry = { path: telemetryPath, ...telemetry.snapshot() }; }
      catch (error) { record.telemetryError = { message: error.message, stack: error.stack }; failure = 'Telemetry capture failed: ' + error.message; resolveCompleted({ status: 'infrastructure_failed' }); return; }
      const params = message.params ?? {}, item = params.item;
      if (message.method === 'thread/settings/updated' && params.threadId === record.launch?.threadId &&
          params.threadSettings?.model === manifest.model && params.threadSettings.effort === manifest.effort)
        resolveSettings(message);
      const allCommands = manifest.providerObservations?.scheme === 'ed25519-completed-command-v2';
      if (manifest.providerObservations && (isProviderLaunchFailure(message) ||
          allCommands && message.method === 'item/completed' && item?.type === 'commandExecution')) {
        try {
          if (allCommands && turnCompletedNotification) throw Error('Late completed command after turn/completed');
          const kind = providerObservationKind(message);
          if (!kind) throw Error('Unsignable completed command event');
          const path = join(observationDirectory, item.id + '.json');
          const binding = providerObservationBinding(protocolHash, { ...record,
            launch: { ...record.launch, turnId: record.launch?.turnId ?? params.turnId ?? turnId } });
          if (existsSync(path)) throw Error('Provider observation event ID already exists: ' + item.id);
          const observation = kind === 'provider-launch-failure' ? signProviderObservation(envelope, binding, observationPrivateKey) :
            signCompletedCommandObservation(envelope, binding, observationPrivateKey);
          writeFileSync(path, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
          acl(path, sid.receipt.sid, owner.receipt.userSid, env);
          record.providerObservationEvents.push({ id: item.id, kind, path: '.handoff/provider-observations/' + item.id + '.json', hash: hash(readFileSync(path)) });
        } catch (error) {
          record.providerObservationError = { message: error.message, stack: error.stack };
          failure = 'Provider observation capture failed: ' + error.message;
          resolveCompleted({ status: 'infrastructure_failed' });
        }
      }
      if (message.method === 'item/completed' && item?.id && /commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent/.test(item.type ?? '')) calls.set(item.id, item);
      if (message.method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage?.total ?? null;
        if (usage && tokenBudgetExceeded(usage, manifest) && !tokenLimit) {
          tokenLimit = true;
          rpc.request('turn/interrupt', { threadId: record.launch.threadId, turnId }).catch(error => {
            failure = 'Budget interrupt failed: ' + error.message; resolveCompleted({ status: 'infrastructure_failed' });
          });
        }
      }
      if (message.method === 'turn/completed') { turnCompletedNotification = true; completion = params.turn; resolveCompleted(completion); }
    });
    await rpc.request('initialize', { clientInfo: { name: 'phase0_baseline', title: 'Phase 0 baseline', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const auth = json(authPath);
    if (auth.auth_mode !== 'chatgpt') throw new Error('ChatGPT auth required; no API fallback');
    await rpc.request('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id });
    const limits = await rpc.request('account/rateLimits/read'), rates = limits.rateLimits;
    save(join(evidence, 'quota.json'), rates);
    const quotaAdmission = assessProviderQuota(rates, manifest.model === 'chatgpt-web/gpt-6-sol' && manifest.effort === 'high' ?
      { model: manifest.model, effort: manifest.effort, ignoreLocalQuota: true } : {});
    save(join(evidence, 'quota-admission.json'), quotaAdmission);
    if (!quotaAdmission.passed) throw new Error('Quota admission/no-paid-fallback gate failed');
    const developerInstructions = [
      ...(feedback?.hostInfrastructureIssues ? ['Bound HOST issue IDs describe immutable host review findings, not failed model commands. Resolve them with fresh canonical publication and verifier PASS, and retain their IDs in RESULT.md and canonical handoff. Do not fabricate failed commands or put host review findings into the command error ledger without their own actual failed execution receipt.'] : []),
      lifecycleInstruction(slot.stage === 1 && attempt === 1 ? null : boundTaskId, record.lifecycleCommand?.path ?? null),
      powershellWorkspaceInstruction(), evidenceInstruction(),
      'Keep historical evidence readbacks bounded: read and hash retained canonical/observation artifacts with Node and print IDs, hashes, bindings and relevant failure fields rather than recursively dumping embedded historical command/output JSON. Preserve every original byte on disk for host review. Print each new captured command stdout/stderr in full once; later readbacks may report their matching hashes. Do not repeatedly print old full payloads or error ledgers inside new signed observations.',
      'Complete the entire current request and mandatory workflow in this turn. After a failed command, inspect its real output, record the failure and continue correcting it. Create each new spec file and check that it exists before executing it. Do not stop after editing source: fresh post-edit acceptance, RESULT, checkpoint, canonical publication and final verification must all be completed and read back. Keep write leases for every changed source file and RESULT.md until their final edits and checkpoint are complete; reacquire both before any corrective checkpoint. Embed the exact compact JSON.stringify of .handoff/source-claims.json in a handoff done entry so CURRENT.md contains the byte-identical source claims. After every correction republish canonical full evidence, check CURRENT.md has the Full evidence pointer, rerun the unique-revision verifier, and read back PASS before ending the turn. If a real external blocker prevents completion, report it honestly; never fabricate success or request another model turn.'
    ].join('\n');
    save(join(evidence, 'developer-instructions.json'), { role: 'developer', text: developerInstructions, sha256: hash(developerInstructions) });
    const thread = await rpc.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', model: manifest.model,
      developerInstructions, config: { model_reasoning_effort: manifest.effort }, dynamicTools: [], ephemeral: false });
    requireActualThreadSettings(thread, manifest.model, manifest.effort);
    save(join(evidence, 'thread.json'), thread);
    const lifecycle = lifecycleInstruction(slot.stage === 1 && attempt === 1 ? null : boundTaskId, record.lifecycleCommand?.path ?? null);
    const helperInstruction = manifest.evidenceContract === 'immutable-command-v1'
      ? 'Run evidence commands with tty=false; preserve machine-readable receipt JSON without terminal wrapping. Use shared B/S helpers: mkdir .handoff/specs first; save spec JSON {id,executable,argv} then run node .bridge-runtime/evidence/agent-evidence-command.cjs <spec>. Each immutable receipt and stdout/stderr has its own original ID and hash. Read captured logs DIRECTLY with Node fs and display bytes in raw tool trace; do not recapture readback. For multiline writes, save UTF-8 .cjs via a literal PowerShell here-string under .handoff and execute through a captured spec. For native PowerShell subprocesses, explicitly wait for child termination and inspect its actual ExitCode; outer exit 0 is insufficient. Preserve reports under .handoff/verifications and verify manifests using node .bridge-runtime/evidence/agent-verify.mjs .handoff/manifests.json <unique-revision>. The helper does not author claims/ledger/payload.' : '';
    const observationInstruction = manifest.providerObservations?.scheme === 'ed25519-completed-command-v2'
      ? 'Host signs EVERY completed command envelope into read-only .handoff/provider-observations/<event-id>.json: provider-completed-command schemaVersion 2, except failed unifiedExecStartup observations retain provider-launch-failure schemaVersion 1. Inspect all signed events including direct IO and exit-zero compound failures. For a real direct nonzero issue use outputReference={kind:"provider-completed-command",eventId,path,hash,failureMode:"nonzero"}; for an actually failed inner subcommand of outer exit-zero use failureMode:"reviewed-inner-error"; for a startup error use {kind:"provider-launch-failure",eventId,path,hash}. Hash must match exact signed JSON bytes, and command/output must match the observed envelope. A silent completed event may have aggregatedOutput:null; preserve that null, and do not invent output or an issue for silent success. For a nonzero event with null output use outputMode:"artifact-reference" plus the signed event reference and a description of its exitCode/null. Only actual errors belong in the ledger, not all successful observations. Host independently reviews raw/issue semantics; agent must include relevant signed observations and errors.json in canonical. If a late failure appears after self-verification, record/correct/publish/reverify in the same attempt.'
      : manifest.providerObservations ? 'For failed unifiedExecStartup commands use the host-signed read-only provider-launch-failure observation, with original command/output and outputReference={kind:"provider-launch-failure",eventId,path,hash}. Keep errors and observation in canonical evidence.' : '';    const request = `${observationInstruction}\n${helperInstruction}\n${powershellWorkspaceInstruction()}\n${evidenceInstruction()}\n${feedback ? `REWORK attempt ${attempt} of ${recoveryAttemptLimits(manifest.maxAttempts, recovery)?.[slot.id] ?? manifest.maxAttempts}: continue the same task and actual workspace; preserve successful code and all prior evidence. Correct the following reviewed deficiencies, rerun the fixed acceptance, and do not create a duplicate task or claim old tests as newly run: ${feedback.reason}\nBound issue checklist: ${JSON.stringify(feedback.issues ?? [])}` : ''}\nFollow the read-only AGENTS.md below and the current request. This is an isolated measurement task; no network calls, package installs, subagents, extra model/provider calls, git commits, or future requirements. Use Node for file IO when rg is unavailable. Native working directory for every tool call: ${workspace}. Bridge executable: node ${cli}. Hooks are disabled; manual lifecycle only. ${lifecycle} Reuse the captured context from the mandatory bootstrap; do not execute context startup again after it succeeds. Native test compatibility: add --experimental-test-isolation=none to every node --test command (same frozen tests/acceptance, same OS sandbox). Do not end the Bridge session yourself; the host ends it only after native writer stop. Product scope: src/** and RESULT.md. Read-only inputs: acceptance tests, checks.mjs, requests, package.json, AGENTS.md, .bridge-runtime. Bridge metadata and a structured handoff payload may be written only under .agent-memory/ or .handoff/. Keep handoff evidence as complete actual command/result text, including failures. Record decisions with reasons and constraints. No runtime goal tool is requested.\n${readFileSync(join(workspace, 'AGENTS.md'), 'utf8')}\nCURRENT REQUEST:\n${readFileSync(join(workspace, requestFile), 'utf8')}`;
    writeFileSync(join(evidence, 'request.txt'), request);
    record.launch = { runId: transport.runId, threadId: thread.thread.id, model: thread.model, effort: thread.reasoningEffort, requestHash: hash(request), observedAt: new Date().toISOString() };
    telemetry.bind({ threadId: record.launch.threadId });
    telemetry.checkpoint('provider-launched');
    record.status = 'launched'; save(statePath, state);
    if (manifest.proxyRoute) {
      await rpc.request('thread/settings/update', { threadId: thread.thread.id, model: manifest.model, effort: 'medium' });
      await rpc.request('thread/settings/update', { threadId: thread.thread.id, model: manifest.model, effort: manifest.effort });
      let settingsTimer;
      try {
        await Promise.race([confirmedSettings, new Promise((_, reject) => {
          settingsTimer = setTimeout(() => reject(Error('Actual model/effort settings receipt missing before inference')), 5000);
        })]);
      } finally { clearTimeout(settingsTimer); }
      const message = events.filter(event => event.method === 'thread/settings/updated' && event.params.threadId === thread.thread.id).at(-1);
      if (message?.params.threadSettings?.model !== manifest.model || message.params.threadSettings.effort !== manifest.effort)
        throw Error('Actual model/effort settings receipt differs before inference');
      save(join(evidence, 'settings-confirmation.json'), { inferenceStarted: false, calibrationEffort: 'medium', message });
    }
    telemetry.checkpoint('turn-requested');
    const response = await rpc.request('turn/start', { threadId: thread.thread.id, model: manifest.model, effort: manifest.effort,
      input: [{ type: 'text', text: request }], approvalPolicy: 'never',
      sandboxPolicy: manifest.proxyRoute ? { type: 'dangerFullAccess' } : { type: 'externalSandbox', networkAccess: 'restricted' } });
    turnId = response.turn?.id; telemetry.bind({ turnId }); record.launch.turnId = turnId; save(statePath, state);
    let timer;
    try { completion = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), manifest.maxAttemptMs); })]); }
    finally { clearTimeout(timer); }
    record.turn = completion;
    const settings = events.filter(event => event.method === 'thread/settings/updated').at(-1)?.params.threadSettings;
    if (settings?.model !== manifest.model || settings.effort !== manifest.effort) failure = 'Actual turn model/effort unverified';
  } catch (error) { failure = error.message; }
  finally {
    try {
      if (rpc) record.nativeStop = await rpc.close();
      else if (transport) record.nativeStop = await transport.stop();
    } catch (error) {
      record.nativeStopError = { message: error.message, stack: error.stack };
    }
    if (transport && record.nativeStop?.writersStopped !== true) {
      const graceDeadline = Date.now() + 15000;
      while (Date.now() < graceDeadline && record.nativeStop?.writersStopped !== true) {
        const late = nativeReceipt(evidence, transport.runId);
        if (late) { record.nativeStop = { ...late, recoveredLateReceipt: true }; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    try {
      if (record.nativeStop?.writersStopped === true && record.nativeStop.activeProcesses === 0 && record.nativeStop.appContainer === true) telemetry.implementationStopped(record.nativeStop);
      else telemetry.checkpoint('native-stop-unverified');
      record.implementationMs = telemetry.snapshot().timing.implementationMs;
      record.telemetry = { path: telemetryPath, ...telemetry.snapshot() };
    } catch (error) {
      record.telemetryError ??= { message: error.message, stack: error.stack };
      record.implementationMs = null;
      failure ??= 'Telemetry persistence failed: ' + error.message;
    }
    if (transport) {
      record.rawProtocol = record.nativeStop.stdoutPath ?? null;
      if (record.rawProtocol && existsSync(record.rawProtocol)) record.rawProtocolHash = hash(readFileSync(record.rawProtocol));
    }
    if (identity && record.nativeStop?.writersStopped === true && record.nativeStop.activeProcesses === 0) {
      try {
        const after = profileSnapshot({ directory: evidence, id: 'profile-after-provider', identity, env });
        record.profileStorage = assessAllowedProfileStorage(storageBefore, after, identity);
        save(join(evidence, 'provider-storage.json'), record.profileStorage);
      } catch (error) { record.profileStorageError = error.message; }
    }
  }
  record.toolCalls = calls.size;
  record.toolCallItems = [...calls.keys()];
  save(join(evidence, 'tool-calls.json'), [...calls.values()]);
  record.shellBootstrapViolations = missingPowerShellBootstrap([...calls.values()]);
  record.usage = usage ? { inputTokens: usage.inputTokens ?? null, cachedInputTokens: usage.cachedInputTokens ?? null,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null, outputTokens: usage.outputTokens ?? null,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? null,
    uncachedInputTokens: Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.cachedInputTokens) && usage.inputTokens >= usage.cachedInputTokens ? usage.inputTokens - usage.cachedInputTokens : null } : null;
  record.observedUsage = record.usage;
  record.usage = telemetry.snapshot().finalUsage;
  record.telemetry = { path: telemetryPath, ...telemetry.snapshot() };
  save(join(evidence, 'result.json'), record); save(statePath, state);
  if (!record.nativeStop?.writersStopped || record.nativeStop.activeProcesses !== 0 || record.nativeStop.appContainer !== true) throw new Error('Native writer stop unverified');
  if (identity && record.profileStorage?.privateStorageAllowedVerified !== true) throw Error(record.profileStorageError ?? 'Provider private storage not verified');
  if (record.shellBootstrapViolations.length) throw new Error('PowerShell workspace bootstrap missing in tool calls: ' + record.shellBootstrapViolations.join(', '));
  if (failure) throw new Error(failure);
  if (!record.launch || !usage || !Number.isSafeInteger(record.observedUsage?.inputTokens) || !Number.isSafeInteger(record.observedUsage?.cachedInputTokens) || !Number.isSafeInteger(record.observedUsage?.outputTokens)) {
    requireProviderTurnCompletion(record.turn);
    throw new Error('Missing mandatory provider usage');
  }
  const compacted = events.some(event => /compacted/.test(event.method ?? '') || event.params?.item?.type === 'contextCompaction');
  for (const [path, expected] of Object.entries(protectedHashes)) if (hash(readFileSync(join(workspace, path))) !== expected) throw new Error('Read-only input changed');
  verify(join(workspace, '.bridge-runtime'), runtimeHashes);
  const runtimeDatabase = new DatabaseSync(join(workspace, '.agent-memory/runtime.db'), { readOnly: true });
  const runtimeConfig = JSON.parse(runtimeDatabase.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload);
  runtimeDatabase.close();
  const config = { ...json(join(workspace, '.agent-memory/config.json')), ...runtimeConfig };
  const taskId = config.currentTasks?.codex ?? config.currentTaskId, sessionId = config.currentSessions?.codex;
  if (!taskId || !sessionId) throw new Error('Missing Bridge task/session identity');
  record.binding = { taskId, sessionId };
  if (continuation && !capacityPredecessor && (boundTaskId !== taskId || continuation.binding?.sessionId === sessionId)) throw new Error('Handoff task/session continuity failed');
  const close = command([cli, 'session', 'end', '--agent', 'codex', '--id', sessionId], workspace, join(evidence, 'session-close'), env);
  if (close.exitStatus !== 0) throw new Error('Bridge close failed after stop');
  const after = product(); save(join(evidence, 'source-after.json'), after);
  cpSync(join(workspace, 'src'), join(evidence, 'source-after'), { recursive: true });
  cpSync(join(workspace, 'src'), join(evidence, 'src'), { recursive: true });
  if (existsSync(join(workspace, 'RESULT.md'))) copyFileSync(join(workspace, 'RESULT.md'), join(evidence, 'RESULT.md'));
  if (existsSync(join(workspace, '.handoff'))) cpSync(join(workspace, '.handoff'), join(evidence, 'handoff'), { recursive: true });
  for (const path of readonly) {
    mkdirSync(dirname(join(evidence, path)), { recursive: true });
    copyFileSync(join(workspace, path), join(evidence, path));
  }
  cpSync(join(workspace, '.agent-memory'), join(evidence, 'agent-memory'), { recursive: true });
  const evaluatorProof = sandbox.verify({ workspace, protectedFiles: guard, internetClient: false });
  save(join(evidence, 'evaluator-boundary.json'), evaluatorProof);
  if (!evaluatorProof.writerEnabled) throw new Error('Evaluator boundary failed');
  telemetry.checkpoint('acceptance-start');
  const acceptance = sandbox.run({ workspace, executable: process.execPath,
    arguments: ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', testFile], timeoutMs: 30000 });
  writeFileSync(join(evidence, 'acceptance.stdout.log'), acceptance.stdout);
  writeFileSync(join(evidence, 'acceptance.stderr.log'), acceptance.stderr);
  for (const [path, expected] of Object.entries(protectedHashes)) if (hash(readFileSync(join(workspace, path))) !== expected) throw new Error('Evaluator read-only input changed');
  const cases = Number(acceptance.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0);
  const failures = Number(acceptance.stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0);
  record.acceptance = { passed: acceptance.exitStatus === 0 && cases === 2 && failures === 0, cases, failures,
    exitStatus: acceptance.exitStatus, nativeStop: { writersStopped: acceptance.writersStopped, activeProcesses: acceptance.activeProcesses, appContainer: acceptance.appContainer } };
  telemetry.checkpoint('acceptance-complete');
  record.unexpectedFiles = Object.keys(inventory(workspace, ['src', '.git', '.bridge-runtime', '.agent-memory', '.handoff', '.bridge-home', '.bridge-tmp']))
    .filter(path => path !== 'RESULT.md' && !(path in protectedHashes));
  record.status = 'finished'; record.finishedAt = new Date().toISOString(); record.elapsedMs = performance.now() - start;
  if (completion?.status === 'failed' && completion.error?.codexErrorInfo === 'usageLimitExceeded') {
    record.providerFailure = { classification: 'provider_quota_exhausted', ...completion.error };
    record.measurementEligible = false;
    record.failureClass = 'provider_quota_exhausted';
  } else if (compacted && !activeCompactionReviewPolicy(capacityRecovery)?.acceptCompaction) {
    record.failureClass = 'controlled_input_compaction';
    record.measurementEligible = false;
  } else {
    record.failureClass = record.acceptance.passed && completion?.status === 'completed' && !tokenLimit && record.unexpectedFiles.length === 0 ? null : 'product';
  }
  record.retryCount = attempt - 1; record.reworkCount = attempt - 1; record.review = 'pending-host-content-review';
  save(join(evidence, 'result.json'), record); save(statePath, state);
  console.log(JSON.stringify({ slot: slot.id, acceptance: record.acceptance.passed, usage: record.usage, elapsedMs: Math.round(record.elapsedMs) }));
  } catch (error) {
    record.invocationError = { message: error.message, stack: error.stack };
    if (record.launch && record.nativeStop?.writersStopped === true && record.nativeStop.activeProcesses === 0 &&
        record.nativeStop.appContainer === true && record.status !== 'finished') {
      record.status = 'terminal_infrastructure_failed';
      record.measurementEligible = false;
      record.terminal = { providerTurnStatus: record.turn?.status ?? null, nativeStopVerified: true,
        classification: 'infrastructure_failed', reason: error.message, observedAt: new Date().toISOString() };
    }
    throw error;
  } finally {
    if (record.nativeStop?.writersStopped === true && record.nativeStop.activeProcesses === 0) {
      try {
        const configPath = join(workspace, '.agent-memory/config.json'), database = join(workspace, '.agent-memory/runtime.db');
        if (existsSync(configPath) && existsSync(database)) {
          const db = new DatabaseSync(database, { readOnly: true });
          let config;
          try { config = { ...json(configPath), ...JSON.parse(db.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload) }; }
          finally { db.close(); }
          const taskId = config.currentTasks?.codex ?? config.currentTaskId, sessionId = config.currentSessions?.codex;
          if (taskId && sessionId) {
            record.binding ??= { taskId, sessionId };
            const close = command([cli, 'session', 'end', '--agent', 'codex', '--id', sessionId], workspace, join(evidence, 'failure-session-close'), env);
            if (close.exitStatus !== 0) throw Error('Failed attempt session closure failed: ' + close.stderr);
          }
        }
        const afterPath = join(evidence, 'source-after.json');
        if (!existsSync(afterPath) && existsSync(join(workspace, 'src'))) {
          save(afterPath, { ...Object.fromEntries(Object.entries(inventory(join(workspace, 'src'))).map(([path, digest]) => ['src/' + path, digest])),
            ...(existsSync(join(workspace, 'RESULT.md')) ? { 'RESULT.md': hash(readFileSync(join(workspace, 'RESULT.md'))) } : {}) });
        }
        for (const [source, destination] of [['src', 'source-after'], ['src', 'src'], ['.handoff', 'handoff'], ['.agent-memory', 'agent-memory'], ['RESULT.md', 'RESULT.md']]) {
          if (existsSync(join(workspace, source)) && !existsSync(join(evidence, destination))) cpSync(join(workspace, source), join(evidence, destination), { recursive: true });
        }
      } catch (error) { record.finalizationError = { message: error.message, stack: error.stack }; }
    }
    if (identity) {
      try {
        const cleanup = cleanupInvocation({ evidence, workspace, owner: record.attemptId, nativeStop: record.nativeStop,
          preserveContinuation: false, requiredArtifacts: existsSync(join(evidence, 'scratch')) ? [join(evidence, 'scratch')] : [] });
        record.cleanup = { path: cleanup.reportPath, passed: cleanup.passed, status: cleanup.status, finishedAt: cleanup.finishedAt };
        if (!cleanup.passed) record.finalizationError ??= { message: 'Invocation cleanup pending: ' + (cleanup.error?.message ?? cleanup.status) };
      } catch (error) { record.finalizationError ??= { message: error.message, stack: error.stack }; }
    }
    try {
      telemetry.checkpoint('cleanup-complete');
      telemetry.finish(record.status);
      record.telemetry = { path: telemetryPath, ...telemetry.snapshot() };
      record.elapsedMs = record.telemetry.timing.elapsedMs;
      record.observedUsage ??= record.telemetry.observedUsage;
      record.usage = record.telemetry.finalUsage;
    } catch (error) {
      record.telemetryError ??= { message: error.message, stack: error.stack };
      record.finalizationError ??= { message: 'Telemetry finalization failed: ' + error.message };
      record.usage = null;
      record.elapsedMs = null;
    } finally {
      try { telemetry.close(); }
      finally { save(join(evidence, 'result.json'), record); save(statePath, state); }
    }
    if (record.finalizationError && !record.invocationError) throw Error('Attempt finalization failed: ' + record.finalizationError.message);
  }
}
const reviewPath = join(directory, phase === 'smoke' ? 'smoke-content-review.json' : 'content-review.json');
const ledger = existsSync(reviewPath) ? json(reviewPath) : { protocolHash, rows: [] };
if (ledger.protocolHash !== protocolHash) throw new Error('Review protocol mismatch');
for (const item of ledger.rows) {
  const row = state.slots.find(row => row.phase === phase && row.id === item.id);
  const resultPath = row ? join(row.evidence, 'RESULT.md') : '';
  if (row && (item.verdict === 'pass' || item.verdict === 'rework' && manifest.workflowContract === 'g4-lifecycle-report-history-v1') && (item.assessment?.canonicalHash !== canonicalEvidence(row.evidence).hash || item.assessment?.eventsHash !== hash(readFileSync(join(row.evidence, 'events.jsonl'))))) throw new Error('Reviewed canonical/raw evidence changed');
  if (row && item.verdict !== 'blocked' && manifest.workflowContract === 'g4-lifecycle-report-history-v1') validateWorkflowChain(state.slots, row, { requireFinalPass: item.verdict === 'pass', recovery });
  if (!row || item.sourceManifestHash !== hash(readFileSync(join(row.evidence, 'source-after.json'))) || item.resultHash !== (existsSync(resultPath) ? hash(readFileSync(resultPath)) : null)) throw new Error('Review is not bound to immutable attempt evidence');
}
const plan = nextInvocation(phase === 'smoke' ? manifest.smoke : manifest.schedule, state.slots.filter(row => row.phase === phase), recoveryReviews(ledger.rows, recovery), recoveryAttemptLimits(manifest.maxAttempts, recovery), capacityRecovery);
if (manifest.recoveryPolicy) {
  const admission = campaignResumeAction(manifest, state, ledger, phase, capacityRecovery);
  if (admission.action === 'stop') throw Error(admission.reason + ': ' + admission.id);
  if (admission.action !== plan.action || admission.attempt !== plan.attempt || admission.slot?.id !== plan.slot?.id)
    throw Error('Recovery scheduler admission differs');
}
if (plan.action !== 'run') {
  state.status = plan.action === 'complete' ? phase + '-completed' : plan.action === 'blocked' ? 'quality_failed' : 'awaiting-review-' + phase;
  if (plan.action === 'blocked' && !existsSync(join(directory, phase + '-review.json'))) save(join(directory, phase + '-review.json'), { protocolHash, verdict: 'blocked', reason: plan.reason, reviewLedgerHash: hash(readFileSync(reviewPath)), observedAttempts: ledger.rows.length });
  save(statePath, state); console.log(JSON.stringify({ action: plan.action, id: plan.id ?? null, report: summarize() }));
  process.exit(plan.action === 'blocked' ? 2 : 0);
}
if (manifest.recoveryPolicy) {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $drive=Get-PSDrive -Name ([IO.Path]::GetPathRoot($env:CAMPAIGN_RESOURCE_ROOT).Substring(0,1)); [ordered]@{freePhysicalBytes=[long]$memory.AvailableBytes;freeCommitBytes=([long]$memory.CommitLimit-[long]$memory.CommittedBytes);freeDiskBytes=[long]$drive.Free}|ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, CAMPAIGN_RESOURCE_ROOT: directory } });
  if (probe.status !== 0) throw Error('Resource preflight failed: ' + (probe.error?.message ?? probe.stderr));
  const resources = JSON.parse(probe.stdout.trim()), admission = assessCampaignResources(resources, manifest.recoveryPolicy);
  save(join(directory, 'admission', phase + '-' + Date.now() + '.json'), { observedAt: new Date().toISOString(), protocolHash, slotId: plan.slot.id, resources, ...admission });
  if (!admission.passed) throw Error('Resource admission blocked before reservation: ' + admission.failures.join(', '));
}
state.status = 'running-' + phase; save(statePath, state);
try { await invocation(plan.slot, plan.attempt, plan.previous, plan.feedback); }
catch (error) {
  const row = state.slots.at(-1);
  if (row && !row.launch) row.status = 'preflight_failed';
  state.status = 'infrastructure_failed'; state.failures.push({ slotId: plan.slot.id, at: new Date().toISOString(), message: error.message, stack: error.stack });
  save(statePath, state); summarize(); throw error;
}
state.status = 'awaiting-review-' + phase; save(statePath, state); console.log(JSON.stringify(summarize()));
