import { remediationScope } from '../benchmarks/task-management/remediation-scope.mjs';
import { DatabaseSync } from 'node:sqlite';
import { containedPath } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { canonicalEvidence, verifySourceEvidence, validatePublishedIssues, validateWorkflowHistory } from '../benchmarks/task-management/comparison-evidence.mjs';
import { createProviderObservationKeys, signCompletedCommandObservation } from '../benchmarks/task-management/provider-observations.mjs';
const root=process.cwd(), out=containedPath(process.argv[2]), area=join(out,'cli-integration');
mkdirSync(area);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const buildIndex=process.argv.indexOf('--build-manifest');
const buildPath=buildIndex<0?null:containedPath(process.argv[buildIndex+1]);
const build=buildPath?json(buildPath):null;
if(build&&build.passed!==true)throw Error('Successful independent build required');
const production=join(area,'candidate-runtime/node_modules'), visited=new Set();
function pack(source) {
  source=realpathSync(source); const pkg=json(join(source,'package.json'));
  if(visited.has(pkg.name))return; visited.add(pkg.name);
  cpSync(source,join(production,pkg.name),{recursive:true,dereference:true,filter:p=>{
    const parts=relative(source,p).split(/[\\/]/);
    return !parts.includes('node_modules')&&(!pkg.name.startsWith('@agent-bridge/')||!parts[0]||['dist','package.json'].includes(parts[0]));
  }});
  const require=createRequire(join(source,'package.json'));
  for(const dep of Object.keys(pkg.dependencies??{})) {
    let entry;try{entry=require.resolve(dep+'/package.json');}catch{entry=require.resolve(dep);}
    let location=dirname(entry);
    while(!existsSync(join(location,'package.json'))||json(join(location,'package.json')).name!==dep){const parent=dirname(location);if(parent===location)throw Error('Missing '+dep);location=parent;}
    pack(location);
  }
}
if(!build)pack(join(root,'packages/cli'));
const baseline=json(resolve('docs/phase8-recovery-20261019/validated/baseline.json'));
const baselineManifest=json(baseline.protocol);
const baselineFrozen=join(baseline.directory,'protocol');
for(const [p,h] of Object.entries(baselineManifest.frozen))assert.equal(hash(join(baselineFrozen,p)),h,'Immutable baseline '+p);
if(build)for(const branch of ['B','S'])for(const [path,digest]of Object.entries(build.branches[branch].runtimeHashes))assert.equal(hash(join(containedPath(build.branches[branch].runtime),path)),digest,'Fresh runtime binding '+branch+'/'+path);
const commands=[],results=[];
for(const profile of remediationScope.profiles) for(const branch of ['B','S']) {
  const workspace=join(area,profile,branch);mkdirSync(join(workspace,'src'),{recursive:true});
  cpSync(build?containedPath(build.branches[branch].runtime):branch==='B'?join(baselineFrozen,'bridge-runtime'):join(area,'candidate-runtime'),join(workspace,'.bridge-runtime'),{recursive:true});
  const cli=join(workspace,'.bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js');
  const helpers=join(workspace,'.bridge-runtime/evidence');mkdirSync(helpers,{recursive:true});
  for(const name of ['agent-evidence-command.cjs','agent-verify.mjs','comparison-evidence.mjs','provider-observations.mjs'])cpSync(join(root,'benchmarks/task-management',name),join(helpers,name));
  function sessionConfig(){
    const config=json(join(workspace,'.agent-memory/config.json')),database=join(workspace,'.agent-memory/runtime.db');
    if(existsSync(database)){const db=new DatabaseSync(database,{readOnly:true});try{return {...config,...JSON.parse(db.prepare('SELECT payload FROM workspace_runtime WHERE id=1').get().payload)};}finally{db.close();}}
    return config;
  }
  const sessionBindings=[];
  function run(name,args){
    const receipt=captureCommand({directory:workspace,id:name,executable:process.execPath,argv:[cli,...args],cwd:workspace,env:process.env});
    commands.push({profile,branch,name,args,...receipt});assert.equal(receipt.exitCode,0,readFileSync(receipt.stderr.path,'utf8'));return readFileSync(receipt.stdout.path,'utf8');
  }
  function captured(name,argv,expectedExit,startupContext){
    const spec=join(workspace,'.handoff',name+'.spec.json');
    save(spec,{id:name,executable:process.execPath,argv,...(startupContext?{startupContext}:{})});
    const receipt=captureCommand({directory:workspace,id:'capture-'+name,executable:process.execPath,argv:[join(helpers,'agent-evidence-command.cjs'),spec],cwd:workspace,env:process.env});
    assert.equal(receipt.exitCode,expectedExit,readFileSync(receipt.stdout.path,'utf8')+readFileSync(receipt.stderr.path,'utf8'));
    const path='.handoff/commands/'+name+'/command.json',command=json(join(workspace,path));
    commands.push({profile,branch,name,kind:'helper',...receipt});
    return{path,command,receiptHash:hash(join(workspace,path)),output:readFileSync(receipt.stdout.path,'utf8')};
  }
  const startupCalls=[];
  function startup(name,args){
    mkdirSync(join(workspace,'.handoff'),{recursive:true});
    const contextId='context-startup-'+name,contextPath='.bridge-runtime/evidence/'+contextId+'.json';
    save(join(workspace,contextPath),{id:contextId,executable:process.execPath,argv:[cli,'context','startup','--agent',profile],timeoutMs:30000});
    const result=captured(name,[cli,...args],0,{path:contextPath,hash:hash(join(workspace,contextPath))});
    startupCalls.push({command:'node agent-evidence-command.cjs '+name,aggregatedOutput:result.output,exitCode:0});
  }
  run('init',['init','--no-claude-hooks','--no-antigravity-hooks']);
  startup('start',['task','start','CLI evidence integration','--goal','Verify portable evidence','--agent',profile]);
  const source=join(workspace,'src/a.mjs');writeFileSync(source,'export const value=0;\n');
  const original={'src/a.mjs':hash(source)};let predecessor=null;const issues=[];
  const observationKeys=createProviderObservationKeys();
  writeFileSync(join(helpers,'provider-observation-public.pem'),observationKeys.publicKey);
  const observationArtifacts=[];
  mkdirSync(join(workspace,'.handoff/provider-observations'),{recursive:true});
  for(const [id,exitCode,failureMode] of [['direct-nonzero',7,'nonzero'],['direct-inner-error',0,'reviewed-inner-error']]){
    const script=join(workspace,'.handoff',id+'.cjs');
    writeFileSync(script,"process.stdout.write('Error: Tiếng Việt direct readback failure\\r\\n');process.exitCode="+exitCode+";\n");
    const raw=captureCommand({directory:workspace,id,executable:process.execPath,argv:[script],cwd:workspace,env:process.env});
    commands.push({profile,branch,name:id,kind:'direct-observation',...raw});assert.equal(raw.exitCode,exitCode);
    const command=JSON.stringify([process.execPath,script]),output=readFileSync(raw.stdout.path,'utf8');
    const envelope={at:raw.finishedAt,message:{method:'item/completed',params:{threadId:'cli-'+branch,turnId:'cli-turn-'+branch,
      item:{id,type:'commandExecution',command,aggregatedOutput:output,status:exitCode?'failed':'completed',exitCode,cwd:workspace}}}};
    const path='.handoff/provider-observations/'+id+'.json';
    save(join(workspace,path),signCompletedCommandObservation(envelope,{protocolHash:'a'.repeat(64),runId:'cli-'+branch,
      threadId:'cli-'+branch,turnId:'cli-turn-'+branch,attemptId:'cli-attempt-'+branch,attempt:1},observationKeys.privateKey));
    observationArtifacts.push(path);
    issues.push({id,attempt:1,command,actualOutput:output,correction:'Read corrected bound artifacts before publication',reference:path,
      verificationStatus:'verified',outputReference:{kind:'provider-completed-command',eventId:id,path,hash:hash(join(workspace,path)),failureMode}});
  }
  for(let stage=1;stage<=3;stage++) {
    if(stage>1){
      const prior=sessionConfig(),taskId=prior.currentTasks?.[profile]??prior.currentTaskId,sessionId=prior.currentSessions?.[profile];
      assert.ok(taskId&&sessionId,'Bound predecessor task/session');
      const currentBefore=readFileSync(join(workspace,'.handoff/CURRENT.md'),'utf8');
      run('session-end-before-'+stage,['session','end','--agent',profile,'--id',sessionId]);
      startup('session-start-'+stage,['session','start','--task',taskId,'--agent',profile]);
      const current=sessionConfig();assert.equal(current.currentTasks?.[profile]??current.currentTaskId,taskId);
      assert.notEqual(current.currentSessions?.[profile],sessionId);assert.ok(current.currentSessions?.[profile]);
      assert.equal(readFileSync(join(workspace,'.handoff/CURRENT.md'),'utf8'),currentBefore,'Session continuation preserves final handoff');
    }
    const session=sessionConfig();sessionBindings.push({stage,taskId:session.currentTasks?.[profile]??session.currentTaskId,sessionId:session.currentSessions?.[profile]});
    const before={'src/a.mjs':hash(source)};writeFileSync(source,`export const value=${stage};\n`);
    const final={'src/a.mjs':hash(source)};
    const claim={predecessorStatus:predecessor?'matched':'absent',reason:predecessor?'Bound prior publish':'First task has no predecessor',files:{'src/a.mjs':{originalBefore:original['src/a.mjs'],predecessorFinal:predecessor?.['src/a.mjs']??null,actualBefore:before['src/a.mjs'],final:final['src/a.mjs']}}};
    const handoff=join(workspace,'.handoff');mkdirSync(handoff,{recursive:true});
    const checkpoint=run('checkpoint-'+stage,['task','checkpoint','--summary','Before final publish','--tests','Integration evidence check','--agent',profile]);
    writeFileSync(join(handoff,'checkpoint-'+stage+'.txt'),checkpoint);
    save(join(handoff,'source-claims.json'),claim);save(join(handoff,'errors.json'),issues);
    writeFileSync(join(workspace,'RESULT.md'),JSON.stringify(claim)+' '+issues.map(issue=>issue.id).join(' '));
    const payload={summary:'Tiếng Việt '+JSON.stringify(claim)+' '+issues.map(issue=>issue.id).join(' '),done:['Checkpoint before publish'],next:[],risks:[],filesChanged:['src/a.mjs'],evidence:[{command:'hash',result:'computed',cases:0,artifact:'.handoff/source-claims.json'},{command:'checkpoint',result:'saved',cases:0,artifact:'.handoff/checkpoint-'+stage+'.txt'},{command:'verify',result:'ledger',cases:0,artifact:'.handoff/errors.json'}],decisions:[{decision:'Use portable evidence',reason:'Verify full artifact binding'}],unresolved:[]};
    for(const artifact of observationArtifacts)payload.evidence.push({command:'signed direct command',result:'actual failure retained and corrected',cases:0,artifact});
    if(existsSync(join(handoff,'verifications')))for(const name of readdirSync(join(handoff,'verifications'))){if(JSON.parse(readFileSync(join(handoff,'verifications',name),'utf8')).passed===false)payload.evidence.push({command:'retain prior FAIL report',result:'immutable history',cases:0,artifact:'.handoff/verifications/'+name});}
    const script=join(handoff,'payload-'+stage+'.cjs');
    writeFileSync(script,"const fs=require('node:fs');const p="+JSON.stringify(join(handoff,'payload.json'))+";fs.writeFileSync(p,JSON.stringify("+JSON.stringify(payload)+"),'utf8');JSON.parse(fs.readFileSync(p,'utf8'));\n");
    const serialized=spawnSync(process.execPath,[script],{cwd:workspace,encoding:'utf8',windowsHide:true});assert.equal(serialized.status,0,serialized.stderr);
    run('publish-'+stage,['handoff','create','--from',profile,'--payload-file',join(handoff,'payload.json')]);
    function snapshot(name){const p=join(workspace,name);mkdirSync(p);cpSync(handoff,join(p,'handoff'),{recursive:true});cpSync(join(workspace,'RESULT.md'),join(p,'RESULT.md'));return p;}
    let evidence=snapshot('evidence-'+stage);
    const manifests={original,before,final,predecessor};
    save(join(handoff,'manifests.json'),manifests);
    const canonical=canonicalEvidence(evidence);assert.equal(canonical.payload.summary,undefined);assert.ok(canonical.current.includes('Tiếng Việt'));
    const verified=verifySourceEvidence(evidence,manifests,canonical);assert.equal(verified.passed,true);
    captured('verify-good-'+stage,[join(helpers,'agent-verify.mjs'),'.handoff/manifests.json','good-'+stage],0);
    const wrong=structuredClone(claim);wrong.files['src/a.mjs'].predecessorFinal='f'.repeat(64);save(join(handoff,'source-claims.json'),wrong);
    payload.summary=JSON.stringify(wrong);save(join(handoff,'payload.json'),payload);writeFileSync(join(workspace,'RESULT.md'),JSON.stringify(wrong));
    run('publish-wrong-'+stage,['handoff','create','--from',profile,'--payload-file',join(handoff,'payload.json')]);
    evidence=snapshot('wrong-'+stage);let failure;try{verifySourceEvidence(evidence,manifests);}catch(e){failure=e.message;}
    assert.match(failure,/predecessorFinal/);
    const failedVerification=captured('verify-fail-'+stage,[join(helpers,'agent-verify.mjs'),'.handoff/manifests.json','fail-'+stage],1);
    const outputReference={commandId:failedVerification.command.id,receipt:failedVerification.path,receiptHash:failedVerification.receiptHash,stream:'stdout',...failedVerification.command.stdout,kind:'command-failure'};
    const issue={id:'verify-'+stage,attempt:stage===2?2:1,command:'agent-verify.mjs',actualOutput:readFileSync(join(workspace,outputReference.path),'utf8'),correction:'Restore bound predecessorFinal',reference:outputReference.path,verificationStatus:'verified',outputReference};
    issues.push(issue);save(join(handoff,'errors.json'),issues);save(join(handoff,'source-claims.json'),claim);
    payload.summary=JSON.stringify(claim)+' '+issues.map(issue=>issue.id).join(' ');payload.evidence[2].result=issue.id+' corrected';
    for(const artifact of [failedVerification.path,failedVerification.command.stdout.path,'.handoff/verifications/fail-'+stage+'.json'])payload.evidence.push({command:'verification failure revision '+stage,result:issue.id+' actual immutable artifact',cases:0,artifact});
    save(join(handoff,'payload.json'),payload);writeFileSync(join(workspace,'RESULT.md'),JSON.stringify(claim)+' '+issues.map(issue=>issue.id).join(' '));
    run('republish-'+stage,['handoff','create','--from',profile,'--payload-file',join(handoff,'payload.json')]);
    captured('verify-final-'+stage,[join(helpers,'agent-verify.mjs'),'.handoff/manifests.json','final-'+stage],0);
    evidence=snapshot('republished-'+stage);const republished=canonicalEvidence(evidence);
    verifySourceEvidence(evidence,manifests,republished);validatePublishedIssues(evidence,issues,republished,{strict:true,providerObservations:{publicKey:observationKeys.publicKey}});
    assert.equal(readFileSync(join(handoff,'checkpoint-'+stage+'.txt'),'utf8'),checkpoint);
    if(stage===2)assert.notEqual(original['src/a.mjs'],before['src/a.mjs']);
    const startupProof=validateWorkflowHistory(workspace,[startupCalls.at(-1)],canonicalEvidence(workspace,{handoffDirectory:'.handoff'}),{continuation:stage>1,taskId:sessionBindings.at(-1).taskId,sessionId:sessionBindings.at(-1).sessionId});
    results.push({profile,branch,stage,sessionBinding:sessionBindings.at(-1),role:stage===1?'first-task':stage===2?'rework':'handoff',pairedContextStartupVerified:startupProof.starts.length===1,verified,wrongClaimRejected:failure,republishPassed:true,signedDirectFailureVerified:true,signedInnerErrorVerified:true,checkpointHash:hash(join(handoff,'checkpoint-'+stage+'.txt'))});
    predecessor=final;
  }
  const currentBeforeClose=readFileSync(join(workspace,'.handoff/CURRENT.md'),'utf8');
  run('end',['session','end','--agent',profile]);
  assert.equal(readFileSync(join(workspace,'.handoff/CURRENT.md'),'utf8'),currentBeforeClose,'Final session cleanup preserves publish');
  assert.equal(new Set(sessionBindings.map(binding=>binding.taskId)).size,1);
  assert.equal(new Set(sessionBindings.map(binding=>binding.sessionId)).size,3);
}
save(join(out,'cli-integration.json'),{passed:true,profiles:remediationScope.profiles,cohort:remediationScope.cohort,baselineProtocolHash:baseline.protocolHash,buildManifestPath:buildPath,buildManifestHash:buildPath?hash(buildPath):null,commands,results,sessionLifecycleVerified:true,strictEvidenceVerified:true,sharedEvidenceHelpers:Object.fromEntries(['agent-evidence-command.cjs','agent-verify.mjs','comparison-evidence.mjs','provider-observations.mjs'].map(name=>[name,hash(join(root,'benchmarks/task-management',name))]))});
console.log(JSON.stringify({passed:true,branches:2,stages:results.length,commands:commands.length,profiles:remediationScope.profiles.length}));
