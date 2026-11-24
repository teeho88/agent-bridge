import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical,sha256 } from './artifacts.mjs';
import { BridgeError,checkpointSchema,validate } from './schema.mjs';
import { ContextDelivery } from './delivery.mjs';

const fail=(code,field,expected,version=null)=>{throw new BridgeError(code,field,expected,version);};
export class SessionHost {
  constructor(store,broker,options={}) {
    this.store=store;this.db=store.db;this.broker=broker;this.delivery=new ContextDelivery(store,options);
    this.db.exec('CREATE TABLE IF NOT EXISTS hosted_sessions (session_id TEXT PRIMARY KEY REFERENCES sessions(id),workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,receipt_path TEXT,thread_id TEXT,phase TEXT NOT NULL,owner_pid INTEGER NOT NULL,last_turn_status TEXT,pending_json TEXT);'+
      'CREATE TABLE IF NOT EXISTS provider_threads (thread_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,workspace_id TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS checkpoint_submissions (task_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,session_id TEXT NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(task_id,idempotency_key));'+
      'CREATE TABLE IF NOT EXISTS provider_observations (session_id TEXT NOT NULL,item_id TEXT NOT NULL,payload_hash TEXT NOT NULL,artifact_ref TEXT NOT NULL,PRIMARY KEY(session_id,item_id));'+
      'CREATE TABLE IF NOT EXISTS provider_invocations (session_id TEXT NOT NULL,turn_id TEXT NOT NULL,status TEXT NOT NULL,usage_json TEXT,PRIMARY KEY(session_id,turn_id));');
  }
  session(id) {
    const row=this.db.prepare('SELECT * FROM hosted_sessions WHERE session_id=?').get(id);
    if(!row)fail('HOST_SESSION_MISSING','/session','host-owned session');
    return row;
  }
  reserve({sessionId,workspaceId,runId=randomUUID(),receiptPath=null,provider='codex'}) {
    return this.store.transaction(()=>{
      const work=this.broker.workspace(workspaceId);
      this.broker.attachRun(workspaceId,runId,{withinTransaction:true});
      this.store.openSession({id:sessionId,taskId:work.task_id,provider,workspace:work.root},{withinTransaction:true});
      this.db.prepare("INSERT INTO hosted_sessions VALUES (?,?,?,?,NULL,'reserved',?,NULL,NULL)").run(sessionId,workspaceId,runId,receiptPath,process.pid);
      return this.session(sessionId);
    });
  }
  launching(sessionId) {
    const row=this.session(sessionId);
    if(row.phase!=='reserved')fail('HOST_SESSION_STATE','/session','reserved session');
    this.db.prepare("UPDATE hosted_sessions SET phase='launching' WHERE session_id=?").run(sessionId);
  }
  cancelReserved(sessionId) {
    const row=this.session(sessionId);
    if(row.phase!=='reserved')fail('HOST_SESSION_STATE','/session','provider has not launched');
    this.broker.recordStopped(row.workspace_id,row.run_id);
    this.store.closeSession(sessionId,{writersStopped:true,crashed:true});
    this.db.prepare("UPDATE hosted_sessions SET phase='crashed' WHERE session_id=?").run(sessionId);
  }
  activated(sessionId,transport) {
    const row=this.session(sessionId),work=this.broker.workspace(row.workspace_id);
    if(row.phase!=='launching'||row.run_id!==transport.runId||work.root!==transport.workspace||row.receipt_path!==transport.receiptPath)
      fail('PROVIDER_BINDING_CONFLICT','/transport','reserved isolated process and workspace');
    this.db.prepare("UPDATE hosted_sessions SET phase='running' WHERE session_id=?").run(sessionId);
  }
  bindThread(sessionId,threadId) {
    if(typeof threadId!=='string'||!threadId)fail('PROVIDER_THREAD_INVALID','/threadId','provider thread identity');
    return this.store.transaction(()=>{
      const row=this.session(sessionId),bound=this.store.session(sessionId);
      const previous=this.db.prepare('SELECT * FROM provider_threads WHERE thread_id=?').get(threadId);
      if(previous&&(previous.task_id!==bound.task_id||previous.workspace_id!==row.workspace_id))fail('PROVIDER_REBIND_FORBIDDEN','/threadId','original task/workspace binding');
      if(row.thread_id&&row.thread_id!==threadId)fail('PROVIDER_REBIND_FORBIDDEN','/threadId','original provider thread');
      this.db.prepare('INSERT OR IGNORE INTO provider_threads VALUES (?,?,?)').run(threadId,bound.task_id,row.workspace_id);
      this.db.prepare('UPDATE hosted_sessions SET thread_id=? WHERE session_id=?').run(threadId,sessionId);
      return this.delivery.reset(sessionId,'provider-thread-bound');
    });
  }
  evidence(sessionId) {
    return this.db.prepare('SELECT artifact_ref FROM provider_observations WHERE session_id=? ORDER BY rowid').all(sessionId).map(row=>row.artifact_ref);
  }
  tool(sessionId,name,input) {
    if(this.session(sessionId).phase!=='running')fail('HOST_SESSION_STATE','/session','running provider session');
    if(name==='bridge.lookup')return this.store.lookup(sessionId,input);
    if(name!=='bridge.checkpoint')fail('TOOL_UNKNOWN','/tool','bridge.checkpoint or bridge.lookup');
    const binding=this.store.session(sessionId),task=this.store.task(binding.task_id);
    validate(checkpointSchema,input,task.stateVersion);
    const payloadHash=sha256(canonical(input));
    const previous=this.db.prepare('SELECT * FROM checkpoint_submissions WHERE task_id=? AND idempotency_key=?').get(task.id,input.idempotencyKey);
    if(previous){
      if(previous.payload_hash!==payloadHash)fail('IDEMPOTENCY_CONFLICT','/idempotencyKey','original checkpoint input',task.stateVersion);
      if(previous.status==='discarded')fail('CHECKPOINT_DISCARDED','/idempotencyKey','new checkpoint after crashed session',task.stateVersion);
      return JSON.parse(previous.receipt_json);
    }
    if(this.session(sessionId).pending_json)fail('FINAL_CHECKPOINT_PENDING','/checkpoint','one final checkpoint per session',task.stateVersion);
    const normalized={...input,evidence:[...new Set([...input.evidence,...this.evidence(sessionId)])]};
    this.store.checkpoint(sessionId,normalized,{preview:true});
    if(input.status==='working')return this.store.transaction(()=>{
      const receipt=this.store.checkpoint(sessionId,normalized,{withinTransaction:true});
      this.db.prepare("INSERT INTO checkpoint_submissions VALUES (?,?,?,?,?,'committed',?)").run(task.id,input.idempotencyKey,payloadHash,sessionId,canonical(normalized),canonical(receipt));
      return receipt;
    });
    return this.store.transaction(()=>{
      if(this.store.task(task.id).stateVersion!==input.expectedVersion)fail('VERSION_CONFLICT','/expectedVersion','unchanged checkpoint version',this.store.task(task.id).stateVersion);
      const receipt={schemaVersion:1,taskId:task.id,idempotencyKey:input.idempotencyKey,status:'pending-stop',requestedStatus:input.status,stateVersion:task.stateVersion,handoff:false};
      this.db.prepare("INSERT INTO checkpoint_submissions VALUES (?,?,?,?,?,'pending',?)").run(task.id,input.idempotencyKey,payloadHash,sessionId,canonical(normalized),canonical(receipt));
      this.db.prepare('UPDATE hosted_sessions SET pending_json=? WHERE session_id=?').run(canonical(normalized),sessionId);
      return receipt;
    });
  }
  observe(sessionId,message) {
    const row=this.session(sessionId),params=message.params||{};
    if(params.threadId&&row.thread_id!==params.threadId)fail('PROVIDER_EVENT_BINDING','/threadId','bound provider thread');
    if(message.method==='turn/started'||message.method==='turn/completed') {
      const turn=params.turn;
      if(!turn?.id)fail('PROTOCOL_INVALID','/turn','provider turn identity');
      const status=message.method==='turn/started'?'inProgress':turn.status;
      this.db.prepare('INSERT INTO provider_invocations VALUES (?,?,?,NULL) ON CONFLICT(session_id,turn_id) DO UPDATE SET status=excluded.status').run(sessionId,turn.id,status||'unknown');
      this.db.prepare('UPDATE hosted_sessions SET last_turn_status=? WHERE session_id=?').run(status||'unknown',sessionId);
    }
    if(message.method==='item/completed'&&params.item?.type==='commandExecution') {
      const item=params.item;
      if(!item.id)fail('PROTOCOL_INVALID','/item/id','observed command identity');
      const hash=sha256(canonical(item));
      const prior=this.db.prepare('SELECT * FROM provider_observations WHERE session_id=? AND item_id=?').get(sessionId,item.id);
      if(prior){if(prior.payload_hash!==hash)fail('OBSERVATION_CONFLICT','/item/id','immutable observed result');return prior.artifact_ref;}
      const task=this.store.task(this.store.session(sessionId).task_id);
      let sourceHash=null;try{sourceHash=this.broker.snapshot(this.broker.workspace(row.workspace_id).root).hash;}catch{}
      const artifact=this.store.recordArtifact(sessionId,canonical(item),{kind:'command',provenance:'runtime-observed',sourceRevision:task.sourceRevision,
        sourceHash,
        command:typeof item.command==='string'&&item.command.length<=8192?item.command:null,
        exitStatus:Number.isInteger(item.exitCode)?item.exitCode:null,observedResult:'Provider-observed command result; test counts and output completeness not inferred'});
      this.db.prepare('INSERT INTO provider_observations VALUES (?,?,?,?)').run(sessionId,item.id,hash,artifact.reference);
      return artifact.reference;
    }
    return null;
  }
  stopped(sessionId,receipt,{crashed=false,publish=true}={}) {
    const row=this.session(sessionId);
    if(['finished','crashed','closed'].includes(row.phase))return {phase:row.phase,task:this.store.task(this.store.session(sessionId,false).task_id)};
    if(receipt?.writersStopped!==true||receipt.appContainer!==true||receipt.activeProcesses!==0||(receipt.runId&&receipt.runId!==row.run_id))fail('WRITER_STOP_UNVERIFIED','/receipt','native stop proof for the reserved run');
    const abnormal=crashed||receipt.timedOut===true||!Number.isInteger(receipt.exitStatus)||![0,130].includes(receipt.exitStatus)||!['completed',null].includes(row.last_turn_status)||Boolean(row.pending_json&&row.last_turn_status!=='completed');
    this.broker.recordStopped(row.workspace_id,row.run_id);
    this.store.closeSession(sessionId,{writersStopped:true,crashed:abnormal});
    if(abnormal) {
      this.store.transaction(()=>{
        this.db.prepare("UPDATE checkpoint_submissions SET status='discarded' WHERE session_id=? AND status='pending'").run(sessionId);
        this.db.prepare("UPDATE hosted_sessions SET phase='crashed',pending_json=NULL WHERE session_id=?").run(sessionId);
      });
      return {phase:'crashed',task:this.store.task(this.store.session(sessionId,false).task_id)};
    }
    if(row.pending_json&&row.last_turn_status!=='completed')fail('TURN_COMPLETION_UNVERIFIED','/turn','completed provider turn before final checkpoint');
    this.db.prepare("UPDATE hosted_sessions SET phase='stopped' WHERE session_id=?").run(sessionId);
    if(!publish){
      if(row.pending_json)fail('FINAL_CHECKPOINT_PENDING','/publication','publish staged final checkpoint');
      this.db.prepare("UPDATE hosted_sessions SET phase='closed' WHERE session_id=?").run(sessionId);
      return {phase:'closed'};
    }
    const pending=row.pending_json?JSON.parse(row.pending_json):null;
    const work=this.broker.workspace(row.workspace_id);
    const publication=this.broker.publish(row.workspace_id,work.base_revision,{expectedTaskVersion:pending?.expectedVersion??null,onCommit:source=>{
      if(pending){
        const finalized={...pending,expectedVersion:source.stateVersion,files:pending.files.map(file=>({...file,sourceRevision:source.sourceRevision}))};
        const receipt=this.store.checkpoint(sessionId,finalized,{finalizing:true,historyRevision:source.baseRevision});
        this.db.prepare("UPDATE checkpoint_submissions SET status='committed',receipt_json=? WHERE task_id=? AND idempotency_key=?").run(canonical(receipt),source.taskId,pending.idempotencyKey);
      }
      this.db.prepare("UPDATE hosted_sessions SET phase='finished',pending_json=NULL WHERE session_id=?").run(sessionId);
    }});
    return {phase:'finished',publication,checkpoint:pending?JSON.parse(this.db.prepare('SELECT receipt_json FROM checkpoint_submissions WHERE task_id=? AND idempotency_key=?').get(publication.taskId,pending.idempotencyKey).receipt_json):null};
  }
  recover() {
    const recovered=[];
    for(const row of this.db.prepare("SELECT * FROM hosted_sessions WHERE phase IN ('reserved','launching','running','stopped')").all()) {
      let alive=true;try{process.kill(row.owner_pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)continue;
      let receipt;
      if(row.phase==='reserved')receipt={appContainer:true,writersStopped:true,activeProcesses:0,runId:row.run_id};
      else{try{receipt=JSON.parse(readFileSync(row.receipt_path,'utf8'));}catch{fail('WRITER_STOP_UNVERIFIED','/recovery','persisted native stop receipt');}}
      recovered.push(this.stopped(row.session_id,receipt,{crashed:true,publish:false}));
    }
    return recovered;
  }
}

