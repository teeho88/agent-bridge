import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, campaignRoot, createDirectory, childEnvironment, containedPath } from '../benchmarks/task-management/remediation-policy.mjs';
import { captureCommand } from '../benchmarks/task-management/command-evidence.mjs';
import { writeCompressedScopeInput } from '../benchmarks/task-management/identity-pool.mjs';
const sid=process.argv[2];
if(!/^S-1-15-2-(\d+-){6}\d+$/.test(sid??''))throw Error('Expected AppContainer SID');
const id='scope-'+randomUUID(),directory=createDirectory(join(campaignRoot,'offline',id)),env=childEnvironment(join(directory,'scratch'));
const entries=[],links=[];
containedPath(projectRoot);
function walk(path){
  entries.push({path,directory:true});
  for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=join(path,entry.name);
    if(entry.isSymbolicLink()){links.push(file);continue;}
    if(entry.isDirectory())walk(file);else if(entry.isFile())entries.push({path:file,directory:false});
  }
}
walk(projectRoot);
const input=join(directory,'scope-input.json.gz');
await writeCompressedScopeInput(input,{root:projectRoot,sid,entries,links});
writeFileSync(join(directory,'manifest.json'),JSON.stringify({id,registeredTemporary:[{owner:id,path:join(directory,'scratch')}]}));
const result=captureCommand({directory,id:'acl',executable:'pwsh.exe',argv:['-NoProfile','-NonInteractive','-File',join(projectRoot,'scripts/phase8-sid-scope.ps1'),'-InputFile',input],cwd:projectRoot,env,timeout:900000});
let scope=null,parseError=null;
try { const output=readFileSync(result.stdout.path,'utf8').trim(); if(output)scope=JSON.parse(output); else parseError='ACL audit returned empty stdout'; }
catch(error) { parseError=error.message; }
const cleanup=captureCommand({directory,id:'cleanup',executable:process.execPath,argv:['scripts/phase8-cleanup-retry.mjs',directory],cwd:projectRoot,env});
const passed=result.exitCode===0 && scope?.passed===true && cleanup.exitCode===0;
console.log(JSON.stringify({directory,exitCode:result.exitCode,signal:result.signal??null,error:result.error??null,scope,parseError,cleanupExitCode:cleanup.exitCode,passed}));
process.exitCode=passed?0:2;
