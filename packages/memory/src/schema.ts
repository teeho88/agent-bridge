export const embeddingProgressSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS embedding_progress (fingerprint TEXT NOT NULL, task_key TEXT NOT NULL, after_id TEXT NOT NULL, PRIMARY KEY(fingerprint, task_key))`,
];

export const vectorCandidateSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS embedding_buckets (memory_id TEXT NOT NULL, fingerprint TEXT NOT NULL, table_no INTEGER NOT NULL, bucket INTEGER NOT NULL, PRIMARY KEY(memory_id, table_no), FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_bucket_lookup ON embedding_buckets(fingerprint, table_no, bucket, memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_compatible ON memories(embedding_fingerprint, embedding_dimensions, task_id) WHERE embedding IS NOT NULL AND superseded_by IS NULL`,
  `CREATE TRIGGER IF NOT EXISTS embedding_bucket_invalidation AFTER UPDATE OF embedding ON memories BEGIN DELETE FROM embedding_buckets WHERE memory_id = NEW.id; END`,
];

export const maintenanceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS memory_archive AS SELECT *, CAST(NULL AS TEXT) AS archived_at, CAST(NULL AS TEXT) AS archive_reason FROM memories WHERE 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_archive_id ON memory_archive(id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_archive_task ON memory_archive(task_id, archived_at)`,
  `CREATE TABLE IF NOT EXISTS maintenance_schedule (name TEXT PRIMARY KEY, next_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consolidation_provenance (representative_id TEXT NOT NULL, member_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(representative_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS consolidation_cursors (task_id TEXT PRIMARY KEY, after_id TEXT NOT NULL)`,
];

export const runtimeMemorySchemaStatements = [
  `ALTER TABLE tasks ADD COLUMN repository_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN branch TEXT`,
  `ALTER TABLE tasks ADD COLUMN base_commit TEXT`,
  `ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE memories ADD COLUMN evidence TEXT`,
  `ALTER TABLE memories ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN scope TEXT`,
  `ALTER TABLE decisions ADD COLUMN evidence TEXT`,
  `ALTER TABLE decisions ADD COLUMN superseded_by TEXT`,
  `ALTER TABLE decisions ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    session_id TEXT, author TEXT, summary TEXT NOT NULL, payload TEXT NOT NULL,
    fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(task_id, revision), FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
];

export const managedTaskSchemaStatements = [
  `ALTER TABLE tasks ADD COLUMN status_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS task_contracts (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, constraints TEXT NOT NULL, acceptance TEXT NOT NULL,
    checks TEXT NOT NULL, depends_on TEXT NOT NULL, context_refs TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_owner_claims (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    agent TEXT NOT NULL, session_id TEXT NOT NULL, claimed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_acceptance_proofs (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    criterion TEXT NOT NULL, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
    contract_version INTEGER NOT NULL, verified_at TEXT NOT NULL,
    PRIMARY KEY(task_id, criterion)
  )`,
];

export const managedTaskCheckProofSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS task_check_proofs (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    command TEXT NOT NULL, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
    contract_version INTEGER NOT NULL, verified_at TEXT NOT NULL,
    PRIMARY KEY(task_id, command)
  )`,
];

export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    owner_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    importance INTEGER NOT NULL DEFAULT 3,
    tags TEXT,
    source_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    related_files TEXT,
    source_agent TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    summary TEXT,
    last_seen_hash TEXT,
    important_ranges TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    from_agent TEXT,
    summary TEXT NOT NULL,
    done TEXT,
    next TEXT,
    risks TEXT,
    files_changed TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent TEXT,
    command TEXT,
    result_summary TEXT,
    token_estimate INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_task_id ON memories(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_task_id ON handoffs(task_id)`
];

// Full-text search over memories. Standalone FTS5 table kept in sync with the
// `memories` table via triggers; `mem_id` links back to the source row.
export const ftsStatements = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    summary,
    tags,
    mem_id UNINDEXED
  )`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (content, summary, tags, mem_id)
    VALUES (new.content, COALESCE(new.summary, ''), COALESCE(new.tags, ''), new.id);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE mem_id = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
    DELETE FROM memories_fts WHERE mem_id = old.id;
    INSERT INTO memories_fts (content, summary, tags, mem_id)
    VALUES (new.content, COALESCE(new.summary, ''), COALESCE(new.tags, ''), new.id);
  END`,
  // Backfill existing rows. Insert straight into the FTS table so the INSERT
  // trigger above does not fire (it is attached to `memories`, not `memories_fts`).
  `INSERT INTO memories_fts (content, summary, tags, mem_id)
   SELECT content, COALESCE(summary, ''), COALESCE(tags, ''), id FROM memories`
];

// v3: re-index the FTS table on a diacritic-folded copy of each column so that
// accent-insensitive queries match (e.g. "dang nhap" finds accented Vietnamese
// content). Folding is done by the custom `fold()` SQL function registered in
// runMigrations; the original `memories` columns are left untouched for display.
// This drops and rebuilds the v2 FTS table and triggers, then backfills folded.
export const ftsFoldStatements = [
  `DROP TRIGGER IF EXISTS memories_fts_ai`,
  `DROP TRIGGER IF EXISTS memories_fts_ad`,
  `DROP TRIGGER IF EXISTS memories_fts_au`,
  `DROP TABLE IF EXISTS memories_fts`,
  `CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    summary,
    tags,
    mem_id UNINDEXED
  )`,
  `CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (content, summary, tags, mem_id)
    VALUES (fold(new.content), fold(COALESCE(new.summary, '')), fold(COALESCE(new.tags, '')), new.id);
  END`,
  `CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE mem_id = old.id;
  END`,
  `CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
    DELETE FROM memories_fts WHERE mem_id = old.id;
    INSERT INTO memories_fts (content, summary, tags, mem_id)
    VALUES (fold(new.content), fold(COALESCE(new.summary, '')), fold(COALESCE(new.tags, '')), new.id);
  END`,
  `INSERT INTO memories_fts (content, summary, tags, mem_id)
   SELECT fold(content), fold(COALESCE(summary, '')), fold(COALESCE(tags, '')), id FROM memories`
];

// v4: consolidation support. A memory whose `superseded_by` points at a
// representative memory is excluded from compile/search (but still readable via
// `memory list`/`export`, so history is never lost). FTS triggers index only
// content/summary/tags, so adding this column does not affect them.
export const supersededColumnStatements = [`ALTER TABLE memories ADD COLUMN superseded_by TEXT`];

// v5: optional semantic search. Stores a float32 embedding per memory (BLOB,
// nullable). Only populated when an embedding provider is configured (via
// `memory reindex`); search blends it with bm25 when present, else stays lexical.
export const embeddingColumnStatements = [`ALTER TABLE memories ADD COLUMN embedding BLOB`];

export const embeddingProvenanceStatements = [
  `ALTER TABLE memories ADD COLUMN embedding_fingerprint TEXT`,
  `ALTER TABLE memories ADD COLUMN embedding_dimensions INTEGER`,
  `ALTER TABLE memories ADD COLUMN embedding_input_hash TEXT`,
  `CREATE INDEX IF NOT EXISTS memories_exact_dedupe ON memories(type, task_id, source_agent, content) WHERE superseded_by IS NULL`,
  `CREATE TRIGGER IF NOT EXISTS memories_embedding_invalidate AFTER UPDATE OF content, summary ON memories
   WHEN COALESCE(NULLIF(NEW.summary, ''), NEW.content) IS NOT COALESCE(NULLIF(OLD.summary, ''), OLD.content)
   BEGIN
     UPDATE memories SET embedding = NULL, embedding_fingerprint = NULL,
       embedding_dimensions = NULL, embedding_input_hash = NULL WHERE id = NEW.id;
   END`,
];

export const retrievalIndexStatements = [
  `CREATE INDEX IF NOT EXISTS idx_memories_active_scope_type ON memories(task_id, type, importance DESC, created_at DESC) WHERE superseded_by IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_latest ON handoffs(task_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_history ON handoffs(created_at DESC, id DESC)`,
];

// v6: distinguish auto-generated (Stop-hook) handoffs from manually authored
// ones, so a manual handoff is never clobbered by the auto refresh.
export const autoHandoffColumnStatements = [`ALTER TABLE handoffs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`];

// v28: handoffs belong to a task, not to an intended recipient. Any agent that
// takes over the task reads the same packet, so a target-agent column creates a
// misleading filter without representing real state.
export const removeHandoffTargetColumnStatements = [`ALTER TABLE handoffs DROP COLUMN to_agent`];

// v7: repository knowledge graph. `graph_nodes` holds files and the symbols they
// define; `graph_edges` holds import relationships (src/dst are node ids; an
// external module is encoded as a dst of `ext:<module>`). Rebuilt wholesale by
// `graph build`, so no triggers/FTS are needed — it is queried by path/name.
export const graphSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT,
    language TEXT,
    symbol_kind TEXT,
    line INTEGER,
    signature TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_edges (
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    kind TEXT NOT NULL,
    raw TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (src, dst, kind)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst)`
];

// v8: file briefs for token-frugal navigation. `files.summary` is an optional
// human/agent-authored brief for previously used files. The legacy importance
// column remains here only to preserve historical migration order; v11 removes it.
// `last_seen_hash` stores the file hash at brief time so graph rebuilds can mark
// stale briefs when the file changes substantially.
export const fileBriefColumnStatements = [
  `ALTER TABLE files ADD COLUMN importance INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE files ADD COLUMN last_task_id TEXT`,
  `ALTER TABLE files ADD COLUMN last_task_edited_at TEXT`,
  `ALTER TABLE graph_nodes ADD COLUMN content_hash TEXT`
];

// v9: repository-wide session events and a reviewable inbox for proposed shared
// knowledge. These rows are append-only/auditable; promotion writes a normal
// taskless `memories` row so existing context compilation stays compatible.
export const workspaceEventSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    agent TEXT,
    kind TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_task ON session_events(task_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    session_event_id TEXT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 3,
    tags TEXT,
    source_agent TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(session_event_id) REFERENCES session_events(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, created_at)`
];

// v10: manual priority is distinct from legacy auto-generated importance. It is
// nullable so a normal brief has no artificial rank boost.
export const manualFilePriorityColumnStatements = [`ALTER TABLE files ADD COLUMN manual_priority INTEGER`];

// v11: graph selection no longer uses file importance. Drop the legacy column
// after v10 has introduced the explicit manual_priority replacement.
export const legacyFileImportanceRemovalStatements = [`ALTER TABLE files DROP COLUMN importance`];

// v12: git-like task orchestration. A task lane describes the isolated working
// area for a task; file leases prevent concurrent writes to the same path;
// task_changes tracks reviewable diffs; agent_requests is the human approval
// inbox for commands, conflicts, merge requests, and questions.
export const taskOrchestrationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS task_lanes (
    task_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    base_ref TEXT,
    base_commit TEXT,
    worktree_path TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS file_leases (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT,
    agent TEXT,
    path TEXT NOT NULL,
    mode TEXT NOT NULL,
    base_hash TEXT,
    current_hash TEXT,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_leases_path_active ON file_leases(path, released_at, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_file_leases_task ON file_leases(task_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS task_changes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    path TEXT NOT NULL,
    change_type TEXT NOT NULL,
    base_hash TEXT,
    current_hash TEXT,
    diff_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    UNIQUE(task_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_changes_task ON task_changes(task_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS agent_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    session_id TEXT,
    agent TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_requests_task ON agent_requests(task_id, status, created_at)`
];

// v13: multi-agent workforce foundations. These tables model dynamic agents,
// credential references, roles, workforces, subtasks, assignments, and dispatch
// runs. Secrets are referenced by name only; raw API keys must never be stored.
export const workforceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL,
    command TEXT,
    base_url TEXT,
    model TEXT,
    credential_ref TEXT,
    capabilities TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents(provider, enabled)`,
  `CREATE TABLE IF NOT EXISTS credential_refs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, kind, ref)
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    permissions TEXT,
    default_prompt TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workforces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    default_leader_assignment_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workforce_members (
    id TEXT PRIMARY KEY,
    workforce_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 3,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(workforce_id) REFERENCES workforces(id),
    FOREIGN KEY(agent_id) REFERENCES agents(id),
    FOREIGN KEY(role_id) REFERENCES roles(id),
    UNIQUE(workforce_id, agent_id, role_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workforce_members_workforce ON workforce_members(workforce_id, enabled, priority)`,
  `CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    parent_task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    status_reason TEXT,
    priority INTEGER NOT NULL DEFAULT 3,
    depends_on TEXT,
    acceptance_criteria TEXT,
    created_by_assignment_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(parent_task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON subtasks(parent_task_id, status, priority)`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    subtask_id TEXT,
    workforce_id TEXT,
    agent_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    prompt TEXT NOT NULL,
    result_summary TEXT,
    test_summary TEXT,
    risk_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(subtask_id) REFERENCES subtasks(id),
    FOREIGN KEY(workforce_id) REFERENCES workforces(id),
    FOREIGN KEY(agent_id) REFERENCES agents(id),
    FOREIGN KEY(role_id) REFERENCES roles(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments(task_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_agent ON assignments(agent_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS dispatch_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    workforce_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    mode TEXT NOT NULL DEFAULT 'dry-run',
    plan_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(workforce_id) REFERENCES workforces(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dispatch_runs_task ON dispatch_runs(task_id, status, updated_at)`
];

export const workforceAgentReasoningColumnStatements = [
  `ALTER TABLE agents ADD COLUMN reasoning_effort TEXT`
];

// Deleted roles are hidden from setup while assignments keep their historical
// role_id reference.
export const workforceRoleArchiveColumnStatements = [
  `ALTER TABLE roles ADD COLUMN deleted_at TEXT`
];

// v16: agent_runs models a single live agent process (spawned, adopted, or
// manual). This is the runtime unit the workforce UI/CLI can list, stop,
// rename model on, or adopt — assignments/subtasks stay the planning unit.
export const agentRunSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    orchestration_id TEXT,
    task_id TEXT NOT NULL,
    subtask_id TEXT,
    assignment_id TEXT,
    workforce_id TEXT,
    agent_id TEXT NOT NULL,
    role_id TEXT,
    origin TEXT NOT NULL DEFAULT 'spawned',
    pid INTEGER,
    session_id TEXT,
    provider TEXT,
    model TEXT,
    reasoning_effort TEXT,
    command TEXT,
    cwd TEXT,
    log_path TEXT,
    status TEXT NOT NULL DEFAULT 'starting',
    phase TEXT,
    progress_percent INTEGER,
    progress_note TEXT,
    restarted_from_run_id TEXT,
    exit_code INTEGER,
    started_at TEXT,
    heartbeat_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(agent_id) REFERENCES agents(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_assignment ON agent_runs(assignment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_orchestration ON agent_runs(orchestration_id, status)`
];

// v17: orchestrations track one leader-driven project loop per task; events
// are the append-only audit trail the UI activity feed reads from.
export const orchestrationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS orchestrations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    workforce_id TEXT,
    leader_agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    autonomy TEXT NOT NULL DEFAULT 'manual',
    cycle INTEGER NOT NULL DEFAULT 0,
    max_cycles INTEGER NOT NULL DEFAULT 8,
    max_parallel INTEGER NOT NULL DEFAULT 3,
    complexity TEXT,
    plan_path TEXT,
    report_path TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(leader_agent_id) REFERENCES agents(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orchestrations_task ON orchestrations(task_id, status)`,
  `CREATE TABLE IF NOT EXISTS orchestration_events (
    id TEXT PRIMARY KEY,
    orchestration_id TEXT NOT NULL,
    cycle INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT,
    payload TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(orchestration_id) REFERENCES orchestrations(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orchestration_events_orch ON orchestration_events(orchestration_id, created_at)`
];

// v18: reviews are reviewer verdicts awaiting leader adjudication. Kept
// separate from assignments so one implementer assignment can accumulate
// multiple review rounds without losing history.
export const reviewSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    subtask_id TEXT,
    reviewer_assignment_id TEXT,
    target_assignment_id TEXT,
    verdict TEXT NOT NULL,
    score INTEGER,
    summary TEXT NOT NULL,
    findings TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id, consumed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_subtask ON reviews(subtask_id)`
];

// v19: deleted agents are archived rather than physically removed, mirroring
// workforceRoleArchiveColumnStatements — assignments, agent_runs, and
// orchestrations all hold a NOT NULL agent_id/leader_agent_id FK, so a hard
// delete would break history the moment the agent had ever done any work.
export const agentArchiveColumnStatements = [
  `ALTER TABLE agents ADD COLUMN deleted_at TEXT`
];

// v20: which orchestration cycle a run belongs to. Without it the Runs board
// can only ever show "everything ever spawned for this task", which on a
// project that went through a few change requests is dozens of finished runs
// the user has to scroll past. Existing rows stay NULL and are treated as
// "unknown cycle" — shown only under the All filter.
export const agentRunCycleColumnStatements = [
  `ALTER TABLE agent_runs ADD COLUMN cycle INTEGER`
];

// v21: which providers the leader may staff its team from, as a JSON array.
// Without it the leader only ever hears about providers that already have a
// registered agent — on a workspace started with a codex leader that is just
// "codex", so every implementer and reviewer it picks is codex too. NULL means
// "no restriction": the caller offers every installed CLI provider.
export const orchestrationTeamProvidersColumnStatements = [
  `ALTER TABLE orchestrations ADD COLUMN team_providers TEXT`
];

// v22: repoint antigravity agents at the headless CLI. Agents registered before
// the provider's command was corrected still carry `antigravity`, which is the
// IDE launcher and is not even on PATH — every spawn of one dies instantly with
// "spawn antigravity ENOENT" and the run just shows up as failed. `agy` is the
// headless agent binary that was always meant to run here. A command pointing
// at a real path is left alone: that is a deliberate override, not stale data.
export const antigravityCommandRepointStatements = [
  `UPDATE agents SET command = 'agy', updated_at = updated_at
     WHERE provider = 'antigravity'
       AND (command IS NULL OR command IN ('antigravity', 'antigravity.exe', 'gemini'))`
];

// v23: free-form expertise profile shown to leaders during planning. Capability
// tags remain hard spawn constraints; this description gives the leader enough
// detail to choose among multiple eligible agents without favoring its provider.
export const agentDescriptionColumnStatements = [
  `ALTER TABLE agents ADD COLUMN description TEXT`
];

// v24: preset identity and selection are separate from enabled/disabled. An
// unchecked preset disappears from the roster but keeps all user edits so the
// same customized agent can be restored on the next check.
export const agentPresetColumnStatements = [
  `ALTER TABLE agents ADD COLUMN preset_key TEXT`,
  `ALTER TABLE agents ADD COLUMN preset_selected INTEGER NOT NULL DEFAULT 1`
];

// v25: a hidden preset is removed from the default-agent table itself, not just
// from the roster. Built-in presets are re-seeded on every dashboard load, so
// the removal has to be recorded on the row instead of deleting it.
export const agentPresetHiddenColumnStatements = [
  `ALTER TABLE agents ADD COLUMN preset_hidden INTEGER NOT NULL DEFAULT 0`
];

// v26: how many times the leader may stop planning to ask the user. A ceiling,
// not a quota: it exists because a leader that re-asks settled ground turns
// planning into an endless plan/answer loop. NULL means "use the default".
export const orchestrationMaxQuestionRoundsColumnStatements = [
  `ALTER TABLE orchestrations ADD COLUMN max_question_rounds INTEGER`
];

// v27: leader rows created before the "lead" capability existed were written
// with staff capabilities, so they showed up in the Agents tab as if they were
// hireable agents — and deleting one there left its orchestration pointing at a
// row that no lookup can resolve ("Registered agent not found"). Mark them
// lead-only so the tab hides them and the delete guard recognises them.
//
// Only auto-generated rows are touched: their name is the synthesized
// "<provider>[-<model>][-<effort>][-lead]" shape. An agent the user named and
// wired up themselves keeps its capabilities even if it happens to lead.
export const leaderCapabilityBackfillStatements = [
  `UPDATE agents SET capabilities = '["lead"]',
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id IN (SELECT leader_agent_id FROM orchestrations)
       AND deleted_at IS NULL
       AND (capabilities IS NULL OR capabilities NOT LIKE '%"lead"%')
       AND (name = provider OR name LIKE provider || '-%')`
];

// v29: blocked/cancelled cards must explain why they are terminal. Backfill a
// truthful marker for legacy rows whose original transition predated reasons.
export const subtaskStatusReasonColumnStatements = [
  `ALTER TABLE subtasks ADD COLUMN status_reason TEXT`,
  `UPDATE subtasks
     SET status_reason = CASE status
       WHEN 'blocked' THEN 'Legacy blocked task; no reason was recorded.'
       WHEN 'cancelled' THEN 'Legacy cancelled task; no reason was recorded.'
     END
     WHERE status IN ('blocked', 'cancelled') AND status_reason IS NULL`
];
export const taskQualitySchemaStatements = [
  `CREATE TABLE IF NOT EXISTS task_quality_reviews (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    payload TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_quality_reviews ON task_quality_reviews(task_id)`
];
export const taskRetrySchemaStatements = [
  `CREATE TABLE IF NOT EXISTS task_retry_policies (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_attempts ON task_attempts(task_id)`
];

export const ftsRowIdentityStatements = [
  `DROP TRIGGER IF EXISTS memories_fts_ai`,
  `DROP TRIGGER IF EXISTS memories_fts_ad`,
  `DROP TRIGGER IF EXISTS memories_fts_au`,
  `CREATE TABLE IF NOT EXISTS memory_fts_keys (fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL UNIQUE)`,
  `DELETE FROM memories_fts`,
  `DELETE FROM memory_fts_keys`,
  `INSERT INTO memory_fts_keys (memory_id) SELECT id FROM memories ORDER BY rowid`,
  `INSERT INTO memories_fts (rowid, content, summary, tags, mem_id)
   SELECT k.fts_rowid, fold(m.content), fold(COALESCE(m.summary, '')), fold(COALESCE(m.tags, '')), m.id
   FROM memories m JOIN memory_fts_keys k ON k.memory_id = m.id`,
  `CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts_keys (memory_id) VALUES (new.id);
    INSERT INTO memories_fts (rowid, content, summary, tags, mem_id)
    VALUES ((SELECT fts_rowid FROM memory_fts_keys WHERE memory_id = new.id), fold(new.content), fold(COALESCE(new.summary, '')), fold(COALESCE(new.tags, '')), new.id);
  END`,
  `CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE rowid = (SELECT fts_rowid FROM memory_fts_keys WHERE memory_id = old.id);
    DELETE FROM memory_fts_keys WHERE memory_id = old.id;
  END`,
  `CREATE TRIGGER memories_fts_au AFTER UPDATE OF id, content, summary, tags ON memories BEGIN
    UPDATE memory_fts_keys SET memory_id = new.id WHERE memory_id = old.id;
    DELETE FROM memories_fts WHERE rowid = (SELECT fts_rowid FROM memory_fts_keys WHERE memory_id = new.id);
    INSERT INTO memories_fts (rowid, content, summary, tags, mem_id)
    VALUES ((SELECT fts_rowid FROM memory_fts_keys WHERE memory_id = new.id), fold(new.content), fold(COALESCE(new.summary, '')), fold(COALESCE(new.tags, '')), new.id);
  END`,
];


export const taskPlanningSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS task_decompositions (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, payload TEXT NOT NULL
  )`
];

export const managedDispatchSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS managed_dispatch_policies (
    parent_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS managed_dispatches (
    request_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id), payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_managed_dispatch_parent ON managed_dispatches(parent_task_id)`
];
