import assert from 'node:assert/strict';
import {openSync,writeSync,fsyncSync,closeSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'];
function normalizeUsage(value){
  for(const name of ['inputTokens','cachedInputTokens','outputTokens'])assert.ok(Number.isSafeInteger(value?.[name])&&value[name]>=0,'Invalid mandatory telemetry usage');
  assert.ok(value.cachedInputTokens<=value.inputTokens,'Cached input exceeds total input');
  for(const name of ['cacheWriteInputTokens','reasoningOutputTokens'])if(value[name]!==undefined&&value[name]!==null)assert.ok(Number.isSafeInteger(value[name])&&value[name]>=0,'Invalid optional telemetry usage');
  if(value.reasoningOutputTokens!==undefined&&value.reasoningOutputTokens!==null)assert.ok(value.reasoningOutputTokens<=value.outputTokens,'Reasoning exceeds output');
  return {...Object.fromEntries(fields.map(name=>[name,value[name]??null])),uncachedInputTokens:value.inputTokens-value.cachedInputTokens};
}
function summarize(entries,truncatedTail=false){
  const first=entries[0];assert.equal(first?.type,'start');
  const binding={...first.data.binding};
  let observedUsage=null,usageSequence=null,answerSequence=null,terminal=null,implementation=null,finished=null,captureErrors=0;
  for(const entry of entries.slice(1)){
    assert.equal(finished,null,'Telemetry record after finish');
    if(entry.type==='bind'){
      for(const [key,value] of Object.entries(entry.data)){
        assert.ok(['runId','threadId','turnId'].includes(key));
        assert.ok(typeof value==='string'&&value);
        assert.ok(!binding[key]||binding[key]===value,'Telemetry binding changed');binding[key]=value;
      }
    }else if(['usage','final-answer','terminal'].includes(entry.type)){
      for(const key of ['runId','threadId','turnId'])assert.ok(binding[key]&&entry.data.binding[key]===binding[key],'Telemetry event binding mismatch');
      if(entry.type==='usage'){observedUsage=normalizeUsage(entry.data.total);usageSequence=entry.sequence;}
      if(entry.type==='final-answer')answerSequence=entry.sequence;
      if(entry.type==='terminal'){
        assert.equal(terminal,null,'Duplicate telemetry terminal');
        terminal={status:entry.data.status,sequence:entry.sequence};
      }
    }else if(entry.type==='implementation-stopped'){
      assert.equal(implementation,null,'Duplicate implementation timing');
      assert.equal(entry.data.writersStopped,true);assert.equal(entry.data.activeProcesses,0);assert.equal(entry.data.appContainer,true);
      implementation=entry;
    }else if(entry.type==='finished'){
      assert.equal(finished,null,'Duplicate telemetry finish');finished=entry;
    }else if(entry.type==='capture-error')captureErrors++;
    else assert.equal(entry.type,'checkpoint','Unknown telemetry record');
  }
  const verified=!truncatedTail&&captureErrors===0&&terminal?.status==='completed'&&observedUsage!==null&&answerSequence!==null&&usageSequence>answerSequence;
  const last=entries.at(-1),elapsed=last.monotonicMs-first.monotonicMs;
  return {schemaVersion:1,binding,clock:first.data.clock,records:entries.length,lastHash:last.hash,truncatedTail,
    observedUsage,finalUsage:verified?observedUsage:null,usageStatus:verified?'confirmed-final':observedUsage?'partial':'missing',
    providerTurnStatus:terminal?.status??null,captureErrors,
    timing:{implementationMs:implementation&&!truncatedTail?implementation.monotonicMs-first.monotonicMs:null,
      elapsedMs:finished&&!truncatedTail?finished.monotonicMs-first.monotonicMs:null,
      elapsedObservedMs:elapsed,complete:finished!==null&&!truncatedTail&&captureErrors===0,lastCheckpointAt:last.at,lastStage:last.data.stage??last.type}};
}

export function readInvocationTelemetry(file,expectedBinding={}){
  const bytes=readFileSync(file,'utf8'),parts=bytes.split('\n');
  const truncatedTail=parts.at(-1)!=='';
  parts.pop();
  const entries=[];let previousHash=null,lastMonotonic=-Infinity;
  for(const text of parts){
    assert.ok(text.trim(),'Empty telemetry record');
    const entry=JSON.parse(text),{hash,...body}=entry;
    assert.equal(body.schemaVersion,1);assert.equal(body.sequence,entries.length);
    assert.equal(body.previousHash,previousHash,'Telemetry chain mismatch');
    assert.equal(digest(body),hash,'Telemetry hash mismatch');
    assert.ok(Number.isFinite(body.monotonicMs)&&body.monotonicMs>=lastMonotonic,'Telemetry clock moved backwards');
    assert.ok(Number.isFinite(Date.parse(body.at)),'Invalid telemetry wall timestamp');
    entries.push(entry);previousHash=hash;lastMonotonic=body.monotonicMs;
  }
  const summary=summarize(entries,truncatedTail);
  for(const [key,value] of Object.entries(expectedBinding))assert.equal(summary.binding[key],value,'Unexpected telemetry identity: '+key);
  return summary;
}

export function createInvocationTelemetry({file,binding,startMonotonicMs=performance.now(),now=()=>performance.now(),wallNow=()=>Date.now()}){
  for(const key of ['protocolHash','attemptId','slotId'])assert.ok(typeof binding[key]==='string'&&binding[key],'Missing telemetry identity: '+key);
  const descriptor=openSync(file,'wx');
  const entries=[];let previousHash=null,closed=false,timer=null,persistentError=null;
  const append=(type,data,monotonicMs=now())=>{
    assert.equal(closed,false,'Telemetry writer closed');
    if(persistentError)throw persistentError;
    assert.ok(Number.isFinite(monotonicMs)&&monotonicMs>=(entries.at(-1)?.monotonicMs??startMonotonicMs),'Telemetry clock moved backwards');
    const body={schemaVersion:1,sequence:entries.length,previousHash,type,at:new Date(wallNow()).toISOString(),monotonicMs,data};
    const entry={...body,hash:digest(body)},candidate=[...entries,entry];
    summarize(candidate);
    try{
      const bytes=Buffer.from(JSON.stringify(entry)+'\n');
      let offset=0;
      while(offset<bytes.length){const written=writeSync(descriptor,bytes,offset,bytes.length-offset);assert.ok(written>0,'Telemetry short write');offset+=written;}
      fsyncSync(descriptor);entries.push(entry);previousHash=entry.hash;
      return entry;
    }catch(error){persistentError=error;throw error;}
  };
  try{append('start',{binding:{...binding},clock:{id:randomUUID(),pid:process.pid,timeOrigin:performance.timeOrigin}},startMonotonicMs);}
  catch(error){closeSync(descriptor);throw error;}
  const api={
    bind(patch){
      const current=summarize(entries).binding,change={};
      for(const [key,value] of Object.entries(patch)){
        if(value===null||value===undefined)continue;
        assert.ok(['runId','threadId','turnId'].includes(key));
        assert.ok(!current[key]||current[key]===value,'Telemetry binding changed');
        if(!current[key])change[key]=value;
      }
      if(Object.keys(change).length)append('bind',change);
    },
    observe(message){
      const params=message.params??{};
      let type;
      if(message.method==='thread/tokenUsage/updated')type='usage';
      else if(message.method==='turn/completed')type='terminal';
      else if(message.method==='item/completed'&&params.item?.type==='agentMessage'&&params.item.phase==='final_answer')type='final-answer';
      else return;
      const current=summarize(entries).binding;
      assert.ok(current.runId&&current.threadId,'Telemetry launch binding missing');
      assert.equal(params.threadId,current.threadId,'Telemetry event thread mismatch');
      const turnId=type==='terminal'?params.turn?.id:params.turnId;
      assert.ok(typeof turnId==='string'&&turnId,'Telemetry event turn missing');
      api.bind({turnId});
      const data={binding:{runId:current.runId,threadId:current.threadId,turnId},providerEventHash:digest(message)};
      if(type==='usage'){normalizeUsage(params.tokenUsage?.total);data.total=params.tokenUsage.total;}
      if(type==='terminal'){assert.ok(['completed','failed','interrupted'].includes(params.turn.status),'Invalid terminal status');data.status=params.turn.status;}
      append(type,data);
    },
    checkpoint(stage){assert.ok(typeof stage==='string'&&stage);append('checkpoint',{stage});},
    implementationStopped(stop){append('implementation-stopped',{writersStopped:stop?.writersStopped,activeProcesses:stop?.activeProcesses,appContainer:stop?.appContainer});},
    finish(status){if(timer){clearInterval(timer);timer=null;}assert.ok(typeof status==='string'&&status);append('finished',{status});},
    snapshot(){if(persistentError)throw persistentError;return summarize(entries);},
    startHeartbeat({intervalMs=1000,onError=()=>{}}={}){
      assert.equal(timer,null);assert.ok(Number.isSafeInteger(intervalMs)&&intervalMs>=10);
      timer=setInterval(()=>{try{api.checkpoint('heartbeat');}catch(error){clearInterval(timer);timer=null;onError(error);}},intervalMs);
      timer.unref();
    },
    close(){if(timer){clearInterval(timer);timer=null;}if(!closed){closed=true;closeSync(descriptor);}}
  };
  for(const name of ['bind','observe']){
    const operation=api[name];
    api[name]=(...args)=>{
      try{return operation(...args);}
      catch(error){
        if(!closed&&!persistentError)append('capture-error',{operation:name,message:error.message});
        throw error;
      }
    };
  }
  return api;
}
