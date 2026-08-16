# Agent Bridge

Agent Bridge is a local-first memory, context, and orchestration layer for coding agents. It lets Claude Code, Codex, Antigravity (`agy`), and other providers work on the same project without repeatedly loading the full conversation or losing task state during handoffs.

The tool runs locally, stores project state in `.agent-memory/`, and exposes both a CLI and a local web dashboard.

## What it provides

- Persistent tasks, subtasks, assignments, decisions, memories, handoffs, reviews, and run history.
- Token-budgeted context compilation per agent, with prompt packs and a cacheable prompt prefix.
- Token-saving instrumentation: compiled-context trends, baseline savings, and provider cache reports.
- Claude Code, Codex, and Antigravity (`agy`) lifecycle hook integration.
- A repository knowledge graph with concise per-file briefs and automatic brief refresh (`graph brief-auto`).
- Registered agents with provider, model, reasoning level, and capabilities, plus a curated default-agent preset list and live model discovery from installed provider CLIs.
- Leader-driven orchestration with plan, implement, review, adjudication, and reporting phases.
- Per-task file leases so parallel agents do not edit the same file.
- A local dashboard (Work Board, Orchestrator, Task, Knowledge, Context, Graph, Handoff, Tools).
- UTF-8-safe input paths and secret redaction before logs or memories are stored.

## Requirements

- Node.js 20 or newer.
- Corepack, included with supported Node.js installations.
- Windows PowerShell for the provided installation scripts.
- At least one provider CLI if you want Agent Bridge to spawn agents, such as `codex`, `claude`, or `agy`.

API-mode and manual agents can also be registered without a local provider CLI.

## Install from source

```powershell
git clone https://github.com/teeho88/agent-bridge.git
cd agent-bridge
corepack pnpm install
corepack pnpm -r build
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -AddToUserPath
```

Open a new terminal after adding the wrapper to `PATH`, then verify the installation:

```powershell
agent-bridge --help
```

Without changing `PATH`, call the generated wrapper directly:

```powershell
& "\path\to\agent-bridge\bin\agent-bridge.ps1" --help
```

## Quick start

Run these commands inside the project that the agents will work on:

```powershell
cd "\path\to\your-project"
agent-bridge init
agent-bridge task start "Fix login persistence" --goal "Keep users signed in after refresh" --agent codex
agent-bridge memory add "The session cookie exists, but restoration fails" --type bug --tags auth,session --importance 5
agent-bridge context compile --agent codex
agent-bridge ui
```

Open the URL printed by the UI command. The default is:

```text
http://127.0.0.1:4783
```

If that port is busy, Agent Bridge automatically tries the next available port. Use `agent-bridge ui --port <port>` to require a specific one or `agent-bridge ui --project <path>` to manage another project.

## Main workflows

### Tasks and shared memory

```powershell
agent-bridge task current
agent-bridge task update --help
agent-bridge memory list
agent-bridge memory search "session cookie"
agent-bridge memory add "Do not modify the payment auth flow" --type constraint --importance 5
```

Memories are task-scoped by default. Agent Bridge can deduplicate, consolidate, prune, export, and optionally embed them for semantic retrieval.

For Vietnamese, other non-ASCII text, or multi-line input, prefer `--stdin`:

```powershell
"Đã sửa phần khôi phục phiên đăng nhập" | agent-bridge memory add --stdin --type note --agent codex
```

### Context compilation and handoff

```powershell
agent-bridge context compile --agent codex --budget 4000
agent-bridge context compile --agent claude --budget 4000 --precise
agent-bridge context compile --agent codex --assignment <assignmentId>
agent-bridge handoff create --from codex --to claude `
  --summary "Session restoration is fixed" `
  --done "Patched cookie parsing" `
  --next "Run the integration suite" `
  --risks "Do not change payment authentication"
```

The compiler combines the current task, relevant memories, decisions, file briefs, repository map, constraints, the assigned subtask, and the latest handoff within a token budget. `--no-repo-map` and `--repo-map-limit <n>` control the injected repository map.

`compiled-context.md` is a single shared file, overwritten and stamped with the agent it was compiled for. Recompile for your own agent before relying on it.

### Knowledge graph and file briefs

```powershell
agent-bridge graph build
agent-bridge graph brief src/auth/session.ts
agent-bridge graph brief-auto src/auth/session.ts
agent-bridge graph brief-auto src/auth/session.ts --task-edited --agent claude
agent-bridge graph neighbors src/auth/session.ts
agent-bridge graph map
```

`brief-auto` refreshes the brief and records the file against the current task. With `--task-edited` it also enforces the file lease, so another task holding the file blocks the edit; always pass `--agent <agent>` together with `--task-edited`.

### File leases

```powershell
agent-bridge file lease "src/auth/session.ts" --mode write --agent claude
agent-bridge file leases --task <taskId>
agent-bridge file release <leaseId>
```

Leases are per task, default to a one-hour TTL, and are the coordination primitive for parallel agents. Continue only when the acquire response reports `"acquired": true`.

### Register agents

Agents are selected by provider availability, enabled state, Team Providers, and required capabilities.

```powershell
agent-bridge agent add codex-implementer `
  --provider codex `
  --mode cli `
  --command codex `
  --model gpt-5.6-sol `
  --reasoning high `
  --capabilities implement

agent-bridge agent add codex-reviewer `
  --provider codex `
  --mode cli `
  --command codex `
  --capabilities review,adjudicate,report

agent-bridge agent list
agent-bridge agent test codex-implementer
```

Common capability names are `implement`, `review`, `adjudicate`, and `report`. Implementer, reviewer, adjudicator, and reporter selection is capability-gated; a registered agent without the required capability is not eligible for that phase.

The dashboard also ships a curated set of default agent presets (Claude, Codex, and Antigravity models) that can be toggled on, customised, or restored, and it can refresh the model catalog by querying the installed provider CLIs.

### Run an orchestration

```powershell
agent-bridge orchestration start "Build a settings page with tests" `
  --leader-provider codex `
  --leader-mode cli `
  --leader-model gpt-5.6-sol `
  --autonomy approve-each `
  --team-providers codex,claude `
  --max-parallel 3 `
  --max-cycles 8
```

Useful controls:

```powershell
agent-bridge orchestration status
agent-bridge orchestration step
agent-bridge orchestration watch
agent-bridge orchestration autonomy auto
agent-bridge orchestration pause
agent-bridge orchestration resume
agent-bridge orchestration stop

agent-bridge assignment list
agent-bridge assignment update <assignmentId> --status done --result "Merged"
```

The normal lifecycle is:

```text
plan -> implement -> review -> adjudicate -> re-plan or report
```

`Team Providers` is a hard allowlist for both the initial plan and change-request re-plans. Routine adjudication can be handled by an eligible adjudicator; risky, conflicting, blocked, or project-completion decisions are escalated to the leader. The dashboard adds spawn approvals, leader questions, change requests, per-task lanes (patch or worktree), and live run logs.

Generate a final report with:

```powershell
agent-bridge report generate
```

An eligible reporter must have the `report` capability and belong to an allowed provider. If reporter execution fails, Agent Bridge can generate a deterministic fallback report.

### Token savings

```powershell
agent-bridge optimize report
agent-bridge optimize report --baseline
agent-bridge optimize baseline --record
agent-bridge optimize cache-report
agent-bridge optimize logs <path>
```

`optimize report` tracks compiled-context size over recorded runs, `optimize baseline` measures what the compiled context saves against loading the raw files, `cache-report` summarises provider prompt-cache usage, and `optimize logs` compresses a log file before it is fed to an agent.

### Agent CLI integrations

`agent-bridge init` installs local Claude Code and Antigravity (`agy`) hooks by default. To skip them:

```powershell
agent-bridge init --no-claude-hooks --no-antigravity-hooks
```

Install or restore them later with:

```powershell
agent-bridge claude install-hooks
agent-bridge antigravity install-hooks
agent-bridge codex install-hooks
```

Restart the agent CLI after installing hooks. Lifecycle events then update the current task, save compact memories, and refresh compiled context automatically.

Agents without native hooks can report lifecycle events manually:

```powershell
agent-bridge session start --agent codex
agent-bridge session summary --agent codex
agent-bridge session end --agent codex
```

`agent-bridge antigravity run -- <agy args>` launches `agy` interactively inside a tracked Work Board session.

### Repair text encoding

All stored text is UTF-8. If old data contains Windows mojibake, scan and repair it with:

```powershell
agent-bridge repair encoding --scan-only
agent-bridge repair encoding
```

Characters already replaced by `?` cannot be reconstructed, but reversible mojibake can be repaired.

## Command map

| Area          | Commands                                                        |
| ------------- | --------------------------------------------------------------- |
| Workspace     | `init`, `ui`, `repair`, `watch`                                   |
| Tasks         | `task`, `subtask`, `assignment`, `session`                        |
| Knowledge     | `memory`, `context`, `graph`, `optimize`                          |
| Collaboration | `handoff`, `request`, `file`, `git`                               |
| Agents        | `agent`, `run`, `claude`, `codex`, `antigravity`, `credential`    |
| Orchestration | `orchestration`, `report`                                         |

`git` is a placeholder for planned Git helpers. Use `agent-bridge <command> --help` for complete options.

## Local project data

Initialization creates local runtime state such as:

```text
.agent-memory/
  memories.db
  config.json
  catalog.json
  token-policy.yaml
  current-task.md
  compiled-context.md
  handoff.md
  handoff.json
  tasks/
  reports/
  artifacts/
  logs/
```

It may also create managed agent files and hooks:

```text
AGENTS.md
CLAUDE.md
.claude/
.codex/
```

These files are project-local runtime/integration state and should normally remain untracked. Agent Bridge preserves user-authored content outside its managed sections.

## Development

```powershell
corepack pnpm install
corepack pnpm -r build
npm test
npm run lint
```

Run the CLI from source:

```powershell
npm run dev -- --help
```

The dashboard is served from the built `dist/ui-page.js`, so rebuild after editing UI source.

The monorepo contains four packages:

- `@agent-bridge/memory`: SQLite storage, schema and migrations, types, retrieval, lifecycle, embeddings, leases, and repository graph.
- `@agent-bridge/core`: context compilation, prompt packs and prompt cache, orchestration, contracts, reports, security, and token optimization.
- `@agent-bridge/adapters`: provider catalogs, invocation builders, managed sections, and process execution.
- `@agent-bridge/cli`: CLI commands, workspace integration, provider/model discovery, default agent presets, and the local dashboard.

## Security notes

- Credential references are stored instead of raw API secrets.
- Common secrets are redacted before logs and memories are persisted.
- `.env`, databases, logs, runtime memory, local hooks, dependencies, and build output are ignored by the repository.
- Review spawned-agent commands and approval requests before allowing external side effects.

## License

No license has been declared yet.
