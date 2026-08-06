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

export function antigravityArtifact(pack: PromptPack): Record<string, unknown> {
  return {
    type: "agent_bridge_artifact",
    task_id: pack.task.id,
    summary: pack.task.goal || pack.task.title,
    startup_rules: [
      "Read .agent-memory/current-task.md before editing.",
      "If no current task exists, run: agent-bridge task start --agent antigravity. A title is optional; agent-bridge seeds one after the first completed response.",
      "Run: agent-bridge context compile --agent antigravity",
      "Read .agent-memory/compiled-context.md and continue only the current task.",
      "Run: agent-bridge session start --agent antigravity so this work appears in the shared dashboard.",
      "After meaningful progress, run: agent-bridge session summary \"<state>\" --agent antigravity. End with: agent-bridge session end --agent antigravity.",
      "Before editing relevant source/config/test/doc files, run: agent-bridge file lease \"<repo-relative-path>\" --mode write --agent antigravity and continue only if acquired=true",
      "After recording the edit with brief-auto --task-edited, release the lease with: agent-bridge file release \"<lease-id>\"",
      "Work-Git leases are enforced by brief-auto --task-edited; if another task holds the file, coordinate through handoff/request and do not edit it.",
      "After reading relevant source/config/test/doc files, run: agent-bridge graph brief-auto \"<repo-relative-path>\"",
      "After editing relevant source/config/test/doc files, run: agent-bridge graph brief-auto \"<repo-relative-path>\" --task-edited (the first --task-edited brief moves the task from todo to in_progress)"
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


