# Agent Bridge

Agent Bridge is a local-first memory, context, and orchestration layer for coding agents. It lets Claude Code, Codex, Antigravity (`agy`), and other providers work on the same project without repeatedly loading the full conversation or losing task state during handoffs.

The tool runs locally, stores project state in `.agent-memory/`, and exposes both a CLI and an interactive terminal dashboard (TUI).

## What it provides

- Persistent tasks, subtasks, assignments, decisions, memories, handoffs, reviews, and run history.
- Token-budgeted context compilation per agent, with prompt packs and a cacheable prompt prefix.
- Token-saving instrumentation: compiled-context trends, baseline savings, and provider cache reports.
- Claude Code, Codex, and Antigravity (`agy`) lifecycle hook integration.
- A repository knowledge graph with concise per-file briefs and watcher-driven automatic updates (`agent-bridge watch`).
- Registered agents with provider, model, reasoning level, and capabilities, plus a curated default-agent preset list and live model discovery from installed provider CLIs.
- Leader-driven orchestration with plan, implement, review, adjudication, and reporting phases.
- Durable, per-orchestration context documents that preserve plans, findings, reviews, and rework history between agent turns.
- Per-task file leases so parallel agents do not edit the same file.
- Repository and global skill management, including installing complete skills from GitHub.
- A terminal dashboard (Work Board, Orchestrator, Knowledge, Context, Graph, Handoff, Skills, Tools).
- UTF-8-safe input paths and secret redaction before logs or memories are stored.

## Requirements

- Node.js 20 or newer.
- For mouse input in the Windows TUI, use Node.js 22.18 or newer and a terminal with mouse reporting, such as Windows Terminal.
- Corepack, included with supported Node.js installations.
- Windows PowerShell for the provided installation scripts.
- At least one provider CLI if you want Agent Bridge to spawn agents, such as `codex`, `claude`, or `agy`.

API-mode and manual agents can also be registered without a local provider CLI.

## Install from source

For a new Windows machine, or when moving the repository to a different path, use the clean installer:

```powershell
git clone https://github.com/teeho88/agent-bridge.git
cd agent-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-clean.ps1
```

The clean installer removes stale global `agent-bridge` npm shims, clears local dependency/build output, installs from the lockfile, rebuilds all packages, creates portable wrappers under `bin`, and places that directory first in your User `PATH`.

Open a new terminal, then verify that Windows resolves the command from this repository:

```powershell
where.exe agent-bridge
agent-bridge --help
```

You can also call the generated wrapper directly:

```powershell
& "\path\to\agent-bridge\bin\agent-bridge.ps1" --help
```

## Git self-update and releases

Git source installations can check and apply stable Agent Bridge releases without replacing the existing `agent-bridge upgrade` migration command:

```powershell
agent-bridge update --check
agent-bridge update --check --json
agent-bridge update --apply
```

Self-update uses the Agent Bridge installation checkout, not the project currently open in Work Board. Only stable tags in the form `vMAJOR.MINOR.PATCH` are considered releases. Prerelease and malformed tags are ignored, and the tagged root `package.json` version must match the tag. Apply is blocked when the installation checkout is dirty, detached, diverged from its tracked release branch, cannot fast-forward, another update is already running, or an active orchestration/agent run makes restart unsafe. An unreachable Git remote is reported as offline without moving the checkout.

The detached update worker targets the exact release commit selected by the check, installs from the frozen lockfile, rebuilds the monorepo, verifies `agent-bridge --version`, and leaves the terminal dashboard open. Reopen `agent-bridge tui` after the update completes to load the new version. If install, build, or smoke verification fails after the fast-forward, it resets to the exact previous commit and rebuilds that version. Progress and logs live under the installation `.agent-memory/update/`; worker logs use `.agent-memory/update/update-<id>.log`.

Use **Tools → Check for updates** in the TUI to check for releases. The dashboard refreshes local state every two seconds; this refresh does not check Git or contact the updater.

The root `package.json` is the canonical application version. Maintainers can validate a release or prepare a synchronized version change with:

```powershell
corepack pnpm release:check
corepack pnpm release:version -- patch
corepack pnpm release:version -- minor
corepack pnpm release:version -- major
corepack pnpm release:version -- 1.2.3
```

`release:version` updates the synchronized package versions and runs release checks; it never creates a Git tag or pushes. After reviewing and committing the version change, the maintainer creates and pushes the stable release tag manually.

## Quick start

Run these commands inside the project that the agents will work on:

```powershell
cd "\path\to\your-project"
agent-bridge
```

Running `agent-bridge` opens the dashboard directly in the current terminal. If the repository has no Agent Bridge configuration or database, it automatically runs the same initialization as `agent-bridge init`, including managed instructions and Claude/Antigravity hooks. Existing workspace settings and data are preserved on subsequent launches. `agent-bridge tui` and `agent-bridge ui` remain available. Use `--project <path>` to manage another project, or `--snapshot` to print all nine screens once in scripts and non-interactive sessions. No browser or listening port is required.

Use **1–9**, **Tab**, or **Left/Right** to switch screens; **Up/Down** to select; **Enter** to inspect; **a** to open actions; **s** to select a task; **/** to filter; **?** for help; and **q** or **Ctrl+C** to exit. Detail views and action reviews support **PageUp/PageDown**.

The dashboard also supports the mouse: click navigation tabs and toolbar buttons, click a record to preview it, double-click to open details, and click an action to open its form. The mouse wheel scrolls the panel under the pointer, and the scrollbars are clickable. In forms, click a field, choose an option, or click inside the text editor to position the cursor. **Review** opens the action summary; **Run action** executes it. Hold **Shift** to use the terminal's text selection. Mouse reporting is disabled when the dashboard exits. Wide terminals show an inspector next to the list; narrow terminals keep all nine navigation tabs visible. Set `NO_COLOR` to use the same layout without colors.

Forms support **Tab/Shift+Tab** between fields, **Up/Down** for choices, **Ctrl+J** for multiline text, **Ctrl+U** to clear, and **Ctrl+S** to review. Press **Enter** on the review to execute, or **Esc** to return to editing. Empty optional fields are omitted. Selecting a task scopes task memories, compiled context and handoff; forms keep their contents during automatic refresh.

Work Board has a **New task** button. Click it, then choose **Codex**, **AGY** or **Claude** to create a fresh task and open its agent CLI in a separate terminal, even when another task is selected. Use **Up/Down** or **Tab** and **Enter** to choose with the keyboard; **Esc** or **Cancel** closes the picker. The launcher requires Windows and the corresponding CLI on `PATH`. Use **Actions → Open agent terminal** to continue an existing task or set launch options.

Work Board puts active tasks and sessions first, then sorts each priority by most recent activity. Task activity includes session events and agent responses as well as task updates. Active rows are green with an **[ACTIVE]** marker, which remains visible without colors. A task is active while it has a live session; an unfinished task alone does not indicate a running terminal. Closing a tracked tab or window ends its session on refresh, and exiting an agent launched from Work Board closes its terminal shell. Tasks with active sessions remain visible even outside the recent-task window.

Each tracked Windows session is bound to a process ID and its creation time. Tabs sharing a window remain independent, and a reused process ID cannot revive a closed session. Idle agents stay active while their process lives. Native hooks capture the agent process; the Work Board launcher verifies its tab's shell process before starting the agent. Window handles are used for focus, not session liveness. Sessions whose process cannot be verified show **[UNVERIFIED]** and do not highlight their tasks as active; they are not ended just because they were idle for 15 minutes. Reopen legacy terminals to establish a verified binding.

Each screen has sections; click their tabs or use **[ / ]** to switch. **All** retains the complete list of records and actions. Orchestrator opens an overview of the selected run with separate clusters for Tasks, Runs, Team, Presets, Questions, Approvals, Plan, Reviews, Activity, External sessions and Settings. Select an orchestration under **Tasks** and press **Use run**; actions then use the selected task, agent, request or run automatically.

Graph loads the repository index when opened. Its three tabs are **Network**, **Repo map** and **Settings**. **Network** opens a terminal diagram with dependents on the left, the selected file in a double border, and its imports on the right. Arrows point from the importing file to its dependency. Taller panels separate filenames from directories; **EDIT** marks files with recorded edits and **STALE** marks outdated briefs, including without colors. Reading a file never adds a recent-read marker. Click a file to recenter, use **Up/Down** to browse files, **Enter** for details, and **Links** buttons to page through neighbors. Narrow panels use a compact list with **←** for dependents, **→** for imports and **↔** for mutual imports.

Edit highlighting uses the last recorded edit time: **EDIT ≤10m** is bright green, **EDIT ≤3h** is green, **EDIT ≤24h** is blue, and **EDIT >24h** is dim. Network and Nodes use the same levels, which update as time passes; text labels remain visible with `NO_COLOR`. A red **STALE** badge is separate from edit age, and the selected node retains its double border. File details show the last edit timestamp.

**Nodes** (or **n**) opens a ranked list with scores, file briefs and import/dependent details in the inspector. Click a row or highlight it and press **Enter** to select that file in Network. Use **/** to search the list and **Esc** to return without changing the selected node. Selection stays on the same file when automatic refresh changes its rank. The list includes up to 5,000 indexed files. **Repo map** contains the text map and index statistics. **Settings** edits repo-map injection, Watch Auto Brief, repo-map limit, include paths and ignore paths. Clearing either path field clears that filter. **Build**, **Nodes**, **Edit brief** and **Refresh briefs** are available as buttons; watcher start/stop and update actions are under **Tools → Tools**. The task selection button appears only where the highlighted record identifies a task; Orchestrator Tasks uses a single **Use run** button.

Graph file lists and Network neighbors are ordered by **structural score, highest first**: `10 × log₂(distinct dependent files + 1) + 2 × manualPriority`. Files without a manual priority use 0 for that term. Dependent counts use the repository index before search or display limits. Equal scores use **latest recorded Edit, newest first**, then the file path as a stable tie-breaker. Reads and manual brief refresh times do not affect this order. Ranking uses the full score; Network, Nodes and file details display two decimal places. This order also applies before the graph's file limit and neighbor pagination.

### Enable or disable Agent Bridge per repository

Open **Tools → Repository** and choose **Disable in this repo** or **Enable in this repo**, or use:

```powershell
agent-bridge repo status
agent-bridge repo disable
agent-bridge repo enable
agent-bridge repo disable --project "\path\to\repo"
```

The switch is stored in that repository's `.agent-memory/config.json`. Disabling unregisters the repository's Claude, Codex and Antigravity Bridge hooks, removes Bridge's managed instruction blocks without adding a disabled notice, stops the watcher and auto-run scheduling, and blocks Agent Bridge write actions. Hook handlers already cached by an agent return no context and skip bookkeeping. Existing tasks, graph, settings and memories remain available in the TUI. User-authored instructions and unrelated hooks are preserved. The suspended integrations are saved in `.agent-memory/disabled-integrations.json` and restored when enabled, including instruction customizations. Coding-agent processes already running are not terminated. Context already loaded in an existing conversation cannot be removed; start a new agent session after disabling to avoid retaining it. This repository switch is separate from disabling an MCP tool in the agent application's Tools menu. Autonomous orchestrations resume when enabled through the TUI or when the TUI next opens. Other repositories keep their own state.

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
agent-bridge handoff create --from codex `
  --summary "Session restoration is fixed" `
  --done "Patched cookie parsing" `
  --next "Run the integration suite" `
  --risks "Do not change payment authentication"
```

The compiler combines the current task, relevant memories, decisions, file briefs, repository map, constraints, the assigned subtask, and the latest handoff within a token budget. `--no-repo-map` and `--repo-map-limit <n>` control the injected repository map.

`compiled-context.md` is a single shared file, overwritten and stamped with the agent it was compiled for. Recompile for your own agent before relying on it.

### Knowledge graph and file briefs

Task context includes only Graph Navigation instructions, without automatically injecting the repo map or graph file briefs. Agents query `agent-bridge graph search <query> --limit 10`, `graph neighbors <path>` and `graph symbols <path>` when they need to locate files to read or edit, verify hints against source, and fall back to scoped `rg` searches if the index is missing or stale. Toggle **Graph → Settings → Enabled** (`graph.enabled` in `.agent-memory/config.json`, default `true`) to control agent graph navigation. Manual graph views and watcher settings remain available independently. Legacy `injectRepoMap` is ignored; `context compile --no-repo-map` and `--repo-map-limit` are deprecated and never inject graph data.

Automatic brief updates come exclusively from the file watcher. Opening the TUI starts the watcher automatically when **Graph → Settings → Watch Auto Brief** is enabled (the default) and Agent Bridge is enabled for the repository. **Tools → Tools → Actions → Stop watcher** pauses it for the current TUI session; automatic refresh does not restart it. Reopening the TUI starts it again. Turn off Watch Auto Brief to opt out of automatic startup. You can also use **Start watcher** manually or run `agent-bridge watch` in a separate terminal. Tool hooks do not refresh briefs. The watcher compares content hashes, so reads, unchanged saves and duplicate filesystem events do not create edit markers or change edit times. Closing the TUI stops its watcher; snapshot mode does not start one. The commands below remain available for an explicit manual refresh; agents do not need to run them after reading or editing files.

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

Agents are selected from the enabled roster by provider availability and required capabilities.

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

**Tools → CLI approval settings** shows one entry per provider. Select Codex to edit its Policy / Sandbox tabs, Antigravity for Policy / Mode, or Claude for Policy. Settings are saved in `.agent-memory/config.json` under `cliApprovalPolicies` and apply to subsequent spawned agents, including orchestration, reports, resumed runs and Work Board terminals.

For CLI sessions opened directly from Windows PowerShell, PowerShell 7 or CMD, run `agent-bridge permissions install-shell` once, then open a new terminal. The Windows installer also installs this integration. To add only CMD support to an existing installation, run `agent-bridge permissions install-cmd`. Calling `codex`, `claude` or `agy` reads the nearest repository's current permission settings, including from subdirectories; unrelated and disabled repositories keep their native behavior. Explicit CLI permission flags take precedence. The integration preserves pipeline input and command exit codes.

CMD integration adds managed `.cmd` launchers under `%LOCALAPPDATA%\AgentBridge\cmd` and appends their initialization script to the current user's Command Processor `AutoRun`, preserving existing startup commands. New CMD processes prepend that directory to their own PATH; the system and user PATH settings stay unchanged. Launchers forward to the provider's native Windows `.exe` or `.com` executable, which must be installed on PATH. Direct executable paths, `cmd /d`, PowerShell `-NoProfile` and other shells bypass their respective shell integration.

Saving permission settings also syncs the native Codex `.codex/config.toml`, preserving unrelated settings. Run `agent-bridge permissions sync` to sync settings already saved before upgrading. Native project settings depend on Codex trusting the repository; managed organization policies still apply. Claude's `auto` and `bypassPermissions` modes cannot be set through project settings, so external Claude sessions use the shell integration. Restart existing agent sessions after changing permissions. The AGY monitoring hook delegates tool decisions to AGY's native permission engine.

| Setting | Supported values and CLI mapping |
| --- | --- |
| Codex policy | `default` → `approval_policy="on-request"`, reviewer `user`; `auto-review` → `on-request`, reviewer `auto_review`; `never` → `approval_policy="never"`; `bypass` → `--dangerously-bypass-approvals-and-sandbox` |
| Codex sandbox (permissions) | `read-only`, `workspace-write` (Bridge default), `danger-full-access` → `--sandbox`; bypass disables the sandbox and takes precedence |
| Antigravity policy | `default` → no permission override; `bypass` → `--dangerously-skip-permissions` |
| Antigravity mode | `default` → use provider settings; `auto`, `accept-edits`, `plan` → `--mode`; independent of the bypass flag |
| Claude policy | `manual`, `auto`, `plan` → matching `--permission-mode`; `accept-edits` → `acceptEdits`; `dont-ask` → `dontAsk`; `bypass` → `--dangerously-skip-permissions` |

Existing Antigravity `accept-edits` and `plan` policy values remain supported. Opening the form moves them into the separate mode field; saving preserves the selected behavior. An explicit `antigravityMode` takes precedence over a legacy mode stored in `antigravity`. Existing Codex and Claude policies remain valid.

Checked against installed Codex **0.169.0**, agy **1.5.9** and Claude Code **2.1.302** using their CLI help, plus the official [Codex config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json), [Antigravity CLI reference](https://antigravity.google/docs/cli/reference/) and [Claude permissions reference](https://code.claude.com/docs/en/permissions). Antigravity spells the mode `accept-edits`; `accept-edit` is invalid. Its `auto` mode requires terminal sandbox support and an eligible account; provider availability checks still apply. Validation covers configuration, form migration and generated arguments; it does not run paid model turns.

### Run an orchestration

```powershell
agent-bridge orchestration start "Build a settings page with tests" `
  --leader-provider codex `
  --leader-mode cli `
  --leader-model gpt-5.6-sol `
  --autonomy approve-each `
  --max-parallel 3 `
  --max-cycles 8
```

Useful controls:

```powershell
agent-bridge orchestration status --task <taskId>
agent-bridge orchestration step --task <taskId>
agent-bridge orchestration watch --task <taskId>
agent-bridge orchestration autonomy --task <taskId> --mode auto
agent-bridge orchestration pause --task <taskId>
agent-bridge orchestration resume --task <taskId>
agent-bridge orchestration stop --task <taskId>

agent-bridge assignment list
agent-bridge assignment update <assignmentId> --status done --result "Merged"
```

The normal lifecycle is:

```text
plan -> implement -> review -> adjudicate -> re-plan or report
```

The enabled roster in the TUI's Orchestrator screen determines which agents the leader can staff. If the roster is empty, Agent Bridge can discover installed provider CLIs and register a suitable agent on first use. Routine adjudication can be handled by an eligible adjudicator; risky, conflicting, blocked, or project-completion decisions are escalated to the leader. The dashboard adds spawn approvals (including reassignment and a note for the authorised turn), leader questions, change requests, per-task lanes (patch or worktree), and live run logs.

Each orchestration keeps its narrative state under `.agent-memory/context/<orchestrationId>/`. Plans, assignment briefs, implementation reports, reviews, adjudications, summaries, and rework rounds are stored as Markdown and passed between agents by path. SQLite remains the source of truth for statuses, assignments, approvals, and run IDs. Spawned orchestration runs are isolated from the terminal agent's task, session, handoff, context, and memory lifecycle commands.

Generate a final report with:

```powershell
agent-bridge report generate
```

An eligible reporter must be enabled and have the `report` capability. If reporter execution fails, Agent Bridge can generate a deterministic fallback report.

### Skills

The TUI's Skills screen can create, import, list, and delete reusable agent skills. Repository skills are stored in `.agents/skills/`; global skills are stored in the user's `.agents/skills/` directory. A GitHub install brings the selected skill's `SKILL.md` together with its scripts, references, and assets.

GitHub code search requires a token visible to the Agent Bridge UI process. Set `GITHUB_TOKEN` or `GH_TOKEN` before starting the dashboard; the token is read from the environment and is not saved by the Skills UI.

### Token savings

```powershell
agent-bridge optimize report
agent-bridge optimize report --baseline
agent-bridge optimize baseline --record
agent-bridge optimize cache-report
agent-bridge optimize logs <path>
```

`optimize report` tracks compiled-context size over recorded runs, `optimize baseline` measures what the compiled context saves against loading the raw files, and `cache-report` summarises provider prompt-cache usage. `optimize logs <path> --max-lines 40 --max-chars 4000 --output <preview-file>` creates a short error-first preview from a previously saved full tool log. The preview reports omitted diagnostics, preserves the original file and gives PowerShell/`rg` commands to retrieve complete evidence. Search source with `rg --files` followed by scoped `rg -n 'symbol' <path>`; read only relevant ranges and direct dependencies, excluding generated and vendor directories.

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
  context/
  tasks/
  reports/
  artifacts/
  logs/
```

Cross-agent handoffs use portable project files instead of `.agent-memory`
artifacts:

```text
.handoff/
  CURRENT.md
  INDEX.md
  history/
```

In the full workflow, installed Claude, Codex, and Antigravity hooks refresh the
task's auto-handoff and `.handoff/CURRENT.md` on `Stop` when an assistant response
is available. Codex reads `last_assistant_message`; Antigravity reads its
transcript. Auto-handoffs preserve authored handoffs and do not create history
entries. Single-workflow sessions and spawned runs skip auto-handoffs. This does
not create a verified checkpoint or transfer task ownership.

It may also create managed agent files and hooks:

```text
AGENTS.md
CLAUDE.md
.agents/skills/
.claude/
.codex/
```

These files are project-local runtime/integration state and should normally remain untracked. Agent Bridge preserves user-authored content outside its managed sections.

## Development

```powershell
corepack pnpm install
corepack pnpm -r build
corepack pnpm --filter @agent-bridge/cli test
npm run lint
```

Run the CLI from source:

```powershell
npm run dev -- --help
```

The terminal dashboard source lives in `packages/cli/src/tui/` and uses Node.js terminal APIs without additional UI dependencies. Rebuild the CLI after changing source.

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
