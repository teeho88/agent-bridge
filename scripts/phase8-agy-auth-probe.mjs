import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { projectRoot, campaignRoot, containedPath, createDirectory, childEnvironment } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { assessAllowedProfileStorage } from '../benchmarks/task-management/profile-storage.mjs';
import { WindowsSandbox } from '../next/runtime/src/sandbox.mjs';

const [installed, profileName, auditPath] = process.argv.slice(2);
if (!installed || !profileName || !auditPath) throw Error('Expected agy executable, existing AppContainer profile and fresh SID audit receipt');
const id = 'agy-auth-' + randomUUID().replaceAll('-', '').slice(0, 16);
const directory = createDirectory(join(campaignRoot, 'offline', id));
const scratch = createDirectory(join(directory, 'scratch')), workspace = createDirectory(join(scratch, 'workspace'));
const env = { ...childEnvironment(scratch), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
save('manifest.json', { id, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Native credential API probe, provider copy and isolated home/cache' }],
  sources: Object.fromEntries(['scripts/phase8-agy-auth-probe.mjs', 'scripts/phase8-profile-snapshot.ps1', 'next/runtime/src/windows-sandbox.cs', 'next/runtime/src/sandbox.mjs'].map(path => [path, hash(join(projectRoot, path))])) });
const sandbox = new WindowsSandbox({ control: createDirectory(join(directory, 'supervisor')), profileName, profileMode: 'existing', environment: env });
const report = { kind: 'auth-diagnosis-not-model-readiness', providerInferenceInvocations: 0, profileName, workspace, root: projectRoot, passed: false };
let before, boundary, nativeModels, nativeCredential, credentialAttempted = false, modelsAttempted = false;
function snapshot(label) {
  const command = captureCommand({ directory, id: label, executable: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-File', join(projectRoot, 'scripts/phase8-profile-snapshot.ps1')],
    cwd: projectRoot, env: { ...env, PHASE8_PROFILE_NAME: profileName, PHASE8_PROFILE_SID: report.sid, PHASE8_HOST_LOCALAPPDATA: process.env.LOCALAPPDATA } });
  if (command.exitCode !== 0) throw Error('Profile snapshot failed');
  return JSON.parse(readFileSync(command.stdout.path, 'utf8'));
}
try {
  const sid = sandbox.invoke({ operation: 'sid', name: profileName });
  report.sid = sid.receipt?.sid;
  const audit = JSON.parse(readFileSync(containedPath(auditPath), 'utf8'));
  const scope = JSON.parse(readFileSync(containedPath(audit.stdout.path), 'utf8'));
  if (!report.sid || audit.exitCode !== 0 || hash(audit.stdout.path) !== audit.stdout.hash || scope.sid !== report.sid || scope.passed !== true || scope.matches.length || scope.failures.length)
    throw Error('Matching successful SID scope audit required');
  report.scopeAudit = { path: auditPath, hash: hash(auditPath) };
  before = snapshot('profile-before');
  const provider = createDirectory(join(scratch, 'provider')), executable = join(provider, 'agy.exe');
  copyFileSync(installed, executable); report.binaryHash = hash(executable);
  for (const [label, argv] of [['version', ['--version']], ['help', ['--help']], ['models', ['models']], ['builtin-sandbox-models', ['--sandbox', 'models']]]) {
    const receipt = captureCommand({ directory, id: 'host-' + label, executable, argv, cwd: workspace, env, timeout: 20000 });
    report['host-' + label] = receipt;
  }
  const probeSource = join(provider, 'credential-api.cs'), probeExecutable = join(provider, 'credential-api.exe');
  writeFileSync(probeSource, `using System;
using System.Runtime.InteropServices;
class CredentialApi {
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  public static int Main(string[] args) {
    Guid parsed;
    if(args.Length!=1 || !Guid.TryParse(args[0],out parsed)) return 2;
    IntPtr value;
    bool found=CredRead("BridgeV2.NonexistentAuthProbe."+parsed.ToString(),1,0,out value);
    int error=found?0:Marshal.GetLastWin32Error();
    if(found) CredFree(value);
    Console.WriteLine("{\\"credentialFound\\":"+found.ToString().ToLowerInvariant()+",\\"win32Error\\":"+error+"}");
    return 0;
  }
}`, { flag: 'wx' });
  const compile = captureCommand({ directory, id: 'compile-probe', executable: join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    argv: ['/nologo', '/target:exe', '/out:' + probeExecutable, probeSource], cwd: projectRoot, env });
  if (compile.exitCode !== 0) throw Error('Credential API probe compilation failed');
  const nonce = randomUUID();
  report.hostCredential = captureCommand({ directory, id: 'host-credential-api', executable: probeExecutable, argv: [nonce], cwd: workspace, env });
  const protectedFiles = ['authoritative', 'state', 'evidence', 'evaluator', 'other-workspace'].map(kind => {
    const path = join(scratch, kind + '.txt'); writeFileSync(path, 'protected ' + kind, { flag: 'wx' }); return { kind, path };
  });
  const authPath = join(process.env.USERPROFILE, '.codex/auth.json');
  if (existsSync(authPath)) protectedFiles.push({ kind: 'auth', path: authPath });
  boundary = sandbox.verify({ workspace, protectedFiles, internetClient: true }); save('boundary.json', boundary);
  if (!boundary.writerEnabled) throw Error('Native boundary failed');
  for (const file of [executable, probeExecutable]) {
    const grant = captureCommand({ directory, id: file === executable ? 'grant-agy' : 'grant-probe', executable: 'icacls.exe', argv: [file, '/grant', '*' + report.sid + ':RX'], cwd: projectRoot, env });
    if (grant.exitCode !== 0) throw Error('Probe executable RX grant failed');
  }
  credentialAttempted = true;
  nativeCredential = sandbox.run({ workspace, executable: probeExecutable, arguments: [nonce], timeoutMs: 15000 });
  save('native-credential-api.json', nativeCredential);
  modelsAttempted = true;
  nativeModels = sandbox.run({ workspace, executable, arguments: ['models'], timeoutMs: 20000 });
  save('native-agy-models.json', nativeModels);
  report.hostKeyringModelsAvailable = readFileSync(report['host-models'].stdout.path, 'utf8').includes('gemini-3.8-flash-high') && report['host-models'].exitCode === 0;
  report.nativeModelsAvailable = nativeModels.exitStatus === 0 && nativeModels.stdout.includes('gemini-3.8-flash-high');
  report.hostCredentialResult = JSON.parse(readFileSync(report.hostCredential.stdout.path, 'utf8'));
  report.nativeCredentialResult = nativeCredential.exitStatus === 0 ? JSON.parse(nativeCredential.stdout) : null;
  report.nativeStopVerified = nativeCredential.writersStopped === true && nativeCredential.activeProcesses === 0 && nativeModels.writersStopped === true && nativeModels.activeProcesses === 0;
} catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  if (before) {
    try { report.storageAssessment = assessAllowedProfileStorage(before, snapshot('profile-after'), { profileName, sid: report.sid }); }
    catch (error) { report.snapshotError = error.message; }
  }
  report.passed = !report.error && report.hostKeyringModelsAvailable === true && report.nativeStopVerified === true && report.storageAssessment?.privateStorageAllowedVerified === true;
  save('report.json', report);
  const noNative = !boundary?.nativeCanaryAttempted;
  const stopped = boundary?.verifiedChildStop === true && (!credentialAttempted || nativeCredential?.writersStopped === true) && (!modelsAttempted || nativeModels?.writersStopped === true);
  if (noNative || stopped) captureCommand({ directory, id: 'cleanup', executable: process.execPath, argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env });
  else save('cleanup-pending.json', { target: scratch, reason: 'Native stop not verified' });
}
console.log(JSON.stringify({ directory, passed: report.passed, hostKeyringModelsAvailable: report.hostKeyringModelsAvailable, nativeModelsAvailable: report.nativeModelsAvailable, hostCredentialResult: report.hostCredentialResult, nativeCredentialResult: report.nativeCredentialResult, error: report.error?.message }));
process.exitCode = report.passed ? 0 : 2;
