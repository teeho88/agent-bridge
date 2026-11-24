import { lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { weightedCapTokens } from './comparison-attempts.mjs';
import { appContainerStoragePolicy, profileStorageLocation, safeProfileRelative } from './profile-storage.mjs';
import { proxyRouteAdmission } from './provider-route.mjs';

export const projectRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
export const campaignRoot = join(projectRoot, 'docs/phase8-2-remediation-20261019');

export function containedPath(target, root = projectRoot) {
  root = realpathSync(root);
  if (typeof target !== 'string' || !target || target.includes('\0') || /^[/\\]{2}/.test(target) || target.split(/[/\\]/).includes('..')) throw new Error('Unsafe path: ' + target);
  const absolute = resolve(root, target);
  const check = path => {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path outside root: ' + path);
  };
  check(absolute);
  let ancestor = absolute;
  while (true) {
    let stat;
    try { stat = lstatSync(ancestor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) check(realpathSync(ancestor));
    if (ancestor === root) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Path ancestor outside root');
    ancestor = parent;
  }
  return absolute;
}

export function createDirectory(target) {
  const path = containedPath(target);
  mkdirSync(path, { recursive: true });
  return containedPath(path);
}

export function childEnvironment(directory, inherited = process.env) {
  const home = createDirectory(join(directory, 'home'));
  const temp = createDirectory(join(directory, 'temp'));
  const cache = createDirectory(join(directory, 'cache'));
  return { ...inherited, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: home, APPDATA: home, CODEX_HOME: createDirectory(join(home, 'codex')),
    XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: home, npm_config_cache: cache,
    COREPACK_HOME: cache, PNPM_HOME: cache };
}

export function validateBudget(policy) {
  const mode = policy.budgetMode ?? 'capped';
  if (!['capped', 'unbounded'].includes(mode)) throw new Error('Invalid budget mode');
  for (const key of ['maxTokens', 'maxWeightedTokens']) {
    if (mode === 'unbounded' ? policy[key] !== null : !Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error('Invalid budget: ' + key);
  }
  if (!Number.isFinite(policy.outputTokenWeight) || policy.outputTokenWeight <= 0) throw new Error('Invalid output token weight');
  return mode;
}

export const webHighQuotaPolicy = 'web-high-no-local-quota-v1';

export function assessProviderQuota(rates, options = {}) {
  if (options.ignoreLocalQuota === true &&
      (options.model !== 'chatgpt-web/gpt-6-sol' || options.effort !== 'high'))
    throw new Error('Local quota override is restricted to GPT-6 Web High');
  const ignoreLocalQuota = options.ignoreLocalQuota === true;
  const minimumRemainingPercent = 20;
  const windows = ['primary', 'secondary'].filter(name => rates?.[name] != null).map(name => {
    const window = rates[name], used = window.usedPercent;
    const valid = Number.isFinite(used) && used >= 0 && used <= 100;
    return { name, usedPercent: used ?? null, remainingPercent: valid ? 100 - used : null,
      resetsAt: window.resetsAt ?? null, valid, sufficientHeadroom: valid && 100 - used >= minimumRemainingPercent };
  });
  const credits = rates?.credits, balance = credits?.balance;
  const ordinaryQuotaAvailable = windows.length > 0 && windows.every(window => window.valid && window.remainingPercent > 0);
  const sufficientHeadroom = windows.length > 0 && windows.every(window => window.sufficientHeadroom);
  const noPaidFallback = Boolean(credits && credits.unlimited === false &&
    (credits.hasCredits === false || (typeof balance === 'number' || typeof balance === 'string' && balance.trim() !== '') && Number(balance) === 0));
  return { policy: ignoreLocalQuota ? webHighQuotaPolicy : 'ordinary-quota-headroom-v1',
    localQuotaCheckBypassed: ignoreLocalQuota, minimumRemainingPercent, windows,
    ordinaryQuotaAvailable, sufficientHeadroom, noPaidFallback,
    passed: noPaidFallback && (ignoreLocalQuota || ordinaryQuotaAvailable && sufficientHeadroom) };
}

export function webHighPreflightAdmission(preflight) {
  return proxyRouteAdmission(preflight) && preflight?.model === 'chatgpt-web/gpt-6-sol' && preflight.effort === 'high' &&
    preflight.quotaAdmission?.policy === webHighQuotaPolicy &&
    preflight.quotaAdmission?.localQuotaCheckBypassed === true &&
    preflight.quotaAdmission?.passed === true && preflight.quotaAdmission?.noPaidFallback === true &&
    preflight.noPaidFallback === true &&
    preflight.selectorListAdmission === 'actual-thread-only-v1' &&
    preflight.threadModel === preflight.model && preflight.threadEffort === preflight.effort;
}

export function tokenBudgetExceeded(usage, policy) {
  if (validateBudget(policy) === 'unbounded') return false;
  return usage.inputTokens + usage.outputTokens > policy.maxTokens || weightedCapTokens(usage, policy.outputTokenWeight) > policy.maxWeightedTokens;
}

export function validateModel({ provider, model, effort }, capability = null) {
  if (provider === 'codex' && model === 'chatgpt-web/gpt-6-sol' && effort === 'high') return true;
  if (provider === 'codex' && model === 'gpt-6-luna' && effort === 'medium') return true;
  if (provider === 'agy' && model === 'gemini-3.8-flash-high' && effort === 'high' && capability?.provider === 'agy' && capability?.available === true && capability?.name === 'Gemini 3.8 Flash High' && capability?.resolvedId === model && capability?.effort === effort && capability?.evidenceHash?.match(/^[a-f0-9]{64}$/)) return true;
  throw new Error('Model/effort outside verified allowlist');
}

export function requireActualThreadSettings(thread, model, effort) {
  if (thread?.model !== model || thread?.reasoningEffort !== effort) throw new Error('Actual thread model/effort differs');
  return true;
}

export function requireProviderTurnCompletion(turn) {
  if (turn?.status === 'completed') return true;
  throw new Error(turn?.error?.message ?? ('Provider turn did not complete: ' + (turn?.status ?? 'missing')),
    { cause: turn?.error ?? null });
}

export function comparisonPointer(args = process.argv.slice(2)) {
  const index = args.indexOf('--pointer');
  if (index < 0) return join(projectRoot, 'docs/phase8-2-20261018/round.json');
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing --pointer value');
  return containedPath(args[index + 1]);
}

export function requireRootConfinement(proof, context = {}) {
  if (proof?.storagePolicy !== undefined && proof.storagePolicy !== appContainerStoragePolicy) throw Error('Unknown storage boundary policy');
  if (proof?.storagePolicy === appContainerStoragePolicy) {
    const storage = proof.privateStorage;
    const expected = profileStorageLocation(proof.profileName, proof.sid,
      process.env.PHASE8_HOST_LOCALAPPDATA ?? process.env.LOCALAPPDATA);
    if (proof.passed !== true || proof.root !== projectRoot || proof.boundaryVerified !== true ||
      proof.nativeBoundaryVerified !== true || proof.nativeStopVerified !== true ||
      proof.provisioningBoundaryVerified !== true || proof.providerEnvironmentVerified !== true ||
      proof.privateStorageAllowedVerified !== true || !storage ||
      storage.profileName !== expected.profileName || storage.sid !== expected.sid ||
      storage.packagePath?.toLowerCase() !== expected.packagePath.toLowerCase() || storage.registryPath !== expected.registryPath ||
      !Array.isArray(proof.externalWrites) || !proof.externalWrites.every(write => safeProfileRelative(write?.path)) ||
      !Array.isArray(proof.unexpectedExternalWrites) || proof.unexpectedExternalWrites.length !== 0 ||
      !proof.workspace || (context.workspace && resolve(context.workspace) !== resolve(proof.workspace)) ||
      (context.profileName && context.profileName !== proof.profileName) || (context.sid && context.sid !== proof.sid))
      throw Error('Registered workspace/AppContainer storage boundary required; identity mismatch or unapproved external writes');
    containedPath(proof.workspace);
    return true;
  }
  if (proof?.passed !== true || proof.root !== projectRoot || proof.rootConfinementVerified !== true ||
    proof.privateStorageWriteDenied !== true || proof.nativeStopVerified !== true ||
    !Array.isArray(proof.externalWrites) || proof.externalWrites.length !== 0) {
    throw new Error('Strict root confinement required: unchanged profile snapshots do not prove private-storage write denial');
  }
  return true;
}
