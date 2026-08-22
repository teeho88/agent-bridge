import type { Command } from "commander";

// The terminal workboard (tasks, sessions, handoffs, compiled context, memory
// entries) is one human's working memory for one terminal. An orchestration is a
// different layer: its memory is `.agent-memory/context/<orchestrationId>/`, and
// every document it needs has a named owner and a named path there.
//
// A spawned agent runs inside the same workspace, so it reads that workspace's
// CLAUDE.md / AGENTS.md — which tell a *human-driven* agent to start a task,
// compile context and update the handoff. Following those rules is exactly wrong
// for a sub-agent: the handoff tab fills with fragments written by agents nobody
// is handing anything to, compiled-context.md gets overwritten mid-turn by a
// parallel implementer, and the active-task slot is taken from the orchestration
// that spawned the run. Prompts say not to; this makes it true regardless.
//
// Only the write side is blocked. Reads stay open: a sub-agent looking at
// `task current` or `memory search` costs nothing and mixes no state.
const BLOCKED_SUBCOMMANDS: Record<string, readonly string[]> = {
  context: ["compile", "edit"],
  handoff: ["create"],
  memory: ["add", "consolidate", "prune", "reindex"],
  session: ["start", "summary", "end"],
  task: ["start", "update", "delete", "lane", "accept", "discard", "merge"],
};

export type SpawnedRunEnv = {
  spawnedRun?: string;
  orchestration?: string;
};

export function blockedForSpawnedRun(path: readonly string[], env: SpawnedRunEnv): string | undefined {
  if (!env.spawnedRun?.trim()) return undefined;
  const [group, sub] = path;
  if (!group || !sub) return undefined;
  if (!BLOCKED_SUBCOMMANDS[group]?.includes(sub)) return undefined;

  const where = env.orchestration?.trim()
    ? `\`.agent-memory/context/${env.orchestration.trim()}/\``
    : "the orchestration context folder named in your prompt";
  return [
    `\`agent-bridge ${group} ${sub}\` is not available to an orchestrated agent.`,
    "",
    `That command writes the terminal workboard, which belongs to the human driving`,
    `this workspace. Your orchestration's memory lives in ${where}, and your prompt`,
    "names the one file you own there. Write that file instead.",
  ].join("\n");
}

// Commander gives the action command; the group is its parent. `program` itself
// is the root, so a top-level command yields a one-element path and is never
// blocked.
function commandPath(command: Command): string[] {
  const path: string[] = [];
  for (let node: Command | null = command; node?.parent; node = node.parent) path.unshift(node.name());
  return path;
}

export function installSpawnedRunGuard(program: Command): void {
  program.hook("preAction", (_thisCommand, actionCommand) => {
    const message = blockedForSpawnedRun(commandPath(actionCommand), {
      spawnedRun: process.env.AGENT_BRIDGE_SPAWNED_RUN,
      orchestration: process.env.AGENT_BRIDGE_ORCHESTRATION,
    });
    if (message) throw new Error(message);
  });
}
