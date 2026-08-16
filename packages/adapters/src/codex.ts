export function codexManagedSection(): string {
  return `<!-- agent-bridge:start -->

# Agent Bridge Context

## Token Rules
- Keep answers concise.
- Do not inspect unrelated files.
- Prefer minimal diffs.
- Do not paste long logs.
- Summarize test output.

## Current Task
See \`.agent-memory/current-task.md\`.

## Agent Startup Rules
At the start of work:
1. Read \`.agent-memory/current-task.md\`.
2. If it says "No current task", start one before editing or recording memory. A title is optional; agent-bridge seeds one after the first completed response:
   \`\`\`bash
   agent-bridge task start --agent codex
   \`\`\`
   Do not start a new task just because the user sends a new prompt inside an active task/session; continue the current task unless the user explicitly asks to switch tasks.
3. Then compile fresh context for this agent:
   \`\`\`bash
   agent-bridge context compile --agent codex
   \`\`\`
4. Read \`.agent-memory/compiled-context.md\` and continue only the current task.
5. Mark this work live in the shared dashboard:
   \`\`\`bash
   agent-bridge session start --agent codex
   \`\`\`
   After meaningful progress, save a short state with \`agent-bridge session summary "<state>" --agent codex\`; finish with \`agent-bridge session end --agent codex\`.

## Compiled Context
See \`.agent-memory/compiled-context.md\`. The agent-bridge hook recompiles it for
codex on every user prompt, so it is always current when you open it — but reading
it costs tokens, so do not re-read it every turn. Read it once at the start of
work, then again only when:
- the task changes, or the user asks you to continue work you did not do yourself;
- the user refers to another agent's work, a handoff, or an earlier decision;
- you are about to edit and no longer hold this task's constraints and handoff.
Within one task, keep working from what you already read.

## Handoff
The \`## Latest Handoff\` section of \`.agent-memory/compiled-context.md\` carries the
current handoff of the task you are on, whichever agent wrote it. When a prompt
continues work someone else started, re-read that section — it is the context to
work from. Rewrite it for the next agent with \`agent-bridge handoff create\` — one
handoff per task, so your packet replaces the previous one.

## Work-Git Rules
- Before editing any source/config/test/doc file for task work, acquire a write lease:
  \`\`\`bash
  agent-bridge file lease "<repo-relative-path>" --mode write --agent codex
  \`\`\`
- Continue editing only when the lease response has \`"acquired": true\`; if it returns \`false\`, inspect \`blockingLease\`, coordinate through handoff/request, and do not edit that file.
- Keep the lease id from the response and release it after the edit is recorded:
  \`\`\`bash
  agent-bridge file release "<lease-id>"
  \`\`\`
- \`agent-bridge graph brief-auto "<repo-relative-path>" --task-edited\` verifies an active write lease for the current task and fails if the file was edited without one.

## File Brief Rules
- After reading any source/config/test/doc file for task work, run:
  \`\`\`bash
  agent-bridge graph brief-auto "<repo-relative-path>"
  \`\`\`
- After editing any source/config/test/doc file, run:
  \`\`\`bash
  agent-bridge graph brief-auto "<repo-relative-path>" --task-edited --agent codex
  \`\`\`
  The first \`--task-edited\` brief moves the task from \`todo\` to \`in_progress\`.
  Always pass \`--agent codex\`; without it the lease check resolves the default agent's task and rejects your own lease.
- You may pass multiple paths to one \`brief-auto\` call. Skip generated/vendor files and files outside the current task.

## Completion Rules
Before finishing:
1. Summarize changed files.
2. Summarize tests run.
3. Save durable findings:
   \`\`\`bash
   agent-bridge memory add "<important fact or decision>" --type note --agent codex
   \`\`\`
   For non-ASCII text (e.g. Vietnamese) or multi-line content, pipe via stdin to avoid shell encoding loss:
   \`\`\`bash
   echo "<nội dung>" | agent-bridge memory add --stdin --type note --agent codex
   \`\`\`
4. Create or update handoff notes:
   \`\`\`bash
   agent-bridge handoff create --from codex --to claude --summary "<summary>" --next "<next action>"
   \`\`\`
   For non-ASCII summaries, pipe via stdin:
   \`\`\`bash
   echo "<tóm tắt>" | agent-bridge handoff create --stdin --from codex --to claude
   \`\`\`
5. Avoid including unnecessary full file contents.

<!-- agent-bridge:end -->`;
}

