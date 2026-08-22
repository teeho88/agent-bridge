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
At the start of work:
1. Read `.agent-memory/current-task.md`.
2. If it says "No current task", start one before editing. A title is optional; agent-bridge seeds one after the first completed response:
   ```bash
   agent-bridge task start --agent codex
   ```
   Do not start a new task just because the user sends a new prompt inside an active task/session; continue the current task unless the user explicitly asks to switch tasks.
3. Then compile fresh context for this agent:
   ```bash
   agent-bridge context compile --agent codex
   ```
4. Read `.agent-memory/compiled-context.md` and continue only the current task.

## Compiled Context
See `.agent-memory/compiled-context.md`.

## Handoff
Read `.handoff/CURRENT.md` when resuming the latest work. If the user names a
topic, use `.handoff/INDEX.md` to locate the matching archived checkpoint
without scanning all of `.handoff/history/`. Handoffs are task-scoped: any agent
that continues the task receives the same context.

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
- `agent-bridge graph brief-auto "<repo-relative-path>" --task-edited` verifies an active write lease for the current task and fails if the file was edited without one.

## File Brief Rules
- After reading any source/config/test/doc file for task work, run:
  ```bash
  agent-bridge graph brief-auto "<repo-relative-path>"
  ```
- After editing any source/config/test/doc file, run:
  ```bash
  agent-bridge graph brief-auto "<repo-relative-path>" --task-edited --agent <agent>
  ```
  The first `--task-edited` brief moves the task from `todo` to `in_progress`.
  Always pass the same `--agent <agent>` you used for the lease; without it the lease check resolves the default agent's task and rejects your own lease.
- You may pass multiple paths to one `brief-auto` call. Skip generated/vendor files and files outside the current task.

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

