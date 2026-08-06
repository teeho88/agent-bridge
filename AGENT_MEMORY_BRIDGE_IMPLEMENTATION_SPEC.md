# Agent Memory Bridge — Implementation Spec for Codex

> Build a local-first, agent-neutral sidecar that reduces token usage and enables handoff continuity across Claude, Codex, Antigravity, and other coding agents.

## 0. Product Summary

**Working name:** `agent-bridge`

`agent-bridge` is a CLI + local memory system that acts as a shared context/memory layer for coding agents.

It should not try to become another coding agent. Instead, it should provide:

1. Shared task memory.
2. Agent-neutral context compilation.
3. Token budget enforcement.
4. Log/output compression.
5. Handoff packets between agents.
6. Adapter outputs for Claude, Codex, Antigravity, and generic agents.
7. Future-ready MCP server integration.

The first version must be local, simple, reliable, and easy to inspect.

---

## 1. Main Goals

### 1.1 Token Saving

The tool should reduce token usage by:

- Avoiding repeated project explanation.
- Avoiding repeated chat history.
- Sending only relevant task context.
- Summarizing long logs.
- Deduplicating repeated information.
- Storing project decisions in memory once and reusing them.
- Generating compact `AGENTS.md`, `CLAUDE.md`, and handoff files.

### 1.2 Cross-Agent Continuity

The tool should allow this workflow:

```txt
Claude starts task
    ↓
agent-bridge saves task state
    ↓
Codex loads compiled context
    ↓
Codex continues task
    ↓
Antigravity receives handoff packet
    ↓
Task continues without reloading full history
```

### 1.3 Agent-Neutral Design

The memory pool must not depend on Claude, Codex, or Antigravity specifically.

Agents are clients.

The core system owns:

- task state
- memory
- decision logs
- file summaries
- handoff packets
- token policies
- compiled context

---

## 2. MVP Scope

Build the first version as a **TypeScript monorepo** with:

- CLI
- SQLite memory store
- Markdown output
- JSON handoff output
- Simple memory search
- Context compiler
- Log compressor
- Token budgeter
- Agent adapters:
  - Claude
  - Codex
  - Antigravity
  - Generic

Do **not** build yet:

- Web dashboard
- Cloud sync
- Multi-user auth
- Team permissions
- Complex vector database
- Auto-running external agents
- Browser automation
- UI plugin

---

## 3. Recommended Tech Stack

### MVP

```txt
Runtime: Node.js 20+
Language: TypeScript
Package manager: pnpm
CLI: commander
Validation: zod
Database: SQLite
SQLite driver: better-sqlite3
File scanning: fast-glob
Git helper: simple-git
Token estimation: simple tokenizer first, replaceable later
Testing: vitest
Lint/format: eslint + prettier
```

### Future Production

```txt
PostgreSQL
pgvector
MCP server
OpenTelemetry
Docker
Web dashboard
Team/cloud sync
```

---

## 4. Repository Structure

Create this structure:

```txt
agent-bridge/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md

  packages/
    cli/
      package.json
      src/
        index.ts
        commands/
          init.ts
          task.ts
          memory.ts
          context.ts
          handoff.ts
          optimize.ts
          git.ts

    core/
      package.json
      src/
        context-compiler.ts
        token-optimizer.ts
        log-compressor.ts
        relevance-ranker.ts
        prompt-pack.ts
        security-policy.ts
        types.ts

    memory/
      package.json
      src/
        memory-store.ts
        sqlite-store.ts
        schema.ts
        migrations.ts
        task-graph.ts
        search.ts

    adapters/
      package.json
      src/
        index.ts
        claude.ts
        codex.ts
        antigravity.ts
        generic.ts

    mcp-server/
      package.json
      src/
        server.ts
        tools/
          get-current-task.ts
          search-memory.ts
          save-memory.ts
          create-handoff.ts
          compile-context.ts

  templates/
    CLAUDE.md
    AGENTS.md
    current-task.md
    handoff.md
    token-policy.yaml

  examples/
    basic-project/
      README.md

  .agent-memory/
    .gitkeep
```

MCP package can be scaffolded but does not need full implementation in MVP if time is limited.

---

## 5. Local Memory Directory

When the user runs:

```bash
agent-bridge init
```

Create:

```txt
.agent-memory/
  memories.db
  current-task.md
  compiled-context.md
  handoff.json
  config.json
  logs/
  artifacts/
  tasks/
```

Generated project files:

```txt
AGENTS.md
CLAUDE.md
```

Important:

- Do not overwrite existing `AGENTS.md` or `CLAUDE.md` without creating a backup.
- If files exist, insert an `agent-bridge` managed section.
- Managed sections should be clearly delimited.

Example:

```md
<!-- agent-bridge:start -->
...
<!-- agent-bridge:end -->
```

---

## 6. Database Schema

Use SQLite.

### 6.1 `tasks`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  owner_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Allowed statuses:

```txt
todo
in_progress
blocked
done
cancelled
```

### 6.2 `memories`

```sql
CREATE TABLE IF NOT EXISTS memories (
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
);
```

Memory types:

```txt
task
decision
file
bug
test
constraint
handoff
artifact
note
```

### 6.3 `decisions`

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  related_files TEXT,
  source_agent TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

### 6.4 `files`

```sql
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  summary TEXT,
  last_seen_hash TEXT,
  important_ranges TEXT,
  updated_at TEXT NOT NULL
);
```

### 6.5 `handoffs`

```sql
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_agent TEXT,
  to_agent TEXT,
  summary TEXT NOT NULL,
  done TEXT,
  next TEXT,
  risks TEXT,
  files_changed TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

### 6.6 `runs`

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent TEXT,
  command TEXT,
  result_summary TEXT,
  token_estimate INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

---

## 7. Core Commands

### 7.1 Init

```bash
agent-bridge init
```

Responsibilities:

- Create `.agent-memory/`
- Create SQLite DB
- Write default `config.json`
- Generate or patch `AGENTS.md`
- Generate or patch `CLAUDE.md`
- Write default token policy
- Print next steps

Expected output:

```txt
Initialized agent-bridge.
Created .agent-memory/memories.db
Created AGENTS.md managed section
Created CLAUDE.md managed section

Next:
  agent-bridge task start "Your task"
  agent-bridge context compile --agent codex
```

---

### 7.2 Start Task

```bash
agent-bridge task start "Fix login session persistence"
```

Options:

```bash
--goal "User remains logged in after browser refresh"
--agent claude
```

Responsibilities:

- Create task row
- Mark as current task in `.agent-memory/config.json`
- Write `.agent-memory/current-task.md`
- Add task memory

---

### 7.3 Show Current Task

```bash
agent-bridge task current
```

Output current task:

```md
# Current Task

## Title
Fix login session persistence

## Status
in_progress

## Goal
User remains logged in after browser refresh.

## Next Actions
- Inspect session middleware
- Check cookie options
- Run auth tests
```

---

### 7.4 Add Memory

```bash
agent-bridge memory add "Cookie exists but session is not restored after refresh"
```

Options:

```bash
--type bug
--task auth-session-fix
--agent claude
--tags auth,cookie,session
--importance 5
```

Memory should be saved to DB.

---

### 7.5 Search Memory

```bash
agent-bridge memory search "session cookie"
```

MVP search can be simple:

- case-insensitive keyword search
- search in `content`, `summary`, `tags`
- order by importance and recency

Future: vector search.

---

### 7.6 Compile Context

```bash
agent-bridge context compile --agent codex
```

Options:

```bash
--budget 4000
--task <task_id>
--output .agent-memory/compiled-context.md
```

Responsibilities:

- Load current task.
- Load relevant memories.
- Load related decisions.
- Load file summaries.
- Load last handoff.
- Apply token budget.
- Generate compact prompt pack.
- Output agent-specific format.

Supported agents:

```txt
claude
codex
antigravity
generic
```

---

### 7.7 Create Handoff

```bash
agent-bridge handoff create --from claude --to codex
```

Options:

```bash
--summary "Found bug in cookie sameSite config"
--done "Inspected auth middleware"
--next "Patch cookie config; run auth integration tests"
--risks "Do not touch payment auth flow"
```

Responsibilities:

- Create `handoffs` row.
- Write `.agent-memory/handoff.json`.
- Write `.agent-memory/handoff.md`.
- Add handoff memory.

---

### 7.8 Compress Logs

```bash
agent-bridge optimize logs ./test-output.log
```

Options:

```bash
--max-lines 80
--max-chars 8000
--keep-errors
```

Rules:

- Keep error lines.
- Keep stack trace top and bottom.
- Remove repeated progress lines.
- Remove package manager noise.
- Collapse repeated identical lines.
- Preserve command exit status if known.

---

### 7.9 Git Snapshot

```bash
agent-bridge git snapshot
```

Responsibilities:

- Summarize current branch.
- List changed files.
- Summarize `git diff --stat`.
- Save run/memory entry.
- Do not include full diff by default.

Future:

```bash
agent-bridge git summarize-diff
```

---

## 8. Context Compiler

The context compiler is the most important part.

### 8.1 Input

```ts
type CompileContextInput = {
  taskId: string;
  agent: "claude" | "codex" | "antigravity" | "generic";
  tokenBudget: number;
  includeFiles?: boolean;
  includeGit?: boolean;
};
```

### 8.2 Output

```ts
type PromptPack = {
  agent: string;
  task: {
    id: string;
    title: string;
    goal?: string;
    status: string;
  };
  currentState: string[];
  relevantFiles: string[];
  knownDecisions: string[];
  constraints: string[];
  nextActions: string[];
  risks: string[];
  handoff?: HandoffSummary;
  tokenEstimate: number;
  renderedMarkdown: string;
};
```

### 8.3 Pipeline

```txt
Raw task/memory/project context
        ↓
Load current task
        ↓
Fetch memories related to task
        ↓
Fetch decisions
        ↓
Fetch file summaries
        ↓
Fetch latest handoff
        ↓
Rank relevance
        ↓
Remove duplicates
        ↓
Apply token budget
        ↓
Render prompt pack
        ↓
Render agent-specific output
```

### 8.4 Prompt Pack Markdown Format

```md
# Agent Task Brief

## Goal
<short goal>

## Current State
- <fact 1>
- <fact 2>

## Relevant Files
- <file path>: <short summary>

## Constraints
- <constraint>

## Known Decisions
- <decision> — <reason>

## Next Actions
1. <step>
2. <step>
3. <step>

## Risks / Do Not Touch
- <risk>

## Expected Output
- Minimal diff
- Test result summary
- Handoff summary
```

---

## 9. Token Optimizer

### 9.1 Token Policy

Default `.agent-memory/token-policy.yaml`:

```yaml
token_policy:
  max_prompt_tokens: 4000
  max_file_snippet_tokens: 1200
  max_memory_tokens: 800
  max_logs_tokens: 300
  max_handoff_tokens: 600
  prefer_summary_over_raw: true
  include_tests_first: true
  include_latest_handoff: true
  include_decisions: true
```

### 9.2 Budget Allocation

Default allocation:

```txt
Task and goal:       10%
Current state:       20%
Relevant memories:   20%
File summaries:      20%
Decisions:           10%
Handoff:             10%
Instructions:        10%
```

### 9.3 Deduplication

Deduplicate by:

- exact string match
- normalized lowercase text
- repeated file paths
- repeated decisions
- repeated next actions

### 9.4 Compression Rules

For long text:

- Keep first important paragraph.
- Keep error messages.
- Keep file paths.
- Keep function names.
- Remove repeated logs.
- Remove package install progress.
- Prefer summary over raw content.

---

## 10. Agent Adapters

### 10.1 Codex Adapter

Codex output should be optimized for `AGENTS.md`.

Generate or update:

```txt
AGENTS.md
.agent-memory/compiled-context.md
.agent-memory/current-task.md
```

Managed section:

```md
<!-- agent-bridge:start -->

# Agent Bridge Context

## Token Rules
- Keep answers concise.
- Do not inspect unrelated files.
- Prefer minimal diffs.
- Do not paste long logs.
- Summarize test output.

## Current Task
See `.agent-memory/current-task.md`.

## Compiled Context
See `.agent-memory/compiled-context.md`.

## Handoff
See `.agent-memory/handoff.md` if present.

## Completion Rules
Before finishing:
1. Summarize changed files.
2. Summarize tests run.
3. Create or update handoff notes.
4. Avoid including unnecessary full file contents.

<!-- agent-bridge:end -->
```

### 10.2 Claude Adapter

Generate or update:

```txt
CLAUDE.md
.agent-memory/compiled-context.md
.agent-memory/current-task.md
```

Managed section:

```md
<!-- agent-bridge:start -->

# Claude Efficiency Rules

- Keep responses short unless asked.
- Ask before reading large files.
- Read only relevant files/functions.
- Do not repeat long logs.
- Do not load full project unless explicitly requested.
- Prefer summaries over raw dumps.
- Use `.agent-memory/current-task.md` as current task context.
- Use `.agent-memory/compiled-context.md` before starting work.
- Update `.agent-memory/handoff.md` after meaningful progress.

<!-- agent-bridge:end -->
```

### 10.3 Antigravity Adapter

Generate:

```txt
.agent-memory/artifacts/
.agent-memory/handoff.json
.agent-memory/compiled-context.md
```

Antigravity should receive:

- task brief
- current state
- next actions
- verification checklist
- artifact import/export location

Suggested artifact format:

```json
{
  "type": "agent_bridge_artifact",
  "task_id": "...",
  "summary": "...",
  "plan": [],
  "progress": [],
  "verification": [],
  "next_actions": [],
  "risks": []
}
```

### 10.4 Generic Adapter

Generate only:

```txt
.agent-memory/compiled-context.md
```

---

## 11. Security Policy

Agents should be treated as semi-trusted processes.

### 11.1 Default Ignore Paths

Do not ingest by default:

```txt
.env
.env.*
*.pem
*.key
id_rsa
id_rsa.pub
secrets.*
credentials.*
node_modules/
dist/
build/
.git/
coverage/
.cache/
.next/
.vite/
```

### 11.2 Blocked Commands

The tool itself should never auto-run these commands:

```txt
rm -rf /
sudo
curl * | sh
chmod -R 777
git push --force
npm publish
pnpm publish
yarn publish
docker system prune
```

### 11.3 Sensitive Data

If logs contain possible secrets, redact them before storing:

Patterns:

```txt
API_KEY=...
SECRET=...
TOKEN=...
PASSWORD=...
PRIVATE_KEY=...
```

Replace with:

```txt
[REDACTED]
```

---

## 12. Config File

Create:

```json
{
  "version": 1,
  "currentTaskId": null,
  "defaultAgent": "codex",
  "tokenBudget": 4000,
  "memoryPath": ".agent-memory",
  "databasePath": ".agent-memory/memories.db",
  "managedFiles": {
    "AGENTS.md": true,
    "CLAUDE.md": true
  },
  "security": {
    "redactSecrets": true,
    "ignorePaths": [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "node_modules/",
      "dist/",
      "build/",
      ".git/"
    ]
  }
}
```

---

## 13. Implementation Checklist

### Phase 1 — Foundation

- [ ] Set up pnpm monorepo.
- [ ] Create packages: cli, core, memory, adapters.
- [ ] Add TypeScript config.
- [ ] Add Vitest.
- [ ] Add CLI entrypoint.
- [ ] Implement `agent-bridge init`.
- [ ] Create `.agent-memory`.
- [ ] Create SQLite DB.
- [ ] Create config file.
- [ ] Generate managed sections in `AGENTS.md` and `CLAUDE.md`.

### Phase 2 — Memory

- [ ] Implement SQLite migrations.
- [ ] Implement memory store interface.
- [ ] Implement task start/current commands.
- [ ] Implement memory add/search commands.
- [ ] Implement current task markdown renderer.
- [ ] Add tests for memory store.

### Phase 3 — Context Compiler

- [ ] Implement context compiler input/output types.
- [ ] Load task, memories, decisions, handoffs, files.
- [ ] Implement relevance ranking.
- [ ] Implement deduplication.
- [ ] Implement token estimation.
- [ ] Implement token budget allocation.
- [ ] Render prompt pack markdown.
- [ ] Add tests for compiler.

### Phase 4 — Adapters

- [ ] Implement Codex adapter.
- [ ] Implement Claude adapter.
- [ ] Implement Antigravity adapter.
- [ ] Implement generic adapter.
- [ ] Implement managed section patching.
- [ ] Add tests for generated markdown.

### Phase 5 — Handoff

- [ ] Implement handoff create command.
- [ ] Save handoff to DB.
- [ ] Write `handoff.json`.
- [ ] Write `handoff.md`.
- [ ] Add handoff to memory.
- [ ] Add tests.

### Phase 6 — Token Saving Utilities

- [ ] Implement log compressor.
- [ ] Implement secret redaction.
- [ ] Implement duplicate removal.
- [ ] Implement `optimize logs`.
- [ ] Add tests with noisy logs.

### Phase 7 — Git Integration

- [ ] Add simple-git.
- [ ] Implement `git snapshot`.
- [ ] Store branch and changed file summary.
- [ ] Do not store full diff by default.
- [ ] Add tests or mock tests.

### Phase 8 — MCP Scaffold

- [ ] Scaffold MCP package.
- [ ] Define tools:
  - get_current_task
  - search_memory
  - save_memory
  - create_handoff
  - compile_context
- [ ] Leave as experimental if not complete.

---

## 14. Acceptance Criteria

The MVP is acceptable when:

1. `agent-bridge init` creates a usable local memory workspace.
2. `agent-bridge task start "..."` creates and persists a current task.
3. `agent-bridge memory add "..."` saves memory to SQLite.
4. `agent-bridge memory search "..."` returns relevant memories.
5. `agent-bridge context compile --agent codex` creates a compact `compiled-context.md`.
6. `agent-bridge context compile --agent claude` updates Claude-compatible context.
7. `agent-bridge handoff create --from claude --to codex` creates JSON and Markdown handoff files.
8. `agent-bridge optimize logs ./file.log` compresses noisy logs and redacts secrets.
9. Existing `AGENTS.md` and `CLAUDE.md` are not destructively overwritten.
10. All main flows have basic tests.

---

## 15. Example Workflow

```bash
agent-bridge init

agent-bridge task start "Fix login session persistence" \
  --goal "User remains logged in after browser refresh" \
  --agent claude

agent-bridge memory add \
  "Cookie is created during login, but session is not restored after refresh" \
  --type bug \
  --tags auth,cookie,session \
  --importance 5 \
  --agent claude

agent-bridge memory add \
  "Do not modify payment auth flow" \
  --type constraint \
  --tags auth,payment \
  --importance 5

agent-bridge context compile --agent codex --budget 4000

agent-bridge handoff create \
  --from claude \
  --to codex \
  --summary "Auth middleware inspected. Likely cookie config or parsing bug." \
  --done "Confirmed cookie exists after login" \
  --next "Patch cookie config and run auth integration tests" \
  --risks "Do not touch payment module"
```

Then Codex should be instructed:

```txt
Read AGENTS.md and .agent-memory/compiled-context.md.
Implement the next action only.
Keep the diff minimal.
After changes, update handoff notes.
```

---

## 16. Example `compiled-context.md`

```md
# Agent Task Brief

## Goal
Fix login session persistence after browser refresh.

## Current State
- Cookie is created during login.
- Session is not restored after refresh.
- Previous agent suspects cookie config or parsing issue.

## Relevant Files
- src/auth/session.ts
- src/middleware/auth.ts

## Constraints
- Do not modify payment auth flow.
- Do not rewrite the auth architecture.
- Keep patch minimal.

## Known Decisions
- Prefer httpOnly cookies.
- Avoid storing refresh tokens in localStorage.

## Next Actions
1. Inspect cookie parsing in auth middleware.
2. Patch cookie options if needed.
3. Run auth integration tests.

## Risks / Do Not Touch
- Payment module.
- Database migrations unless absolutely required.

## Expected Output
- Minimal diff.
- Test result summary.
- Updated handoff note.
```

---

## 17. Development Rules for Codex

When implementing this project:

1. Prefer small, testable modules.
2. Do not introduce unnecessary frameworks.
3. Keep MVP local-first.
4. Do not add cloud sync.
5. Do not add dashboard yet.
6. Do not over-engineer vector search.
7. Use SQLite keyword search first.
8. Keep generated files human-readable.
9. Preserve user-authored content in `AGENTS.md` and `CLAUDE.md`.
10. Add tests for all core commands.
11. Do not store secrets from logs or files.
12. Keep public interfaces stable and typed.

---

## 18. Suggested Package Scripts

Root `package.json`:

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "format": "prettier --write .",
    "dev": "pnpm --filter @agent-bridge/cli dev"
  }
}
```

CLI package:

```json
{
  "bin": {
    "agent-bridge": "dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

---

## 19. Suggested Type Definitions

```ts
export type AgentKind = "claude" | "codex" | "antigravity" | "generic";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

export type MemoryType =
  | "task"
  | "decision"
  | "file"
  | "bug"
  | "test"
  | "constraint"
  | "handoff"
  | "artifact"
  | "note";

export type Task = {
  id: string;
  title: string;
  goal?: string;
  status: TaskStatus;
  ownerAgent?: AgentKind;
  createdAt: string;
  updatedAt: string;
};

export type Memory = {
  id: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number;
  tags: string[];
  sourceAgent?: AgentKind;
  createdAt: string;
  updatedAt: string;
};

export type Handoff = {
  id: string;
  taskId: string;
  fromAgent?: AgentKind;
  toAgent?: AgentKind;
  summary: string;
  done: string[];
  next: string[];
  risks: string[];
  filesChanged: string[];
  createdAt: string;
};
```

---

## 20. First Implementation Target

Start with this exact priority order:

```txt
1. Monorepo setup
2. CLI init
3. SQLite schema
4. task start/current
5. memory add/search
6. context compile --agent codex
7. context compile --agent claude
8. handoff create
9. optimize logs
10. tests
```

Do not start MCP until the local CLI is stable.

---

## 21. Final Product Principle

This tool is not an AI agent.

It is a **shared operating layer for AI agents**.

Keep the core philosophy:

```txt
Agents do the work.
agent-bridge preserves context, compresses memory, and coordinates handoff.
```
