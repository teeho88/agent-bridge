import { mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
const out=resolve(process.argv[2]??'docs/phase8-recovery-20261019'),source=resolve('.bridge-tmp/recovery/baseline-source');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
if(!read(join(out,'checks.json')).every(c=>c.exitCode===0))throw Error('Checks must pass');
const sourceManifest=join(out,'baseline-source.json'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const directory=resolve('next/.local/recovered-baselines',randomUUID()),frozen=join(directory,'protocol'),production=join(frozen,'bridge-runtime/node_modules'),visited=new Set();
mkdirSync(frozen,{recursive:true});
function pack(location){
 location=realpathSync(location);const pkg=read(join(location,'package.json'));if(visited.has(pkg.name))return;visited.add(pkg.name);
 cpSync(location,join(production,pkg.name),{recursive:true,dereference:true,filter:p=>{const parts=relative(location,p).split(/[\\/]/);return !parts.includes('node_modules')&&(!pkg.name.startsWith('@agent-bridge/')||!parts[0]||['dist','package.json'].includes(parts[0]));}});
 const require=createRequire(join(location,'package.json'));
 for(const dependency of Object.keys(pkg.dependencies??{})){
  let entry;try{entry=require.resolve(dependency+'/package.json');}catch{entry=require.resolve(dependency);}
  let parent=dirname(entry);while(!existsSync(join(parent,'package.json'))||read(join(parent,'package.json')).name!==dependency){const next=dirname(parent);if(next===parent)throw Error('Missing '+dependency);parent=next;}pack(parent);
 }
}
pack(join(source,'packages/cli'));
copyFileSync('benchmarks/task-management/native-stdio.cjs',join(frozen,'bridge-runtime/native-stdio.cjs'));
const {codexManagedSection}=await import(pathToFileURL(join(source,'packages/adapters/dist/codex.js')));
writeFileSync(join(frozen,'AGENTS.md'),codexManagedSection({hooked:false}).replaceAll('agent-bridge ','node .bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js '));
copyFileSync(sourceManifest,join(frozen,'baseline-source.json'));
copyFileSync(join(source,'pnpm-lock.yaml'),join(frozen,'pnpm-lock.yaml'));
const files={};function walk(p,prefix=''){for(const e of readdirSync(p,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())walk(join(p,e.name),rel+'/');else if(e.isFile())files[rel]=hash(join(p,e.name));else throw Error('Unexpected frozen link');}}walk(frozen);
const manifest={schemaVersion:3,id:randomUUID(),createdAt:new Date().toISOString(),directory,codeProvenance:'rebuilt legacy 0.1.1 from 2026-10-11 archive plus recorded pre-Phase-1 changes; fresh recovered baseline, historical revision-5 byte identity unverified',archiveManifestHash:hash(sourceManifest),sourceArchiveHash:read(sourceManifest).archiveHash,measurementStatus:'not-yet-measured; collect B smoke/formal under comparison protocol',frozen:files};
manifest.protocolHash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
writeFileSync(join(directory,'protocol.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
writeFileSync(join(out,'baseline.json'),JSON.stringify({directory,protocolHash:manifest.protocolHash,protocol:join(directory,'protocol.json')},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({directory,protocolHash:manifest.protocolHash,packages:visited.size}));
