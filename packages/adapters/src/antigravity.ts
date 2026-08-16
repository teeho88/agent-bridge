import type { PromptPack } from "@agent-bridge/core";
import type { CreateRegisteredAgentInput } from "@agent-bridge/memory";

// Replaces the deprecated gemini CLI (whose geminiAgentDefaults this supersedes).
// The command is `agy`, not `antigravity`: the latter only launches the IDE,
// while `agy --print` is the headless agent that can be spawned and read back.
export function antigravityAgentDefaults(name = "antigravity"): CreateRegisteredAgentInput {
  return {
    name,
    provider: "antigravity",
    mode: "cli",
    command: "agy",
    model: "gemini-3.1-pro-high",
    capabilities: ["chat", "implement", "review"],
  };
}

// agy loads AGENTS.md too, and this repo's AGENTS.md is written for codex — it
// hardcodes `--agent codex` in every command. Following it verbatim is what
// made agy register as codex, which then broke every per-agent dashboard action
// (focus terminal, prompt, stop) because they all key off the session's agent.
// agy also loads `.agents/rules/*.md`, which codex never reads, so the override
// lives there and cannot leak back into a codex run.
export function antigravityRulesSection(): string {
  return `<!-- agent-bridge:start -->

# Agent Bridge Rules for Antigravity (agy)

## Your Agent Identity
You are the **\`antigravity\`** agent, not codex.

\`AGENTS.md\` in this repository is written for the codex CLI and spells out
\`--agent codex\` in its examples. Those examples do not apply to you: whenever a
command in \`AGENTS.md\` takes \`--agent codex\`, run it with \`--agent antigravity\`
instead. Registering as codex makes the dashboard attach your work to a codex
session, and every session action there (focus terminal, prompt, stop) then
targets the wrong agent.

## Session Lifecycle: Do Not Start It Yourself
agent-bridge hooks (\`.agents/hooks.json\`) already open the task and the live
session for this conversation before your first model call, and record your
reply when the turn ends. Therefore:
- Do **not** run \`agent-bridge task start\`.
- Do **not** run \`agent-bridge session start\` or \`agent-bridge session end\`.
Running them creates a second task and a second live session for work that is
already on the board.

## Token Rules
- Keep answers concise.
- Do not inspect unrelated files.
- Prefer minimal diffs.
- Do not paste long logs.
- Summarize test output.

## Current Task
Read \`.agent-memory/current-task.md\`, then compile fresh context for yourself:
\`\`\`bash
agent-bridge context compile --agent antigravity
\`\`\`
Read \`.agent-memory/compiled-context.md\` and continue only the current task.
The hook recompiles that file for antigravity on every prompt, so it is current
whenever you open it — but reading it costs tokens. Read it once at the start of
work, then again only when the task changes, when the user asks you to continue
work you did not do yourself or refers to another agent's work, or when you are
about to edit and no longer hold this task's constraints and handoff. Within one
task, keep working from what you already read.
Its \`## Latest Handoff\` section holds the current handoff of this task, whoever
wrote it; when the prompt continues work another agent started, re-read that
section — it is the context to work from, and your own handoff replaces it (one
per task).
Do not start a new task just because the user sends a new prompt inside an
active task; continue the current one unless the user asks to switch.

## Work-Git Rules
- Before editing any source/config/test/doc file for task work, acquire a write lease:
  \`\`\`bash
  agent-bridge file lease "<repo-relative-path>" --mode write --agent antigravity
  \`\`\`
- Continue editing only when the lease response has \`"acquired": true\`; if it returns \`false\`, inspect \`blockingLease\`, coordinate through handoff/request, and do not edit that file.
- Keep the lease id from the response and release it after the edit is recorded:
  \`\`\`bash
  agent-bridge file release "<lease-id>"
  \`\`\`

## File Brief Rules
- After reading any source/config/test/doc file for task work, run:
  \`\`\`bash
  agent-bridge graph brief-auto "<repo-relative-path>"
  \`\`\`
- After editing any source/config/test/doc file, run:
  \`\`\`bash
  agent-bridge graph brief-auto "<repo-relative-path>" --task-edited --agent antigravity
  \`\`\`
  The first \`--task-edited\` brief moves the task from \`todo\` to \`in_progress\`.
  Always pass \`--agent antigravity\`; without it the lease check resolves the default agent's task and rejects your own lease.
- You may pass multiple paths to one \`brief-auto\` call. Skip generated/vendor files and files outside the current task.

## Completion Rules
Before finishing:
1. Summarize changed files.
2. Summarize tests run.
3. Save durable findings:
   \`\`\`bash
   agent-bridge memory add "<important fact or decision>" --type note --agent antigravity
   \`\`\`
   For non-ASCII text (e.g. Vietnamese) or multi-line content, pipe via stdin to avoid shell encoding loss:
   \`\`\`bash
   echo "<nội dung>" | agent-bridge memory add --stdin --type note --agent antigravity
   \`\`\`
4. Create or update handoff notes:
   \`\`\`bash
   agent-bridge handoff create --from antigravity --to codex --summary "<summary>" --next "<next action>"
   \`\`\`
   For non-ASCII summaries, pipe via stdin:
   \`\`\`bash
   echo "<tóm tắt>" | agent-bridge handoff create --stdin --from antigravity --to codex
   \`\`\`
5. Avoid including unnecessary full file contents.

<!-- agent-bridge:end -->`;
}

export function antigravityArtifact(pack: PromptPack): Record<string, unknown> {
  return {
    type: "agent_bridge_artifact",
    task_id: pack.task.id,
    summary: pack.task.goal || pack.task.title,
    startup_rules: [
      "You are the antigravity agent. AGENTS.md is written for codex; wherever it says --agent codex, use --agent antigravity.",
      "Read .agent-memory/current-task.md before editing.",
      "The agent-bridge hooks in .agents/hooks.json already opened the task and the live session for this conversation: do not run task start, session start, or session end.",
      "Run: agent-bridge context compile --agent antigravity",
      "Read .agent-memory/compiled-context.md and continue only the current task.",
      "The hook recompiles that file every prompt, so it is always current — read it again only when the task changes, when you are asked to continue work you did not do yourself, or when you no longer hold this task's constraints and handoff. Do not re-read it every turn.",
      "Before editing relevant source/config/test/doc files, run: agent-bridge file lease \"<repo-relative-path>\" --mode write --agent antigravity and continue only if acquired=true",
      "After recording the edit with brief-auto --task-edited, release the lease with: agent-bridge file release \"<lease-id>\"",
      "Work-Git leases are enforced by brief-auto --task-edited; if another task holds the file, coordinate through handoff/request and do not edit it.",
      "After reading relevant source/config/test/doc files, run: agent-bridge graph brief-auto \"<repo-relative-path>\"",
      "After editing relevant source/config/test/doc files, run: agent-bridge graph brief-auto \"<repo-relative-path>\" --task-edited --agent antigravity (the first --task-edited brief moves the task from todo to in_progress)",
      "Always pass --agent antigravity with --task-edited; without it the lease check resolves the default agent's task and rejects your own lease."
    ],
    plan: pack.nextActions,
    progress: pack.currentState,
    verification: ["Run focused tests", "Summarize result", "Save durable findings to agent-bridge memory"],
    next_actions: pack.nextActions,
    risks: pack.risks,
    completion_rules: [
      "Run: agent-bridge memory add \"<important fact or decision>\" --type note --agent antigravity",
      "For non-ASCII (e.g. Vietnamese) or multi-line text, pipe via stdin: echo \"<nội dung>\" | agent-bridge memory add --stdin --type note --agent antigravity",
      "Run: agent-bridge handoff create --from antigravity --to codex --summary \"<summary>\" --next \"<next action>\"",
      "For non-ASCII summaries: echo \"<tóm tắt>\" | agent-bridge handoff create --stdin --from antigravity --to codex"
    ]
  };
}


