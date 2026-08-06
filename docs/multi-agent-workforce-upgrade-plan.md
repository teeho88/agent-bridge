# Multi-Agent Workforce Upgrade Plan

## Muc tieu

Nang cap `agent-bridge` tu mot memory/handoff sidecar thanh he thong dieu phoi nhieu agent nhu mot doi "nhan vien" trong workspace local.

He thong moi can cho phep nguoi dung:

- Dang ky agent tuy y: Codex, Claude, Antigravity, GLM, DeepSeek, Kimi, OpenAI-compatible endpoint, local CLI, hoac manual agent.
- Gan role tuy y: leader, distributor, implementer, tester, reviewer, researcher, integrator.
- Tao task ngay tren UI tu yeu cau cua user, chon agent cho tung role va tao team lam viec cho task do.
- Thay doi team trong luc task dang chay: them agent vao role, doi agent dam nhan assignment/subtask moi, disable agent khong con muon dung.
- Chia task lon thanh subtask co dependency, acceptance criteria va owner ro rang.
- Chon agent/role cho tung subtask, hoac de distributor tu de xuat.
- Spawn sub-agent tuy chon, co approval gate truoc khi chay command/API co side effect.
- Quan ly API key an toan bang environment variable hoac secret reference, khong luu raw key trong memory/handoff/log.
- Tong hop ket qua, test, risk, handoff va memory theo tung agent/subtask.

## Workflow UI muc tieu

### Manual team-first flow

1. User nhap yeu cau/task tren UI.
2. User chon hoac tao workforce, chon agent cho cac role can thiet: leader, distributor, implementer, tester, reviewer.
3. UI tao task, tao workforce/member neu can, tao assignment leader dau tien de lap plan.
4. User co the tao subtask, gan agent/role cho tung assignment, start/done/fail assignment ngay tren UI.
5. Khi dang chay, user co the them agent vao role, gan assignment moi cho agent thay the, hoac disable agent khong con dung nua.

### Leader/distributor-assisted flow

1. User nhap yeu cau va chon leader.
2. Leader tao plan va acceptance criteria.
3. User chon agent lam distributor.
4. Distributor dua tren plan de tao subtask, dependency va assignment de xuat.
5. User approve dispatch/spawn request; moi spawn/API/command co side effect van phai qua approval gate.
6. User co the thay leader, distributor, implementer, tester, reviewer bat ky luc nao bang cach them member/assignment moi va huy/chan assignment cu.

Trong MVP, UI uu tien manual team-first flow. Leader/distributor-assisted flow dung chung data model, dispatch dry-run va approval queue; auto-split bang LLM la buoc sau khi adapter/orchestrator on dinh.

## Nguyen tac thiet ke

- Mo rong kien truc hien co, khong viet lai tu dau.
- Giu local-first: state chinh van nam trong `.agent-memory/` va SQLite.
- Moi thao tac tu dong co rui ro phai co audit trail.
- Spawn agent phai tach ro: dry-run, approve, execute, record result.
- API key va secret chi duoc luu duoi dang reference.
- File edit cua nhieu agent phai di qua task lane va file lease.
- UI va CLI phai cung dung chung store/schema, khong tao state rieng.

## Nen tang hien co

Repo hien co da co cac building block quan trong:

- `tasks`: task chinh, status, owner agent.
- `session_events`: lifecycle cua agent session.
- `agent_requests`: approval/question/merge/command inbox.
- `task_lanes`: lane tach biet cho task theo patch/worktree.
- `file_leases`: khoa doc/ghi file de tranh conflict.
- `task_changes`: change set cua task.
- `handoffs`: ban giao giua agent.
- `memories`: shared/task memory.
- `context compile`: bien state thanh prompt/context cho agent.
- UI dashboard co current task, memory, request, graph, handoff.

Plan nay se them workforce layer len tren cac primitive do.

## Kien truc muc tieu

```text
User
  |
  v
Workforce UI / CLI
  |
  v
Orchestrator
  |-- Agent Registry
  |-- Role Policy
  |-- Task Splitter
  |-- Dispatcher
  |-- Approval Gate
  |-- Result Aggregator
  |
  v
Agent Adapters
  |-- CLI adapter: codex, claude, antigravity
  |-- API adapter: DeepSeek, Kimi, GLM, OpenAI-compatible
  |-- Manual adapter: human-operated or externally-run agent
  |
  v
.agent-memory SQLite + artifacts
```

## Data model can them

### Agent registry

Them type:

```ts
export type AgentProvider =
  | "codex"
  | "claude"
  | "antigravity"
  | "openai-compatible"
  | "deepseek"
  | "kimi"
  | "glm"
  | "manual"
  | "generic";

export type AgentRunMode = "cli" | "api" | "manual";

export type RegisteredAgent = {
  id: string;
  name: string;
  provider: AgentProvider;
  mode: AgentRunMode;
  command?: string;
  baseUrl?: string;
  model?: string;
  credentialRef?: string;
  capabilities: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```

Bang SQLite:

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
);
```

### Credential reference

Khong luu raw API key. Chi luu cach lay key.

```ts
export type CredentialRef = {
  id: string;
  provider: string;
  kind: "env" | "command" | "os-store" | "manual";
  ref: string;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS credential_refs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Example: `DEEPSEEK_API_KEY`, `KIMI_API_KEY`, `GLM_API_KEY`.

### Roles

```ts
export type WorkforceRoleName =
  | "leader"
  | "distributor"
  | "implementer"
  | "tester"
  | "reviewer"
  | "researcher"
  | "integrator"
  | string;

export type WorkforceRole = {
  id: string;
  name: WorkforceRoleName;
  description?: string;
  permissions: string[];
  defaultPrompt?: string;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  permissions TEXT,
  default_prompt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Default roles:

- `leader`: lap chien luoc, chap nhan/reject ket qua, quyet dinh merge.
- `distributor`: tach task, gan owner, dieu chinh dependency.
- `implementer`: sua code/doc/test theo assignment.
- `tester`: chay test, tao bug report, xac nhan acceptance criteria.
- `reviewer`: review diff, risk, missing test, regression.
- `researcher`: doc code, tim context, de xuat phuong an.
- `integrator`: merge change set, xu ly conflict, tao release note.

### Workforce

```ts
export type Workforce = {
  id: string;
  name: string;
  description?: string;
  defaultLeaderAssignmentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkforceMember = {
  id: string;
  workforceId: string;
  agentId: string;
  roleId: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS workforces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  default_leader_assignment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workforce_members (
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
  FOREIGN KEY(role_id) REFERENCES roles(id)
);
```

### Subtasks

Subtask nen lien ket voi `tasks` hien co, nhung co them parent/dependency/acceptance criteria.

```ts
export type SubtaskStatus =
  | "todo"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export type Subtask = {
  id: string;
  parentTaskId: string;
  title: string;
  goal?: string;
  status: SubtaskStatus;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  createdByAssignmentId?: string;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 3,
  depends_on TEXT,
  acceptance_criteria TEXT,
  created_by_assignment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(parent_task_id) REFERENCES tasks(id)
);
```

### Assignments

Assignment la don vi dieu phoi thuc su: agent nao, role nao, lam subtask nao.

```ts
export type AssignmentStatus =
  | "queued"
  | "approved"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type Assignment = {
  id: string;
  taskId: string;
  subtaskId?: string;
  workforceId?: string;
  agentId: string;
  roleId: string;
  status: AssignmentStatus;
  prompt: string;
  resultSummary?: string;
  testSummary?: string;
  riskSummary?: string;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS assignments (
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
);
```

### Dispatch runs

```ts
export type DispatchRunStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DispatchRun = {
  id: string;
  taskId: string;
  workforceId?: string;
  status: DispatchRunStatus;
  mode: "dry-run" | "spawn";
  planSummary?: string;
  createdAt: string;
  updatedAt: string;
};
```

```sql
CREATE TABLE IF NOT EXISTS dispatch_runs (
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
);
```

## CLI de xuat

### Agent registry

```powershell
agent-bridge agent add codex --provider codex --mode cli --command "codex"
agent-bridge agent add claude --provider claude --mode cli --command "claude"
agent-bridge agent add deepseek --provider deepseek --mode api --base-url "https://api.deepseek.com" --model "deepseek-chat" --key-env DEEPSEEK_API_KEY
agent-bridge agent add kimi --provider kimi --mode api --base-url "<endpoint>" --model "<model>" --key-env KIMI_API_KEY
agent-bridge agent list
agent-bridge agent disable deepseek
agent-bridge agent test deepseek
```

### Credential refs

```powershell
agent-bridge credential add deepseek --kind env --ref DEEPSEEK_API_KEY
agent-bridge credential list
agent-bridge credential test deepseek
```

### Roles

```powershell
agent-bridge role init-defaults
agent-bridge role create leader --permissions plan,approve,merge
agent-bridge role create tester --permissions test,report
agent-bridge role list
```

### Workforce

```powershell
agent-bridge workforce create "Default Engineering Team"
agent-bridge workforce add "Default Engineering Team" --agent codex --role implementer
agent-bridge workforce add "Default Engineering Team" --agent claude --role reviewer
agent-bridge workforce add "Default Engineering Team" --agent deepseek --role researcher
agent-bridge workforce list
agent-bridge workforce show "Default Engineering Team"
```

### Subtask va assignment

```powershell
agent-bridge task split --task <taskId> --strategy manual
agent-bridge subtask create --task <taskId> --title "Implement agent registry" --criteria "CLI can add/list/test agents"
agent-bridge assignment create --task <taskId> --subtask <subtaskId> --agent codex --role implementer
agent-bridge assignment list --task <taskId>
agent-bridge assignment start <assignmentId>
agent-bridge assignment complete <assignmentId> --summary "Implemented registry schema"
```

### Dispatch

```powershell
agent-bridge dispatch plan --task <taskId> --workforce "Default Engineering Team"
agent-bridge dispatch run --task <taskId> --workforce "Default Engineering Team" --mode dry-run
agent-bridge dispatch run --task <taskId> --workforce "Default Engineering Team" --mode spawn
agent-bridge dispatch status --task <taskId>
```

`spawn` nen tao `agent_requests` truoc khi chay:

- type: `command`
- title: `Spawn assignment <id> with agent <agent>`
- payload: command/API target, prompt path, cwd, expected files

## Adapter layer

### Interface chung

```ts
export type AgentInvocation = {
  assignmentId: string;
  agentId: string;
  roleName: string;
  prompt: string;
  cwd: string;
  allowedFiles?: string[];
  timeoutMs?: number;
};

export type AgentInvocationResult = {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  stdout?: string;
  stderr?: string;
  filesChanged: string[];
  testsRun: string[];
  requests: Array<{
    type: "approval" | "command" | "merge" | "question";
    title: string;
    payload?: string;
  }>;
};

export interface AgentAdapter {
  kind: string;
  test(agent: RegisteredAgent): Promise<void>;
  invoke(input: AgentInvocation): Promise<AgentInvocationResult>;
}
```

### CLI adapter

Dung cho Codex, Claude, Antigravity neu co command local.

Can co:

- dry-run command preview.
- cwd control.
- timeout.
- stdout/stderr capture va log compression.
- secret redaction truoc khi ghi DB.
- optional prompt file trong `.agent-memory/artifacts/assignments/<id>.md`.

### API adapter

Dung cho DeepSeek, Kimi, GLM, OpenAI-compatible.

Can co:

- base URL.
- model.
- credential env var.
- request timeout/retry.
- token/cost estimate neu co.
- output parser theo JSON schema neu distributor/tester can structured output.

### Manual adapter

Dung khi user muon tu chay agent ben ngoai.

Manual assignment se:

- tao prompt artifact.
- hien command/context can copy.
- cho user/agent goi `assignment complete`.
- van ghi memory/handoff nhu cac agent khac.

## Orchestration flow

### Flow mac dinh

1. User start task lon.
2. Leader tao plan tong quan va acceptance criteria.
3. Distributor tach subtask va dependency.
4. User approve dispatch plan.
5. Implementer nhan subtask, lay file lease, sua code/doc/test.
6. Tester chay test va ghi `testSummary`.
7. Reviewer review diff/risk/missing tests.
8. Leader accept/rework/merge.
9. Integrator tong hop handoff va memory.

### State transition

```text
subtask.todo
  -> assigned
  -> in_progress
  -> testing
  -> review
  -> done

assignment.queued
  -> approved
  -> running
  -> waiting
  -> done
```

Neu bi loi:

```text
running -> failed
running -> waiting
waiting -> running
review -> in_progress
```

## UI can them

Them tab `Workforce` trong dashboard.

Can hien:

- Agent registry: name, provider, mode, model, enabled, test status.
- Workforce members: agent + role + priority.
- Role board: leader/distributor/implementer/tester/reviewer.
- Subtask tree hoac DAG: dependency, status, owner.
- Assignment queue: queued/running/waiting/done/failed.
- Approval inbox: spawn command, merge request, conflict, API key missing.
- Result panel: summary, files changed, tests run, risks.
- Token/cost panel: estimate theo agent/provider.

Hanh dong UI toi thieu:

- Add/edit/disable agent.
- Add credential reference.
- Create workforce.
- Assign role.
- Split task.
- Approve dispatch.
- Start/stop assignment.
- Mark complete/rework.

## Context compile update

`context compile` nen them workforce context khi co task dang active:

```md
## Workforce
- Active workforce: Default Engineering Team
- Leader: claude
- Distributor: codex
- Implementers: codex, deepseek
- Tester: claude

## Current Assignment
- Role: implementer
- Subtask: Implement agent registry
- Acceptance criteria:
  - agent add/list/test works
  - no raw API keys persisted
  - migration test passes
```

Can gioi han token:

- Chi inject assignment cua agent hien tai.
- Chi inject subtask lien quan va dependencies gan nhat.
- Summary thay vi full logs.

## Security policy

- Khong bao gio luu raw API key.
- Redact secret trong stdout/stderr truoc khi ghi DB.
- `credential_refs.ref` chi la env var name, command name, hoac OS secret key.
- Spawn command phai qua `agent_requests` neu:
  - tao process moi.
  - goi network/API.
  - sua file.
  - chay command co side effect.
- API adapter khong duoc echo Authorization header.
- UI khong hien raw secret.

## Permission model goi y

```ts
export type RolePermission =
  | "plan"
  | "split"
  | "assign"
  | "spawn"
  | "read"
  | "edit"
  | "test"
  | "review"
  | "approve"
  | "merge"
  | "handoff";
```

Default:

- leader: `plan,approve,merge,handoff`
- distributor: `split,assign`
- implementer: `read,edit,test`
- tester: `read,test,review`
- reviewer: `read,review,approve`
- researcher: `read,plan`
- integrator: `merge,handoff`

## Roadmap implement

### P0 - Schema va type foundations

Files likely:

- `packages/memory/src/types.ts`
- `packages/memory/src/schema.ts`
- `packages/memory/src/migrations.ts`
- `packages/memory/src/memory-store.ts`
- `packages/memory/src/sqlite-store.ts`
- `packages/memory/src/sqlite-store.test.ts`

Deliverables:

- Them type cho agents, credentials, roles, workforces, subtasks, assignments, dispatch runs.
- Them migration moi.
- Them store methods:
  - `createAgent`, `listAgents`, `updateAgent`
  - `createCredentialRef`, `listCredentialRefs`
  - `createRole`, `listRoles`, `ensureDefaultRoles`
  - `createWorkforce`, `addWorkforceMember`, `listWorkforceMembers`
  - `createSubtask`, `listSubtasks`, `updateSubtask`
  - `createAssignment`, `listAssignments`, `updateAssignment`
  - `createDispatchRun`, `updateDispatchRun`

Tests:

- migration creates tables.
- CRUD roundtrip.
- no raw secret field exists.

### P1 - CLI registry va roles

Files likely:

- `packages/cli/src/index.ts`
- `packages/cli/src/commands/agent.ts`
- `packages/cli/src/commands/credential.ts`
- `packages/cli/src/commands/role.ts`
- `packages/cli/src/commands/workforce.ts`

Deliverables:

- `agent add/list/show/disable/test`
- `credential add/list/test`
- `role init-defaults/create/list`
- `workforce create/add/list/show`

Tests:

- CLI command parse.
- env key test without printing secret.
- duplicate role/agent handling.

### P2 - Subtask va assignment

Files likely:

- `packages/cli/src/commands/subtask.ts`
- `packages/cli/src/commands/assignment.ts`
- `packages/cli/src/commands/task.ts`
- `packages/core/src/context-compiler.ts`

Deliverables:

- Manual subtask create/list/update.
- Assignment create/list/start/complete/fail.
- Context compile inject current assignment.
- Assignment completion writes memory and session event.

Tests:

- subtask dependency parse.
- assignment lifecycle.
- compiled context includes only relevant assignment.

### P3 - Dispatcher dry-run

Files likely:

- `packages/cli/src/commands/dispatch.ts`
- `packages/core/src/workforce-planner.ts`
- `packages/core/src/types.ts`

Deliverables:

- `dispatch plan` creates proposed subtasks/assignments.
- `dispatch run --mode dry-run` prints plan and creates no side effects unless approved.
- Distributor policy:
  - prefer explicit user role assignment.
  - use role capabilities if user did not specify exact agent.
  - never assign edit task to disabled agent.

Tests:

- deterministic assignment selection.
- missing role/agent produces clear request.

### P4 - Spawn execution

Files likely:

- `packages/adapters/src/*.ts`
- `packages/cli/src/commands/dispatch.ts`
- `packages/cli/src/commands/request.ts`

Deliverables:

- Adapter interface.
- CLI adapter.
- Manual adapter.
- Spawn approval through `agent_requests`.
- Prompt artifacts under `.agent-memory/artifacts/assignments/`.
- Result aggregation into assignment + memory + handoff.

Tests:

- spawn dry-run does not execute.
- pending request created before execution.
- failed command records failed assignment.

### P5 - API providers

Files likely:

- `packages/adapters/src/openai-compatible.ts`
- `packages/adapters/src/deepseek.ts`
- `packages/adapters/src/kimi.ts`
- `packages/adapters/src/glm.ts`

Deliverables:

- OpenAI-compatible chat adapter.
- Provider presets for DeepSeek/Kimi/GLM.
- Credential env lookup.
- JSON output option for distributor/tester.

Tests:

- credential missing -> request/question.
- Authorization header redacted.
- mocked API response parsed.

### P6 - Workforce UI

Files likely:

- `packages/cli/src/ui-page.ts`
- `packages/cli/src/commands/ui.ts`
- `packages/cli/src/commands/ui.test.ts`

Deliverables:

- Workforce tab.
- Agent registry panel.
- Role/member panel.
- Start task + team form: user nhap yeu cau, chon leader/distributor/implementer/tester/reviewer tu registered agents, UI tao task va workforce membership.
- Member form cho phep them agent vao role bat ky trong khi task dang chay.
- Subtask + assignment forms cho phep user chia viec va gan agent/role truc tiep tren UI.
- Assignment action controls: start, complete, fail/rework.
- Subtask tree.
- Assignment board.
- Approval actions.

Important repo note:

After editing `packages/cli/src/ui-page.ts` or other CLI source feeding dashboard, run:

```powershell
.\node_modules\.bin\tsc.CMD -p packages/cli/tsconfig.json
```

The UI freshness check rejects stale dist output.

Tests:

- UI API returns workforce state.
- render contains agent/assignment data.
- TypeScript build passes.

### P7 - Quality gates

Deliverables:

- Tester role gate before assignment can become `done`.
- Reviewer gate before parent task merge.
- Leader can override with recorded decision.
- `dispatch status` shows blockers and next action.

Tests:

- cannot mark task done if required assignment failed.
- override writes decision memory.
- failed tests block merge.

## Suggested implementation order

1. Add schema/types/store methods.
2. Add CLI for static management: agent, credential, role, workforce.
3. Add subtask/assignment lifecycle.
4. Add context compiler support for current assignment.
5. Add dispatcher dry-run.
6. Add manual adapter.
7. Add CLI adapter with approval.
8. Add API adapter.
9. Add UI.
10. Add tester/reviewer/leader gates.

## Minimal first milestone

MVP nen gom:

- Dynamic agent registry.
- Default roles.
- Workforce membership.
- Manual subtask creation.
- Assignment lifecycle.
- Manual adapter.
- Context compile includes assignment.
- No automatic spawn yet.

MVP khong can ngay:

- API calling.
- Auto split bang LLM.
- Complex DAG visualization.
- Cost accounting.
- Parallel worktree execution.

## Acceptance criteria tong the

- User co the dang ky agent bat ky voi provider/mode/model/key reference.
- User co the tao workforce va gan agent vao role.
- User co the tach task thanh subtask va gan cho role/agent.
- Agent hien tai khi compile context se thay assignment cua minh.
- Ket qua assignment duoc luu vao memory/session/handoff.
- Spawn command/API khong chay neu chua duoc approve.
- API key khong xuat hien trong DB, log, handoff, compiled context.
- Tester/reviewer co the chan task truoc khi done/merge.
- UI hien duoc agents, roles, subtasks, assignments va approvals.

## Open questions

- Co can spawn nhieu terminal/process song song trong version dau khong, hay chi quan ly assignment truoc?
- User muon API providers nao uu tien: DeepSeek, Kimi, GLM, OpenRouter, local Ollama?
- Role prompt nen luu trong DB hay file template trong `.agent-memory/roles/`?
- Nen mac dinh dung patch lane hay git worktree lane cho sub-agent co edit?
- Co can cost budget theo workforce/task khong?

## Rủi ro

- Spawn nhieu agent tu dong co the tao conflict file neu khong bat buoc file lease.
- API output khong structured se lam dispatcher kho merge ket qua.
- UI co the phinh to neu gom qua nhieu logic; can giu orchestration trong store/core.
- Secret leakage phai duoc test nhu tinh nang bat buoc, khong de sau.
- Auto split task bang LLM co the tao subtask qua rong; nen bat dau bang manual/dry-run.


