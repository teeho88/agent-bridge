import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
const sessionRoot=path.join(process.env.USERPROFILE,'.codex/sessions/2026/10');
const baselineMode=process.env.PHASE8_RECOVERY_SCOPE==='baseline';
const stage=path.resolve(baselineMode?'.bridge-tmp/recovery/baseline-source':'.bridge-tmp/recovery/next'), files=new Map(), provenance=[], failures=[];
if(baselineMode){function load(p,prefix=''){for(const e of fs.readdirSync(p,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='dist')continue;const rel=prefix+e.name;if(e.isDirectory())load(path.join(p,e.name),rel+'/');else if(e.isFile())files.set(rel,fs.readFileSync(path.join(p,e.name),'utf8'));}}load(stage);}
const operations=[];
function parse(code){return ts.createSourceFile('recovery.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);}
for(const day of fs.readdirSync(sessionRoot))for(const name of fs.readdirSync(path.join(sessionRoot,day))){
 if(!name.endsWith('.jsonl'))continue;
 const source=path.join(sessionRoot,day,name);
 for(const line of fs.readFileSync(source,'utf8').split('\n')){
  let r;try{r=JSON.parse(line);}catch{continue;}
  if(r.timestamp>=(baselineMode?'2026-10-16T09:58:51Z':'2026-10-19T04:00:00Z'))continue;
  if(baselineMode&&r.timestamp<'2026-10-12T00:00:00Z')continue;
  const item=r.payload?.item;
  if(r.type==='event_msg'&&r.payload?.type==='item_completed'&&typeof item?.arguments?.code==='string')operations.push({time:r.timestamp,source,id:item.id,kind:'js',code:item.arguments.code});
  if(r.type==='event_msg'&&r.payload?.type==='item_completed'&&item?.type==='FileChange'){
   for(const [p,change] of Object.entries(item.changes??{})){
    if(change.type==='add')operations.push({time:r.timestamp,source,id:item.id,kind:'patch',code:'*** Begin Patch\n*** Add File: '+p+'\n'+change.content.split('\n').map(l=>'+'+l).join('\n')+'\n*** End Patch'});
    else if(change.type==='update')operations.push({time:r.timestamp,source,id:item.id,kind:'patch',code:'*** Begin Patch\n*** Update File: '+p+'\n'+change.unified_diff+'\n*** End Patch'});
   }
  }
  const p=r.payload;
  if(false&&r.type==='response_item'&&p?.type==='custom_tool_call'){
   if(p.name==='apply_patch'&&typeof p.input==='string')operations.push({time:r.timestamp,source,id:p.call_id,kind:'patch',code:p.input});
   else if(p.name==='exec'&&typeof p.input==='string'&&p.input.includes('apply_patch')){
    function visit(n){if(ts.isCallExpression(n)&&n.expression.getText().endsWith('.apply_patch')&&n.arguments.length&&ts.isStringLiteralLike(n.arguments[0]))operations.push({time:r.timestamp,source,id:p.call_id,kind:'patch',code:n.arguments[0].text});ts.forEachChild(n,visit);}
    visit(parse(p.input));
   }
  }
 }
}
operations.sort((a,b)=>a.time.localeCompare(b.time));
let current;
function clean(p){p=String(p).replaceAll('\\','/');if(baselineMode){const marker='/Optimize_token_and_memory_pool/';const i=p.indexOf(marker);if(i>=0)p=p.slice(i+marker.length);if(!/^packages\/(cli|core|memory|adapters)\//.test(p)||p.split('/').includes('..'))throw Error('Out of recovery scope: '+p);return p;}const i=p.indexOf('/next/');if(i>=0)p=p.slice(i+6);else p=p.replace(/^next\//,'');if(!/^(runtime\/|adapter-codex\/|tests\/|package(?:-lock)?\.json$)/.test(p)||p.split('/').includes('..'))throw Error('Out of recovery scope: '+p);return p;}
function put(p,data){p=clean(p);if(typeof data!=='string')throw Error('Non-string write');files.set(p,data);provenance.push({path:p,time:current.time,source:current.source,id:current.id,sha256:createHash('sha256').update(data).digest('hex')});}
const env=new Map([['root','D:/TAILIEU/MyProject/AI_Tool/Optimize_token_and_memory_pool']]);
function value(n){
 if(!n)throw Error('Missing expression');
 if(ts.isStringLiteralLike(n))return n.text;
 if(ts.isNumericLiteral(n))return Number(n.text);
 if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;
 if(ts.isIdentifier(n)){if(env.has(n.text))return env.get(n.text);throw Error('Unknown variable '+n.text);}
 if(ts.isAwaitExpression(n)||ts.isParenthesizedExpression(n))return value(n.expression);
 if(ts.isArrayLiteralExpression(n))return n.elements.map(value);
 if(ts.isObjectLiteralExpression(n)){const o={};for(const p of n.properties){if(!ts.isPropertyAssignment(p))throw Error('Unsupported object');o[p.name.text]=value(p.initializer);}return o;}
 if(ts.isTemplateExpression(n)){let s=n.head.text;for(const t of n.templateSpans)s+=value(t.expression)+t.literal.text;return s;}
 if(ts.isRegularExpressionLiteral(n)){const m=n.text.match(/^\/(.*)\/([a-z]*)$/s);return new RegExp(m[1],m[2]);}
 if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken)return value(n.left)+value(n.right);
 if(ts.isCallExpression(n)){
  const name=n.expression.getText(),args=()=>n.arguments.map(value);
  if(name==='JSON.stringify')return JSON.stringify(...args());
  if(name==='JSON.parse')return JSON.parse(...args());
  if(name==='Object.entries')return Object.entries(...args());
  if(name==='fs.readFile'||name==='fs.readFileSync'){const p=clean(value(n.arguments[0]));if(!files.has(p))throw Error('Missing recovered file '+p);return files.get(p);}
  if(name==='path.join'||name==='join')return path.posix.join(...args());
  if(ts.isPropertyAccessExpression(n.expression)){
   const method=n.expression.name.text;
   if(['replace','replaceAll','slice','substring','split','join','trim','concat','indexOf','lastIndexOf'].includes(method)){const receiver=value(n.expression.expression);return receiver[method](...args());}
  }
 }
 throw Error('Unsupported expression '+n.getText().slice(0,90));
}
function evaluateCode(code){
 const sf=parse(code);
 function statement(s){
  try{
   if(ts.isBlock(s)){for(const child of s.statements)statement(child);return;}
   if(ts.isForOfStatement(s)&&ts.isVariableDeclarationList(s.initializer)){
    const sequence=value(s.expression),binding=s.initializer.declarations[0].name;
    for(const row of sequence){if(ts.isArrayBindingPattern(binding)){binding.elements.forEach((e,i)=>env.set(e.name.text,row[i]));}else if(ts.isIdentifier(binding))env.set(binding.text,row);statement(s.statement);}return;
   }
   if(ts.isVariableStatement(s)){for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer){try{env.set(d.name.text,value(d.initializer));}catch{env.delete(d.name.text);}}return;}
   if(!ts.isExpressionStatement(s))return;
   let e=s.expression;if(ts.isAwaitExpression(e))e=e.expression;
   if(ts.isBinaryExpression(e)&&ts.isIdentifier(e.left)){
    if(e.operatorToken.kind===ts.SyntaxKind.EqualsToken)env.set(e.left.text,value(e.right));
    else if(e.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken)env.set(e.left.text,value(e.left)+value(e.right));return;
   }
   if(ts.isBinaryExpression(e)&&ts.isElementAccessExpression(e.left)&&ts.isIdentifier(e.left.expression)&&e.operatorToken.kind===ts.SyntaxKind.EqualsToken){const target=env.get(e.left.expression.text);target[value(e.left.argumentExpression)]=value(e.right);return;}
   if(!ts.isCallExpression(e))return;
   const name=e.expression.getText();
   if(name==='write'||name==='fs.writeFile'||name==='fs.writeFileSync')put(value(e.arguments[0]),value(e.arguments[1]));
   if(name==='fs.appendFile'||name==='fs.appendFileSync'){const p=clean(value(e.arguments[0]));if(!files.has(p))throw Error('Missing append target '+p);put(p,files.get(p)+value(e.arguments[1]));}
  }catch(error){failures.push({time:current.time,id:current.id,statement:s.getText().slice(0,150),error:error.message});}
 }
 for(const s of sf.statements)statement(s);
}
function patch(text){
 const sections=text.split(/^\*\*\* (Add|Update|Delete) File: /m);
 for(let i=1;i<sections.length;i+=2){
  const kind=sections[i],lines=sections[i+1].split('\n'),name=lines.shift().trim();let p;
  try{p=clean(name);}catch{continue;}
  const end=lines.findIndex(l=>l==='*** End Patch');if(end>=0)lines.splice(end);
  if(kind==='Add'){put(p,lines.filter(l=>l.startsWith('+')).map(l=>l.slice(1)).join('\n')+'\n');continue;}
  if(kind==='Delete'){files.delete(p);continue;}
  if(!files.has(p)){failures.push({id:current.id,path:p,error:'Patch target missing'});continue;}
  let content=files.get(p),chunks=[],old=[],replacement=[],anchor='',newLine=null;
  function flush(){if(old.length||replacement.length)chunks.push({old:old.join('\n'),replacement:replacement.join('\n'),anchor,newLine});old=[];replacement=[];}
  for(const l of lines){if(l.startsWith('@@')){flush();const numeric=l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);newLine=numeric?Number(numeric[1]):null;anchor=numeric?'':l.slice(2).trim();continue;}if(l==='*** End of File'||l==='')continue;if(l[0]===' '){old.push(l.slice(1));replacement.push(l.slice(1));}else if(l[0]==='-')old.push(l.slice(1));else if(l[0]==='+')replacement.push(l.slice(1));}flush();
  let valid=true,cursor=0;
  for(const c of chunks){let start=cursor;if(c.newLine!==null)start=content.split('\n').slice(0,Math.max(0,c.newLine-1)).reduce((n,l)=>n+l.length+1,0);if(c.anchor){const a=content.indexOf(c.anchor,cursor);if(a>=0)start=a;}const at=content.indexOf(c.old,start);if(at<0){failures.push({id:current.id,path:p,error:'Patch context missing',context:c.old.slice(0,100)});valid=false;break;}content=content.slice(0,at)+c.replacement+content.slice(at+c.old.length);cursor=at+c.replacement.length;}
  if(valid)put(p,content);
 }
}
for(const op of operations){current=op;if(op.kind==='patch')patch(op.code);else evaluateCode(op.code);}
for(const [p,data]of files){const target=path.join(stage,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
fs.mkdirSync(path.dirname(stage),{recursive:true});
fs.writeFileSync(path.join(path.dirname(stage),baselineMode?'baseline-recovery-manifest.json':'recovery-manifest.json'),JSON.stringify({operations:operations.length,files:[...files.keys()],provenance,failures},null,2)+'\n');
console.log(JSON.stringify({operations:operations.length,files:files.size,failures:failures.length,paths:[...files.keys()].filter(p=>!p.startsWith('tests/'))}));
