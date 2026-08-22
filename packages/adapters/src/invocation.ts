import { readFileSync } from "node:fs";
import type { RegisteredAgent } from "@agent-bridge/memory";
import { AGY_EFFORT_LEVELS, getProviderCatalog } from "./catalog.js";

export type AgentInvocation = {
  adapter: string;
  mode: RegisteredAgent["mode"];
  provider: RegisteredAgent["provider"];
  agentId: string;
  agentName: string;
  model?: string;
  reasoningEffort?: string;
  executable?: string;
  args?: string[];
  command?: string;
  stdinFilePath?: string;
  description: string;
  promptArtifactPath: string;
  cwd: string;
};

export type AgentInvocationResult = {
  accepted: boolean;
  assignmentId: string;
  requestId?: string;
  summary: string;
};

export type AgentAdapter = {
  buildInvocation(agent: RegisteredAgent, promptArtifactPath: string, cwd: string): AgentInvocation;
};

export function buildSpawnPreview(
  agent: RegisteredAgent,
  promptArtifactPath: string,
  cwd: string,
): AgentInvocation {
  const base = {
    adapter: agent.provider,
    mode: agent.mode,
    provider: agent.provider,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    promptArtifactPath,
    cwd,
  };

  if (agent.mode === "cli") {
    const executable = resolveExecutable(agent);
    if (agent.provider === "codex") {
      // `codex exec` defaults to sandbox: read-only, which silently makes
      // every implementer run a no-op: the agent reports "blocked by
      // workspace permissions", writes nothing, and even its own
      // agent-bridge bookkeeping fails with "attempt to write a readonly
      // database". workspace-write is the narrowest mode that lets an
      // implementer actually do its job — deliberately NOT
      // danger-full-access, so writes stay confined to the project.
      const args = [
        "exec",
        "--sandbox",
        "workspace-write",
        ...(agent.model ? ["--model", agent.model] : []),
        ...(agent.reasoningEffort ? ["-c", `model_reasoning_effort=\"${agent.reasoningEffort}\"`] : []),
        "-",
      ];
      return { ...base, executable, args, stdinFilePath: promptArtifactPath, command: `${executable} ${args.map(quoteCommandArg).join(" ")}`, description: `Codex CLI run for ${agent.name} using ${agent.model ?? "default model"}${agent.reasoningEffort ? ` (${agent.reasoningEffort})` : ""}. Approval is required unless dispatch auto-run was selected.` };
    }
    if (agent.provider === "claude") {
      // Headless `claude --print` cannot prompt for tool-use approval — with
      // no bypass flag it just describes what it would write/run and stops,
      // which looks indistinguishable from a hung or silently-failed spawn.
      // Codex's own `exec` subcommand already defaults to unattended
      // (approval: never); this brings claude to the same unattended parity.
      //
      // --output-format stream-json --verbose is not cosmetic: plain --print
      // output is fully buffered by the CLI until the process exits when
      // stdout isn't a TTY (verified live — a single chunk arrives right
      // before exit, no matter how long the run takes), so a live-tailed log
      // would sit blank the entire run. stream-json emits one event per turn
      // as it happens; process-runner.ts's isClaudeStreamJson formatter turns
      // that into a readable progress line without touching the final result.
      const args = [
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(agent.model ? ["--model", agent.model] : []),
        ...(agent.reasoningEffort ? ["--effort", agent.reasoningEffort] : []),
      ];
      return { ...base, executable, args, stdinFilePath: promptArtifactPath, command: `${executable} ${args.map(quoteCommandArg).join(" ")}`, description: `Claude Code run for ${agent.name} using ${agent.model ?? "default model"}${agent.reasoningEffort ? ` (${agent.reasoningEffort})` : ""}. Runs unattended with tool-use permission checks bypassed (--dangerously-skip-permissions) and streams progress live (--output-format stream-json).` };
    }
    if (agent.provider === "antigravity") {
      // `--print` TAKES the prompt as its value (`--prompt` is documented as
      // its alias), so it has to come last, immediately before the prompt.
      // Every other flag goes first. Getting this wrong is silent and vicious:
      // `--print --dangerously-skip-permissions ... "<prompt>"` makes
      // "--dangerously-skip-permissions" itself the prompt and drops the real
      // one — observed live, the agent replied "Could you please clarify your
      // intent? Are you trying to configure the CLI to run without prompting
      // you?" and then, unpermitted, "no output produced — a tool required
      // the command permission that headless mode cannot prompt for".
      //
      // stdin is not an option: `agy --print` ignores it entirely. So the
      // prompt travels as an argv string, which is what MAX_INLINE_PROMPT_CHARS
      // guards — and past that limit readPromptArtifact hands over a short
      // pointer that tells agy to read the artifact off disk instead.
      //
      // --dangerously-skip-permissions matches what claude already runs with:
      // without it a spawned run stalls on a tool-approval prompt nobody can
      // answer. --add-dir puts the project inside the agent's workspace, and
      // --print-timeout lifts the 5-minute default that would otherwise cut a
      // long implementer turn off mid-edit.
      const effort = agent.reasoningEffort && AGY_EFFORT_LEVELS.has(agent.reasoningEffort) ? agent.reasoningEffort : undefined;
      const args = [
        "--dangerously-skip-permissions",
        "--print-timeout",
        "60m",
        "--add-dir",
        cwd,
        ...(agent.model ? ["--model", agent.model] : []),
        ...(effort ? ["--effort", effort] : []),
        // Same reason claude gets stream-json: plain `--print` text is buffered
        // until the process exits, so a live-tailed log sits at 0 bytes for the
        // whole run and an implementer that is working looks identical to one
        // that hung. stream-json emits an NDJSON event per step as it happens
        // (verified live: 8 chunks over an 11s run); process-runner's
        // isAgyStreamJson formatter renders those as progress lines and still
        // writes the final `result.response` verbatim, which is what the leader
        // and review contract parsers read.
        "--output-format",
        "stream-json",
        "--print",
        readPromptArtifact(promptArtifactPath, cwd),
      ];
      return {
        ...base,
        executable,
        args,
        // The prompt is left out of the preview string on purpose: it is an
        // entire leader turn, and inlining it would bury every actual flag.
        command: `${executable} ${args.slice(0, -1).map(quoteCommandArg).join(" ")} "<prompt from ${promptArtifactPath}>"`,
        description: `Antigravity (agy) run for ${agent.name} using ${agent.model ?? "default model"}${effort ? ` (${effort})` : ""}. Runs unattended with tool approvals auto-accepted (--dangerously-skip-permissions), streams progress live (--output-format stream-json); the prompt is passed inline from ${promptArtifactPath}.`,
      };
    }
    const args = ["--prompt-file", promptArtifactPath];
    return {
      ...base,
      executable,
      args,
      command: `${executable} ${args.map((arg) => quoteCommandArg(arg)).join(" ")}`,
      description: `CLI spawn preview for ${agent.name}. Approval is required before running this command.`,
    };
  }

  if (agent.mode === "api") {
    const target = [agent.provider, agent.model].filter(Boolean).join(":");
    return {
      ...base,
      description: `API spawn preview for ${target || agent.name}. Uses credential reference ${agent.credentialRef ?? "none"} without exposing secrets.`,
    };
  }

  return {
    ...base,
    description: `Manual spawn preview for ${agent.name}. Open the prompt artifact and run the agent manually after approval.`,
  };
}

export function renderInvocationPrompt(input: {
  assignmentId: string;
  taskTitle?: string;
  subtaskTitle: string;
  roleName: string;
  agentName: string;
  prompt: string;
  acceptanceCriteria?: string[];
  contextHint?: string;
}): string {
  const lines = [
    "# Agent Assignment",
    "",
    `Assignment: ${input.assignmentId}`,
    `Agent: ${input.agentName}`,
    `Role: ${input.roleName}`,
  ];
  if (input.taskTitle) lines.push(`Task: ${input.taskTitle}`);
  lines.push(`Subtask: ${input.subtaskTitle}`, "", "## Prompt", "", input.prompt);
  if (input.acceptanceCriteria?.length) {
    lines.push("", "## Acceptance Criteria");
    for (const criterion of input.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  if (input.contextHint) lines.push("", "## Context", "", input.contextHint);
  lines.push("", "## Return Contract", "", "- Update the assignment with result, tests, and risks.", "- Do not expose raw API keys or credentials.");
  return `${lines.join("\n")}\n`;
}

// Windows' CreateProcess caps the whole command line at 32,767 characters, and
// a prompt passed as argv counts against it. Failing here with the real reason
// beats an ENAMETOOLONG from deep inside spawn(), which says nothing about
// which agent or which turn was too big.
const MAX_INLINE_PROMPT_CHARS = 30_000;

function readPromptArtifact(promptArtifactPath: string, cwd: string): string {
  const prompt = readFileSync(promptArtifactPath, "utf8");
  if (prompt.length <= MAX_INLINE_PROMPT_CHARS) return prompt;
  // A leader turn on a real repo routinely runs past the argv cap, and failing
  // the whole run there strands the orchestration: the turn is legitimate, only
  // the transport is too small. agy has file tools and the artifact lives under
  // --add-dir cwd, so hand it the path and make reading it step one. The
  // pointer stays deliberately blunt — an agy turn that answers from the
  // pointer alone would produce an off-contract reply the leader parser drops.
  return [
    "Your full instructions for this turn do not fit in a command-line argument, so they are on disk.",
    "",
    `Read this file FIRST, in full, before doing anything else: ${promptArtifactPath}`,
    `Working directory: ${cwd}`,
    "",
    "That file is the real prompt: follow it exactly, including its output format and any JSON contract it specifies.",
    "Do not answer from this message alone, and do not ask for the instructions to be repeated here.",
  ].join("\n");
}

// Commands that were once written into agent rows but can never run a headless
// turn, mapped to the binary that can. `antigravity` is the IDE launcher: it
// isn't even on PATH, so a stale row spawns nothing and the run dies instantly
// with "spawn antigravity ENOENT". The v22 migration rewrites stored rows; this
// covers agents built in memory (or registered by an older client) that never
// went through it.
const OBSOLETE_COMMANDS: Record<string, Set<string>> = {
  antigravity: new Set(["antigravity", "antigravity.exe", "gemini"]),
};

function resolveExecutable(agent: RegisteredAgent): string {
  const fallback = getProviderCatalog(agent.provider)?.defaultCommand;
  const command = agent.command?.trim();
  // Only bare names are second-guessed: a path is a deliberate override.
  if (command && fallback && !command.includes("/") && !command.includes("\\") && OBSOLETE_COMMANDS[agent.provider]?.has(command)) {
    return fallback;
  }
  // agent.name is a free-text display label (e.g. "leader", "thợ code 1"),
  // never a real executable — fall back to the provider's known CLI binary
  // name before ever falling back to the display name.
  return command || fallback || agent.name;
}

function quoteCommandArg(value: string): string {
  // An empty argument has to keep its quotes: the preview string is meant to be
  // copy-pasteable, and `-p ` with nothing after it is a different command from
  // `-p ""` — the shell would swallow the argument entirely.
  if (!value) return '""';
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
