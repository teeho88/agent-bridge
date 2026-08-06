# Agent Bridge

Agent Bridge is a local-first memory, context, and orchestration layer for coding agents. It lets Claude, Codex, Antigravity, and other providers work on the same project without repeatedly loading the full conversation or losing task state during handoffs.

The tool runs locally, stores project state in `.agent-memory/`, and exposes both a CLI and a local web dashboard.

## What it provides

- Persistent tasks, decisions, memories, handoffs, reviews, and run history.
- Token-budgeted context compilation for different coding agents.
- Claude Code hooks and Codex lifecycle integration.
- A repository knowledge graph and concise per-file briefs.
- Registered agents with provider, model, reasoning level, and capabilities.
- Leader-driven orchestration with implementation, review, adjudication, and reporting phases.
- A local dashboard for tasks, agents, runs, approvals, memory, and orchestration.
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
npm run build
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
agent-bridge context compile --agent claude --budget 4000
agent-bridge handoff create --from codex --to claude `
  --summary "Session restoration is fixed" `
  --done "Patched cookie parsing" `
  --next "Run the integration suite" `
  --risks "Do not change payment authentication"
```

The compiler combines the current task, relevant memories, decisions, file briefs, repository map, constraints, and the latest handoff within a token budget.

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
agent-bridge orchestration pause
agent-bridge orchestration resume
agent-bridge orchestration stop
```

The normal lifecycle is:

```text
plan -> implement -> review -> adjudicate -> re-plan or report
```

`Team Providers` is a hard allowlist for both the initial plan and change-request re-plans. Routine adjudication can be handled by an eligible adjudicator; risky, conflicting, blocked, or project-completion decisions are escalated to the leader.

Generate a final report with:

```powershell
agent-bridge report generate
```

An eligible reporter must have the `report` capability and belong to an allowed provider. If reporter execution fails, Agent Bridge can generate a deterministic fallback report.

### Claude Code integration

`agent-bridge init` installs local Claude Code hooks by default. To skip them:

```powershell
agent-bridge init --no-claude-hooks
```

Install or restore them later with:

```powershell
agent-bridge claude install-hooks
```

Restart Claude Code after installing hooks. Claude lifecycle events then update the current task, save compact memories, and refresh compiled context automatically.

### Repair text encoding

All stored text is UTF-8. If old data contains Windows mojibake, scan and repair it with:

```powershell
agent-bridge repair encoding --scan-only
agent-bridge repair encoding
```

Characters already replaced by `?` cannot be reconstructed, but reversible mojibake can be repaired.

## Command map

| Area          | Commands                                        |
| ------------- | ----------------------------------------------- |
| Workspace     | `init`, `ui`, `repair`, `watch`                 |
| Tasks         | `task`, `subtask`, `session`                    |
| Knowledge     | `memory`, `context`, `graph`, `optimize`        |
| Collaboration | `handoff`, `request`, `file`                    |
| Agents        | `agent`, `run`, `claude`, `codex`, `credential` |
| Orchestration | `orchestration`, `report`                       |

Use `agent-bridge <command> --help` for complete options.

## Local project data

Initialization creates local runtime state such as:

```text
.agent-memory/
  memories.db
  current-task.md
  compiled-context.md
  handoff.md
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
npm run build
npm test
npm run lint
```

Run the CLI from source:

```powershell
npm run dev -- --help
```

The monorepo contains four packages:

- `@agent-bridge/memory`: SQLite storage, types, retrieval, lifecycle, embeddings, and repository graph.
- `@agent-bridge/core`: context compilation, orchestration, contracts, reports, security, and token optimization.
- `@agent-bridge/adapters`: provider catalogs, invocation builders, managed sections, and process execution.
- `@agent-bridge/cli`: CLI commands, workspace integration, and the local dashboard.

## Security notes

- Credential references are stored instead of raw API secrets.
- Common secrets are redacted before logs and memories are persisted.
- `.env`, databases, logs, runtime memory, local hooks, dependencies, and build output are ignored by the repository.
- Review spawned-agent commands and approval requests before allowing external side effects.

## License

No license has been declared yet.
