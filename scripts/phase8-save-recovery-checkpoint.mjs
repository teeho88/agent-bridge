import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statfsSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const out=resolve('docs/phase8-recovery-20261019/validated'),name=process.argv[2];
if(!name||!/^[A-Za-z0-9_-]+$/.test(name))throw Error('Unique checkpoint name required');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const pointer=read('docs/phase8-2-20261018/round.json'),manifest=read(pointer.protocol);
const {protocolHash,...body}=manifest;
if(protocolHash!==pointer.protocolHash||createHash('sha256').update(JSON.stringify(body)).digest('hex')!==protocolHash)throw Error('Protocol fingerprint mismatch');
for(const [p,h]of Object.entries(manifest.frozen))if(hash(join(pointer.directory,'protocol',p))!==h)throw Error('Frozen drift '+p);
for(const [p,h]of Object.entries(manifest.harnessSources))if(hash(p)!==h)throw Error('Harness drift '+p);
if(manifest.maxWeightedTokens!==200000||manifest.outputTokenWeight!==8||manifest.maxAttempts!==2||manifest.schedule.length!==50||manifest.smoke.length!==6)throw Error('Unexpected measurement contract');
const sources={};
function walk(p,prefix){for(const e of readdirSync(p,{withFileTypes:true})){if(['node_modules','dist'].includes(e.name))continue;const rel=prefix+'/'+e.name;if(e.isDirectory())walk(join(p,e.name),rel);else if(e.isFile())sources[rel]=hash(join(p,e.name));}}
for(const p of ['packages','next/runtime/src','next/adapter-codex/src','benchmarks/task-management'])walk(resolve(p),p);
for(const p of ['package.json','pnpm-lock.yaml','scripts/phase8-recover-sources.mjs','scripts/phase8-recovery-prepare.mjs','scripts/phase8-freeze-recovered-baseline.mjs'])sources[p]=hash(p);
const disk=statfsSync(out);
writeFileSync(join(out,name+'.json'),JSON.stringify({observedAt:new Date().toISOString(),pointer,protocolHash,manifestHash:hash(pointer.protocol),cap:manifest.maxWeightedTokens,weight:manifest.outputTokenWeight,freeBytes:disk.bavail*disk.bsize,sources,state:existsSync(join(pointer.directory,'state.json'))?read(join(pointer.directory,'state.json')):null,historicalEvidenceAvailable:false},null,2)+'\n',{flag:'wx'});
if(name==='freeze-checkpoint'){
 const origin=resolve('.bridge-tmp/recovery/baseline-source'),destination=join(out,'baseline-source');
 function snapshot(p,rel=''){for(const e of readdirSync(p,{withFileTypes:true})){if(['node_modules','dist'].includes(e.name))continue;const r=join(rel,e.name);if(e.isDirectory())snapshot(join(p,e.name),r);else if(e.isFile()){mkdirSync(join(destination,rel),{recursive:true});copyFileSync(join(p,e.name),join(destination,r));}}}
 snapshot(origin);
}
console.log(JSON.stringify({name,protocolHash,freeBytes:disk.bavail*disk.bsize}));
