import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WindowsSandbox } from '../../next/runtime/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compat = process.argv[2] === 'compat';
const missingProbe = process.argv[2] === 'missing';
const pointer = JSON.parse(readFileSync(join(root, 'docs/phase0-20261016/round.json'), 'utf8'));
const directory = join(root, 'next/.local/phase0-native-probes', randomUUID());
const output = join(root, 'docs/phase0-20261016/native-probe' + (compat ? '-compat' : missingProbe ? '-missing' : '') + '.json');
if (existsSync(output)) throw new Error('Probe evidence exists');
mkdirSync(directory, { recursive: true });
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), directory, providerInvocations: 0, cases: [] };
const cases = missingProbe ? [
  ['missing-program', ['--require', './.bridge-runtime/native-stdio.cjs', '-e', 'const p=require("node:child_process");console.log("before-missing");const r=p.spawnSync("phase0-no-such-executable",[],{encoding:"utf8",timeout:1000});console.log(JSON.stringify({status:r.status,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));']],
  ['checkpoint-traced', ['--require', './.bridge-runtime/native-stdio.cjs', '-e', 'const cp=require("node:child_process"),path=require("node:path");const pre=path.resolve(".bridge-runtime/native-stdio.cjs"),cli=".bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js";for(const args of [["task","start","Lifecycle probe","--goal","Verify lifecycle"],["file","lease-batch","src/clamp.mjs","--agent","codex","--compact"],["task","checkpoint","--agent","codex","--summary","Native probe","--tests","not_run","--files","src/clamp.mjs","--next","Finish probe"]]){console.log("before-cli",args.join(" "));const r=cp.spawnSync(process.execPath,["--require",pre,cli,...args],{encoding:"utf8",timeout:4000});console.log(JSON.stringify({status:r.status,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));if(r.status!==0)break;}']]
] : compat ? [
  ['test-no-isolation', ['--test', '--experimental-test-isolation=none', 'acceptance.test.mjs']],
  ['spawn-child', ['--require', './.bridge-runtime/native-stdio.cjs', '-e', 'const p=require("node:child_process");const r=p.spawnSync(process.execPath,["-e","console.log(123)"],{encoding:"utf8",timeout:3000});console.log(JSON.stringify({status:r.status,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));if(r.status!==0||r.stdout.trim()!=="123")process.exitCode=1;']],
  ['task-start', ['--require', './.bridge-runtime/native-stdio.cjs', './.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js', 'task', 'start', 'Native probe', '--goal', 'Verify unchanged legacy lifecycle', '--agent', 'codex']]
] : [
  ['test-default', ['--test', 'acceptance.test.mjs']],
  ['test-no-isolation', ['--test', '--experimental-test-isolation=none', 'acceptance.test.mjs']],
  ['spawn-child', ['-e', 'const p=require("node:child_process");console.log("before-spawn");const r=p.spawnSync(process.execPath,["-e","console.log(123)"],{encoding:"utf8",timeout:3000});console.log(JSON.stringify({status:r.status,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));']],
  ['task-start-traced', ['-e', 'const p=require("node:child_process");const original=p.execFileSync;p.execFileSync=(...a)=>{console.log("execFileSync-start",a[0]);try{return original(...a);}finally{console.log("execFileSync-end",a[0]);}};require("node:module").syncBuiltinESMExports();process.argv=[process.execPath,"cli","task","start","Native probe","--goal","Verify baseline runtime in isolation","--agent","codex"];import("./.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js");']]
];
for (const [id, args] of cases) {
  const workspace = join(directory, id), control = join(directory, id + '-supervisor');
  cpSync(join(pointer.directory, 'protocol/fixtures/small'), workspace, { recursive: true });
  cpSync(join(pointer.directory, 'protocol/bridge-runtime'), join(workspace, '.bridge-runtime'), { recursive: true });
  if (compat || missingProbe) cpSync(join(root, 'benchmarks/task-management/native-stdio.cjs'), join(workspace, '.bridge-runtime/native-stdio.cjs'));
  const init = spawnSync(process.execPath, ['.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js', 'init', '--no-claude-hooks', '--no-antigravity-hooks'], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (init.status !== 0) throw new Error('Probe init failed');
  const sandbox = new WindowsSandbox({ control, profileName: 'BridgeV2.NativeProbe.' + randomUUID() });
  const sentinel = join(control, 'sentinel.txt'); mkdirSync(control, { recursive: true }); writeFileSync(sentinel, 'protected probe evidence');
  const proof = sandbox.verify({ workspace, protectedFiles: ['authoritative', 'state', 'evidence', 'evaluator', 'other-workspace'].map(kind => ({ kind, path: sentinel })) });
  if (!proof.writerEnabled) throw new Error('Probe native boundary failed');
  const result = sandbox.run({ workspace, arguments: args, timeoutMs: 12000 });
  writeFileSync(join(control, 'stdout.log'), result.stdout); writeFileSync(join(control, 'stderr.log'), result.stderr);
  report.cases.push({ id, args, ...result });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ id, exitStatus: result.exitStatus, stdout: result.stdout.slice(0, 800), stderr: result.stderr.slice(0, 300), writersStopped: result.writersStopped }));
}
