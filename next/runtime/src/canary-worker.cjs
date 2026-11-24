const fs=require('node:fs');
const cp=require('node:child_process');
const path=require('node:path');
const protectedFiles=JSON.parse(process.argv[2]);
const child=process.argv[3]==='child';
const marker=process.argv[4];
let allowed=false;
try{fs.writeFileSync(path.join(process.cwd(),'.bridge-tmp',child?'allowed-child':'allowed-parent'),'ok');allowed=true;}catch{}
const attempts=protectedFiles.map(entry=>{
  let writeDenied=false,readDenied=false;
  try{const fd=fs.openSync(entry.path,'r+');fs.closeSync(fd);}catch(error){writeDenied=['EACCES','EPERM'].includes(error.code);}
  try{fs.readFileSync(entry.path);}catch(error){readDenied=['EACCES','EPERM'].includes(error.code);}
  return {kind:entry.kind,writeDenied,readDenied};
});
let descendant=null;
if(!child){
  const resultFile=__filename+'.child-result.json';
  const run=cp.spawnSync(process.execPath,[...process.execArgv,__filename,JSON.stringify(protectedFiles),'child',marker,resultFile],{stdio:['ignore','inherit','inherit'],windowsHide:true,timeout:3000});
  try{if(run.status===0)descendant=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch{}
  const code='setTimeout(()=>require("node:fs").writeFileSync('+JSON.stringify(marker)+',"bypass"),2000)';
  const late=cp.spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore',windowsHide:true});late.unref();
}
const result=JSON.stringify({allowed,attempts,descendant});
if(child&&process.argv[5])fs.writeFileSync(process.argv[5],result,{flag:'wx'});
else console.log(result);
