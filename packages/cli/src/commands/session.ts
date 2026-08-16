import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import type { AgentKind } from "@agent-bridge/memory";
import { firstLineSummary } from "@agent-bridge/core";
import {
  endAgentSession,
  rememberSessionWindowHandle,
  openStore,
  readConfig,
  resolveActiveTaskId,
  startAgentSession,
  writeCurrentTaskArtifact,
} from "../workspace.js";
import { applyTaskLabelSuggestion } from "../task-suggestions.js";

const agents: AgentKind[] = ["claude", "codex", "gemini", "antigravity", "generic"];

export function registerSession(program: Command): void {
  const session = program.command("session").description("Record lifecycle events for agents without native hooks");

  session
    .command("start")
    .description("Start a live session for the active task")
    .option("--agent <agent>", "agent source", "codex")
    .option("--task <taskId>", "task id (required when this agent has multiple active tasks)")
    .option("--id <sessionId>", "optional stable session id")
    .action((options: { agent: string; task?: string; id?: string }) => {
      const agent = parseAgent(options.agent);
      const store = openStore();
      try {
        const taskId = options.task?.trim() || resolveSessionStartTaskId(store, agent);
        const task = taskId ? store.getTask(taskId) : undefined;
        if (!task) throw new Error("No active task. Run `agent-bridge task start \"...\" --agent " + agent + "` first.");
        const sessionId = options.id?.trim() || `${agent}-${randomUUID()}`;
        startAgentSession(sessionId, task.id, undefined, agent);
        setTerminalTitle(agent, task.id, sessionId);
        rememberSessionWindowHandle(sessionId, task.id, agent);
        store.recordSessionEvent({ sessionId, taskId: task.id, agent, kind: "session_started", summary: `${agentLabel(agent)} session started.` });
        writeCurrentTaskArtifact(task);
        console.log(`Started ${agent} session ${sessionId} for ${task.id}`);
      } finally {
        store.close();
      }
    });

  session
    .command("summary")
    .description("Save the latest working state for the active session")
    .argument("<text>", "short current state")
    .option("--agent <agent>", "agent source", "codex")
    .option("--task <taskId>", "task id (defaults to this agent's active task)")
    .option("--id <sessionId>", "session id (defaults to this agent's current session)")
    .action((text: string, options: { agent: string; task?: string; id?: string }) => {
      const agent = parseAgent(options.agent);
      const store = openStore();
      try {
        const config = readConfig();
        const sessionId = options.id?.trim() || config.currentSessions?.[agent];
        if (!sessionId) throw new Error(`No active ${agent} session. Run \`agent-bridge session start --agent ${agent}\` first.`);
        const taskId = options.task ?? config.sessionTasks?.[sessionId] ?? resolveActiveTaskId(store, undefined, undefined, agent);
        if (!taskId || !store.getTask(taskId)) throw new Error("No active task for this session.");
        const summary = text.trim();
        if (!summary) throw new Error("Session summary cannot be empty.");
        store.upsertLatestMemory(
          { taskId, type: "note", content: `${agentLabel(agent)} latest response: ${summary}`, summary: `${agentLabel(agent)} latest response: ${firstLineSummary(summary)}`, importance: 3, sourceAgent: agent, tags: [agent, "latest-response"] },
          { latestTag: "latest-response", legacyContentPrefix: `${agentLabel(agent)} latest response:` },
        );
        const task = applyTaskLabelSuggestion(store, taskId, { titleText: summary, goalText: summary });
        if (task) writeCurrentTaskArtifact(task);
        store.recordSessionEvent({ sessionId, taskId, agent, kind: "assistant_summary", summary: `${agentLabel(agent)} updated session state.` });
        console.log(`Updated ${agent} session state for ${taskId}`);
      } finally {
        store.close();
      }
    });

  session
    .command("end")
    .description("End a live session")
    .option("--agent <agent>", "agent source", "codex")
    .option("--task <taskId>", "task id (defaults to the session task)")
    .option("--id <sessionId>", "session id (defaults to this agent's current session)")
    .action((options: { agent: string; task?: string; id?: string }) => {
      const agent = parseAgent(options.agent);
      const config = readConfig();
      const sessionId = options.id?.trim() || config.currentSessions?.[agent];
      if (!sessionId) throw new Error(`No active ${agent} session.`);
      const store = openStore();
      try {
        const taskId = options.task ?? config.sessionTasks?.[sessionId];
        store.recordSessionEvent({ sessionId, taskId, agent, kind: "session_ended", summary: `${agentLabel(agent)} session ended.` });
        endAgentSession(sessionId);
        console.log(`Ended ${agent} session ${sessionId}`);
      } finally {
        store.close();
      }
    });
}

function resolveSessionStartTaskId(
  store: ReturnType<typeof openStore>,
  agent: AgentKind,
): string | null {
  const candidates = store
    .listTasks(500)
    .filter(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        (!task.ownerAgent || task.ownerAgent === agent),
    );
  if (candidates.length > 1) {
    const choices = candidates
      .slice(0, 8)
      .map((task) => `- ${task.id}: ${task.title}`)
      .join("\n");
    throw new Error(
      `Multiple active ${agent} tasks found. Bind this terminal explicitly:\n` +
        `agent-bridge session start --agent ${agent} --task <taskId>\n\n${choices}`,
    );
  }
  return candidates[0]?.id ?? resolveActiveTaskId(store, undefined, undefined, agent);
}

function parseAgent(value: string): AgentKind {
  if (agents.includes(value as AgentKind)) return value as AgentKind;
  throw new Error(`Invalid agent \"${value}\". Use one of: ${agents.join(", ")}.`);
}

function agentLabel(agent: AgentKind): string {
  return agent === "antigravity" ? "Antigravity" : agent[0].toUpperCase() + agent.slice(1);
}

function setTerminalTitle(agent: AgentKind, taskId: string, sessionId: string): void {
  const title = `AgentBridge ${agent} ${taskId} ${sessionId}`;
  if (process.platform === "win32") {
    try {
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentBridgeConsoleTitle {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SetConsoleTitle(string lpConsoleTitle);
}
"@
[void][AgentBridgeConsoleTitle]::SetConsoleTitle(${psString(title)})
`;
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      return;
    } catch {
      // Fall through to the ANSI terminal title sequence.
    }
  }
  process.stdout.write(`\u001b]0;${title}\u0007`);
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}


