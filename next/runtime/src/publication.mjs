import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, chmodSync, rmdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonical, sha256 } from './artifacts.mjs';
import { sourceError, sourcePath, contained, noLinks, disjoint, scopes, tree, assertWorkspaceTree, allowed } from './source-paths.mjs';

function durableFile(target, data, mode = 0o600) {
  noLinks(dirname(target));
  const fd = openSync(target, 'wx', mode);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) sourceError('GIT_FAILED', '/git', 'successful host-owned Git operation');
  return result.stdout.trim();
}
const revision = (generation, hash, head) => (head ? 'git:' + head : 'snapshot') + ':' + generation + ':' + hash;
const summary = entry => entry ? { path: entry.path, hash: entry.hash, bytes: entry.bytes, executable: entry.executable } : null;

export class ProjectBroker {
  constructor(store, { project, allowlist }) {
    this.store = store;
    this.ownedPublications = new Set();
    this.metrics = { manifestScans:0, manifestFilesRead:0, manifestFileBytesRead:0, copiedBytes:0, sourceBytesWritten:0, failedApplyAttempts:0 };
    this.db = store.db;
    this.project = noLinks(resolve(project));
    this.allowlist = scopes(allowlist);
    this.control = noLinks(join(store.directory, 'source-control'), true);
    disjoint(this.project, store.directory);
    mkdirSync(this.control, { recursive: true });
    this.db.exec('CREATE TABLE IF NOT EXISTS source_project (id INTEGER PRIMARY KEY CHECK(id=1),root TEXT NOT NULL,allowlist_json TEXT NOT NULL,generation INTEGER NOT NULL,revision TEXT NOT NULL,manifest_hash TEXT NOT NULL,git_head TEXT,pending TEXT);' +
      'CREATE TABLE IF NOT EXISTS source_workspaces (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),root TEXT NOT NULL,base_revision TEXT NOT NULL,status TEXT NOT NULL,git_control_hash TEXT,run_id TEXT);' +
      'CREATE TABLE IF NOT EXISTS source_publications (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES source_workspaces(id),task_id TEXT NOT NULL,task_version INTEGER NOT NULL,base_revision TEXT NOT NULL,target_revision TEXT NOT NULL,journal_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL);');
    this.store.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM source_project WHERE id=1').get();
      if (existing) {
        if (existing.root !== this.project || existing.allowlist_json !== canonical(this.allowlist)) sourceError('PROJECT_BINDING_CONFLICT','/project','immutable project/allowlist binding');
      } else {
        const current = this.snapshot(this.project);
        const head = this.head();
        this.db.prepare('INSERT INTO source_project VALUES (1,?,?,0,?,?,?,NULL)').run(this.project,canonical(this.allowlist),revision(0,current.hash,head),current.hash,head);
      }
    });
    if(this.db.prepare('PRAGMA user_version').get().user_version<2)this.db.exec('PRAGMA user_version = 2;');
    this.recover();
  }
  snapshot(location,options={}) {
    const result=tree(location,this.allowlist,options);
    this.metrics.manifestScans++;this.metrics.manifestFilesRead+=result.entries.length;this.metrics.manifestFileBytesRead+=result.bytes;
    return result;
  }
  head() {
    if (!existsSync(join(this.project,'.git'))) return null;
    noLinks(join(this.project,'.git'));
    return git(this.project,['rev-parse','HEAD']);
  }
  binding() { return this.db.prepare('SELECT * FROM source_project WHERE id=1').get(); }
  workspace(id) {
    const record = this.db.prepare('SELECT * FROM source_workspaces WHERE id=?').get(id);
    if (!record) sourceError('WORKSPACE_MISSING','/workspace','host-owned working copy');
    noLinks(record.root);
    return record;
  }
  assertIdle() {
    if (this.binding().pending) sourceError('SOURCE_CONFLICT','/project','other publication owns this source base');
    if (this.db.prepare("SELECT 1 FROM sessions WHERE lifecycle='open'").get() || this.db.prepare("SELECT 1 FROM source_workspaces WHERE status='running'").get()) sourceError('WRITERS_RUNNING','/session','no open session before preparation/publication');
  }
  currentRevision() {
    const binding = this.binding();
    if (binding.pending) sourceError('RECOVERY_REQUIRED','/project','recovered publication');
    const actual = this.snapshot(this.project);
    if (actual.hash !== binding.manifest_hash || this.head() !== binding.git_head) sourceError('SOURCE_CONFLICT','/sourceRevision','unchanged authoritative source and Git HEAD');
    return binding.revision;
  }
  prepare(taskId, id) {
    const started=performance.now();const initial={...this.metrics};
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) sourceError('WORKSPACE_INVALID','/id','portable workspace identity');
    this.recover();
    const result=this.store.transaction(() => {
      this.assertIdle();
      if (this.db.prepare('SELECT 1 FROM source_workspaces WHERE id=?').get(id)) sourceError('WORKSPACE_EXISTS','/id','new workspace identity');
      const baseRevision = this.currentRevision();
      const task = this.store.task(taskId);
      if (task.sourceRevision !== baseRevision) sourceError('REVISION_MISMATCH','/sourceRevision',baseRevision);
      const copy = contained(this.control,'workspaces/' + id + '/source');
      mkdirSync(dirname(copy),{recursive:true});
      const base = this.snapshot(this.project,{capture:true});
      const head = this.head();
      if (head) git(this.project,['worktree','add','--detach','--no-checkout',copy,head]);
      else mkdirSync(copy);
      for (const entry of base.entries) {
        const target = contained(copy,entry.path);
        mkdirSync(dirname(target),{recursive:true});
        durableFile(target,Buffer.from(entry.content,'base64'),entry.executable ? 0o700 : 0o600);
        this.metrics.copiedBytes+=entry.bytes;
      }
      mkdirSync(join(copy,'.bridge-home'));
      mkdirSync(join(copy,'.bridge-tmp'));
      const actual = this.snapshot(copy);
      if (actual.hash !== base.hash || this.currentRevision() !== baseRevision) sourceError('SOURCE_CONFLICT','/sourceRevision','stable copy from expected base');
      const gitControlHash = head ? sha256(readFileSync(join(copy,'.git'))) : null;
      this.db.prepare("INSERT INTO source_workspaces VALUES (?,?,?,?,'prepared',?,NULL)").run(id,taskId,copy,baseRevision,gitControlHash);
      return { id, workspace:copy, sourceRevision:baseRevision, backend:head?'git-worktree':'owned-snapshot',
        elapsedMs:performance.now()-started,io:{copiedFiles:base.entries.length,copiedBytes:base.bytes,
          manifestScans:this.metrics.manifestScans-initial.manifestScans,manifestFilesRead:this.metrics.manifestFilesRead-initial.manifestFilesRead,
          manifestFileBytesRead:this.metrics.manifestFileBytesRead-initial.manifestFileBytesRead} };
    });
    result.elapsedMs=performance.now()-started;return result;
  }
  attachRun(id, runId,{withinTransaction=false}={}) {
    if(withinTransaction&&this.store.transactionDepth!==1)sourceError('HOST_TRANSACTION_REQUIRED','/run','host transaction');
    const action=() => {
      this.assertIdle();
      const work = this.workspace(id);
      if (!['prepared','stopped','rolled-back'].includes(work.status)||work.base_revision!==this.currentRevision()) sourceError('WORKSPACE_STATE','/workspace','current prepared or stopped working copy');
      this.db.prepare("UPDATE source_workspaces SET status='running',run_id=? WHERE id=?").run(runId,id);
    };
    return withinTransaction?action():this.store.transaction(action);
  }
  recordStopped(id, runId) {
    return this.store.transaction(() => {
      const work = this.workspace(id);
      if(['stopped','rolled-back'].includes(work.status)&&work.run_id===runId)return;
      if (work.status !== 'running' || work.run_id !== runId) sourceError('WRITER_PROOF_INVALID','/runId','matching supervised run');
      this.db.prepare("UPDATE source_workspaces SET status='stopped' WHERE id=?").run(id);
    });
  }
  validateWorkspace(work) {
    assertWorkspaceTree(work.root,this.allowlist,Boolean(work.git_control_hash));
    if (work.git_control_hash) {
      const target = noLinks(join(work.root,'.git'));
      if (!lstatSync(target).isFile() || sha256(readFileSync(target)) !== work.git_control_hash) sourceError('GIT_CONTROL_CHANGED','/workspace','unchanged host-created Git control file');
    }
    return this.snapshot(work.root,{capture:true});
  }
  publish(id, expectedRevision, {expectedTaskVersion=null,onCommit=null}={}) {
    const started = performance.now();
    const publicationId = randomUUID();
    let journal, work;
    const existing = this.db.prepare("SELECT receipt_json FROM source_publications WHERE workspace_id=? AND status='committed'").get(id);
    if (existing) {
      const receipt = JSON.parse(existing.receipt_json);
      if(receipt.baseRevision !== expectedRevision) sourceError('SOURCE_CONFLICT','/expectedRevision',receipt.baseRevision);
      return receipt;
    }
    this.store.transaction(() => {
      this.assertIdle();
      work = this.workspace(id);
      if (!['prepared','stopped','rolled-back'].includes(work.status)) sourceError('WRITERS_RUNNING','/workspace','never-launched host copy or stopped supervised writers');
      const baseRevision = this.currentRevision();
      if (expectedRevision !== baseRevision || work.base_revision !== baseRevision) sourceError('SOURCE_CONFLICT','/expectedRevision',baseRevision);
      const task = this.store.task(work.task_id);
      if(expectedTaskVersion!==null&&task.stateVersion!==expectedTaskVersion)sourceError('VERSION_CONFLICT','/publication','checkpoint submission version');
      if(task.sourceRevision !== baseRevision) sourceError('REVISION_MISMATCH','/sourceRevision',baseRevision);
      const base = this.snapshot(this.project,{capture:true});
      const target = this.validateWorkspace(work);
      const before = new Map(base.entries.map(e=>[e.path,e]));
      const after = new Map(target.entries.map(e=>[e.path,e]));
      const operations = [...new Set([...before.keys(),...after.keys()])].sort().flatMap(name=>
        canonical(summary(before.get(name))) === canonical(summary(after.get(name))) ? [] : [{path:name,before:before.get(name)||null,after:after.get(name)||null}]);
      const binding = this.binding();
      if(!Number.isSafeInteger(binding.generation+1)||!Number.isSafeInteger(task.stateVersion+1))sourceError('VERSION_OVERFLOW','/publication','safe integer versions');
      journal = { schemaVersion:1, ownerPid:process.pid, base:base.entries.map(summary), target:target.entries.map(summary),
        operations: operations.map((op,index)=>({...op,temporary:op.path+'.bridge-publish-'+publicationId+'-'+index})), generation:binding.generation+1, gitHead:binding.git_head,
        targetRevision:revision(binding.generation+1,target.hash,binding.git_head), targetHash:target.hash };
      for(const op of journal.operations)if(existsSync(contained(this.project,op.temporary)))sourceError('TEMPORARY_CONFLICT','/publication','new host temporary path');
      this.db.prepare("INSERT INTO source_publications VALUES (?,?,?,?,?,?,?,'prepared',NULL,?)").run(publicationId,id,work.task_id,task.stateVersion,
        baseRevision,journal.targetRevision,canonical(journal),new Date().toISOString());
      this.db.prepare('UPDATE source_project SET pending=? WHERE id=1').run(publicationId);
      this.db.prepare("UPDATE source_workspaces SET status='publishing' WHERE id=?").run(id);
    });
    this.ownedPublications.add(publicationId);
    try {
      this.cleanTemporary(journal);
      this.assertRecoverable(journal);
      for (const operation of journal.operations.filter(op=>op.after===null)) this.apply(operation.path,null,operation.temporary);
      for (const operation of journal.operations.filter(op=>op.after!==null)) this.apply(operation.path,operation.after,operation.temporary);
      if (this.snapshot(this.project).hash !== journal.targetHash || this.head() !== journal.gitHead) sourceError('SOURCE_CONFLICT','/publication','exact target manifest');
      return this.store.transaction(() => {
        const record = this.db.prepare('SELECT * FROM source_publications WHERE id=?').get(publicationId);
        const task = this.store.task(record.task_id);
        if(task.stateVersion !== record.task_version || task.sourceRevision !== record.base_revision) sourceError('VERSION_CONFLICT','/publication','unchanged task/source version');
        const stateVersion = task.stateVersion+1;
        const receipt = { schemaVersion:1, publicationId, workspaceId:id, taskId:task.id, baseRevision:record.base_revision,
          sourceRevision:journal.targetRevision,stateVersion,changedFiles:journal.operations.length,
          eventReference:'event:'+task.id+':'+stateVersion, handoff:false, preCommitElapsedMs:performance.now()-started };
        this.db.prepare('UPDATE tasks SET source_revision=?,state_version=? WHERE id=?').run(journal.targetRevision,stateVersion,task.id);
        this.db.prepare('INSERT INTO events (task_id,session_id,state_version,kind,idempotency_key,payload_hash,payload_json,receipt_json,created_at) VALUES (?,NULL,?,?,?,?,?,?,?)')
          .run(task.id,stateVersion,'source-publication','publish-'+publicationId,sha256(canonical(journal)),canonical({sourceRevision:journal.targetRevision,baseRevision:record.base_revision,files:journal.target}),canonical(receipt),new Date().toISOString());
        for(const reference of task.state.evidence) this.db.prepare('INSERT INTO artifact_refs VALUES (?,?,?)').run(task.id,stateVersion,reference.slice(9));
        this.db.prepare('UPDATE source_project SET generation=?,revision=?,manifest_hash=?,pending=NULL WHERE id=1').run(journal.generation,journal.targetRevision,journal.targetHash);
        this.db.prepare("UPDATE source_workspaces SET status='published' WHERE id=?").run(id);
        this.db.prepare("UPDATE source_publications SET status='committed',receipt_json=? WHERE id=?").run(canonical(receipt),publicationId);
        if(onCommit)onCommit(receipt);
        return receipt;
      });
    } catch(error) { this.metrics.failedApplyAttempts++;this.recover(true); throw error; }
    finally { this.metrics.lastPublicationElapsedMs=performance.now()-started;this.ownedPublications.delete(publicationId); }
  }
  validateJournal(journal,record,binding) {
    if(journal.schemaVersion!==1 || !Number.isInteger(journal.ownerPid) || journal.ownerPid<1 || !Array.isArray(journal.base) || !Array.isArray(journal.target) || !Array.isArray(journal.operations) ||
      sha256(canonical(journal.base))!==binding.manifest_hash || sha256(canonical(journal.target))!==journal.targetHash || record.base_revision!==binding.revision ||
      journal.generation!==binding.generation+1 || journal.gitHead!==binding.git_head || journal.targetRevision!==revision(journal.generation,journal.targetHash,journal.gitHead))
      sourceError('JOURNAL_INVALID','/journal','consistent publication manifest and revision');
    const before=new Map(journal.base.map(e=>[e.path,e])),after=new Map(journal.target.map(e=>[e.path,e]));
    if(before.size!==journal.base.length || after.size!==journal.target.length)sourceError('JOURNAL_INVALID','/journal','unique paths');
    const expected=[...new Set([...before.keys(),...after.keys()])].sort().filter(name=>canonical(before.get(name)||null)!==canonical(after.get(name)||null));
    if(canonical(expected)!==canonical(journal.operations.map(op=>op.path)))sourceError('JOURNAL_INVALID','/journal','exact source diff');
    for(const [index,op] of journal.operations.entries()) {
      sourcePath(op.path);
      if(!allowed(op.path,this.allowlist) || op.temporary!==op.path+'.bridge-publish-'+record.id+'-'+index)sourceError('JOURNAL_INVALID','/journal','allowlisted source and owned temporary path');
      for(const [entry,wanted] of [[op.before,before.get(op.path)||null],[op.after,after.get(op.path)||null]]) {
        if(canonical(summary(entry))!==canonical(wanted))sourceError('JOURNAL_INVALID','/journal','matching before/after entry');
        if(entry) {
          const bytes=Buffer.from(entry.content,'base64');
          if(bytes.toString('base64')!==entry.content || bytes.length!==entry.bytes || sha256(bytes)!==entry.hash)sourceError('JOURNAL_INVALID','/journal','verified before/after bytes');
        }
      }
    }
  }
  assertRecoverable(journal) {
    if(this.head() !== journal.gitHead) sourceError('RECOVERY_CONFLICT','/git','unchanged Git HEAD during publication/recovery');
    const actual = new Map(this.snapshot(this.project).entries.map(e=>[e.path,e]));
    const before = new Map(journal.base.map(e=>[e.path,e]));
    const after = new Map(journal.target.map(e=>[e.path,e]));
    for(const name of new Set([...actual.keys(),...before.keys(),...after.keys()])) {
      const value = canonical(summary(actual.get(name)));
      if(value !== canonical(summary(before.get(name))) && value !== canonical(summary(after.get(name))))
        sourceError('RECOVERY_CONFLICT','/source','only journaled before/after bytes; preserve external edits');
    }
  }
  cleanTemporary(journal) {
    for(const op of journal.operations) {
      const location=contained(this.project,op.temporary);
      if(existsSync(location)) {
        const stat=lstatSync(location);
        if(!stat.isFile() || stat.nlink!==1)sourceError('RECOVERY_CONFLICT','/temporary','regular host journal temporary file');
        unlinkSync(location);
      }
    }
  }
  prune(directory) {
    while(directory!==this.project) {
      noLinks(directory,true);
      try { rmdirSync(directory); } catch(error) { if(['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))break; throw error; }
      directory=dirname(directory);
    }
  }
  apply(name, entry, temporaryName) {
    sourcePath(name);
    const target = contained(this.project,name);
    if(entry===null) {
      if(existsSync(target)) {
        const stat=lstatSync(target);
        if(stat.isFile()){unlinkSync(target);this.prune(dirname(target));}
        else if(!stat.isDirectory())sourceError('SOURCE_TYPE','/path','regular source file');
      }
      return;
    }
    if(existsSync(target)) {
      const stat=lstatSync(target);
      if(stat.isFile()&&stat.nlink===1&&sha256(readFileSync(target))===entry.hash&&(process.platform==='win32'||Boolean(stat.mode&0o111)===entry.executable))return;
    }
    mkdirSync(dirname(target),{recursive:true});
    noLinks(dirname(target));
    if(existsSync(target) && lstatSync(target).isDirectory()) rmdirSync(target);
    const temporary=contained(this.project,temporaryName);
    try {
      durableFile(temporary,Buffer.from(entry.content,'base64'),entry.executable?0o700:0o600);
      this.metrics.sourceBytesWritten+=entry.bytes;
      renameSync(temporary,target);
      if(process.platform!=='win32')chmodSync(target,entry.executable?0o700:0o600);
    } finally { if(existsSync(temporary))unlinkSync(temporary); }
  }
  recover(allowOwned = false) {
    const binding=this.binding();
    if(!binding.pending)return {recovered:false};
    return this.store.transaction(() => {
      const locked=this.binding();
      if(!locked.pending)return {recovered:false};
      if(this.db.prepare("SELECT 1 FROM source_workspaces WHERE status='running'").get())sourceError('WRITERS_RUNNING','/recovery','supervised writers stopped before recovery');
      const record=this.db.prepare('SELECT * FROM source_publications WHERE id=?').get(locked.pending);
      if(!record || record.status!=='prepared')sourceError('JOURNAL_INVALID','/recovery','durable prepared publication journal');
      const journal=JSON.parse(record.journal_json);
      if (!(allowOwned && this.ownedPublications.has(record.id))) {
        let alive=true;
        try { process.kill(journal.ownerPid,0); } catch(error) { if(error.code==='ESRCH')alive=false; }
        if(alive)sourceError('SOURCE_CONFLICT','/recovery','live publication must finish before recovery');
      }
      this.validateJournal(journal,record,locked);
      this.cleanTemporary(journal);
      this.assertRecoverable(journal);
      for(const op of [...journal.operations].filter(op=>op.before===null))this.apply(op.path,null,op.temporary);
      for(const op of [...journal.operations].filter(op=>op.before!==null).reverse())this.apply(op.path,op.before,op.temporary);
      if(this.snapshot(this.project).hash!==locked.manifest_hash)sourceError('RECOVERY_CONFLICT','/recovery','complete base manifest after rollback');
      this.db.prepare('UPDATE source_project SET pending=NULL WHERE id=1').run();
      this.db.prepare("UPDATE source_publications SET status='rolled-back' WHERE id=?").run(record.id);
      this.db.prepare("UPDATE source_workspaces SET status='rolled-back' WHERE id=?").run(record.workspace_id);
      return {recovered:true,publicationId:record.id,sourceRevision:locked.revision};
    });
  }
}
