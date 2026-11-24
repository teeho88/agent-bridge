import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEvidence, verifySourceEvidence } from '../benchmarks/task-management/comparison-evidence.mjs';
const id=process.argv[2];
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const pointer=read('docs/phase8-2-20261018/round.json'),state=read(join(pointer.directory,'state.json'));
const row=state.slots.find(r=>r.id===id);if(!row||row.status!=='finished')throw Error('Completed invocation required');
const evidence=row.evidence;
const events=readFileSync(join(evidence,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const commands=events.filter(r=>r.message.method==='item/completed'&&r.message.params.item.type==='commandExecution').map(r=>({at:r.at,...r.message.params.item}));
if(['packet','artifact','inventory'].includes(process.argv[3])){
 const canonical=canonicalEvidence(evidence);
 if(process.argv[3]==='packet')console.log('CURRENT\n'+canonical.current+'\nCANONICAL\n'+canonical.full);
 if(process.argv[3]==='artifact'){const a=canonical.artifacts[Number(process.argv[4])];if(!a)throw Error('Unknown artifact index');console.log('ARTIFACT '+a.path+' SHA256 '+a.hash+'\n'+a.content);}
 if(process.argv[3]==='inventory')console.log(JSON.stringify({row:{id:row.id,continuationFrom:row.continuationFrom,turnStatus:row.turn.status,failureClass:row.failureClass,usage:row.usage},canonicalHash:canonical.hash,eventsHash:hash(join(evidence,'events.jsonl')),resultHash:hash(join(evidence,'RESULT.md')),commands:commands.map((c,i)=>({index:i,id:c.id,exitCode:c.exitCode,bytes:c.aggregatedOutput?.length??0})),artifacts:canonical.artifacts.map((a,i)=>({index:i,path:a.path,bytes:a.bytes,hash:a.hash}))},null,2));
 process.exit(0);
}
if(process.argv[3]==='commands'){
 const start=Number(process.argv[4]??0),end=Number(process.argv[5]??commands.length);
 for(const [i,c]of commands.entries())if(i>=start&&i<end){console.log('COMMAND '+i+' '+c.id+' EXIT '+c.exitCode+'\n'+c.command+'\nOUTPUT\n'+c.aggregatedOutput);}
 process.exit(0);
}
if(process.argv[3]==='artifacts'){
 const canonical=canonicalEvidence(evidence);console.log('CURRENT\n'+canonical.current+'\nCANONICAL\n'+canonical.full);
 for(const a of canonical.artifacts)console.log('ARTIFACT '+a.path+' SHA256 '+a.hash+'\n'+a.content);
 for(const directory of ['source-before','source-after']){const p=join(evidence,directory);if(existsSync(p))for(const e of readdirSync(p))if(existsSync(join(p,e))&&!readdirSync(p,{withFileTypes:true}).find(x=>x.name===e).isDirectory())console.log(directory+'/'+e+'\n'+readFileSync(join(p,e),'utf8'));}
 process.exit(0);
}
console.log(JSON.stringify({row,eventsHash:hash(join(evidence,'events.jsonl')),resultHash:existsSync(join(evidence,'RESULT.md'))?hash(join(evidence,'RESULT.md')):null,eventCount:events.length,commands},null,2));
for(const e of events){const m=e.message;if(m.method==='error'||m.method==='thread/settings/updated'||m.method==='turn/completed'||m.method==='item/completed'&&m.params.item.type!=='commandExecution'&&m.params.item.type!=='reasoning')console.log(JSON.stringify(e));}
function files(p,prefix=''){if(!existsSync(p))return;for(const e of readdirSync(p,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())files(join(p,e.name),rel+'/');else if(e.isFile())console.log(JSON.stringify({path:rel,hash:hash(join(p,e.name)),content:readFileSync(join(p,e.name),'utf8')}));}}
files(join(evidence,'source-before'),'source-before/');files(join(evidence,'source-after'),'source-after/');
for(const name of ['source-before.json','source-after.json','RESULT.md','acceptance.stdout.log','acceptance.stderr.log','checkpoint.stdout.log','checkpoint.stderr.log','handoff/errors.json'])if(existsSync(join(evidence,name)))console.log(JSON.stringify({path:name,hash:hash(join(evidence,name)),content:readFileSync(join(evidence,name),'utf8')}));
try{
 const canonical=canonicalEvidence(evidence);console.log(JSON.stringify({canonical},null,2));
 const predecessor=state.slots.find(r=>r.id===row.continuationFrom);let original=row;const seen=new Set();while(original.continuationFrom){if(seen.has(original.id))throw Error('Ancestry cycle');seen.add(original.id);original=state.slots.find(r=>r.id===original.continuationFrom);if(!original)throw Error('Missing ancestor');}
 console.log(JSON.stringify({sourceVerification:verifySourceEvidence(evidence,{original:read(join(original.evidence,'source-before.json')),before:read(join(evidence,'source-before.json')),final:read(join(evidence,'source-after.json')),predecessor:predecessor?read(join(predecessor.evidence,'source-after.json')):null},canonical)}));
}catch(error){console.log(JSON.stringify({evidenceError:error.message}));}
