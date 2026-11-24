import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { BridgeError, validate, checkpointSchema, lookupSchema, taskSchema, sessionSchema, stateSchema, artifactMetadataSchema } from './schema.mjs';
import { canonical, sha256, writeArtifact, readArtifact } from './artifacts.mjs';

const maxMetadataBytes = 256 * 1024;
function fail(code, field, expected, version = null) { throw new BridgeError(code, field, expected, version); }
function bounded(value, field, version = null) {
  if (Buffer.byteLength(canonical(value)) > maxMetadataBytes) fail('METADATA_OVERFLOW', field, 'at most ' + maxMetadataBytes + ' UTF-8 bytes', version);
}
export class TaskStore {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, 'state.sqlite'));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const existingVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    const applicationId = this.db.prepare('PRAGMA application_id').get().application_id;
    if ((existingVersion !== 0 && applicationId !== 0x42525632) || (existingVersion === 0 && applicationId !== 0)) { this.db.close(); fail('STORE_SCHEMA', '/', 'Bridge v2 application identity'); }
    if (![0,1,2,3].includes(existingVersion)) { this.db.close(); fail('STORE_SCHEMA', '/', 'v2 store schema 1–3'); }
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (existingVersion === 0 && existing.length) { this.db.close(); fail('STORE_SCHEMA', '/', 'new empty v2 database'); }
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;' +
      'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state_version INTEGER NOT NULL, source_revision TEXT NOT NULL, state_json TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL, workspace TEXT NOT NULL, lifecycle TEXT NOT NULL, delivery_cursor TEXT);' +
      "CREATE UNIQUE INDEX IF NOT EXISTS single_writer ON sessions((1)) WHERE lifecycle = 'open';" +
      'CREATE TABLE IF NOT EXISTS artifacts (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, provenance TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT REFERENCES sessions(id), state_version INTEGER NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id,state_version), UNIQUE(task_id,idempotency_key));' +
      'CREATE TABLE IF NOT EXISTS artifact_refs (task_id TEXT NOT NULL REFERENCES tasks(id), state_version INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES artifacts(hash), PRIMARY KEY(task_id,state_version,hash), FOREIGN KEY(task_id,state_version) REFERENCES events(task_id,state_version));' +
      'PRAGMA application_id = 1112692274;' + (existingVersion >= 2 ? '' : 'PRAGMA user_version = 1;')
    );
  }
  close() { this.db.close(); }
  transaction(action,{preview=false}={}) {
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth=1;
    try { const result = action(); this.db.exec(preview?'ROLLBACK':'COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth=0; }
  }
  createTask(input) {
    validate(taskSchema, input);
    bounded(input, '/task');
    const state = { schemaVersion: 1, objective: input.objective, constraints: input.constraints,
      status: 'working', decisions: [], completed: [], issues: [], next: [], files: [], evidence: [] };
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM tasks WHERE id=?').get(input.id)) fail('TASK_EXISTS', '/id', 'new task id');
      this.db.prepare('INSERT INTO tasks VALUES (?,0,?,?)').run(input.id, input.sourceRevision, canonical(state));
      return this.task(input.id);
    });
  }
  task(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) fail('TASK_MISSING', '/taskId', 'existing task');
    return { id: row.id, stateVersion: row.state_version, sourceRevision: row.source_revision, state: JSON.parse(row.state_json) };
  }
  openSession(input,{withinTransaction=false}={}) {
    validate(sessionSchema, input);
    if(withinTransaction&&this.transactionDepth!==1)fail('HOST_TRANSACTION_REQUIRED','/session','host transaction');
    const action=() => {
      this.task(input.taskId);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_project'").get()) {
        const project = this.db.prepare('SELECT pending,revision FROM source_project WHERE id=1').get();
        if (project?.pending) fail('RECOVERY_REQUIRED', '/session', 'source publication recovery before opening a session');
        const workspace = this.db.prepare('SELECT task_id,base_revision,status FROM source_workspaces WHERE root=?').get(resolve(input.workspace));
        if (!workspace || workspace.task_id !== input.taskId || workspace.base_revision !== project.revision || !['prepared','running'].includes(workspace.status)) fail('WORKSPACE_BINDING_INVALID', '/workspace', 'current host-owned working copy');
      }
      if (this.db.prepare("SELECT id FROM sessions WHERE lifecycle='open'").get()) fail('WRITER_ACTIVE', '/session', 'previous session stopped and closed');
      if (this.db.prepare('SELECT id FROM sessions WHERE id=?').get(input.id)) fail('SESSION_EXISTS', '/id', 'new session identity');
      this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,'open',NULL)").run(input.id, input.taskId, input.provider, resolve(input.workspace));
      return this.session(input.id);
    };
    return withinTransaction?action():this.transaction(action);
  }
  session(id, requireOpen = true) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) fail('SESSION_MISSING', '/session', 'host-bound session');
    if (requireOpen && row.lifecycle !== 'open') fail('SESSION_CLOSED', '/session', 'open session');
    return row;
  }
  closeSession(id, { writersStopped, crashed = false }) {
    if (writersStopped !== true) fail('WRITERS_RUNNING', '/writersStopped', 'host-confirmed stopped writers');
    return this.transaction(() => {
      const row = this.session(id, false);
      if (row.lifecycle === 'open') this.db.prepare('UPDATE sessions SET lifecycle=? WHERE id=?').run(crashed ? 'crashed' : 'closed', id);
      return this.session(id, false);
    });
  }
  recordArtifact(sessionId, content, metadata) {
    const session = this.session(sessionId);
    const task = this.task(session.task_id);
    metadata = { ...metadata, taskId: session.task_id };
    validate(artifactMetadataSchema, metadata, task.stateVersion);
    bounded(metadata, '/metadata', task.stateVersion);
    if (metadata.sourceRevision !== task.sourceRevision) fail('REVISION_MISMATCH', '/sourceRevision', task.sourceRevision, task.stateVersion);
    const artifact = writeArtifact(this.directory, content, metadata);
    const metadataJson = canonical(metadata);
    this.transaction(() => {
      this.session(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?,?,?,?)').run(artifact.hash, metadata.kind, artifact.size,
        metadata.provenance, artifact.relativePath, metadataJson, new Date().toISOString());
    });
    return { reference: artifact.reference, sourceRevision: metadata.sourceRevision };
  }
  verifyFiles(files, session, task) {
    const workspace = realpathSync(session.workspace);
    const seen = new Set();
    for (const [index, reference] of files.entries()) {
      const field = '/files/' + index;
      if (seen.has(reference.path)) fail('FILE_DUPLICATE', field + '/path', 'unique path', task.stateVersion);
      seen.add(reference.path);
      const parts = reference.path.split(/[\\/]/);
      if (isAbsolute(reference.path) || /^[A-Za-z]:/.test(reference.path) || parts.some(p => !p || p === '.' || p === '..' || p.includes(':')))
        fail('PATH_INVALID', field + '/path', 'relative project file without traversal', task.stateVersion);
      let current = workspace;
      try {
        for (const part of parts) {
          current = join(current, part);
          if (lstatSync(current).isSymbolicLink()) fail('PATH_ESCAPE', field + '/path', 'no symlink or junction', task.stateVersion);
        }
        const actual = realpathSync(current);
        const offset = relative(workspace, actual);
        if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) fail('PATH_ESCAPE', field + '/path', 'file inside workspace', task.stateVersion);
        if (!lstatSync(actual).isFile()) fail('FILE_MISSING', field + '/path', 'regular file', task.stateVersion);
        if (sha256(readFileSync(actual)) !== reference.hash) fail('FILE_HASH_MISMATCH', field + '/hash', 'current content hash', task.stateVersion);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        fail('FILE_MISSING', field + '/path', 'readable project file', task.stateVersion);
      }
      if (reference.sourceRevision !== task.sourceRevision) fail('REVISION_MISMATCH', field + '/sourceRevision', task.sourceRevision, task.stateVersion);
    }
  }
  checkpoint(sessionId, input, {preview=false,finalizing=false,historyRevision=null,withinTransaction=false}={}) {
    if((finalizing||withinTransaction)&&this.transactionDepth!==1)fail('FINALIZATION_TRANSACTION_REQUIRED','/checkpoint','host transaction');
    if(preview&&(finalizing||withinTransaction))fail('PREVIEW_TRANSACTION_INVALID','/checkpoint','standalone preview transaction');
    const binding = this.session(sessionId,!finalizing);
    if(finalizing&&binding.lifecycle!=='closed')fail('SESSION_STATE_INVALID','/session','normally stopped and closed session');
    const initial = this.task(binding.task_id);
    validate(checkpointSchema, input, initial.stateVersion);
    bounded(input, '/', initial.stateVersion);
    const payload = canonical(input);
    const payloadHash = sha256(payload);
    const action=() => {
      const session = this.session(sessionId,!finalizing);
      const task = this.task(session.task_id);
      const previous = this.db.prepare('SELECT * FROM events WHERE task_id=? AND idempotency_key=?').get(task.id, input.idempotencyKey);
      if (previous) {
        if (previous.payload_hash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', '/idempotencyKey', 'same payload for existing key', task.stateVersion);
        return JSON.parse(previous.receipt_json);
      }
      if (input.expectedVersion !== task.stateVersion) fail('VERSION_CONFLICT', '/expectedVersion', String(task.stateVersion), task.stateVersion);
      if (task.state.status === 'complete' && input.status !== 'complete') fail('TASK_COMPLETE', '/status', 'complete', task.stateVersion);
      const decisions = new Map(task.state.decisions.map(d => [d.key, d]));
      const changed = new Set();
      for (const [index, decision] of input.decisions.entries()) {
        const field = '/decisions/' + index;
        if (changed.has(decision.key)) fail('DECISION_DUPLICATE', field + '/key', 'one change per key', task.stateVersion);
        changed.add(decision.key);
        const old = decisions.get(decision.key);
        if (decision.supersedes !== (old?.revision ?? null)) fail('DECISION_CONFLICT', field + '/supersedes', String(old?.revision ?? null), task.stateVersion);
        if (decision.revision !== (old?.revision ?? 0) + 1) fail('DECISION_REVISION', field + '/revision', String((old?.revision ?? 0) + 1), task.stateVersion);
        decisions.set(decision.key, decision);
      }
      this.verifyFiles(input.files, session, task);
      const state = { ...task.state, status: input.status, decisions: [...decisions.values()],
        completed: [...new Set([...task.state.completed, ...input.completed])],
        issues: input.issues, next: input.next, files: input.files,
        evidence: [...new Set([...task.state.evidence, ...input.evidence])] };
      validate(stateSchema, state, task.stateVersion);
      bounded(state, '/state', task.stateVersion);
      for (const reference of state.evidence) {
        const record = this.db.prepare('SELECT * FROM artifacts WHERE hash=?').get(reference.slice(9));
        if (!record) fail('ARTIFACT_MISSING', '/evidence', 'recorded artifact', task.stateVersion);
        const artifact = readArtifact(this.directory, record);
        if (artifact.metadata.taskId !== task.id) fail('REFERENCE_FORBIDDEN', '/evidence', 'artifact belonging to bound task', task.stateVersion);
        if (input.evidence.includes(reference) && !task.state.evidence.includes(reference) && artifact.metadata.sourceRevision !== task.sourceRevision && !(finalizing&&artifact.metadata.sourceRevision===historyRevision)) fail('REVISION_MISMATCH', '/evidence', task.sourceRevision, task.stateVersion);
      }
      const newVersion = task.stateVersion + 1;
      if (!Number.isSafeInteger(newVersion)) fail('VERSION_OVERFLOW', '/stateVersion', 'safe integer', task.stateVersion);
      const receipt = { schemaVersion: 1, taskId: task.id, stateVersion: newVersion, status: state.status,
        eventReference: 'event:' + task.id + ':' + newVersion,
        handoff: state.status === 'handoff' };
      const updated = this.db.prepare('UPDATE tasks SET state_version=?,state_json=? WHERE id=? AND state_version=?')
        .run(newVersion, canonical(state), task.id, input.expectedVersion);
      if (updated.changes !== 1) fail('VERSION_CONFLICT', '/expectedVersion', 'current version', task.stateVersion);
      this.db.prepare('INSERT INTO events (task_id,session_id,state_version,kind,idempotency_key,payload_hash,payload_json,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(task.id, sessionId, newVersion, input.status, input.idempotencyKey, payloadHash, payload, canonical(receipt), new Date().toISOString());
      for (const reference of state.evidence) this.db.prepare('INSERT INTO artifact_refs VALUES (?,?,?)').run(task.id, newVersion, reference.slice(9));
      return receipt;
    };
    return finalizing||withinTransaction?action():this.transaction(action,{preview});
  }
  lookup(sessionId, input) {
    validate(lookupSchema, input);
    const session = this.session(sessionId);
    if (input.reference.startsWith('event:')) {
      const [, taskId, version] = input.reference.split(':');
      if (taskId !== session.task_id) fail('REFERENCE_FORBIDDEN', '/reference', 'reference belonging to bound task');
      const event = this.db.prepare('SELECT payload_json,receipt_json,created_at FROM events WHERE task_id=? AND state_version=?').get(taskId, Number(version));
      if (!event) fail('REFERENCE_MISSING', '/reference', 'committed event');
      return { reference: input.reference, historical: true, delta: JSON.parse(event.payload_json), receipt: JSON.parse(event.receipt_json), timestamp: event.created_at };
    }
    const hash = input.reference.slice(9);
    const record = this.db.prepare('SELECT * FROM artifacts WHERE hash=?').get(hash);
    if (!record || JSON.parse(record.metadata_json).taskId !== session.task_id)
      fail('REFERENCE_FORBIDDEN', '/reference', 'artifact recorded for bound task');
    const artifact = readArtifact(this.directory, record);
    return { ...artifact, content: artifact.content.toString('utf8'), timestamp: record.created_at, historical: artifact.metadata.sourceRevision !== this.task(session.task_id).sourceRevision };
  }
}
