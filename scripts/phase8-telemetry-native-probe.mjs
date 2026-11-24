import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WindowsSandbox} from '../next/runtime/src/sandbox.mjs';
import {scopeEntries,writeCompressedScopeInput,profileSnapshot} from '../benchmarks/task-management/identity-pool.mjs';
import {assessAllowedProfileStorage} from '../benchmarks/task-management/profile-storage.mjs';
import {captureCommand} from '../benchmarks/task-management/command-evidence.mjs';
import {childEnvironment} from '../benchmarks/task-management/remediation-policy.mjs';
import {createInvocationTelemetry,readInvocationTelemetry} from '../benchmarks/task-management/invocation-telemetry.mjs';

const root=resolve('.'),read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const id='telemetry-native-'+randomUUID(),folder=join(root,'docs',id),workspace=join(root,'.local',id,'workspace');
const evidence=join(folder,'evidence');mkdirSync(evidence,{recursive:true});mkdirSync(workspace,{recursive:true});
const save=(name,value)=>writeFileSync(join(folder,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const pairIndex=process.argv.indexOf('--identity-pair');
const pairPath=resolve(pairIndex<0?'docs/phase8-2-remediation-20261019/manifests/native-identity-pair-76af363a-9d51-4260-8e74-efc842d0453c.json':process.argv[pairIndex+1]);
const pair=read(pairPath);
assert.equal(pair.kind,'native-existing-identity-pair-v1');assert.equal(pair.root,root);
assert.equal(hash(pair.discovery.path),pair.discovery.hash);
const identity=pair.entries.find(x=>x.key==='native-B');assert.ok(identity);
const env=childEnvironment(join(workspace,'.bridge-home'));
const sandbox=new WindowsSandbox({control:join(evidence,'supervisor'),profileName:identity.profileName,profileMode:'existing',environment:env});
const report={id,root,folder,workspace,identityProvenance:{path:pairPath,sha256:hash(pairPath)},profileName:identity.profileName,sid:identity.sid,modelCallsAdded:0,inference:false,nativeLaunchAttempted:false,passed:false};
let transport=null,stop=null,granted=false;
save('started.json',report);console.log(JSON.stringify({stage:'scope-enumeration',folder}));
try{
  const scope=scopeEntries(workspace);
  report.scopeInput=await writeCompressedScopeInput(join(evidence,'scope.json.gz'),{...scope,sid:identity.sid});
  console.log(JSON.stringify({stage:'scope-audit',entries:scope.entries.length}));
  const receipt=captureCommand({directory:evidence,id:'scope-audit',executable:'pwsh.exe',argv:['-NoProfile','-NonInteractive','-File',join(root,'scripts/phase8-sid-scope.ps1'),'-InputFile',report.scopeInput.path],cwd:root,env,timeout:300000});
  report.scopeReceipt=receipt;report.scope=read(receipt.stdout.path);
  assert.equal(receipt.exitCode,0);assert.equal(report.scope.passed,true);
  const before=profileSnapshot({directory:evidence,id:'profile-before',identity,env});
  const protectedFiles=['authoritative','state','evidence','evaluator','other-workspace'].map(kind=>{
    const path=join(evidence,kind+'.sentinel');writeFileSync(path,'protected '+kind,{flag:'wx'});return {kind,path};
  });
  const hostJournal=join(evidence,'host-journal.jsonl'),host=createInvocationTelemetry({file:hostJournal,binding:{protocolHash:id,slotId:'host',attemptId:id}});
  host.checkpoint('native-probe');host.close();const hostHash=hash(hostJournal);
  protectedFiles.find(x=>x.kind==='evidence').path=hostJournal;
  console.log(JSON.stringify({stage:'native-boundary'}));
  report.nativeLaunchAttempted=true;granted=true;
  report.boundary=sandbox.verify({workspace,protectedFiles,internetClient:false});
  assert.equal(report.boundary.writerEnabled,true,JSON.stringify({reason:report.boundary.reason,steps:report.boundary.steps.map(x=>({operation:x.operation,exitStatus:x.exitStatus,stderr:x.stderr}))}));
  copyFileSync(join(root,'benchmarks/task-management/invocation-telemetry.mjs'),join(workspace,'invocation-telemetry.mjs'));
  const worker=join(workspace,'worker.mjs');
  writeFileSync(worker,`import fs from 'node:fs';import {createInvocationTelemetry} from './invocation-telemetry.mjs';
const protectedPath=process.argv[2],id=process.argv[3];let readDenied=false,writeDenied=false;
try{fs.readFileSync(protectedPath);}catch{readDenied=true;}try{fs.appendFileSync(protectedPath,'forbidden');}catch{writeDenied=true;}
const j=createInvocationTelemetry({file:'native-journal.jsonl',binding:{protocolHash:id,slotId:'native',attemptId:id}});j.bind({runId:id,threadId:'synthetic-thread',turnId:'synthetic-turn'});
j.observe({method:'thread/tokenUsage/updated',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',tokenUsage:{total:{inputTokens:123,cachedInputTokens:20,outputTokens:7}}}});
j.startHeartbeat({intervalMs:100});console.log(JSON.stringify({ready:true,readDenied,writeDenied,counterSource:'synthetic-native-probe',cwd:process.cwd()}));setInterval(()=>{},1000);
`,{flag:'wx'});
  transport=sandbox.start({workspace,executable:process.execPath,arguments:[worker,hostJournal,id],maxSessionMs:30000});
  let stdout='',ready=null;const deadline=Date.now()+20000;
  while(Date.now()<deadline&&!ready){stdout+=transport.read().toString('utf8');for(const line of stdout.trim().split(/\r?\n/)){try{const item=JSON.parse(line);if(item.ready)ready=item;}catch{}}if(!ready)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'Native journal worker did not become ready');report.worker=ready;
  assert.equal(ready.readDenied,true);assert.equal(ready.writeDenied,true);assert.equal(resolve(ready.cwd),workspace);
  await new Promise(resolve=>setTimeout(resolve,350));
  stop=await transport.stop();report.nativeStop=stop;
  assert.equal(stop.writersStopped,true);assert.equal(stop.activeProcesses,0);assert.equal(stop.appContainer,true);
  const journal=join(workspace,'native-journal.jsonl');
  report.recovered=readInvocationTelemetry(journal,{protocolHash:id,slotId:'native',attemptId:id});
  assert.equal(report.recovered.usageStatus,'partial');assert.equal(report.recovered.finalUsage,null);
  assert.equal(report.recovered.timing.implementationMs,null);assert.equal(report.recovered.timing.elapsedMs,null);
  assert.ok(report.recovered.timing.elapsedObservedMs>0);assert.equal(hash(hostJournal),hostHash);
  copyFileSync(journal,join(evidence,'native-journal.jsonl'));report.journalHash=hash(journal);
  const after=profileSnapshot({directory:evidence,id:'profile-after',identity,env});
  report.storage=assessAllowedProfileStorage(before,after,identity);assert.equal(report.storage.privateStorageAllowedVerified,true);
  assert.deepEqual(report.storage.unexpectedExternalWrites,[]);
  report.passed=true;
}catch(error){report.error={message:error.message,stack:error.stack};}
finally{
  if(transport&&!stop){try{stop=await transport.stop();report.nativeStop=stop;}catch(error){report.stopError=error.message;report.passed=false;}}
  if(granted){
    const rel=relative(root,workspace);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    const revoke=captureCommand({directory:evidence,id:'revoke-owned-grant',executable:'icacls.exe',argv:[workspace,'/remove:g','*'+identity.sid,'/T','/C'],cwd:root,env,timeout:30000});
    report.revoke=revoke;if(revoke.exitCode!==0)report.passed=false;
  }
  if(!report.nativeLaunchAttempted||stop?.writersStopped===true&&stop.activeProcesses===0){
    for(const name of ['.bridge-home','.bridge-tmp']){
      const target=resolve(workspace,name),rel=relative(workspace,target);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
      if(existsSync(target))rmSync(target,{recursive:true});
    }
    report.cleanup={passed:!existsSync(join(workspace,'.bridge-home'))&&!existsSync(join(workspace,'.bridge-tmp')),sessionsCreated:0,leasesCreated:0};
  }else{report.cleanup={passed:false,reason:'Native stop not verified'};report.passed=false;}
  save('result.json',report);console.log(JSON.stringify({folder,passed:report.passed,error:report.error?.message??null,modelCallsAdded:0}));
  if(!report.passed)process.exitCode=1;
}
