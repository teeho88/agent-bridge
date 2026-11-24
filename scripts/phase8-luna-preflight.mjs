import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectRoot, campaignRoot, createDirectory, childEnvironment, containedPath, requireRootConfinement, assessProviderQuota, webHighPreflightAdmission } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { WindowsSandbox } from '../next/runtime/src/sandbox.mjs';
import { CodexRpc } from '../next/adapter-codex/src/rpc.mjs';
import { assessAllowedProfileStorage } from '../benchmarks/task-management/profile-storage.mjs';
import { powershellWorkspaceCommand } from '../benchmarks/task-management/powershell-cwd.mjs';
import { readHostProxyRoute, proxyConfigArgs } from '../benchmarks/task-management/provider-route.mjs';

const [installed, profileName, auditPath] = process.argv.slice(2);
if (!installed || !profileName || !auditPath) throw Error('Expected codex executable, existing profile and SID scope audit receipt');
const webHigh = process.argv.includes('--web-high');
const id = (webHigh ? 'web-high-pf-' : 'luna-pf-') + randomUUID().replaceAll('-', '').slice(0, 16), directory = createDirectory(join(campaignRoot, 'offline', id));
const scratch = createDirectory(join(directory, 'scratch'));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
const env = childEnvironment(scratch, inherited);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => hash(readFileSync(path));
const credentials = new Set();
const redact = value => typeof value === 'string' ? [...credentials].reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value) : value;
const json = value => JSON.stringify(value, (_key, item) => redact(item), 2);
const save = (name, value) => writeFileSync(join(directory, name), json(value) + '\n', { flag: 'wx' });
save('manifest.json', { id, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Native provider workspace, executable copies, compiler/cache/home' }],
  sources: Object.fromEntries(['next/runtime/src/sandbox.mjs', 'next/runtime/src/session-policy.mjs', 'next/runtime/src/windows-sandbox.cs', 'next/runtime/src/windows-sandbox.ps1', 'next/adapter-codex/src/rpc.mjs', 'scripts/phase8-luna-preflight.mjs', 'scripts/phase8-profile-snapshot.ps1', 'benchmarks/task-management/powershell-cwd.mjs', 'benchmarks/task-management/profile-storage.mjs', 'benchmarks/task-management/remediation-policy.mjs'].map(path => [path, fileHash(join(projectRoot, path))])) });
const provider = createDirectory(join(scratch, 'provider')), workspace = createDirectory(join(scratch, 'workspace'));
const executable = join(provider, 'codex.exe');
for (const name of ['codex.exe', 'codex-code-mode-host.exe']) copyFileSync(join(dirname(installed), name), join(provider, name));
const sandbox = new WindowsSandbox({ control: createDirectory(join(directory, 'supervisor')), profileName, profileMode: 'existing', environment: env });
const report = { passed: false, model: webHigh ? 'chatgpt-web/gpt-6-sol' : 'gpt-6-luna', effort: webHigh ? 'high' : 'medium', providerInferenceInvocations: 0, providerProcessInvocations: 0, root: projectRoot,
  providerInvocations: 0, inferenceStarted: false, node: process.version, nodeHash: fileHash(process.execPath),
  executable: resolve(installed), providerHash: fileHash(installed), codeModeHostHash: fileHash(join(dirname(installed), 'codex-code-mode-host.exe')), workspace, profileName };
const shell = { schemaVersion: 1, observedAt: new Date().toISOString(), passed: false, providerInvocations: 0, inferenceStarted: false,
  workspace, profileName, compatibility: 'powershell-workspace-psdrive-v1',
  bootstrapHash: fileHash(join(projectRoot, 'benchmarks/task-management/powershell-cwd.mjs')), node: null, powershell: null };
const stopped = result => result?.appContainer === true && result.writersStopped === true && result.activeProcesses === 0;
let rpc, transport, boundary, before, shellStopSafe = true;
function snapshot(label, sid) {
  const receipt = captureCommand({ directory, id: label, executable: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-File', join(projectRoot, 'scripts/phase8-profile-snapshot.ps1')], cwd: projectRoot,
    env: { ...env, PHASE8_PROFILE_NAME: profileName, PHASE8_PROFILE_SID: sid, PHASE8_HOST_LOCALAPPDATA: process.env.LOCALAPPDATA } });
  if (receipt.exitCode !== 0) throw Error('Profile snapshot failed');
  return JSON.parse(readFileSync(receipt.stdout.path, 'utf8'));
}
function tokens() {
  let auth;
  try { auth = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.codex/auth.json'), 'utf8')); }
  catch { throw Error('Existing host ChatGPT credentials unreadable; no fallback'); }
  for (const secret of Object.values(auth.tokens ?? {})) if (typeof secret === 'string' && secret) credentials.add(secret);
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token || !auth.tokens?.account_id) throw Error('Existing host ChatGPT credentials unavailable; no fallback');
  return { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id };
}
try {
  if (webHigh) {
    report.proxyRoute = readHostProxyRoute(join(process.env.USERPROFILE, '.codex/config.toml'));
    report.proxyRouteSourceHash = fileHash(join(projectRoot, 'benchmarks/task-management/provider-route.mjs'));
  }
  if (fileHash(executable) !== report.providerHash || fileHash(join(provider, 'codex-code-mode-host.exe')) !== report.codeModeHostHash) throw Error('Installed provider copy hash mismatch');
  const sid = sandbox.invoke({ operation: 'sid', name: profileName });
  if (!sid.receipt?.sid) throw Error('Existing SID unavailable');
  report.sid = sid.receipt.sid;
  shell.sid = report.sid;
  const audit = JSON.parse(readFileSync(containedPath(auditPath), 'utf8'));
  const scope = JSON.parse(readFileSync(containedPath(audit.stdout.path), 'utf8'));
  if (audit.exitCode !== 0 || fileHash(audit.stdout.path) !== audit.stdout.hash || scope.passed !== true || scope.sid !== report.sid || scope.matches.length || scope.failures.length) throw Error('Matching successful SID scope audit required');
  report.scopeAudit = { path: auditPath, hash: fileHash(auditPath), checked: scope.checked };
  before = snapshot('profile-before', report.sid);
  if (!before.mappingExists) throw Error('Preprovisioned profile required');
  for (const [label, args] of [['version', ['--version']], ['schema-help', ['app-server', 'generate-json-schema', '--help']]]) {
    report.providerProcessInvocations++;
    const receipt = captureCommand({ directory, id: label, executable, argv: args, cwd: projectRoot, env });
    if (receipt.exitCode !== 0) throw Error('Installed provider capability failed: ' + label);
  }
  const schemaDirectory = createDirectory(join(directory, 'schema'));
  report.providerProcessInvocations++;
  const schemas = captureCommand({ directory, id: 'schema-generate', executable, argv: ['app-server', 'generate-json-schema', '--out', schemaDirectory, '--experimental'], cwd: projectRoot, env });
  if (schemas.exitCode !== 0) throw Error('Installed provider schema generation failed');
  const protectedFiles = ['authoritative', 'state', 'evidence', 'evaluator', 'other-workspace'].map(kind => {
    const path = join(scratch, kind + '.txt'); writeFileSync(path, 'protected ' + kind, { flag: 'wx' }); return { kind, path };
  });
  const authPath = join(process.env.USERPROFILE, '.codex/auth.json');
  if (existsSync(authPath)) protectedFiles.push({ kind: 'auth', path: authPath });
  boundary = sandbox.verify({ workspace, protectedFiles, internetClient: true }); save('boundary.json', boundary);
  if (!boundary.writerEnabled) throw Error('Native boundary failed');
  shell.boundary = boundary;
  writeFileSync(join(workspace, 'sentinel.txt'), 'workspace sentinel', { flag: 'wx' });
  shellStopSafe = false;
  shell.node = sandbox.run({ workspace, executable: process.execPath,
    arguments: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),sentinel:require("node:fs").readFileSync("sentinel.txt","utf8")}))'], timeoutMs: 15000 });
  shellStopSafe = stopped(shell.node);
  if (!shellStopSafe) throw Error('Native Node probe stop unverified');
  shellStopSafe = false;
  shell.powershell = sandbox.run({ workspace, executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    arguments: ['-NoProfile', '-NonInteractive', '-Command', powershellWorkspaceCommand('$ErrorActionPreference="Stop"; Set-Content -LiteralPath "shell-write.txt" -Value "shell write"; [ordered]@{cwd=(Get-Location).ProviderPath;processCwd=[Environment]::CurrentDirectory;sentinel=(Test-Path -LiteralPath "sentinel.txt");written=(Get-Content -LiteralPath "shell-write.txt")} | ConvertTo-Json -Compress')], timeoutMs: 15000 });
  shellStopSafe = stopped(shell.powershell);
  const nodeOutput = JSON.parse(shell.node.stdout.trim()), shellOutput = JSON.parse(shell.powershell.stdout.trim());
  const samePath = path => typeof path === 'string' && path.replace(/[\\/]+$/, '').toLowerCase() === workspace.replace(/[\\/]+$/, '').toLowerCase();
  shell.nativeStopVerified = stopped(shell.node) && stopped(shell.powershell);
  shell.capabilityPassed = shell.nativeStopVerified && [shell.node, shell.powershell].every(result => result.exitStatus === 0 && result.timedOut === false) &&
    samePath(nodeOutput.cwd) && nodeOutput.sentinel === 'workspace sentinel' && samePath(shellOutput.cwd) && samePath(shellOutput.processCwd) &&
    shellOutput.sentinel === true && shellOutput.written === 'shell write' && readFileSync(join(workspace, 'shell-write.txt'), 'utf8').trim() === 'shell write';
  if (!shell.capabilityPassed) throw Error('Native Node/PowerShell bootstrap preflight failed');
  if (webHigh) {
    const healthUrl = new URL('/healthz', report.proxyRoute.baseUrl).href;
    const probe = sandbox.run({ workspace, executable: process.execPath, timeoutMs: 15000,
      arguments: ['-e', '(async()=>{try{const r=await fetch(' + JSON.stringify(healthUrl) + ',{signal:AbortSignal.timeout(5000)});const d=await r.json();console.log(JSON.stringify({passed:r.ok&&d.service==="codex-chatgpt-web",status:r.status,service:d.service}));}catch(e){console.log(JSON.stringify({passed:false,error:e.message,code:e.cause?.code??null}));}})()'] });
    report.proxyHealth = { ...JSON.parse(probe.stdout.trim()), nativeStopVerified: stopped(probe) };
    save('proxy-health.json', { ...report.proxyHealth, probe });
    if (!report.proxyHealth.passed || !report.proxyHealth.nativeStopVerified)
      throw Error('AppContainer cannot reach the pinned local proxy; verify per-SID loopback exemption');
  }
  const grant = captureCommand({ directory, id: 'helper-grant', executable: 'icacls.exe', argv: [join(provider, 'codex-code-mode-host.exe'), '/grant', '*' + report.sid + ':RX'], cwd: projectRoot, env });
  if (grant.exitCode !== 0) throw Error('Code-mode helper grant failed');
  transport = sandbox.start({ workspace, executable, readOnlyExecutable: true, maxSessionMs: 180000, arguments: ['app-server', '--listen', 'stdio://',
    ...(webHigh ? proxyConfigArgs(report.proxyRoute) : []),
    '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'model="' + report.model + '"', '-c', 'model_reasoning_effort="' + report.effort + '"', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '--disable', 'hooks', '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'multi_agent_v2_dynamic_tools', '--disable', 'memories', '--disable', 'skill_search', '--disable', 'in_app_browser', '--disable', 'computer_use'] });
  report.providerProcessInvocations++;
  rpc = new CodexRpc(transport);
  rpc.on('request', message => {
    if (message.method === 'account/chatgptAuthTokens/refresh') {
      try { rpc.send({ id: message.id, result: tokens() }); }
      catch { rpc.send({ id: message.id, error: { code: -32000, message: 'Host authentication unavailable' } }); }
    } else rpc.send({ id: message.id, error: { code: -32600, message: 'No interactive approvals or extra tools in preflight' } });
  });
  rpc.on('failure', () => {});
  await rpc.request('initialize', { clientInfo: { name: 'phase8_preflight', version: '1.0.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
  const requirements = await rpc.request('configRequirements/read');
  report.requirements = requirements; save('requirements.json', requirements);
  const allowed = requirements.requirements?.allowedApprovalPolicies;
  if (Array.isArray(allowed) && !allowed.includes('never')) throw Error('Managed requirements disallow approvalPolicy never');
  const login = await rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...tokens() });
  report.hostBrokerAuthenticated = login.type === 'chatgptAuthTokens';
  if (!report.hostBrokerAuthenticated) throw Error('Host token RPC was not accepted');
  const models = webHigh ? { data: [], skipped: true, reason: 'Local proxy selector is verified through actual thread settings' } :
    await rpc.request('model/list', { includeHidden: false, limit: 100 }); save('models.json', models);
  const match = models.data?.find(model => model.id === report.model || model.model === report.model);
  report.modelAvailable = Boolean(match);
  report.effortAvailable = match?.supportedReasoningEfforts?.some(value => value.reasoningEffort === report.effort) === true;
  report.selectorListAdmission = webHigh ? 'actual-thread-only-v1' : 'advertised-only-v1';
  const limits = await rpc.request('account/rateLimits/read'); save('quota.json', limits);
  report.quotaAdmission = assessProviderQuota(limits.rateLimits, webHigh ?
    { model: report.model, effort: report.effort, ignoreLocalQuota: true } : {});
  report.quotaAvailable = report.quotaAdmission.ordinaryQuotaAvailable;
  report.noPaidFallback = report.quotaAdmission.noPaidFallback;
  const admissionBlockers = [
    ...(!webHigh && !report.modelAvailable ? ['Requested model selector absent from provider model/list'] : []),
    ...(!webHigh && !report.effortAvailable ? ['Requested reasoning effort unavailable for selected model'] : []),
    ...(!report.quotaAdmission.passed ? ['Quota admission/no-paid-fallback gate failed'] : []),
  ];
  report.admissionBlockers = admissionBlockers;
  if (admissionBlockers.length) throw Error(admissionBlockers.join('; '));
  const thread = await rpc.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', model: report.model,
    config: { model_reasoning_effort: report.effort }, dynamicTools: [], ephemeral: true });
  save('thread.json', thread);
  report.threadModel = thread.model; report.threadEffort = thread.reasoningEffort ?? null;
  const config = await rpc.request('config/read', { includeLayers: false });
  report.effectiveConfig = Object.fromEntries(['model', 'model_provider', 'openai_base_url', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode', 'cli_auth_credentials_store'].map(key => [key, config.config?.[key] ?? null]));
  save('effective-config.json', report.effectiveConfig);
} catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  if (rpc) { try { report.nativeStop = await rpc.close(); } catch (error) { report.stopError = error.message; } }
  else if (transport) { try { report.nativeStop = await transport.stop(); } catch (error) { report.stopError = error.message; } }
  if (before) {
    try { Object.assign(report, assessAllowedProfileStorage(before, snapshot('profile-after', report.sid), { profileName, sid: report.sid, localAppData: process.env.LOCALAPPDATA })); }
    catch (error) { report.snapshotError = error.message; }
  }
  try {
    report.binaryBindingVerified = fileHash(process.execPath) === report.nodeHash && fileHash(report.executable) === report.providerHash &&
      fileHash(join(dirname(report.executable), 'codex-code-mode-host.exe')) === report.codeModeHostHash &&
      fileHash(executable) === report.providerHash && fileHash(join(provider, 'codex-code-mode-host.exe')) === report.codeModeHostHash;
  } catch { report.binaryBindingVerified = false; }
  report.capabilityPassed = !report.error && report.binaryBindingVerified && boundary?.writerEnabled === true && report.hostBrokerAuthenticated === true &&
    (webHigh ? webHighPreflightAdmission(report) : report.modelAvailable === true && report.effortAvailable === true && report.quotaAvailable === true && report.quotaAdmission?.passed === true && report.noPaidFallback === true) &&
    report.threadModel === report.model && (webHigh ? report.threadEffort === report.effort : report.threadEffort === null || report.threadEffort === report.effort) &&
    stopped(report.nativeStop) && shell.capabilityPassed === true;
  report.rootConfinementVerified = false;
  report.nativeBoundaryVerified = boundary?.verifiedWriteBoundary === true && boundary?.verifiedChildStop === true;
  report.nativeStopVerified = stopped(report.nativeStop) && shell.nativeStopVerified === true;
  report.providerEnvironmentVerified = boundary?.writerEnabled === true;
  report.provisioningBoundaryVerified = boundary?.profileExisting === true && boundary?.profileProvisioningSkipped === true;
  report.boundaryVerified = report.nativeBoundaryVerified && report.privateStorageAllowedVerified === true;
  report.passed = report.capabilityPassed && report.boundaryVerified && report.nativeStopVerified;
  if (report.passed) {
    try { requireRootConfinement(report, { workspace, profileName, sid: report.sid }); }
    catch (error) { report.passed = false; report.policyError = error.message; }
  }
  report.blockers = report.passed ? [] : [report.error?.message, report.policyError,
    !report.privateStorageAllowedVerified ? 'Registered private-storage identity/snapshot not verified' : null,
    !report.capabilityPassed ? 'Provider capability/auth/quota/stop preflight incomplete' : null].filter(Boolean);
  shell.privateStorageAllowedVerified = report.privateStorageAllowedVerified === true;
  shell.passed = shell.capabilityPassed === true && report.boundaryVerified === true && report.provisioningBoundaryVerified === true &&
    shellStopSafe && (!transport || stopped(report.nativeStop));
  if (!shell.passed) shell.error = report.error?.message ?? report.snapshotError ?? 'Native shell/storage preflight incomplete';
  save('shell-preflight.json', shell);
  report.shellPreflight = { path: join(directory, 'shell-preflight.json'), hash: fileHash(join(directory, 'shell-preflight.json')), passed: shell.passed };
  save('preflight.json', report);
  const noProvider = !transport && !boundary?.nativeCanaryAttempted;
  if (shellStopSafe && (noProvider || stopped(report.nativeStop) || !transport && boundary?.verifiedChildStop === true)) {
    const cleanup = captureCommand({ directory, id: 'cleanup', executable: process.execPath, argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env });
    if (cleanup.exitCode !== 0) report.cleanupPending = true;
  } else save('cleanup-pending.json', { target: scratch, reason: 'Native process stop not proven' });
}
console.log(json({ directory, preflight: join(directory, 'preflight.json'), shellPreflight: join(directory, 'shell-preflight.json'),
  passed: report.passed, modelAvailable: report.modelAvailable ?? null, error: report.error?.message ?? null }));
process.exitCode = report.passed ? 0 : 2;
