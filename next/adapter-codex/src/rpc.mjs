import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class CodexRpc extends EventEmitter {
  constructor(transport,{requestTimeoutMs=30000}={}) {
    super();this.transport=transport;this.timeout=requestTimeoutMs;this.nextId=1;this.pending=new Map();
    this.decoder=new StringDecoder('utf8');this.buffer='';this.stopped=false;this.closing=false;this.failure=null;
    this.metrics={bytesReceived:0,bytesSent:0,messagesReceived:0,failedOperations:0};
    this.timer=setInterval(()=>this.poll(),10);this.timer.unref();
    transport.closed.then(receipt=>{this.poll();if(this.buffer.trim())this.failure=new Error('Truncated Codex protocol message');this.fail(new Error('Codex transport closed'),this.closing);this.emit('closed',receipt);});
  }
  send(message) {
    if(this.stopped)throw new Error('Codex transport closed');
    this.transport.send(message);this.metrics.bytesSent+=Buffer.byteLength(JSON.stringify(message)+'\n');
  }
  request(method,params={}) {
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);this.metrics.failedOperations++;reject(new Error('Codex RPC timeout: '+method));},this.timeout);
      this.pending.set(id,{resolve,reject,timer,method});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  notify(method,params={}) {this.send({method,params});}
  poll() {
    if(this.stopped)return;
    try {
      const bytes=this.transport.read();this.metrics.bytesReceived+=bytes.length;this.buffer+=this.decoder.write(bytes);
      if(Buffer.byteLength(this.buffer)>2*1024*1024)throw new Error('Codex protocol line overflow');
      let end;
      while((end=this.buffer.indexOf('\n'))!==-1){
        const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);
        if(!line.trim())continue;
        const message=JSON.parse(line);this.metrics.messagesReceived++;
        if(message.method&&Object.hasOwn(message,'id'))this.emit('request',message);
        else if(message.method)this.emit('notification',message);
        else {
          const pending=this.pending.get(message.id);
          if(!pending)continue;
          this.pending.delete(message.id);clearTimeout(pending.timer);
          if(message.error){this.metrics.failedOperations++;const error=new Error(message.error.message||'Codex RPC error');error.code=message.error.code;pending.reject(error);}
          else pending.resolve(message.result);
        }
      }
    } catch(error){this.fail(error);this.emit('failure',error);}
  }
  fail(error,expected=false) {
    if(!expected)this.failure=error;
    if(this.stopped)return;this.stopped=true;clearInterval(this.timer);
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}
    this.pending.clear();
  }
  async close(){this.closing=true;const receipt=await this.transport.stop();this.poll();this.fail(new Error('Codex RPC stopped'),true);return receipt;}
}

