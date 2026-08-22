import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const start = "<!-- agent-bridge:start -->";
const end = "<!-- agent-bridge:end -->";

// Every rule above this block — start a task, compile context, open a session,
// write a handoff — addresses the agent a human is driving in a terminal. An
// agent spawned by an orchestration runs in the same workspace and reads the
// same file, and following those rules puts its work in the wrong layer:
// handoffs addressed to nobody, a compiled-context.md that parallel implementers
// overwrite mid-turn, and the active-task slot taken from the orchestration that
// spawned it. The orchestrator's own prompts say this too, but the agent reads
// CLAUDE.md/AGENTS.md first — this is where it needs to be told.
export function orchestratedRunSection(): string {
  return `## If You Were Spawned By An Orchestration

If the environment variable \`AGENT_BRIDGE_SPAWNED_RUN\` is set, you are a
sub-agent of an orchestration, not a terminal agent, and **none of the task,
session, handoff, compiled-context or memory rules above apply to you**. Do not
run \`agent-bridge task|session|handoff|context|memory\` write commands — they are
refused for spawned runs — and do not edit \`.handoff/CURRENT.md\`,
\`.handoff/INDEX.md\`, \`current-task.md\` or \`compiled-context.md\`. Your memory is the orchestration
context folder your prompt names (\`.agent-memory/context/<orchestrationId>/\`),
and your prompt names the one file in it you own. File leases and
\`graph brief-auto\` still apply: parallel implementers rely on them.`;
}

export function patchManagedSection(filePath: string, section: string): "created" | "updated" {
  const absolute = resolve(filePath);
  const normalizedSection = section.includes(start) ? section.trim() : `${start}\n\n${section.trim()}\n\n${end}`;

  if (!existsSync(absolute)) {
    writeFileSync(absolute, `${normalizedSection}\n`, "utf8");
    return "created";
  }

  const current = readFileSync(absolute, "utf8");
  copyFileSync(absolute, `${absolute}.bak`);
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, normalizedSection)
    : `${current.trimEnd()}\n\n${normalizedSection}\n`;
  writeFileSync(absolute, next, "utf8");
  return "updated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
