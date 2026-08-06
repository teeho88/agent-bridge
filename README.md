# agent-bridge

Local-first memory and handoff sidecar for coding agents.

## MVP Commands

```bash
pnpm install
pnpm build
pnpm --filter @agent-bridge/cli dev -- init
pnpm --filter @agent-bridge/cli dev -- task start "Fix login session persistence"
pnpm --filter @agent-bridge/cli dev -- memory add "Cookie exists but session is not restored" --type bug
pnpm --filter @agent-bridge/cli dev -- context compile --agent codex
pnpm --filter @agent-bridge/cli dev -- handoff create --from claude --to codex --summary "Ready for Codex"
```

The MVP stores all state in `.agent-memory/` and never overwrites user-authored `AGENTS.md` or `CLAUDE.md` outside the managed section.

## Windows Install

From this repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

To add the generated `bin\agent-bridge.cmd` wrapper to your user PATH:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -AddToUserPath
```

Open a new terminal after adding PATH, then use:

```powershell
agent-bridge --help
```

Without PATH setup, use the generated wrapper directly:

```powershell
& "\path\to\root\bin\agent-bridge.ps1" --help
```

## Local UI

Inside the project you want Claude or Codex to work on:

```powershell
agent-bridge init
agent-bridge ui
```

Open:

```txt
http://127.0.0.1:4783
```

If 4783 is already in use, the default UI command automatically tries the next port and prints the URL. Use `agent-bridge ui --port <port>` to require a specific port.

The UI can start tasks, add/search memories, compile context for Claude/Codex, and create handoffs. It auto-refreshes every 2 seconds, so updates written by Claude Code hooks appear without refreshing the browser.

## Claude Code Auto Sync

Claude Code does not expose its live task state to external tools unless you connect through Claude Code hooks. Install local hooks in the project Claude Code is working on:

```powershell
cd "\path\to\your-project"
agent-bridge init
```

`agent-bridge init` installs Claude Code hooks by default. To skip that:

```powershell
agent-bridge init --no-claude-hooks
```

If hooks were skipped or removed, install them separately:

```powershell
agent-bridge claude install-hooks
```

You can also open the UI and click `Install Claude Hook`.

Restart Claude Code in that project after installing hooks, or use `/hooks` inside Claude Code to verify the hooks.

After that:

- First Claude prompt creates a current task if none exists.
- Claude `TaskCreated` events create/update the current task.
- Claude `TaskCompleted` marks the task done.
- Claude `Stop`, `SessionEnd`, and `PostCompact` save compact memory and refresh `.agent-memory/compiled-context.md`.

The hook config is written to:

```txt
.claude/settings.local.json
.claude/hooks/agent-bridge-claude-hook.ps1
```

`settings.local.json` is local to your machine and should not be committed.

## Unicode / Encoding (Windows)

All text is stored as UTF-8. On Windows the console code page is often not UTF-8, which can corrupt non-ASCII text (e.g. Vietnamese) before it ever reaches the tool. agent-bridge handles this on every input path:

- **Claude Code hooks** read stdin as raw bytes (base64) instead of decoding through the console code page, so hook payloads stay intact.
- **CLI arguments** are safe at the Node layer (Windows passes the command line as Unicode via `GetCommandLineW`).
- **`--stdin` flag** lets agents pipe content as raw UTF-8 bytes, bypassing the shell entirely. Use it for non-ASCII or multi-line text:

```bash
echo "Sửa lỗi đăng nhập: phần được nạp chưa đúng" | agent-bridge memory add --stdin --type bug --agent codex
echo "Bàn giao: đã sửa phần mã hóa, kết nối ổn định" | agent-bridge handoff create --stdin --from codex --to claude
```

`--stdin` overrides the positional `<content>` (for `memory add`) and `--summary` (for `handoff create`).

If older data was already corrupted, scan and repair it:

```powershell
agent-bridge repair encoding --scan-only   # report suspected issues without changing anything
agent-bridge repair encoding               # repair mojibake in memories.db and .agent-memory files
```

> Note: characters already lost to `?` substitution cannot be fully recovered; only mojibake (e.g. `Ä‘Äƒng`) is repairable. After updating, re-run `agent-bridge claude install-hooks` in each project so the fixed hook script is regenerated.

## Optional Token Tools

These are not required for the MVP, but they are useful companion tools:

- `repomix`: packs repository context for agents.
- `ccusage`: inspects Claude Code token/cost usage.

Install their CLIs globally:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-token-tools.ps1 -InstallGlobal
```

Clone their source repositories for inspection/customization:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-token-tools.ps1 -CloneRepos
```

Do both:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-token-tools.ps1 -InstallGlobal -CloneRepos
```
