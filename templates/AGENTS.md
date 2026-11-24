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

## Agent Startup Rules
Codex lifecycle hooks already create or restore the task and live session before the first model call. Do not run `agent-bridge task start`, `agent-bridge session start`, or `agent-bridge session end` during ordinary hooked Codex work; doing so can create a second live card for the same terminal.
Use Agent Bridge history only when the request needs it. Start with the prompt, retained conversation, and current source. Do not load compiled context automatically on session start, resume, or compaction.

For a clear repository reference that needs past work, run `agent-bridge context find "<term>" --limit 3`. Inspect only a relevant result with `agent-bridge context query "<term>" --task <id>`, `agent-bridge context expand <memory-id> --task <id>`, or `agent-bridge context handoff --task <id>`. If the repository reference is unclear, ask one focused question before searching history. If several results plausibly match, ask which one before opening details. A lookup does not switch the active task. Verify historical details against current source.

Do not start a new task just because the user sends a new prompt inside an active task/session; continue the current task unless the user explicitly asks to switch tasks.

## Work-Git Rules
- Before editing any source/config/test/doc file for task work, acquire a write lease:
  ```bash
  agent-bridge file lease "<repo-relative-path>" --mode write --agent codex
  ```
- Continue editing only when the lease response has `"acquired": true`; if it returns `false`, inspect `blockingLease`, coordinate through handoff/request, and do not edit that file.
- Keep the lease id from the response and release it after the edit is recorded:
  ```bash
  agent-bridge file release "<lease-id>"
  ```

## Graph Navigation
- Follow Graph Navigation in compiled context. Graph use is enabled by default; toggle `graph.enabled` in `.agent-memory/config.json` or Graph → Settings → Enabled.
- When enabled and you need to find files to read/edit, use `agent-bridge graph search <query> --limit 10`, then `agent-bridge graph neighbors <path>` or `agent-bridge graph symbols <path>` as needed. Verify hints against source and read relevant ranges only. Use scoped `rg` if disabled or the index is missing/stale. Do not load the global graph or all briefs.

## File Brief Rules
- Automatic file briefs are maintained exclusively by the watcher when source content changes on disk. Opening the TUI starts it by default when Watch Auto Brief is enabled. Tools → Tools provides manual Start/Stop controls.
- Reading a file does not refresh its brief or mark it as edited. Do not run brief commands after each Read/Edit/Write tool call.
- Use an explicit manual brief refresh only when the user requests it. Keep write leases for edits independently of brief updates.

## Completion Rules
Before finishing:
1. Summarize changed files.
2. Summarize tests run.
3. Save durable findings:
   ```bash
   agent-bridge memory add "<important fact or decision>" --type note --agent codex
   ```
4. Create or update handoff notes:
   ```bash
   agent-bridge handoff create --from codex --summary "<summary>" --next "<next action>"
   ```
5. Avoid including unnecessary full file contents.

<!-- agent-bridge:end -->

