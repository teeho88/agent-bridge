# Workforce v2 — Leader-Driven Orchestration Plan

Thay thế toàn bộ luồng workforce hiện tại (manual team-first + dispatch heuristic) bằng luồng **leader tự chủ**: user chỉ nhập prompt + chọn model leader, leader lo phần còn lại.

Kế thừa và thay thế `docs/multi-agent-workforce-upgrade-plan.md` (P0–P5 của plan đó đã implement xong; plan này viết lại P3/P6/P7).

---

## 1. Luồng mục tiêu

```
User: prompt + chọn leader (provider / mode / model / reasoning)
   │
   ▼
Leader turn #1  ── PLAN ──►  .agent-memory/plans/<taskId>.md
   │                         + danh sách subtask (dependency, acceptance criteria)
   │                         + độ phức tạp → số implementer / reviewer cần
   │                         + agentPreference cho từng subtask
   ▼
Orchestrator ── spawn implementer runs (codex / claude / gemini CLI hoặc API) ──►
   │                                                                    │
   │◄──────────── run kết thúc (exit code + log + handoff) ─────────────┘
   ▼
Orchestrator ── spawn reviewer runs (leader tự tạo, scope theo nhóm subtask) ──►
   │                                                                    │
   │◄──────────── review verdict (pass / rework / block) ───────────────┘
   ▼
Leader turn #N ── ADJUDICATE ──► accept → subtask done
                                 rework → tạo subtask mới + gán implementer phù hợp
                                          (quay lại vòng spawn)
   │
   ▼ (tất cả subtask done)
Leader turn cuối ── REPORT ──► spawn reporter ──► .agent-memory/reports/<taskId>.md
```

Xuyên suốt vòng lặp, user quan sát và can thiệp qua **Team Board UI**: thêm subtask + spawn agent, stop/xoá subtask, đổi model của agent đang chạy, adopt agent ngoài team.

---

## 2. Gap analysis — hiện tại vs. cần có

| Yêu cầu | Hiện trạng | Cần làm |
|---|---|---|
| Chọn leader = CLI + model + reasoning | `RegisteredAgent` đã có `model` / `reasoningEffort`; UI chỉ có `<datalist>` model chung, không phân biệt provider, không có reasoning | Agent catalog theo provider + form phụ thuộc provider |
| Gemini CLI | **Không tồn tại** | Adapter mới `packages/adapters/src/gemini.ts` |
| Leader lên plan + tạo file plan | Không có. `dispatch.ts:321 preferredRoleName()` chỉ regex title → role | Orchestrator + leader JSON contract |
| Leader tự tạo implementer/reviewer | Không. User phải tự add member cho từng role | Leader turn sinh subtask + reviewer spec, orchestrator tự tạo agent/member |
| Review loop quay lại leader | Không có | Bảng `reviews` + phase `adjudicate` |
| Quản lý agent đang chạy | `request.ts:165 execFileSync` — **blocking, không PID, không kill được, không tail log** | Chuyển sang `spawn` + bảng `agent_runs` |
| Stop / xoá subtask đang chạy | Không có | `run stop` + kill process tree |
| Đổi model agent đang chạy | Không có | `run set-model` (stop → handoff → respawn) |
| Adopt agent ngoài team | Không có | `run adopt` từ `session_events` hoặc PID |
| UI quan sát tiến độ + vai trò | Panel tĩnh trong `view-workforce` | View `Team Board` mới, swimlane theo role, progress + log tail |
| Reporter tổng hợp .md | Không có | Role `reporter` + phase `report` |

---

## 3. Kiến trúc

```
packages/core/src/
  orchestrator.ts          state machine của một project run
  leader-contract.ts       schema + parser JSON của leader turn
  leader-prompts.ts        prompt template cho plan / adjudicate / report
  agent-selector.ts        map agentPreference → RegisteredAgent (tạo mới nếu chưa có)

packages/adapters/src/
  catalog.ts               model + reasoning level theo provider
  gemini.ts                gemini CLI adapter
  invocation.ts            (sửa) thêm gemini, thêm resume/continue args
  process-runner.ts        spawn detached, tail log, kill tree (win32 + posix)

packages/memory/src/
  types.ts, schema.ts, migrations.ts, sqlite-store.ts   (+ 3 migration mới)

packages/cli/src/commands/
  workforce.ts             (viết lại) start / step / status / pause / resume / stop
  run.ts                   (mới) list / log / stop / set-model / adopt / progress / reassign
  report.ts                (mới) generate
  agent.ts                 (sửa) catalog / probe
  dispatch.ts              (giữ) làm fallback deterministic khi không dùng leader
  ui.ts                    (sửa) API board + actions
  ui-page.ts               (sửa) view Team Board
```

Nguyên tắc giữ nguyên: local-first, state trong SQLite `.agent-memory/`, không lưu raw API key, mọi side effect có audit trail, UI và CLI dùng chung store.

---

## 4. Data model mới

### 4.1 Migration 16 — `agent_runs`

Đơn vị "một tiến trình agent đang sống". Đây là cái đang thiếu và là gốc của mọi tính năng quản lý runtime.

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  assignment_id TEXT,
  workforce_id TEXT,
  agent_id TEXT NOT NULL,
  role_id TEXT,
  origin TEXT NOT NULL DEFAULT 'spawned',   -- spawned | adopted | manual
  pid INTEGER,
  session_id TEXT,                          -- liên kết session_events (hook-driven agent)
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  command TEXT,
  cwd TEXT,
  log_path TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  -- starting|running|waiting|stopping|stopped|done|failed|detached
  phase TEXT,                               -- implement | review | report | plan
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
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_assignment ON agent_runs(assignment_id);
```

### 4.2 Migration 17 — `orchestrations` + `orchestration_events`

```sql
CREATE TABLE IF NOT EXISTS orchestrations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workforce_id TEXT,
  leader_agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  -- planning|executing|reviewing|adjudicating|reworking|reporting|done|failed|paused
  autonomy TEXT NOT NULL DEFAULT 'approve-each',  -- manual | approve-each | auto
  cycle INTEGER NOT NULL DEFAULT 0,
  max_cycles INTEGER NOT NULL DEFAULT 8,
  max_parallel INTEGER NOT NULL DEFAULT 3,
  complexity TEXT,
  plan_path TEXT,
  report_path TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS orchestration_events (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL,          -- leader_turn | spawn | run_ended | verdict | rework | error | user_action
  summary TEXT,
  payload TEXT,                -- JSON đã redact
  created_at TEXT NOT NULL,
  FOREIGN KEY(orchestration_id) REFERENCES orchestrations(id)
);
```

### 4.3 Migration 18 — `reviews`

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  reviewer_assignment_id TEXT,
  target_assignment_id TEXT,
  verdict TEXT NOT NULL,        -- pass | rework | block
  score INTEGER,                -- 0..100
  summary TEXT NOT NULL,
  findings TEXT,                -- JSON array {severity,file,line,issue,suggestion}
  consumed_at TEXT,             -- thời điểm leader đã adjudicate
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

### 4.4 Type bổ sung (`packages/memory/src/types.ts`)

- `AgentProvider` += `"gemini"`.
- `AgentKind` += `"gemini"` (ảnh hưởng hook + `sourceAgent`).
- `RolePermission` += `"report"`.
- Role mặc định thêm `reporter` (`permissions: report,read,handoff`) trong `ensureDefaultWorkforceRoles()`.
- `AgentRun`, `CreateAgentRunInput`, `UpdateAgentRunInput`, `Orchestration`, `OrchestrationEvent`, `Review` + input types.

### 4.5 Store methods mới (`sqlite-store.ts` + `memory-store.ts`)

```
createAgentRun / updateAgentRun / getAgentRun / listAgentRuns({taskId,status,subtaskId,limit})
createOrchestration / updateOrchestration / getOrchestrationByTask / listOrchestrations
recordOrchestrationEvent / listOrchestrationEvents({orchestrationId,limit})
createReview / listReviews({taskId,subtaskId,consumed}) / markReviewConsumed
```

---

## 5. Agent catalog (`packages/adapters/src/catalog.ts`)

Nguồn dữ liệu cho dropdown model + reasoning ở UI, và để validate `--model` trước khi spawn.

```ts
export type ReasoningLevel = { value: string; label: string };
export type CatalogModel = { value: string; label: string; reasoning?: ReasoningLevel[] };
export type ProviderCatalog = {
  provider: AgentProvider;
  mode: AgentRunMode;
  defaultCommand: string;
  models: CatalogModel[];
  reasoning: ReasoningLevel[];          // mặc định chung nếu model không override
  reasoningFlag?: "codex-config" | "claude-effort" | "none";
};
```

Seed:

| Provider | Command | Models | Reasoning |
|---|---|---|---|
| `codex` | `codex` | `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.4`, `gpt-5.4-codex` | `minimal`, `low`, `medium`, `high`, `xhigh` → `-c model_reasoning_effort="<v>"` |
| `claude` | `claude` | `opus`, `sonnet`, `haiku`, `fable` | `low`, `medium`, `high` → `--effort <v>` |
| `gemini` | `gemini` | `gemini-2.5-pro`, `gemini-2.5-flash` | không có flag → `none` (chỉ hiện "default") |
| API providers | — | lấy từ preset `openai-compatible.ts` | không áp dụng |

Catalog là **seed có thể ghi đè**: thêm `agent-bridge agent probe <provider>` chạy `<cmd> --help` (timeout 10s), parse các model/flag khả dụng, cache vào `.agent-memory/catalog.json`. UI merge seed + cache. Việc này tránh catalog cứng bị lỗi thời khi CLI cập nhật.

### Gemini adapter

`buildSpawnPreview()` thêm nhánh:

```ts
if (agent.provider === "gemini") {
  const args = [...(agent.model ? ["-m", agent.model] : []), "-p", "-"];  // prompt qua stdin
  return { ...base, executable, args, stdinFilePath: promptArtifactPath, ... };
}
```

Kiểm chứng cờ thực tế khi implement bằng `gemini --help`; nếu `-p -` không đọc stdin thì fallback `--prompt-file` hoặc truyền nội dung prompt trực tiếp.

---

## 6. Leader contract (`packages/core/src/leader-contract.ts`)

Leader là một agent CLI/API → cần output máy đọc được. Contract: leader **phải** trả về đúng một fenced block ` ```json `.

### PLAN turn

```json
{
  "version": 1,
  "phase": "plan",
  "complexity": "small | medium | large",
  "planMarkdown": "# Plan\n...",
  "subtasks": [{
    "key": "s1",
    "title": "Add agent_runs schema",
    "goal": "...",
    "priority": 5,
    "dependsOn": [],
    "acceptanceCriteria": ["migration 16 applies", "CRUD roundtrip test passes"],
    "role": "implementer",
    "parallelSafe": true,
    "files": ["packages/memory/src/schema.ts"],
    "agentPreference": {
      "provider": "codex", "mode": "cli",
      "model": "gpt-5.6", "reasoningEffort": "high",
      "reason": "schema work, cần reasoning cao"
    }
  }],
  "reviewers": [{
    "key": "r1", "scope": ["s1", "s2"], "role": "reviewer",
    "agentPreference": { "provider": "claude", "mode": "cli", "model": "opus", "reasoningEffort": "high" }
  }],
  "questions": []
}
```

Số implementer/reviewer do leader quyết theo `complexity`; orchestrator chỉ ép trần `max_parallel`.

### ADJUDICATE turn

Input cho leader: danh sách review verdict chưa consumed + tóm tắt run + acceptance criteria.

```json
{
  "version": 1,
  "phase": "adjudicate",
  "decisions": [{
    "subtaskKey": "s1",
    "verdict": "accept | rework | block",
    "rework": {
      "title": "Fix migration ordering",
      "goal": "...",
      "acceptanceCriteria": ["..."],
      "agentPreference": { "provider": "codex", "model": "gpt-5.6", "reasoningEffort": "xhigh" }
    }
  }],
  "projectComplete": false,
  "questions": []
}
```

### Parser

1. Trích fenced json → `JSON.parse` → validate schema thủ công (không thêm dependency).
2. Fail lần 1 → retry leader với prompt `"Trả lời lại CHỈ bằng một khối ```json hợp lệ."`.
3. Fail lần 2 → `createAgentRequest({type:"question"})` cho user, orchestration → `paused`, ghi `orchestration_events(kind:"error")`.
4. `questions[]` không rỗng → tạo `agent_requests` type `question` và pause (autonomy ≠ `auto`).

---

## 7. Orchestrator (`packages/core/src/orchestrator.ts`)

Hàm thuần: `stepOrchestration(store, orchestrationId, deps) → OrchestrationStepResult`. Không tự chạy vòng lặp vô hạn — mỗi lần gọi tiến **một** bước; CLI/UI/watcher gọi lặp. Điều này giữ orchestrator test được và tránh daemon treo.

| Status vào | Điều kiện | Hành động | Status ra |
|---|---|---|---|
| `planning` | — | Spawn leader run (phase `plan`), parse PLAN, ghi `plan_path`, tạo subtasks + agents + workforce members + reviewer spec | `executing` |
| `executing` | có subtask `todo` và slot trống | Tạo assignment + spawn implementer run (tôn trọng `dependsOn`, `max_parallel`) | `executing` |
| `executing` | tất cả run implementer của một reviewer scope đã kết thúc | Spawn reviewer run cho scope đó | `reviewing` |
| `reviewing` | reviewer run kết thúc → parse verdict → `reviews` | — | `adjudicating` |
| `adjudicating` | có review chưa consumed | Spawn leader turn ADJUDICATE | `executing` (nếu có rework) / `reporting` (nếu `projectComplete`) |
| `reporting` | — | Spawn reporter run → `.agent-memory/reports/<taskId>.md` | `done` |
| bất kỳ | `cycle > max_cycles` | Ghi error + tạo request cho user | `paused` |

**Autonomy gate:**
- `manual` — mỗi bước chỉ tạo assignment + approval request, không spawn.
- `approve-each` (mặc định) — spawn cần approve request; leader turn và reviewer turn tự chạy.
- `auto` — tự spawn hết, chỉ dừng khi có `questions` hoặc `verdict: block`.

Mọi transition ghi một `orchestration_events` row → đây chính là feed cho UI.

**Vòng lặp tự động:** `agent-bridge workforce watch --task <id> --interval 5000` gọi `stepOrchestration` định kỳ + reap run đã kết thúc. Cùng cơ chế với `commands/watch.ts` hiện có.

---

## 8. Runtime agent manager

### 8.1 `process-runner.ts` — thay `execFileSync`

```ts
spawnAgentRun(store, { assignment, agent, preview, runRow }): AgentRun
```

- `child_process.spawn(exe, args, { cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe","pipe","pipe"] })`
- stdin ← prompt artifact, stdout/stderr → stream vào `.agent-memory/artifacts/runs/<runId>/output.log` (qua `redactIfEnabled` theo chunk).
- Ghi `pid`, `started_at`, `status: running` ngay; `on("exit")` cập nhật `exit_code`, `ended_at`, `status: done|failed` + gọi `recordAssignmentOutcome` như hiện tại.
- `heartbeat_at` = mtime của log file, cập nhật khi có chunk mới.

**Chú ý:** process sống độc lập với tiến trình CLI đang gọi. Vì vậy khi CLI thoát, cần một **reaper**: `reapAgentRuns(store)` chạy đầu mỗi `stepOrchestration` — với mỗi run `running` kiểm tra PID còn sống (`process.kill(pid, 0)`), nếu chết mà chưa có `ended_at` → đọc log, kết luận `done`/`failed`. Đây là nguồn sự thật thay cho việc giữ handle trong bộ nhớ.

### 8.2 Stop / xoá subtask

`stopAgentRun(store, runId, { reason, cancelSubtask })`:
- win32: `taskkill /PID <pid> /T /F`; posix: `process.kill(-pid, "SIGTERM")` → sau 5s `SIGKILL`.
- `status: stopped`, ghi `orchestration_events(kind:"user_action")`.
- assignment → `cancelled`; nếu `cancelSubtask` thì subtask → `cancelled` và loại khỏi kế hoạch của leader (thông báo ở leader turn kế tiếp).

### 8.3 Đổi model của agent đang chạy

CLI/API không hỗ trợ đổi model giữa chừng → **stop-and-respawn có kế thừa ngữ cảnh**:

1. `stopAgentRun` (giữ log).
2. Sinh resume artifact `.agent-memory/artifacts/runs/<runId>/resume.md`: assignment gốc + acceptance criteria + `compressLog(tail của output.log)` (dùng `packages/core/src/log-compressor.ts` sẵn có) + "phần đã làm / phần còn lại".
3. `updateRegisteredAgent` hoặc tạo agent variant mới với `model`/`reasoningEffort` mới (không sửa agent gốc nếu agent đó đang được run khác dùng).
4. Spawn run mới với `restarted_from_run_id = <runId cũ>`, prompt = resume artifact.
5. Assignment giữ nguyên id → lịch sử liền mạch; run mới nối vào chuỗi trên UI.

### 8.4 Adopt agent ngoài team

Agent do user tự mở trong cùng root project (Claude Code / Codex có hook `agent-bridge` đã cài) sẽ ghi `session_events` với `sessionId` + `agent`.

- `listAdoptableSessions(store)` = session có event trong N phút gần đây, không có `agent_runs.session_id` trỏ tới.
- `adoptAgentRun(store, { sessionId | pid, roleId, subtaskId?, workforceId, agentId? })`:
  - tạo `agent_runs` với `origin: "adopted"`, `status: "detached"` (không kill được nếu chỉ có sessionId; có PID thì kill được).
  - tạo/nhận `RegisteredAgent` mode `manual` nếu chưa có, thêm `workforce_members`.
  - tạo assignment gắn subtask (hoặc subtask mới "External work: …").
  - từ đó agent này xuất hiện trên board, tiến độ đọc từ `session_events` (`assistant_summary`) thay vì log file, và leader nhìn thấy nó trong turn kế tiếp.
- Có thể "release" trở lại: `run release <runId>` → gỡ khỏi team, giữ lịch sử.

### 8.5 Progress reporting

Hai nguồn, ưu tiên nguồn 1:
1. Agent tự báo: prompt artifact chèn dòng hướng dẫn `agent-bridge run progress --run <id> --percent <n> --note "<text>"` sau mỗi mốc. (Chèn vào `renderInvocationPrompt` + biến môi trường `AGENT_BRIDGE_RUN_ID` khi spawn.)
2. Suy ra: `heartbeat_at` + dòng log cuối + số acceptance criteria đã tick.

---

## 9. CLI surface

```powershell
# Catalog
agent-bridge agent catalog --provider codex
agent-bridge agent probe codex

# Khởi động project
agent-bridge workforce start "Xây dựng module báo cáo" `
  --leader-provider codex --leader-mode cli --leader-model gpt-5.6 --leader-reasoning high `
  --autonomy approve-each --max-parallel 3

# Điều khiển vòng lặp
agent-bridge workforce step   --task <id>
agent-bridge workforce watch  --task <id> --interval 5000
agent-bridge workforce status --task <id>
agent-bridge workforce pause | resume | stop --task <id>

# Quản lý run
agent-bridge run list --task <id>
agent-bridge run log <runId> --tail 200
agent-bridge run stop <runId> [--cancel-subtask]
agent-bridge run set-model <runId> --model opus --reasoning high
agent-bridge run reassign <runId> --agent <agentId>
agent-bridge run adopt --session <sessionId> --role implementer [--subtask <id>]
agent-bridge run release <runId>
agent-bridge run progress --run <runId> --percent 60 --note "schema xong, đang viết test"

# Subtask nóng
agent-bridge subtask add-and-spawn --task <id> --title "..." --role implementer `
  --provider claude --model opus --reasoning high

# Báo cáo
agent-bridge report generate --task <id> [--reporter <agentId>]
```

Lệnh workforce cũ (`create/add/list/show/update/delete`) giữ nguyên cho phần thiết lập agent/team thủ công.

---

## 10. UI

### 10.1 Endpoint mới (`packages/cli/src/commands/ui.ts`)

```
GET  /api/workforce/catalog                    → provider catalog (models + reasoning)
GET  /api/workforce/board?task=<id>            → orchestration + runs + subtasks + reviews + events
GET  /api/workforce/run/log?run=<id>&tail=200  → log tail đã redact
GET  /api/workforce/adoptable                  → session ngoài team có thể adopt

POST /api/workforce/start                      {prompt, leader:{provider,mode,model,reasoningEffort}, autonomy, maxParallel, workforceName}
POST /api/workforce/step                       {taskId}
POST /api/workforce/pause | /resume | /stop    {taskId}
POST /api/workforce/subtask/add-and-spawn      {taskId,title,goal,role,agentPreference,criteria}
POST /api/workforce/run/stop                   {runId,cancelSubtask}
POST /api/workforce/run/set-model              {runId,model,reasoningEffort}
POST /api/workforce/run/reassign               {runId,agentId}
POST /api/workforce/run/adopt                  {sessionId|pid,roleId,subtaskId}
POST /api/workforce/run/release                {runId}
POST /api/workforce/report                     {taskId}
```

### 10.2 View `Team Board` (`packages/cli/src/ui-page.ts`)

Thay thế nội dung `#view-workforce` hiện tại; các form setup cũ gom vào tab con **Setup**.

```
┌─ Start ────────────────────────────────────────────────────────────┐
│ Request: [                                                      ]  │
│ Leader:  [Codex CLI ▾] [gpt-5.6 ▾] [high ▾]   ← model/reasoning    │
│          phụ thuộc provider, lấy từ /api/workforce/catalog         │
│ Autonomy: (○) Manual  (●) Approve each  (○) Auto   Parallel: [3]   │
│                                            [ Start Project ]        │
└────────────────────────────────────────────────────────────────────┘

┌─ Orchestration ─────────────────────────────────────────────────────┐
│ Task · phase: executing · cycle 2/8 · complexity: medium            │
│ [Plan.md] [Report.md]        [Step] [Pause] [Stop All] [+ Subtask]  │
└─────────────────────────────────────────────────────────────────────┘

LEADER          IMPLEMENTERS                      REVIEWERS       REPORTER
┌──────────┐    ┌───────────────────────────┐    ┌──────────┐
│ codex    │    │ codex · gpt-5.6 · high    │    │ claude   │
│ gpt-5.6  │    │ s1 Add agent_runs schema  │    │ opus     │
│ ● idle   │    │ ●running ▓▓▓▓▓░░░ 62%     │    │ ●running │
│          │    │ 4m12s · "writing tests"   │    │ scope s1,s2
│          │    │ [Stop][Model▾][Log][→]    │    │ [Stop][Log]
└──────────┘    ├───────────────────────────┤    └──────────┘
                │ gemini · 2.5-pro (adopted)│
                │ …                          │
                └───────────────────────────┘

┌─ Subtasks (DAG) ──────────┐ ┌─ Reviews ──────────┐ ┌─ Approvals ────┐
│ s1 ✔ → s2 ▶ → s3 ○        │ │ s1 pass 88         │ │ spawn s3 [✓][✗]│
│ s4 ⟳ rework (cycle 2)     │ │ s2 rework: thiếu…  │ │                │
└───────────────────────────┘ └────────────────────┘ └────────────────┘

┌─ Activity ────────────────────────────────────────────────────────┐
│ 14:02 leader_turn  plan → 5 subtasks, 2 reviewers                 │
│ 14:03 spawn        codex s1                                        │
│ 14:11 verdict      s1 pass (88)                                    │
└────────────────────────────────────────────────────────────────────┘
```

Chi tiết:
- **Run card** hiển thị: agent name, badge provider, model + reasoning, role, subtask, status pill có màu, progress bar, elapsed, dòng log cuối, origin badge (`spawned` / `adopted`).
- **[Model▾]** mở modal chọn model + reasoning theo catalog của provider agent đó → gọi `run/set-model`, cảnh báo rõ "agent sẽ được khởi động lại kèm ngữ cảnh đã tóm tắt".
- **[Log]** mở modal tail log, auto-refresh.
- **Adopt**: panel "External agents" liệt kê session ngoài team + nút `Adopt into team` (chọn role + subtask).
- Poll `/api/workforce/board` mỗi 3s (theo cơ chế refresh hiện có); log modal poll 2s.

> Sau khi sửa `ui-page.ts` / `ui.ts`, **bắt buộc** chạy `.\node_modules\.bin\tsc.CMD -p packages/cli/tsconfig.json` trước khi start `agent-bridge ui` — UI có freshness check, source mới hơn dist sẽ bị từ chối.

---

## 11. Reporter

Role mới `reporter`. Phase `reporting` spawn một run với prompt gồm:
- plan gốc (`plan_path`),
- toàn bộ subtask + status + acceptance criteria,
- toàn bộ `reviews` (verdict, score, findings),
- `task_changes` / files changed,
- các handoff và decision của task,
- vòng rework đã xảy ra.

Output: `.agent-memory/reports/<taskId>-report.md`, cấu trúc cố định:

```md
# <Task title> — Project Report
## Tóm tắt điều hành
## Phạm vi & kế hoạch ban đầu
## Đội thực hiện (agent, model, role, đóng góp)
## Kết quả theo subtask
## Tổng hợp review (findings, verdict, điểm số)
## Thay đổi file
## Rework & lý do
## Rủi ro còn lại và việc cần làm tiếp
## Phụ lục: timeline
```

Orchestrator xác thực file tồn tại và không rỗng; nếu reporter fail → fallback render deterministic từ DB (không cần LLM) để user luôn có báo cáo.

---

## 12. Roadmap

| Phase | Nội dung | Files chính | Test |
|---|---|---|---|
| **W0** | Schema + types + store methods (migration 16–18), role `reporter`, provider `gemini` | `memory/src/{types,schema,migrations,memory-store,sqlite-store}.ts` | migration applies, CRUD roundtrip, `agent_runs` index |
| **W1** | Catalog + gemini adapter + `agent catalog/probe` | `adapters/src/{catalog,gemini,invocation}.ts`, `cli/commands/agent.ts` | preview args cho 3 CLI, catalog merge cache |
| **W2** | `process-runner.ts`: spawn non-blocking, log stream + redact, reaper, `run list/log` | `adapters/src/process-runner.ts`, `cli/commands/{run,request}.ts` | spawn ghi pid+log, exit cập nhật status, reaper phát hiện process chết |
| **W3** | `run stop / set-model / reassign / progress` | `cli/commands/run.ts` | kill tree win32+posix (mock), set-model tạo run mới có `restarted_from_run_id` + resume artifact |
| **W4** | Leader contract + prompts + agent-selector | `core/src/{leader-contract,leader-prompts,agent-selector}.ts` | parse JSON hợp lệ/không hợp lệ, retry, fallback tạo question; selector map preference → agent (tái dùng agent trùng cấu hình) |
| **W5** | Orchestrator state machine + `workforce start/step/watch/pause/resume/stop` | `core/src/orchestrator.ts`, `cli/commands/workforce.ts` | mỗi transition (bảng ở §7) test riêng với leader giả lập; `max_cycles` guard; autonomy gate không spawn khi `manual` |
| **W6** | Review loop: parse verdict reviewer → `reviews` → adjudicate → rework subtask | `core/src/orchestrator.ts`, `leader-contract.ts` | verdict rework sinh đúng subtask mới + assignment; verdict block pause orchestration |
| **W7** | Adopt agent ngoài team | `cli/commands/run.ts`, store `listAdoptableSessions` | session ngoài team hiện ra; adopt tạo run/member/assignment; release gỡ đúng |
| **W8** | UI Team Board + tất cả endpoint §10 | `cli/commands/ui.ts`, `cli/src/ui-page.ts`, `ui.test.ts` | API board trả đủ state; render chứa run card; start/stop/set-model/adopt gọi được từ UI; `tsc` pass |
| **W9** | Reporter + fallback deterministic | `cli/commands/report.ts`, `core/src/report.ts` | report file sinh ra, fallback khi reporter fail |

Thứ tự bắt buộc: W0 → W2 → W3 (runtime là nền của mọi thứ) trước khi làm W4–W6. W1 làm song song được. W8 sau W5.

---

## 13. Breaking changes & migration

- `dispatch.ts` giữ nguyên nhưng đổi vai trò thành **fallback deterministic** (khi user không muốn dùng leader LLM). `preferredRoleName()` regex không còn là đường chính.
- `request.ts:executeSpawnRequest` đổi từ đồng bộ sang bất đồng bộ có PID → **thay đổi hành vi**: lệnh trả về ngay với `runId` thay vì chờ xong. `--wait` giữ hành vi cũ cho script.
- `/api/workforce/team-task` cũ giữ lại (manual flow) nhưng UI mặc định dùng `/api/workforce/start`.
- DB cũ tự migrate; không mất dữ liệu (chỉ thêm bảng/cột).

---

## 14. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Leader trả JSON sai định dạng → kẹt vòng lặp | Retry 1 lần + fallback question + `max_cycles` guard |
| Nhiều implementer sửa cùng file → conflict | Bắt buộc `file_leases` (đã có) trước khi spawn song song; leader phải khai `files[]`, orchestrator không spawn song song 2 subtask giao file |
| Zombie process khi CLI thoát | Reaper theo PID + `heartbeat_at`; `run list` hiển thị stale |
| Kill process tree khác nhau win32/posix | Tách `process-runner` với test riêng cho từng nền tảng |
| Log agent chứa secret | Stream qua `redactIfEnabled` **trước** khi ghi file, không sau |
| Chi phí token của leader loop | Leader turn chỉ nhận summary + verdict, không nhận full log (`compressLog`); cap `max_cycles` |
| Catalog model lỗi thời | `agent probe` + cho phép nhập tay model không có trong danh sách |
| Đổi model giữa chừng làm mất ngữ cảnh | Resume artifact bắt buộc; assignment id giữ nguyên; UI cảnh báo trước khi restart |

---

## 15. Câu hỏi cần chốt

1. **Autonomy mặc định** — `approve-each` (mỗi spawn cần bấm duyệt) hay `auto` (chạy thẳng, chỉ dừng khi có câu hỏi)?
2. **Song song thật** — implementer chạy song song có cần mỗi agent một git worktree riêng (`task_lanes` mode `worktree`) không, hay chấp nhận cùng working tree + file lease?
3. **Gemini CLI** — máy đã cài `gemini` chưa? Cần xác nhận cờ non-interactive thực tế trước khi code adapter.
