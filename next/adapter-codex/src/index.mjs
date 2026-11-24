import { randomUUID,createHash } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError,toolMetadata } from '@bridge-v2/runtime';
import { CodexRpc } from './rpc.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const usageFields=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const compactToolSchema=value=>{
  if(Array.isArray(value))return value.map(compactToolSchema);
  if(!value||typeof value!=='object')return value;
  const omitted=new Set(['$schema','$id','examples','maxLength','maxItems','uniqueItems','maximum']);
  return Object.fromEntries(Object.entries(value).filter(([key])=>!omitted.has(key)).map(([key,item])=>[key,compactToolSchema(item)]));
};
export const dynamicTools=[{type:'namespace',name:'bridge',description:'Versioned task checkpoint and exact evidence/history lookup',tools:toolMetadata.map(tool=>({
  type:'function',name:tool.name.slice('bridge.'.length),description:tool.description+' Handoff/complete receipts remain pending until writers stop and source publication commits.',inputSchema:compactToolSchema(tool.inputSchema),
}))}];

export class CodexAdapter {
  constructor(host,sessionId,rpc,{model=null,effort=null,freshThread=true,tokenProvider=null,bridgeEnabled=true}={}) {
    this.host=host;this.sessionId=sessionId;this.rpc=rpc;this.model=model;this.effort=effort;
    this.threadId=null;this.activeTurn=null;this.offer=null;this.pendingAck=null;this.retention=null;
    this.tokenProvider=tokenProvider;this.authAccountId=null;
    this.bridgeEnabled=bridgeEnabled;
    this.completed=new Map();this.waiters=new Map();this.processExits=new Map();this.processWaiters=new Map();this.usageBaseline=freshThread?Object.fromEntries(usageFields.map(k=>[k,0])):null;
    this.usageLast=this.usageBaseline;this.turnUsageBaseline=null;this.usageBaselines=new Map();
    this.metrics={turnRequests:0,checkpointCalls:0,lookupCalls:0,contextBytesDelivered:0,failedOperations:0,sourceReads:null,modelInvocations:null};
    this.capabilities={structuredInput:'dynamic-tools',writeBoundary:'external-appcontainer',resume:'full-snapshot-new-session',reset:'full-snapshot',compaction:'full-snapshot',inferenceVerified:false,networkAccess:'restricted'};
    if(!bridgeEnabled)this.capabilities.structuredInput='none';
    rpc.on('request',message=>{this.handleRequest(message).catch(error=>{this.metrics.failedOperations++;rpc.emit('failure',error);});});
    rpc.on('notification',message=>{try{this.notification(message);}catch(error){this.metrics.failedOperations++;rpc.emit('failure',error);}});
    rpc.on('failure',()=>{this.retention=null;this.protocolFailed=true;rpc.transport.stop().then(receipt=>this.host.stopped(this.sessionId,receipt,{crashed:true,publish:false})).catch(()=>{this.metrics.failedOperations++;});});
    rpc.on('closed',()=>{
      for(const waiter of this.waiters.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Provider closed before turn completion'));}this.waiters.clear();
      for(const waiter of this.processWaiters.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Provider closed before native process exit'));}this.processWaiters.clear();
    });
  }
  async initialize({resumeThreadId=null}={}) {
    this.initializeReceipt=await this.rpc.request('initialize',{clientInfo:{name:'bridge_v2',title:'Bridge v2',version:'2.0.0-dev.0'},capabilities:{experimentalApi:true}});
    this.rpc.notify('initialized');
    if(this.tokenProvider){
      const tokens=await this.tokens();
      const login=await this.rpc.request('account/login/start',{type:'chatgptAuthTokens',...tokens});
      if(login.type!=='chatgptAuthTokens')throw new Error('External host authentication was not accepted');
      this.authAccountId=tokens.chatgptAccountId;
    }
    const workspace=this.host.broker.workspace(this.host.session(this.sessionId).workspace_id);
    if(resumeThreadId) {
      const binding=this.host.db.prepare('SELECT * FROM provider_threads WHERE thread_id=?').get(resumeThreadId);
      if(!binding||binding.task_id!==workspace.task_id||binding.workspace_id!==workspace.id)throw new BridgeError('PROVIDER_REBIND_FORBIDDEN','/threadId','persisted task/workspace binding');
    }
    const params={cwd:workspace.root,approvalPolicy:'never',sandbox:'danger-full-access',...(this.model?{model:this.model}:{})};
    let result;
    if(resumeThreadId){
      try{result=await this.rpc.request('thread/resume',{...params,threadId:resumeThreadId,excludeTurns:true});this.resumeReceipt={mode:'thread-resume',threadId:resumeThreadId};}
      catch(error){
        if(error.code!==-32600||!/no rollout found/i.test(error.message))throw error;
        result=await this.rpc.request('thread/start',{...params,dynamicTools:this.bridgeEnabled?dynamicTools:[],ephemeral:false});
        this.resumeReceipt={mode:'new-thread-full-snapshot',reason:'no-persisted-rollout',requestedThreadId:resumeThreadId};
        this.usageLast=Object.fromEntries(usageFields.map(key=>[key,0]));
      }
    }else result=await this.rpc.request('thread/start',{...params,dynamicTools:this.bridgeEnabled?dynamicTools:[],ephemeral:false});
    if(!result.thread?.id)throw new Error('Codex did not return a thread identity');
    this.threadReceipt=result;
    this.threadId=result.thread.id;
    this.host.bindThread(this.sessionId,this.threadId);
    this.retention=null;
    return result;
  }
  async tokens(){
    if(typeof this.tokenProvider!=='function')throw new Error('Host token provider unavailable');
    const value=await this.tokenProvider();
    if(!value||typeof value.accessToken!=='string'||!value.accessToken||typeof value.chatgptAccountId!=='string'||!value.chatgptAccountId||
      this.authAccountId&&this.authAccountId!==value.chatgptAccountId)throw new Error('Host authentication identity unavailable or changed');
    return {accessToken:value.accessToken,chatgptAccountId:value.chatgptAccountId,...(typeof value.chatgptPlanType==='string'?{chatgptPlanType:value.chatgptPlanType}:{})};
  }
  async handleRequest(message) {
    if(message.method==='account/chatgptAuthTokens/refresh'){
      try{
        if(!this.authAccountId||message.params?.previousAccountId&&message.params.previousAccountId!==this.authAccountId)throw new Error('Authentication binding mismatch');
        this.rpc.send({id:message.id,result:await this.tokens()});
      }catch{this.rpc.send({id:message.id,error:{code:-32001,message:'Host authentication unavailable'}});}
      return;
    }
    try {
      if(message.method!=='item/tool/call'||!this.bridgeEnabled){
        this.rpc.send({id:message.id,error:{code:-32601,message:'Unsupported server request; no implicit approval'}});return;
      }
      const params=message.params||{};
      if(params.threadId!==this.threadId||!this.activeTurn||params.turnId!==this.activeTurn)throw new BridgeError('TOOL_TURN_BINDING','/turnId','active bound provider turn');
      const name=params.namespace?params.namespace+'.'+params.tool:params.tool;
      if(name==='bridge.checkpoint')this.metrics.checkpointCalls++;
      if(name==='bridge.lookup')this.metrics.lookupCalls++;
      const result=this.host.tool(this.sessionId,name,params.arguments);
      this.rpc.send({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
    } catch(error) {
      this.metrics.failedOperations++;
      const detail=error instanceof BridgeError?error.toJSON():{code:'BRIDGE_TOOL_FAILED',field:'/',expected:'valid structured tool input',currentVersion:null};
      this.rpc.send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:JSON.stringify(detail)}]}});
    }
  }
  acknowledge() {
    if(!this.offer||!this.pendingAck)return;
    const receipt=this.host.delivery.receipt(this.offer.id);
    if(receipt.status==='offered')return;
    try{this.host.delivery.acknowledge(this.offer.id,this.pendingAck);}catch{this.metrics.failedOperations++;}
    this.pendingAck=null;
  }
  notification(message) {
    const params=message.params||{};
    if(params.threadId&&this.threadId&&params.threadId!==this.threadId)throw new BridgeError('PROVIDER_EVENT_BINDING','/threadId','bound provider thread');
    this.host.observe(this.sessionId,message);
    if(message.method==='process/exited'){
      this.processExits.set(params.processHandle,params);
      const waiter=this.processWaiters.get(params.processHandle);if(waiter){clearTimeout(waiter.timer);this.processWaiters.delete(params.processHandle);waiter.resolve(params);}
    }
    if(message.method==='turn/started'){this.activeTurn=params.turn.id;if(!this.usageBaselines.has(params.turn.id))this.usageBaselines.set(params.turn.id,this.turnUsageBaseline);}
    if(['thread/compacted','thread/reset'].includes(message.method)||(message.method==='item/completed'&&params.item?.type==='contextCompaction')) {
      this.host.delivery.reset(this.sessionId,'provider-reset-or-compaction');this.retention=null;this.pendingAck=null;
    }
    if(this.bridgeEnabled&&['item/started','item/completed'].includes(message.method)&&params.item?.type==='userMessage'&&this.offer) {
      const content=(params.item.content||[]).map(item=>typeof item.text==='string'?item.text:'').join('');
      if(hash(content)===this.offer.textHash){this.pendingAck={threadId:params.threadId,turnId:params.turnId,textHash:hash(content)};this.acknowledge();}
    }
    if(message.method==='thread/tokenUsage/updated') {
      const total=params.tokenUsage?.total;
      if(total&&usageFields.every(key=>Number.isSafeInteger(total[key]??(key==='cacheWriteInputTokens'?0:NaN))&&(total[key]??0)>=0)){
        const next=Object.fromEntries(usageFields.map(key=>[key,total[key]??0]));
        const baseline=this.usageBaselines.get(params.turnId)||null;
        const deltas=baseline?Object.fromEntries(usageFields.map(key=>[key,next[key]-baseline[key]])):null;
        const valid=deltas&&usageFields.every(key=>deltas[key]>=0)&&deltas.cachedInputTokens<=deltas.inputTokens;
        const usage=valid?{...deltas,uncachedInputTokens:deltas.inputTokens-deltas.cachedInputTokens}:null;
        this.host.db.prepare('INSERT INTO provider_invocations VALUES (?,?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET usage_json=excluded.usage_json').run(this.sessionId,params.turnId,'inProgress',JSON.stringify({reportedTotal:next,turnUsage:usage}));
        if(!this.usageLast||usageFields.every(key=>next[key]>=this.usageLast[key]))this.usageLast=next;
      }
    }
    if(message.method==='turn/completed') {
      const turn=params.turn;this.completed.set(turn.id,turn);
      this.retention=turn.status==='completed'?this.host.delivery.proof(this.sessionId,this.threadId,turn.id):null;
      if(turn.status==='completed')this.capabilities.inferenceVerified=true;
      const waiter=this.waiters.get(turn.id);if(waiter){clearTimeout(waiter.timer);this.waiters.delete(turn.id);waiter.resolve(turn);}
      if(this.activeTurn===turn.id)this.activeTurn=null;
    }
  }
  async turn(request,{timeoutMs=120000}={}) {
    if(!this.threadId||this.activeTurn||this.offer?.inFlight)throw new BridgeError('TURN_STATE_INVALID','/turn','idle initialized provider thread');
    if(typeof request!=='string'||!request)throw new Error('Current request required');
    const offer=this.bridgeEnabled?this.host.delivery.offer(this.sessionId,request,this.retention):
      {text:request,textHash:hash(request),bytes:Buffer.byteLength(request),status:'offered',mode:'raw'};
    if(offer.status==='overflow')return offer;
    this.offer={...offer,inFlight:true};this.pendingAck=null;this.turnUsageBaseline=this.usageLast;
    this.metrics.turnRequests++;
    try {
      const response=await this.rpc.request('turn/start',{threadId:this.threadId,input:[{type:'text',text:offer.text}],approvalPolicy:'never',sandboxPolicy:{type:'externalSandbox',networkAccess:'restricted'},
        ...(this.model?{model:this.model}:{}),...(this.effort?{effort:this.effort}:{})});
      const turnId=response.turn?.id;if(!turnId)throw new Error('Codex turn identity missing');
      if(!this.usageBaselines.has(turnId))this.usageBaselines.set(turnId,this.turnUsageBaseline);
      if(this.bridgeEnabled){this.host.delivery.delivered(offer.id,{threadId:this.threadId,turnId});this.acknowledge();}this.metrics.contextBytesDelivered+=offer.bytes;
      const completed=this.completed.get(turnId)||await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.waiters.delete(turnId);reject(new Error('Codex turn completion timeout'));},timeoutMs);this.waiters.set(turnId,{resolve,reject,timer});
      });
      this.retention=this.bridgeEnabled&&completed.status==='completed'?this.host.delivery.proof(this.sessionId,this.threadId,turnId):null;
      return {turn:completed,delivery:this.bridgeEnabled?this.host.delivery.receipt(offer.id):{status:'delivered',mode:'raw',textHash:offer.textHash,bytes:offer.bytes}};
    } catch(error){this.metrics.failedOperations++;this.retention=null;throw error;}
    finally{this.offer.inFlight=false;}
  }
  async close({publish=true,crashed=false}={}) {
    const receipt=await this.rpc.close();
    return this.host.stopped(this.sessionId,receipt,{publish,crashed:crashed||Boolean(this.rpc.failure)||this.protocolFailed===true});
  }
  async execute(command,{timeoutMs=10000,outputBytesCap=1024*1024}={}) {
    if(!this.threadId||!Array.isArray(command)||!command.length||!command.every(part=>typeof part==='string'&&!part.includes('\0')))throw new BridgeError('COMMAND_INVALID','/command','argv vector on a bound provider connection');
    const processHandle=randomUUID(),workspace=this.host.broker.workspace(this.host.session(this.sessionId).workspace_id).root;
    await this.rpc.request('process/spawn',{processHandle,command,cwd:workspace,streamStdin:false,streamStdoutStderr:false,tty:false,timeoutMs,outputBytesCap});
    const result=this.processExits.get(processHandle)||await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.processWaiters.delete(processHandle);reject(new Error('Native process exit timeout'));},timeoutMs+5000);
      this.processWaiters.set(processHandle,{resolve,reject,timer});
    });
    const reference=this.host.observe(this.sessionId,{method:'item/completed',params:{threadId:this.threadId,item:{type:'commandExecution',id:'native-'+processHandle,
      command:command.map(part=>JSON.stringify(part)).join(' '),exitCode:result.exitCode,aggregatedOutput:result.stdout,stderr:result.stderr,
      stdoutTruncated:result.stdoutCapReached,stderrTruncated:result.stderrCapReached}}});
    return {...result,evidenceReference:reference};
  }
  static async launch({host,sandbox,protectedFiles,sessionId,workspaceId,executable,model=null,effort=null,resumeThreadId=null,maxSessionMs=600000,tokenProvider=null,internetClient=false,bridgeEnabled=true}) {
    const runId=randomUUID(),receiptPath=join(sandbox.control,runId+'.receipt');
    const reserved=host.reserve({sessionId,workspaceId,runId,receiptPath});
    const workspace=host.broker.workspace(workspaceId).root;
    const proof=sandbox.verify({workspace,protectedFiles,internetClient});
    if(!proof.writerEnabled){
      const stopped=!proof.nativeCanaryAttempted||proof.steps.some(step=>step.operation==='native-canary'&&step.receipt?.writersStopped&&step.receipt.activeProcesses===0);
      if(stopped)host.cancelReserved(sessionId);
      throw new BridgeError('WRITE_BOUNDARY_UNVERIFIED','/sandbox','actual bound workspace/protected-root canary');
    }
    host.launching(sessionId);
    const transport=sandbox.start({workspace,executable,runId,maxSessionMs,readOnlyExecutable:true,arguments:['app-server','--listen','stdio://',
      '-c','cli_auth_credentials_store="ephemeral"','-c','web_search="disabled"','-c','model_auto_compact_token_limit=1000000000',
      '--disable','hooks','--disable','apps','--disable','multi_agent','--disable','multi_agent_v2','--disable','multi_agent_v2_dynamic_tools','--disable','memories',
      '--disable','external_agent_memory_import','--disable','skill_search','--disable','in_app_browser','--disable','in_app_chat','--disable','standalone_web_search','--disable','browser_use','--disable','computer_use']});
    host.activated(reserved.session_id,transport);
    const rpc=new CodexRpc(transport),adapter=new CodexAdapter(host,sessionId,rpc,{model,effort,freshThread:!resumeThreadId,tokenProvider,bridgeEnabled});
    adapter.boundaryProof=proof;adapter.capabilities.networkAccess=internetClient?'appcontainer-internet-client':'restricted';
    try{await adapter.initialize({resumeThreadId});return adapter;}
    catch(error){try{await adapter.close({publish:false,crashed:true});}catch{}throw error;}
  }
}

export { CodexRpc } from './rpc.mjs';

