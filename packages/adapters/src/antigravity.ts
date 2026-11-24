import type { PromptPack } from "@agent-bridge/core";
import type { CreateRegisteredAgentInput } from "@agent-bridge/memory";
import { compactWorkflowSection } from "./managed-section.js";
import { orchestratedRunSection, permissionEscalationSection, temporaryArtifactCleanupSection } from "./managed-section.js";

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
export function antigravityRulesSection(options: { hooked?: boolean } = {}): string {
  return `<!-- agent-bridge:start -->\n\n${compactWorkflowSection("antigravity", options)}\n\n<!-- agent-bridge:end -->`;
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
      "Use context find only when the request needs repository history; open relevant results with context query, expand, or handoff. Ask before searching history when the reference is unclear.",
      "Before edits: agent-bridge file lease-batch <paths...> --agent antigravity --compact; continue only if acquired=true. Retain lease ids and include --session for session-owned leases. On conflict coordinate with the blocking owner.",
      "Read relevant source ranges; briefs are navigation hints. The watcher refreshes briefs only on source content changes; reads do not refresh briefs or mark edits. Do not run brief commands after tool use.",
      "After a group of edits: agent-bridge task checkpoint --agent antigravity --summary \"...\" --tests \"actual results or not run\" --files <edited paths...> --next \"next action\". This checks leases and refreshes briefs; it does not complete the task or commit.",
      "After recording edits, release only your leases: agent-bridge file release-batch <leaseIds...> --agent antigravity --compact."
    ],
    plan: pack.nextActions,
    progress: pack.currentState,
    verification: ["Run focused tests", "Summarize result", "Save durable findings to agent-bridge memory"],
    next_actions: pack.nextActions,
    risks: pack.risks,
    completion_rules: [
      "Save one task checkpoint with actual test results and next actions when handing off or finishing.",
      "Repository Memory goes through Inbox unless explicitly requested; no mandatory memory add each turn."
    ]
  };
}
