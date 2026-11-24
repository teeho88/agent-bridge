import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { projectRoot, campaignRoot, containedPath, createDirectory, childEnvironment } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { validateIdentityPool, workspaceKey } from '../benchmarks/task-management/identity-pool.mjs';
import { profileStorageLocation } from '../benchmarks/task-management/profile-storage.mjs';
import { diagnosticSchedules } from '../benchmarks/task-management/diagnostic-plan.mjs';

export function campaignSchedules() {
  const slots = (repetition, branch) => [['small', 1], ['debug', 1], ['multi', 1], ['handoff', 1], ['handoff', 2]]
    .map(([taskId, stage]) => ({ id: `${branch}-${repetition}-${taskId}-${stage}`, branch, repetition, taskId, stage }));
  return {
    smoke: ['B', 'S'].flatMap(branch => slots(0, branch).filter(slot => slot.taskId === 'small' || slot.taskId === 'handoff')),
    formal: [1, 2, 3, 4, 5].flatMap(repetition => (repetition % 2 ? ['B', 'S'] : ['S', 'B']).flatMap(branch => slots(repetition, branch))),
  };
}

export function selectIdentityPool(discovery, audit, schedules = campaignSchedules(), root = projectRoot, diagnosticPlan = null, excludedSids = []) {
  if (discovery?.schemaVersion !== 1 || discovery.scanComplete !== true || !Array.isArray(discovery.candidates)) throw Error('Incomplete registry discovery');
  const candidates = discovery.candidates;
  for (const candidate of candidates) profileStorageLocation(candidate.profileName, candidate.sid, candidate.localAppData);
  const sids = [...new Set(candidates.map(candidate => candidate.sid))].sort();
  if (audit?.schemaVersion !== 1 || audit.root !== root || audit.scanComplete !== true ||
      !Number.isSafeInteger(audit.checked) || audit.checked < 1 || !Array.isArray(audit.failures) || audit.failures.length ||
      !Array.isArray(audit.matches) || !Array.isArray(audit.links) || JSON.stringify(audit.candidateSids) !== JSON.stringify(sids)) throw Error('Incomplete or unbound project ACL audit');
  for (const link of audit.links) {
    containedPath(link.path, root);
    containedPath(link.target, root);
  }
  if (!Array.isArray(excludedSids) || excludedSids.some(sid => typeof sid !== 'string' || !sids.includes(sid)) ||
      new Set(excludedSids).size !== excludedSids.length) throw Error('Invalid excluded identity SIDs');
  const rejected = new Set(excludedSids);
  for (const match of audit.matches) {
    if (!sids.includes(match.sid) || typeof match.path !== 'string' || !match.path) throw Error('Invalid ACL match');
    rejected.add(match.sid);
  }
  const profiles = new Map(), counts = new Map();
  for (const candidate of candidates) {
    const name = candidate.profileName.toLowerCase();
    profiles.set(name, (profiles.get(name) ?? 0) + 1);
    counts.set(candidate.sid, (counts.get(candidate.sid) ?? 0) + 1);
  }
  const clean = candidates.filter(candidate => !rejected.has(candidate.sid) && counts.get(candidate.sid) === 1 && profiles.get(candidate.profileName.toLowerCase()) === 1)
    .sort((a, b) => a.profileName.toLowerCase().localeCompare(b.profileName.toLowerCase(), 'en') || a.sid.localeCompare(b.sid, 'en'));
  const keys = [...new Set(Object.entries(schedules).flatMap(([phase, slots]) => slots.map(slot => workspaceKey(phase, slot))))];
  if (diagnosticPlan) {
    if (JSON.stringify(schedules) !== JSON.stringify(diagnosticSchedules(diagnosticPlan)) || keys.length !== 6) throw Error('Unexpected diagnostic schedule');
  } else if (schedules.smoke.length !== 6 || schedules.formal.length !== 50 || keys.length !== 44) throw Error('Unexpected campaign schedule');
  if (clean.length < keys.length) throw Error(`Need ${keys.length} unique identities with no project ACL grants; found ${clean.length} of ${candidates.length}`);
  return validateIdentityPool({ schemaVersion: 1, entries: keys.map((key, index) => ({ key, ...clean[index] })) }, schedules);
}

export function registerIdentityPool() {
  if (process.platform !== 'win32') throw Error('Windows AppContainer registry discovery required');
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--diagnostic-plan', '--exclude-pool'].includes(arg)) ||
      args.filter(arg => arg === '--diagnostic-plan').length > 1 || args.filter(arg => arg === '--exclude-pool').length > 1) {
    throw Error('Usage: node scripts/phase8-register-identity-pool.mjs [--diagnostic-plan path] [--exclude-pool path]');
  }
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const planPath = option('--diagnostic-plan') ? containedPath(resolve(option('--diagnostic-plan')), join(campaignRoot, 'diagnostics')) : null;
  const exclusionPath = option('--exclude-pool') ? containedPath(resolve(option('--exclude-pool')), join(campaignRoot, 'offline')) : null;
  const priorPool = exclusionPath ? JSON.parse(readFileSync(exclusionPath, 'utf8')) : null;
  if (priorPool && (priorPool.schemaVersion !== 1 || !Array.isArray(priorPool.entries) ||
      priorPool.entries.some(entry => typeof entry.sid !== 'string' || typeof entry.profileName !== 'string'))) {
    throw Error('Invalid prior identity pool for exclusion');
  }
  const excludedSids = priorPool ? [...new Set(priorPool.entries.map(entry => entry.sid))] : [];
  const plan = planPath ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  const schedules = plan ? diagnosticSchedules(plan) : campaignSchedules();
  const requiredIdentities = new Set(Object.entries(schedules).flatMap(([phase, slots]) => slots.map(slot => workspaceKey(phase, slot)))).size;
  const id = 'identity-pool-' + randomUUID();
  const directory = containedPath(join(campaignRoot, 'offline', id));
  createDirectory(join(campaignRoot, 'offline'));
  mkdirSync(directory);
  const scratch = join(directory, 'scratch');
  const helper = join(projectRoot, 'scripts/phase8-register-identity-pool.ps1');
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const save = (name, value) => {
    const path = containedPath(join(directory, name));
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return { path, hash: hash(path) };
  };
  const registeredTemporary = [{ path: scratch, owner: id, purpose: 'Child environment scratch; remove after captured processes stop' }];
  save('manifest.json', { schemaVersion: 1, id, directory, registeredTemporary });
  const hostLocalAppData = process.env.PHASE8_HOST_LOCALAPPDATA ?? process.env.LOCALAPPDATA;
  if (!hostLocalAppData || !existsSync(hostLocalAppData)) throw Error('Existing host LOCALAPPDATA required for registered AppContainer identities');
  const env = { ...childEnvironment(createDirectory(scratch)), PHASE8_HOST_LOCALAPPDATA: hostLocalAppData };
  const cleanupScript = join(projectRoot, 'scripts/phase8-cleanup-retry.mjs');
  const sources = [fileURLToPath(import.meta.url), helper, cleanupScript, process.execPath, ...['identity-pool.mjs', 'profile-storage.mjs', 'remediation-policy.mjs', 'provider-route.mjs', 'command-evidence.mjs', 'compare-run.mjs']
    .map(name => join(projectRoot, 'benchmarks/task-management', name)), join(projectRoot, 'benchmarks/task-management/diagnostic-plan.mjs'), ...(planPath ? [planPath] : []), ...(exclusionPath ? [exclusionPath] : [])];
  const sourceHashes = Object.fromEntries(sources.map(path => [path, hash(path)]));
  const receipts = [];
  let error = null, output = null, pool = null;
  try {
    const run = (mode, extra = []) => {
      const receipt = captureCommand({ directory, id: mode.toLowerCase(), executable: 'pwsh.exe',
        argv: ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', mode, ...extra], cwd: scratch, env, timeout: 1800000 });
      receipts.push(receipt);
      if (receipt.exitCode !== 0 || receipt.error || receipt.signal) throw Error(`${mode} failed; inspect ${join(directory, mode.toLowerCase(), 'command.json')}`);
      return JSON.parse(readFileSync(receipt.stdout.path, 'utf8').replace(/^\uFEFF/, ''));
    };
    const discovery = run('Discover');
    if (discovery.scanComplete !== true || !Array.isArray(discovery.candidates)) throw Error('Incomplete discovery');
    for (const candidate of discovery.candidates) profileStorageLocation(candidate.profileName, candidate.sid, candidate.localAppData);
    if (discovery.candidates.length < requiredIdentities) throw Error(`Need at least ${requiredIdentities} existing registry mappings; found ${discovery.candidates.length}`);
    const input = save('audit-input.json', { root: projectRoot, candidates: discovery.candidates });
    const audit = run('Audit', ['-InputFile', input.path]);
    pool = selectIdentityPool(discovery, audit, schedules, projectRoot, plan, excludedSids);
    if (sources.some(path => hash(path) !== sourceHashes[path])) throw Error('Source provenance changed during registration');
    const provenance = save('provenance.json', { id, createdAt: new Date().toISOString(), root: projectRoot, node: process.version,
      sourceHashes, schedules, ...(planPath ? { diagnosticPlan: { path: planPath, hash: hash(planPath) }, formalPermitted: false } : {}),
      ...(exclusionPath ? { excludedPool: { path: exclusionPath, hash: hash(exclusionPath), sids: excludedSids } } : {}),
      auditInput: input, receipts: [...receipts], registeredTemporary,
      policy: 'Existing registry mappings only; reject every existing project Allow ACE; follow contained reparse targets once; fail closed on scan errors and external or unresolved reparse targets',
      providerInferenceInvocations: 0, profileMutations: 0, aclMutations: 0 });
    pool = { ...pool, provenance };
  } catch (failure) { error = failure.stack; }
  let cleanup = null;
  try {
    if (receipts.some(receipt => receipt.error || receipt.signal || receipt.exitCode === null)) throw Error('Cannot certify captured process stop for scratch cleanup');
    cleanup = captureCommand({ directory, id: 'cleanup', executable: process.execPath, argv: [cleanupScript, directory], cwd: directory, env });
    receipts.push(cleanup);
    if (cleanup.exitCode !== 0 || cleanup.error || cleanup.signal || existsSync(scratch)) throw Error('Scratch cleanup failed; inspect cleanup receipts');
  } catch (failure) { error = [error, failure.stack].filter(Boolean).join('\n'); }
  if (!error) output = save('identity-pool.json', { ...pool, cleanup: { path: join(directory, 'cleanup', 'command.json'), hash: hash(join(directory, 'cleanup', 'command.json')) } });
  const report = { id, directory, passed: !error, output, sourceHashes, receipts, error };
  save('registration-report.json', report);
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = registerIdentityPool().passed ? 0 : 2; }
  catch (error) { console.error(error.stack); process.exitCode = 2; }
}
