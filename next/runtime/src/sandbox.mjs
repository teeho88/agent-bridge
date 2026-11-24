import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonical, sha256 } from './artifacts.mjs';
import { noLinks, disjoint, sourceError } from './source-paths.mjs';
import { maxNativeSessionMs } from './session-policy.mjs';

const helper=fileURLToPath(new URL('./windows-sandbox.ps1',import.meta.url));
const native=fileURLToPath(new URL('./windows-sandbox.cs',import.meta.url));
const valid=new WeakMap();
const helperHash=()=>sha256(Buffer.concat([readFileSync(native),readFileSync(helper),readFileSync(new URL('./canary-worker.cjs',import.meta.url))]));
function command(executable,args,timeout=30000,options={}) {
  const run=spawnSync(executable,args,{...options,encoding:'utf8',timeout,windowsHide:true,maxBuffer:1024*1024});
  return {exitStatus:run.status,stdout:run.stdout||'',stderr:run.stderr||'',error:run.error?.code||null};
}
export class WindowsSandbox {
  constructor({control,profileName,profileMode='create',environment=null}) {
    this.control=noLinks(resolve(control),true);mkdirSync(this.control,{recursive:true});
    if(typeof profileName!=='string'||!/^BridgeV2\.[A-Za-z0-9.-]{1,100}$/.test(profileName))sourceError('SANDBOX_PROFILE_INVALID','/profileName','host-provisioned unique BridgeV2 AppContainer profile');
    this.profileName=profileName;
    if(!['create','derive-only','existing'].includes(profileMode))sourceError('SANDBOX_PROFILE_INVALID','/profileMode','create, existing or derive-only');
    this.profileMode=profileMode;
    this.hostOptions={cwd:dirname(helper),...(environment?{env:{...environment}}:{})};
  }
  invoke(request,timeout=30000) {
    if(request.operation==='host-run')sourceError('HOST_COORDINATOR_FORBIDDEN','/operation','separate explicitly trusted host job backend');
    const requestPath=join(this.control,randomUUID()+'.json');
    writeFileSync(requestPath,JSON.stringify({...request,nodeDirectory:dirname(process.execPath)}),{flag:'wx',mode:0o600});
    if(this.profileMode!=='create'&&request.operation==='provision')sourceError('SANDBOX_PROVISION_FORBIDDEN','/operation','non-creating identity cannot provision profiles');
    const result=command('powershell.exe',['-NoProfile','-NonInteractive','-File',helper,'-RequestFile',requestPath],timeout,this.hostOptions);
    let receipt=null;
    try{receipt=JSON.parse(result.stdout.trim());}catch{}
    writeFileSync(requestPath+'.result.json',JSON.stringify({...result,receipt}),{flag:'wx',mode:0o600});
    return {...result,receipt};
  }
  verify({workspace,protectedFiles,executable=process.execPath,internetClient=false}) {
    valid.delete(this);
    if(typeof internetClient!=='boolean')sourceError('SANDBOX_REQUEST_INVALID','/internetClient','explicit host boolean');
    const started=performance.now();
    const directory=noLinks(resolve(workspace));
    disjoint(directory,this.control);
    if(!Array.isArray(protectedFiles)||protectedFiles.length<5)sourceError('CANARY_SCOPE_INVALID','/protectedFiles','authoritative/state/evidence/evaluator/other-workspace sentinels');
    const kinds=new Set(protectedFiles.map(p=>p.kind));
    for(const kind of ['authoritative','state','evidence','evaluator','other-workspace'])if(!kinds.has(kind))sourceError('CANARY_SCOPE_INVALID','/protectedFiles','all protected boundary kinds');
    const protectedScope=protectedFiles.map(entry=>{
      const file=noLinks(resolve(entry.path));disjoint(directory,file);
      if(!lstatSync(file).isFile())sourceError('CANARY_SCOPE_INVALID','/protectedFiles','existing regular protected sentinel');
      return {kind:entry.kind,path:file,hash:sha256(readFileSync(file))};
    });
    const report={schemaVersion:1,backend:'windows-appcontainer-job',profileName:this.profileName,
      workspace:directory,helperHash:helperHash(),protectedScope,internetClient,profileMode:this.profileMode,
      verifiedWriteBoundary:false,verifiedChildStop:false,writerEnabled:false,steps:[]};
    if(process.platform!=='win32'){report.reason='unsupported-platform';return report;}
    const sid=this.invoke({operation:'sid',name:this.profileName});report.steps.push({operation:'derive-sid',...sid});
    if(sid.exitStatus!==0||!sid.receipt?.sid){report.reason='sid-unavailable';return report;}
    if(this.profileMode==='existing'){
      const existing=this.invoke({operation:'existing-profile',name:this.profileName});
      report.steps.push({operation:'verify-existing-profile',...existing});
      if(existing.exitStatus!==0||existing.receipt?.sid!==sid.receipt.sid||existing.receipt?.existing!==true){report.reason='existing-profile-unavailable';return report;}
      report.profileExisting=true;
    }
    const bindingPath=join(this.control,sha256(this.profileName)+'.binding.json');
    if(existsSync(bindingPath)) {
      if(JSON.parse(readFileSync(bindingPath,'utf8')).workspace!==directory)sourceError('SANDBOX_PROFILE_REUSED','/profileName','one AppContainer identity per working copy');
    } else writeFileSync(bindingPath,JSON.stringify({workspace:directory,profileName:this.profileName}),{flag:'wx',mode:0o600});
    const grant=command('icacls.exe',[directory,'/grant','*'+sid.receipt.sid+':(OI)(CI)M'],30000,this.hostOptions);
    report.steps.push({operation:'grant-owned-workspace',...grant});
    const owner=this.invoke({operation:'workspace-owner',workspace:directory});
    report.steps.push({operation:'verify-workspace-owner',...owner});
    if(owner.exitStatus!==0||!owner.receipt?.userSid||owner.receipt.userSid!==owner.receipt.ownerSid) {
      report.reason='workspace-owner-unverified';report.profileProvisioned=false;report.nativeCanaryAttempted=false;return report;
    }
    const labelAccess=command('icacls.exe',[directory,'/grant','*'+owner.receipt.userSid+':(WO)'],30000,this.hostOptions);
    report.steps.push({operation:'grant-host-workspace-write-owner',...labelAccess});
    const integrity=command('icacls.exe',[directory,'/setintegritylevel','(OI)(CI)L'],30000,this.hostOptions);
    report.steps.push({operation:'set-workspace-low-integrity',...integrity});
    if(grant.exitStatus!==0||labelAccess.exitStatus!==0||integrity.exitStatus!==0) {
      report.reason='workspace-acl-unavailable';report.profileProvisioned=false;report.nativeCanaryAttempted=false;report.elapsedMs=performance.now()-started;return report;
    }
    report.profileProvisioned=false;
    report.profileProvisioningSkipped=this.profileMode!=='create';
    if(!report.profileProvisioningSkipped){
      const provision=this.invoke({operation:'provision',name:this.profileName});
      report.steps.push({operation:'provision-appcontainer-profile',...provision});
      report.profileProvisioned=provision.exitStatus===0&&provision.receipt?.sid===sid.receipt.sid;
      if(!report.profileProvisioned){report.reason='appcontainer-profile-unavailable';report.elapsedMs=performance.now()-started;return report;}
    }
    report.nativeCanaryAttempted=true;
    const temporary=join(directory,'.bridge-tmp');mkdirSync(temporary,{recursive:true});
    mkdirSync(join(directory,'.bridge-home'),{recursive:true});
    mkdirSync(join(directory,'.bridge-home','codex'),{recursive:true});
    const worker=join(temporary,'canary-'+randomUUID()+'.cjs');
    const source=readFileSync(new URL('./canary-worker.cjs',import.meta.url));
    writeFileSync(worker,source,{flag:'wx',mode:0o600});
    const id=randomUUID();
    const lateMarker=join(temporary,'late-'+id);
    const run=this.invoke({operation:'run',name:this.profileName,executable,arguments:['--preserve-symlinks-main',worker,JSON.stringify(protectedScope),'parent',lateMarker],workspace:directory,
      stdout:join(this.control,id+'.stdout'),stderr:join(this.control,id+'.stderr'),parentId:process.pid,timeoutMs:10000,internetClient},25000);
    report.steps.push({operation:'native-canary',...run});
    let output=null;
    try{output=JSON.parse(readFileSync(join(this.control,id+'.stdout'),'utf8').trim());}catch{}
    report.canary=output;
    const intact=protectedScope.every(p=>sha256(readFileSync(p.path))===p.hash);
    const checks=value=>value?.allowed===true&&value.attempts?.length===protectedScope.length&&value.attempts.every(a=>a.writeDenied&&a.readDenied);
    const stopped=run.exitStatus===0&&run.receipt?.appContainer===true&&run.receipt?.writersStopped===true&&run.receipt.exitStatus===0&&!run.receipt.timedOut&&run.receipt.activeProcesses===0&&run.receipt.totalProcesses>=3&&!existsSync(lateMarker);
    report.verifiedChildStop=stopped;
    report.verifiedWriteBoundary=grant.exitStatus===0&&integrity.exitStatus===0&&intact&&stopped&&checks(output)&&checks(output?.descendant);
    report.writerEnabled=report.verifiedWriteBoundary;
    report.elapsedMs=performance.now()-started;
    report.reason=report.writerEnabled?null:'native-canary-not-verified';
    if(report.writerEnabled)valid.set(this,{workspace:directory,scope:canonical(protectedScope),helperHash:report.helperHash,sid:sid.receipt.sid,internetClient});
    return report;
  }
  run({workspace,executable=process.execPath,arguments:args=[],timeoutMs=30000}) {
    const proof=valid.get(this);
    if(!proof||proof.workspace!==noLinks(resolve(workspace))||proof.helperHash!==helperHash())sourceError('WRITE_BOUNDARY_UNVERIFIED','/sandbox','successful same-workspace native canary');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!args.every(a=>typeof a==='string'))sourceError('SANDBOX_REQUEST_INVALID','/arguments','string argv and timeout within 30 seconds');
    const checked=this.verify({workspace:proof.workspace,protectedFiles:JSON.parse(proof.scope),internetClient:proof.internetClient});
    if(!checked.writerEnabled)sourceError('WRITE_BOUNDARY_UNVERIFIED','/sandbox','fresh same-workspace native canary');
    const id=randomUUID();
    const result=this.invoke({operation:'run',name:this.profileName,executable,arguments:args,workspace:proof.workspace,
      stdout:join(this.control,id+'.stdout'),stderr:join(this.control,id+'.stderr'),parentId:process.pid,timeoutMs,internetClient:proof.internetClient},timeoutMs+15000);
    if(result.exitStatus!==0||result.receipt?.writersStopped!==true||result.receipt?.appContainer!==true) {
      valid.delete(this);sourceError('WRITER_STOP_UNVERIFIED','/sandbox','OS-confirmed complete writer stop');
    }
    return {...result.receipt,runId:id,stdout:readFileSync(join(this.control,id+'.stdout'),'utf8'),stderr:readFileSync(join(this.control,id+'.stderr'),'utf8')};
  }
  start({workspace,executable,arguments:args=[],maxSessionMs=600000,readOnlyExecutable=false,runId=null}) {
    const proof=valid.get(this);
    if(!proof||proof.workspace!==noLinks(resolve(workspace))||proof.helperHash!==helperHash())sourceError('WRITE_BOUNDARY_UNVERIFIED','/sandbox','successful same-workspace native canary');
    if(!Array.isArray(args)||!args.every(a=>typeof a==='string')||!Number.isInteger(maxSessionMs)||maxSessionMs<1||maxSessionMs>maxNativeSessionMs)sourceError('SANDBOX_REQUEST_INVALID','/arguments','string argv and bounded session timeout');
    const checked=this.verify({workspace:proof.workspace,protectedFiles:JSON.parse(proof.scope),internetClient:proof.internetClient});
    if(!checked.writerEnabled)sourceError('WRITE_BOUNDARY_UNVERIFIED','/sandbox','fresh native canary');
    const target=noLinks(resolve(executable));
    if(!lstatSync(target).isFile())sourceError('SANDBOX_REQUEST_INVALID','/executable','regular trusted executable');
    if(readOnlyExecutable){
      disjoint(proof.workspace,dirname(target));
      const grant=command('icacls.exe',[target,'/grant','*'+proof.sid+':RX'],30000,this.hostOptions);
      if(grant.exitStatus!==0)sourceError('EXECUTABLE_ACCESS_UNVERIFIED','/executable','read/execute-only grant');
    }
    if(runId!==null&&!/^[a-f0-9-]{36}$/.test(runId))sourceError('RUN_ID_INVALID','/runId','host UUID');
    const id=runId||randomUUID(),prefix=join(this.control,id);
    const paths={stdin:'BridgeV2.Input.'+id,stdout:prefix+'.stdout',stderr:prefix+'.stderr',stop:prefix+'.stop',receipt:prefix+'.receipt'};
    const request=prefix+'.json';
    writeFileSync(request,JSON.stringify({operation:'interactive',name:this.profileName,executable:target,arguments:args,workspace:proof.workspace,
      ...paths,parentId:process.pid,timeoutMs:maxSessionMs,internetClient:proof.internetClient,nodeDirectory:dirname(process.execPath)}),{flag:'wx',mode:0o600});
    const launcher=prefix+'.launch.json';
    writeFileSync(launcher,JSON.stringify({operation:'launch-supervisor',helper,supervisorRequest:request,cwd:proof.workspace}),{flag:'wx',mode:0o600});
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',helper,'-RequestFile',launcher],{...this.hostOptions,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let failure='',done=false,offset=0,poll=null,socket=null,retry=null,connected=false;
    const pending=[];
    const connect=()=>{
      if(done)return;
      socket=createConnection('\\\\.\\pipe\\'+paths.stdin);
      socket.on('connect',()=>{connected=true;for(const line of pending.splice(0))socket.write(line);});
      socket.on('error',()=>{connected=false;if(!done)retry=setTimeout(connect,50);});
    };
    const release=()=>{clearTimeout(retry);socket?.destroy();};
    child.stdout.on('data',bytes=>{failure=(failure+bytes.toString('utf8')).slice(-8192);});
    child.stderr.on('data',bytes=>{failure=(failure+bytes.toString('utf8')).slice(-8192);});
    const closed=new Promise(resolve=>{
      child.once('error',error=>{done=true;release();resolve({writersStopped:null,error:error.code||'LAUNCH_FAILED'});});
      child.once('close',exitStatus=>{
        if(exitStatus!==0){done=true;release();resolve({writersStopped:null,exitStatus,error:'SUPERVISOR_LAUNCH_FAILED',detail:failure});return;}
        connect();
        const deadline=Date.now()+maxSessionMs+20000;
        poll=setInterval(()=>{
          let receipt=null;try{receipt=JSON.parse(readFileSync(paths.receipt,'utf8'));}catch{}
          if(receipt){clearInterval(poll);done=true;release();
            if(receipt.appContainer===true&&receipt.writersStopped===true&&receipt.activeProcesses===0)resolve({...receipt,runId:id,stdoutPath:paths.stdout,stderrPath:paths.stderr});
            else resolve({writersStopped:null,error:'WRITER_STOP_UNVERIFIED',detail:failure});
          }else if(Date.now()>deadline){clearInterval(poll);done=true;release();resolve({writersStopped:null,error:'SUPERVISOR_RECEIPT_TIMEOUT',detail:failure});}
        },20);
      });
    });
    return {
      runId:id,workspace:proof.workspace,receiptPath:paths.receipt,closed,
      send(message){
        if(done)sourceError('TRANSPORT_CLOSED','/transport','running isolated process');
        const line=JSON.stringify(message)+'\n';
        if(Buffer.byteLength(line)>1024*1024)sourceError('TRANSPORT_OVERFLOW','/message','at most 1 MiB');
        if(connected)socket.write(line);else pending.push(line);
      },
      read(){
        if(!existsSync(paths.stdout))return Buffer.alloc(0);
        const fd=openSync(paths.stdout,'r');
        try{const size=fstatSync(fd).size-offset;if(size<0)sourceError('TRANSPORT_REWOUND','/transport','append-only protocol');
          const buffer=Buffer.alloc(Math.min(size,1024*1024));const count=readSync(fd,buffer,0,buffer.length,offset);offset+=count;return buffer.subarray(0,count);
        }finally{closeSync(fd);}
      },
      async stop(){
        if(!done&&!existsSync(paths.stop))writeFileSync(paths.stop,'stop',{flag:'wx',mode:0o600});
        let timer;
        try{return await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Writer stop receipt timeout')),20000);})]);}
        finally{clearTimeout(timer);}
      },
    };
  }
}
