import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { campaignRoot, projectRoot, createDirectory, childEnvironment } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { agyCapability } from '../benchmarks/task-management/agy-stream.mjs';
import { configureAgyBuiltin, agyBuiltinArguments, agyBuiltinBackend, agySettingsHash } from '../benchmarks/task-management/agy-builtin.mjs';
import { WindowsHostJob } from '../next/runtime/src/host-job.mjs';

const installed = process.argv[2];
if (!installed) throw Error('Expected installed agy executable');
const id = 'agy-builtin-' + randomUUID().slice(0, 8), directory = createDirectory(join(campaignRoot, 'offline', id));
const scratch = createDirectory(join(directory, 'scratch')), workspace = createDirectory(join(scratch, 'workspace')), env = childEnvironment(scratch);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sources = ['scripts/phase8-agy-builtin-preflight.mjs', 'benchmarks/task-management/agy-builtin.mjs', 'next/runtime/src/host-job.mjs', 'next/runtime/src/windows-sandbox.cs', 'next/runtime/src/windows-sandbox.ps1'];
save('manifest.json', { id, registeredTemporary: [{ owner: id, path: scratch, purpose: 'Host coordinator configuration/provider/startup probes' }], sources: Object.fromEntries(sources.map(p => [p, hash(join(projectRoot, p))])) });
const protectedPaths = ['source', 'evaluator', 'evidence', 'sibling'].map(name => {
  const file = join(scratch, name + '.txt'); writeFileSync(file, 'protected ' + name, { flag: 'wx' }); return file;
});
const config = configureAgyBuiltin({ workspace, protectedPaths }); save('configuration.json', { ...config, settings: JSON.parse(readFileSync(config.settingsPath)) });
const provider = createDirectory(join(scratch, 'provider')), executable = join(provider, 'agy.exe'); copyFileSync(installed, executable);
const job = new WindowsHostJob({ control: createDirectory(join(directory, 'supervisor')), environment: env, coordinatorTrusted: true });
const runs = [], report = { backend: agyBuiltinBackend, passed: false, workspace, binaryHash: hash(executable), settingsHash: config.settingsHash,
  hostAuthenticationVerified: false, commandBoundaryVerified: false, fileToolsBoundaryVerified: false,
  noHostCommandFallbackVerified: false, nativeStopVerified: false, noPaidFallbackVerified: false, noPromptSubmitted: true };
async function run(label, target, args, maxSessionMs = 15000, runId = null) {
  const transport = job.start({ workspace, executable: target, arguments: args, maxSessionMs, runId });
  const receipt = await transport.closed; runs.push(receipt);
  save(label + '.json', receipt);
  if (receipt.writersStopped !== true || receipt.activeProcesses !== 0 || receipt.hostCoordinator !== true) throw Error('Host job stop unverified');
  return { ...receipt, stdout: readFileSync(receipt.stdoutPath, 'utf8'), stderr: readFileSync(receipt.stderrPath, 'utf8') };
}
try {
  const marker = join(workspace, 'child-ready'), late = join(workspace, 'late-write');
  const childCode = 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"ready");setTimeout(()=>require("node:fs").writeFileSync(' + JSON.stringify(late) + ',"escaped"),2500)';
  const parentCode = 'const f=require("node:fs"),c=require("node:child_process");c.spawn(process.execPath,["-e",' + JSON.stringify(childCode) + '],{stdio:"ignore"}).unref();const t=setInterval(()=>{if(f.existsSync(' + JSON.stringify(marker) + ')){clearInterval(t);process.exit(0)}},20)';
  const lifecycle = await run('lifecycle', process.execPath, ['-e', parentCode]);
  report.nativeStopVerified = lifecycle.exitStatus === 0 && lifecycle.totalProcesses >= 2 && existsSync(marker) && !existsSync(late);
  const version = await run('version', executable, ['--version']);
  const help = await run('help', executable, ['--help']);
  const models = await run('models', executable, ['--sandbox', 'models'], 25000);
  save('settings-after-models.json', JSON.parse(readFileSync(config.settingsPath, 'utf8')));
  const capability = agyCapability(models.stdout, help.stdout + help.stderr, report.binaryHash); save('capability.json', capability);
  report.hostAuthenticationVerified = models.exitStatus === 0 && capability.available;
  if (!report.nativeStopVerified || !report.hostAuthenticationVerified || version.exitStatus !== 0) throw Error('Lifecycle/auth/capability prerequisite failed');
  const startup = await run('startup-empty-stream', executable, [...agyBuiltinArguments({ capability }), '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''], 12000);
  report.startup = { exitStatus: startup.exitStatus, timedOut: startup.timedOut, stdout: startup.stdout, stderr: startup.stderr };
  const files = [];
  function walk(path) { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push({ path: file, hash: hash(file) }); else throw Error('Unexpected link in coordinator home'); } }
  walk(join(workspace, '.bridge-home')); save('home-inventory.json', files);
  report.settingsRawUnchanged = hash(config.settingsPath) === config.settingsRawHash;
  const effective = JSON.parse(readFileSync(config.settingsPath, 'utf8'));
  save('settings-after-startup.json', effective);
  report.effectiveSettingsHash = agySettingsHash(effective);
  report.settingsSecurityUnchanged = report.effectiveSettingsHash === config.settingsHash;
  report.unsupportedOptionalSettingsOmitted = ['allowNonWorkspaceAccess', 'useG1Credits'];
  report.coreSettingsRetained = effective.enableTerminalSandbox === true && effective.toolPermission === 'proceed-in-sandbox' &&
    JSON.parse(readFileSync(join(directory, 'configuration.json'))).settings.permissions.deny.every(rule => effective.permissions?.deny?.includes(rule));
  if (process.argv.includes('--hook-probe')) {
    const hookId = randomUUID(), stopPath = join(directory, 'supervisor', hookId + '.stop');
    const hooksPath = createDirectory(join(workspace, '.bridge-home/.gemini/config'));
    const hookScript = join(directory, 'boundary-hooks.cjs'), hookEvents = join(directory, 'hook-events.jsonl');
    const worker = join(workspace, 'canary-worker.cjs'), entry = join(workspace, 'canary-entry.cjs'), shellProof = join(workspace, 'shell-proof.json');
    copyFileSync(join(projectRoot, 'next/runtime/src/canary-worker.cjs'), worker);
    const guard = protectedPaths.map((path, index) => ({ path, kind: ['authoritative', 'evaluator', 'evidence', 'other-workspace'][index] }));
    writeFileSync(entry, `const f=require('node:fs'),c=require('node:child_process');const r=c.spawnSync(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(JSON.stringify(guard))},'parent',${JSON.stringify(join(workspace, 'hook-late-marker'))}],{encoding:'utf8'});f.writeFileSync(${JSON.stringify(shellProof)},JSON.stringify({exitCode:r.status,stdout:r.stdout,stderr:r.stderr}));process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;`, { flag: 'wx' });
    const command = '"' + process.execPath + '" "' + entry + '"';
    const injected = [{ toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: workspace, WaitMsBeforeAsync: 10000 } } },
      { toolCall: { name: 'view_file', args: { AbsolutePath: protectedPaths[0] } } },
      { toolCall: { name: 'write_to_file', args: { TargetFile: join(workspace, 'file-tool-positive.txt'), Overwrite: true, CodeContent: 'allowed', Description: 'Boundary positive control' } } },
      { toolCall: { name: 'write_to_file', args: { TargetFile: protectedPaths[1], Overwrite: true, CodeContent: 'denied-write-attempt', Description: 'Protected dummy canary' } } }];
    writeFileSync(hookScript, `const f=require('node:fs');const event=process.argv[2],input=JSON.parse(f.readFileSync(0,'utf8'));f.appendFileSync(${JSON.stringify(hookEvents)},JSON.stringify({event,input})+'\\n');if(event==='SessionStart'){console.log(JSON.stringify({injectSteps:${JSON.stringify(injected)}}));}else if(event==='PreInvocation'){f.writeFileSync(${JSON.stringify(stopPath)},'stop-before-model');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}else{console.log('{}');}`, { flag: 'wx' });
    const hookCommand = event => '"' + process.execPath + '" "' + hookScript + '" ' + event;
    const hooks = { 'boundary-probe': { SessionStart: [{ type: 'command', command: hookCommand('SessionStart'), timeout: 10 }],
      PreInvocation: [{ type: 'command', command: hookCommand('PreInvocation'), timeout: 30 }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('PostToolUse'), timeout: 10 }] }] } };
    writeFileSync(join(hooksPath, 'hooks.json'), JSON.stringify(hooks, null, 2), { flag: 'wx' }); save('hooks-config.json', hooks);
    const result = await run('hook-stream-empty', executable, [...agyBuiltinArguments({ capability }), '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''], 15000, hookId);
    report.offlineHookProbe = { exitStatus: result.exitStatus, timedOut: result.timedOut, eventsObserved: existsSync(hookEvents), shellExecuted: existsSync(shellProof), noNonemptyPromptSubmitted: true };
    if (existsSync(shellProof)) { copyFileSync(shellProof, join(directory, 'shell-proof.json')); }
    save('settings-after-hooks.json', JSON.parse(readFileSync(config.settingsPath, 'utf8')));
  }
  report.blockers = ['No verified offline interface executed builtin shell and file-tool boundary canaries; metadata/startup alone is insufficient'];
} catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  save('preflight.json', report);
  if (runs.length && runs.every(r => r.writersStopped === true && r.activeProcesses === 0)) {
    const cleanup = captureCommand({ directory, id: 'cleanup', executable: process.execPath, argv: ['scripts/phase8-cleanup-retry.mjs', directory], cwd: projectRoot, env });
    if (cleanup.exitCode !== 0) process.exitCode = 2;
  } else save('cleanup-pending.json', { target: scratch, reason: 'Host job stop unverified' });
}
console.log(JSON.stringify({ directory, passed: report.passed, hostAuthenticationVerified: report.hostAuthenticationVerified, nativeStopVerified: report.nativeStopVerified, startup: report.startup, error: report.error?.message }));
if (!report.passed) process.exitCode = 2;
