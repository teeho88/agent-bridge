import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {captureCommand} from '../benchmarks/task-management/command-evidence.mjs';
import {childEnvironment} from '../benchmarks/task-management/remediation-policy.mjs';
import {readInvocationTelemetry} from '../benchmarks/task-management/invocation-telemetry.mjs';

const root=resolve('.'),nativeFolder=resolve(process.argv[2]),read=file=>JSON.parse(readFileSync(file,'utf8'));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),ref=path=>({path,sha256:sha(path)});
const native=read(join(nativeFolder,'result.json'));
assert.equal(native.root,root);assert.equal(native.passed,true);assert.equal(native.modelCallsAdded,0);assert.equal(native.inference,false);
assert.equal(native.scope.passed,true);assert.deepEqual(native.scope.matches,[]);assert.deepEqual(native.scope.failures,[]);
for(const key of ['writerEnabled','verifiedWriteBoundary','verifiedChildStop','profileExisting','profileProvisioningSkipped'])assert.equal(native.boundary[key],true);
assert.equal(native.boundary.steps.find(x=>x.operation==='derive-sid').receipt.sid,native.sid);
for(const key of ['readDenied','writeDenied','ready'])assert.equal(native.worker[key],true);
assert.equal(native.worker.counterSource,'synthetic-native-probe');
assert.equal(native.nativeStop.appContainer,true);assert.equal(native.nativeStop.writersStopped,true);assert.equal(native.nativeStop.activeProcesses,0);
assert.equal(native.nativeStop.internetClient,false);assert.equal(native.revoke.exitCode,0);assert.equal(native.cleanup.passed,true);
assert.equal(native.storage.privateStorageAllowedVerified,true);assert.deepEqual(native.storage.unexpectedExternalWrites,[]);
const journal=join(nativeFolder,'evidence/native-journal.jsonl');assert.equal(sha(journal),native.journalHash);
const recovered=readInvocationTelemetry(journal,{protocolHash:native.id,attemptId:native.id,slotId:'native'});
assert.deepEqual(recovered,native.recovered);assert.equal(recovered.finalUsage,null);assert.equal(recovered.usageStatus,'partial');
assert.equal(recovered.timing.elapsedMs,null);assert.equal(recovered.timing.implementationMs,null);
const hostJournal=native.boundary.protectedScope.find(x=>x.kind==='evidence');assert.equal(sha(hostJournal.path),hostJournal.hash);
const basePath=join(root,'docs/phase8-telemetry-readiness-20261114/result.json'),base=read(basePath);
const probePath=join(root,'scripts/phase8-telemetry-native-probe.mjs');
for(const item of [...base.sources,...base.localDependencies,...base.preservedClosedCohort.inputs,base.checks.pipeline.tap]){
  if(item.path===probePath)continue;
  assert.equal(sha(item.path),item.sha256);
}
const oldProbe=base.sources.find(x=>x.path===probePath);assert.ok(oldProbe);
assert.equal(sha(join(root,'docs/phase8-telemetry-readiness-20261114/sources/phase8-telemetry-native-probe.mjs')),oldProbe.sha256);
const evidence=join(nativeFolder,'evidence'),scopePath=join(evidence,'post-revoke-scope-input.json'),entries=[];
function walk(path){entries.push({path,directory:true});for(const item of readdirSync(path,{withFileTypes:true})){const file=join(path,item.name);assert.equal(item.isSymbolicLink(),false);if(item.isDirectory())walk(file);else entries.push({path:file,directory:false});}}
walk(native.workspace);writeFileSync(scopePath,JSON.stringify({sid:native.sid,entries,readOnlyExecutables:[]})+'\n',{flag:'wx'});
const checkEnvPath=join(evidence,'post-revoke-env'),env=childEnvironment(checkEnvPath);
let receipt;
try{receipt=captureCommand({directory:evidence,id:'post-revoke-scope',executable:'pwsh.exe',argv:['-NoProfile','-NonInteractive','-File',join(root,'scripts/phase8-sid-scope.ps1'),'-InputFile',scopePath],cwd:root,env,timeout:30000});}
finally{const rel=relative(evidence,resolve(checkEnvPath));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(checkEnvPath,{recursive:true});}
assert.equal(receipt.exitCode,0);const revokeAudit=read(receipt.stdout.path);assert.equal(revokeAudit.passed,true);assert.deepEqual(revokeAudit.matches,[]);
for(const command of [receipt,native.scopeReceipt,native.revoke])for(const stream of [command.stdout,command.stderr])assert.equal(sha(stream.path),stream.hash);
const output=join(root,'docs/phase8-telemetry-native-ready-20261114');assert.equal(existsSync(output),false);mkdirSync(join(output,'sources'),{recursive:true});
const sources=base.sources.map(x=>ref(x.path)),dependencies=base.localDependencies.map(x=>ref(x.path));
for(const source of sources)copyFileSync(source.path,join(output,'sources',source.path.split(/[\\/]/).at(-1)));
const manifest={schemaVersion:1,createdAt:new Date().toISOString(),status:'ready-for-future-freeze',readyForFutureFreeze:true,
  parent:{result:ref(basePath),sourceManifest:ref(join(root,'docs/phase8-telemetry-readiness-20261114/source-manifest.json'))},
  entrypoints:base.entrypoints,sources,sourceArchives:sources.map(x=>ref(join(output,'sources',x.path.split(/[\\/]/).at(-1)))),localDependencies:dependencies,
  driverAmendment:{path:probePath,parentHash:oldProbe.sha256,currentHash:sha(probePath),reason:'Use the provenance-bound native identity pair instead of a cohort evaluator identity with retained historical grants.'},
  checks:{offline:{passed:true,tests:base.checks.pipeline.tests,tap:base.checks.pipeline.tap,sourceHashesRechecked:true},
    native:{passed:true,result:ref(join(nativeFolder,'result.json')),journal:ref(journal),hostJournal:ref(hostJournal.path),
      postRevokeAudit:{...ref(receipt.stdout.path),checked:revokeAudit.checked},profileName:native.profileName,scopeEntries:native.scope.checked,
      permissionsVerified:true,stopVerified:true,interruptedReadbackVerified:true,cleanupPassed:true,activeProcesses:0}},
  priorFailedNativeAttempt:ref(join(root,'docs/telemetry-native-752e1148-7354-430b-8858-877227e6c0fe/result.json')),
  preservedClosedCohort:{hashesUnchanged:true,measurementComplete:false,releasePassed:false,inputs:base.preservedClosedCohort.inputs},
  modelCallsAdded:0,operationalFreezeCreated:false,benchmarkRerun:false,generator:ref(fileURLToPath(import.meta.url))};
writeFileSync(join(output,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const md=`# Native telemetry retry — 14/11/2026

Native probe PASS; revision được đánh dấu **readyForFutureFreeze=true**. Chỉ xác nhận sẵn sàng chuẩn bị freeze trong tương lai; không tạo operational freeze, không gọi model và không đo lại benchmark.

- Pipeline offline50/50 PASS được giữ và toàn bộ source hashes liên quan đã đối chiếu lại.
- Native AppContainer với existing registered identity; audit${native.scope.checked}entries,0matches/0failures. Native canary xác minh write boundary và child-stop.
- Sandbox ghi được journal trong workspace; đọc/ghi host journal bên ngoài bị từ chối. Host journal giữ nguyên hash.
- Worker bị dừng có receipt AppContainer,writersStopped=true,activeProcesses=0,internetClient=false. Đọc lại journal giữ observed counter/checkpoint; finalUsage,implementationMs,elapsedMs đều null khi thiếu terminal/final endpoint. Counter là synthetic probe data, không phải usage model.
- Cleanup cache PASS, không tạo session/lease. Đã revoke owned grant và audit lại workspace${revokeAudit.checked}entries,0matches/0failures. Profile storage policy PASS, không có unexpected external writes.

Lần thử đầu sau mở quyền đã đọc được toàn bộ scope nhưng phát hiện1415historical grants của identity evaluator cũ. Giữ nguyên grants và evidence đó; không chạy sandbox với identity này. Probe chuyển sang native identity pair có provenance và audit mới sạch; thay đổi chỉ ở probe driver. Những lần thất bại trước giữ nguyên kết luận lịch sử.

[Source manifest, hashes, entrypoints và evidence references](source-manifest.json).

Cohort8.2 đã chốt giữ measurementComplete=false/releasePassed=false. Readiness của revision tương lai không thay thế các phép đo còn thiếu của cohort cũ.
`;
writeFileSync(join(output,'report.md'),md,{flag:'wx'});
for(const item of base.preservedClosedCohort.inputs)assert.equal(sha(item.path),item.sha256);
console.log(JSON.stringify({report:join(output,'report.md'),manifest:join(output,'source-manifest.json'),readyForFutureFreeze:true,nativePassed:true,activeProcesses:0,modelCallsAdded:0}));
