import { randomUUID } from 'node:crypto';
import { canonical,sha256 } from './artifacts.mjs';
import { BridgeError } from './schema.mjs';

const error=(code,field,expected,version=null)=>{throw new BridgeError(code,field,expected,version);};
export class ContextDelivery {
  constructor(store,{maxBytes=256*1024}={}) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024)error('CONTEXT_LIMIT_INVALID','/maxBytes','1 byte to 1 MiB');
    this.store=store;this.db=store.db;this.maxBytes=maxBytes;
    this.db.exec('CREATE TABLE IF NOT EXISTS context_deliveries (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),epoch TEXT NOT NULL,state_version INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,text_hash TEXT NOT NULL,artifact_ref TEXT NOT NULL,bytes INTEGER NOT NULL,thread_id TEXT,turn_id TEXT,created_at TEXT NOT NULL); PRAGMA user_version=3;');
  }
  cursor(sessionId) {
    const session=this.store.session(sessionId);
    try{const cursor=JSON.parse(session.delivery_cursor);if(cursor?.schemaVersion===1&&typeof cursor.epoch==='string')return cursor;}catch{}
    return this.reset(sessionId,'new-or-invalid-cursor');
  }
  reset(sessionId,reason) {
    this.store.session(sessionId);
    const cursor={schemaVersion:1,epoch:randomUUID(),reason,acknowledged:null};
    this.db.prepare('UPDATE sessions SET delivery_cursor=? WHERE id=?').run(canonical(cursor),sessionId);
    return cursor;
  }
  snapshot(sessionId) {
    const session=this.store.session(sessionId),task=this.store.task(session.task_id);
    const files=task.state.files.map(reference=>{
      try{this.store.verifyFiles([reference],session,task);return {...reference,freshness:'verified'};}
      catch(failure){return {...reference,freshness:failure.code==='FILE_HASH_MISMATCH'?'stale':'unverified',reason:failure.code||'FILE_UNAVAILABLE'};}
    });
    return {schemaVersion:1,taskId:task.id,stateVersion:task.stateVersion,sourceRevision:task.sourceRevision,
      objective:task.state.objective,constraints:task.state.constraints,decisions:task.state.decisions,
      issues:task.state.issues,next:task.state.next,files,evidence:task.state.evidence};
  }
  offer(sessionId,request,proof=null) {
    if(typeof request!=='string'||!request.trim())error('REQUEST_INVALID','/request','nonempty current request');
    const cursor=this.cursor(sessionId),snapshot=this.snapshot(sessionId),ack=cursor.acknowledged;
    const retained=ack&&proof?.sessionId===sessionId&&proof?.epoch===cursor.epoch&&proof?.deliveryId===ack.id&&proof?.threadId===ack.threadId&&
      proof?.stateVersion===snapshot.stateVersion&&ack.stateVersion===snapshot.stateVersion&&proof?.textHash===ack.textHash;
    const mode=retained?'request':'full';
    const payload=retained?{schemaVersion:1,request}:{schemaVersion:1,taskSnapshot:snapshot,request};
    const text=canonical(payload),bytes=Buffer.byteLength(text),id=randomUUID();
    const artifact=this.store.recordArtifact(sessionId,text,{kind:'note',provenance:'runtime-observed',sourceRevision:snapshot.sourceRevision,
      command:null,exitStatus:null,observedResult:'Host-offered context; delivery is recorded separately'});
    const status=bytes>this.maxBytes?'overflow':'offered';
    this.db.prepare('INSERT INTO context_deliveries VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)').run(id,sessionId,cursor.epoch,snapshot.stateVersion,
      mode,status,sha256(text),artifact.reference,bytes,new Date().toISOString());
    return {id,sessionId,epoch:cursor.epoch,stateVersion:snapshot.stateVersion,mode,status,text:status==='overflow'?null:text,
      textHash:sha256(text),bytes,reference:artifact.reference};
  }
  receipt(id) {
    const row=this.db.prepare('SELECT * FROM context_deliveries WHERE id=?').get(id);
    if(!row)error('DELIVERY_MISSING','/deliveryId','host-offered delivery');
    return row;
  }
  delivered(id,{threadId,turnId}) {
    const row=this.receipt(id);this.store.session(row.session_id);
    if(!['offered','delivered','acknowledged'].includes(row.status))error('DELIVERY_STATE_INVALID','/status','offered delivery');
    if(row.thread_id&&(row.thread_id!==threadId||row.turn_id!==turnId))error('DELIVERY_BINDING_CONFLICT','/turnId','original provider thread/turn');
    if(row.status==='offered')this.db.prepare("UPDATE context_deliveries SET status='delivered',thread_id=?,turn_id=? WHERE id=?").run(threadId,turnId,id);
    return this.receipt(id);
  }
  acknowledge(id,{threadId,turnId,textHash}) {
    return this.store.transaction(()=>{
      const row=this.receipt(id),cursor=this.cursor(row.session_id);
      if(row.epoch!==cursor.epoch||row.text_hash!==textHash||row.thread_id!==threadId||row.turn_id!==turnId)
        error('DELIVERY_ACK_INVALID','/receipt','same epoch, text hash, provider thread and turn');
      if(!['delivered','acknowledged'].includes(row.status))error('DELIVERY_STATE_INVALID','/status','delivered input');
      this.db.prepare("UPDATE context_deliveries SET status='acknowledged' WHERE id=?").run(id);
      cursor.acknowledged={id,stateVersion:row.state_version,textHash,threadId,turnId};
      this.db.prepare('UPDATE sessions SET delivery_cursor=? WHERE id=?').run(canonical(cursor),row.session_id);
      return this.receipt(id);
    });
  }
  proof(sessionId,threadId,turnId) {
    const cursor=this.cursor(sessionId),ack=cursor.acknowledged;
    if(!ack||ack.threadId!==threadId||ack.turnId!==turnId)return null;
    return {sessionId,epoch:cursor.epoch,deliveryId:ack.id,stateVersion:ack.stateVersion,textHash:ack.textHash,threadId};
  }
}

