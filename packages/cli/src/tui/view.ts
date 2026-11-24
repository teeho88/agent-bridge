import { stripVTControlCharacters } from "node:util";
import type { Screen } from "./actions.js";
import { array, object, type Data } from "./service.js";

export interface Entry {
  label: string;
  group: string;
  data: unknown;
  active?: boolean;
  lastActivityAt?: string;
}

function latestActivity(...rows: Data[]): string | undefined {
  const times = rows.flatMap((row) => [row.lastActivityAt, row.updatedAt, row.createdAt])
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export function clean(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
}

export function cellWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === "\u200d" || char === "\ufe0f") return 0;
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300) ? 2 : 1;
}

export function fit(value: unknown, width: number): string {
  let line = "";
  let used = 0;
  for (const char of clean(value).replace(/\n/g, " ")) {
    const size = cellWidth(char);
    if (used + size > width) break;
    line += char;
    used += size;
  }
  return line + " ".repeat(Math.max(0, width - used));
}

export function wrap(value: unknown, width: number): string[] {
  width = Math.max(1, width);
  return clean(value).split("\n").flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    let used = 0;
    for (const char of line) {
      const size = cellWidth(char);
      if (used + size > width) { lines.push(current); current = ""; used = 0; }
      current += char;
      used += size;
    }
    lines.push(current);
    return lines;
  });
}

export function describe(value: unknown, indent = 0): string {
  if (value === undefined || value === null) return "(none)";
  if (typeof value !== "object") return clean(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${describe(item, indent + 2)}`).join("\n\n") : "(empty)";
  return Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => {
    const label = key.replace(/([a-z])([A-Z])/g, "$1 $2");
    return typeof item === "object" && item !== null
      ? `${label}:\n${describe(item, indent + 2).split("\n").map((line) => `  ${line}`).join("\n")}`
      : `${label}: ${clean(item)}`;
  }).join("\n");
}

export function screenEntries(screen: Screen, state: Data, board: Data): Entry[] {
  const entries: Entry[] = [];
  const one = (group: string, label: string, data: unknown): void => { entries.push({ group, label, data }); };
  const many = (group: string, value: unknown): void => {
    for (const row of array(value)) {
      const text = row.title ?? row.taskTitle ?? row.planTitle ?? row.name ?? row.label ?? row.path ?? row.summary ?? row.content ?? row.id ?? row.sessionId ?? "Record";
      const status = row.status ?? (typeof row.enabled === "boolean" ? (row.enabled ? "enabled" : "disabled") : row.type);
      const id = row.id ?? row.sessionId;
      one(group, `${status ? `[${status}] ` : ""}${clean(text).split("\n")[0]}${id ? `  (${id})` : ""}`, row);
    }
  };
  switch (screen) {
    case "Work Board": {
      const sessions = array(state.sessionHistory ?? state.activeSessionEvents);
      const isActiveSession = (session: Data): boolean =>
        session.liveness !== "unknown" && session.liveness !== "ended" &&
        !["session_ended", "session_paused", "stop_requested", "task_cancelled"].includes(String(session.kind));
      many("Tasks", array(state.tasks).map((task) => {
        const live = array(state.liveTasks).find((item) => object(item.task).id === task.id);
        const related = sessions.filter((session) => session.taskId === task.id);
        const active = !["done", "cancelled"].includes(String(task.status)) &&
          (Boolean(live?.hasActiveSession) || related.some(isActiveSession));
        return { ...live, ...task, active, lastActivityAt: latestActivity(task, ...related, ...array(live?.events), object(live?.sessionState)) };
      }));
      many("Sessions", sessions.map((session) => ({ ...session,
        title: `${session.agent ?? "Agent"} · ${session.title ?? session.summary ?? session.sessionId}`,
        active: isActiveSession(session),
        lastActivityAt: latestActivity(session),
      })));
      for (const entry of entries) {
        const row = object(entry.data);
        entry.active = row.active === true;
        entry.lastActivityAt = typeof row.lastActivityAt === "string" ? row.lastActivityAt : undefined;
      }
      entries.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0));
      many("Requests", state.agentRequests);
      many("File leases", state.fileLeases);
      many("File changes", state.taskChanges);
      many("Task lanes", state.taskLanes);
      break;
    }
    case "Orchestrator":
      many("Orchestrations", board.orchestrations);
      if (board.orchestration) one("Selected orchestration", String(board.taskTitle ?? "Orchestration"), { ...object(board.orchestration), leader: board.leaderAgent, autoRun: board.autoRun });
      if (board.orchestration) one("Orchestration settings", "Autonomy, limits and scheduling", board.orchestration);
      if (board.leaderAgent) one("Leader", "Leader provider and model", board.leaderAgent);
      many("Questions", board.questions);
      many("Approvals", board.approvals);
      many("Runs", board.runs);
      many("Subtasks", board.subtasks);
      many("Reviews", board.reviews);
      many("Activity", board.events);
      many("Agents", state.registeredAgents);
      many("Agent presets", state.defaultAgentPresets);
      many("External sessions", board.adoptable);
      break;
    case "Knowledge":
      many("Task memories", state.memories);
      many("Repository memories", state.repoMemories);
      many("Memory candidates", state.repoMemoryCandidates);
      break;
    case "Context":
      one("Context", "Compiled context", state.compiledContext || "No compiled context. Press a to compile.");
      one("Token statistics", "Token savings", state.tokenStats);
      one("Optimization", "Optimization statistics", state.optimizeStats);
      one("Token stack", "Available token tools", state.tokenStack);
      break;
    case "Graph":
      one("Graph", "Repository graph statistics", state.graphStats);
      one("Settings", "Graph settings", object(state.config).graph);
      break;
    case "Handoff":
      if (state.handoff) one("Current", "Latest handoff", state.handoff);
      one("Portable state", "Portable handoff", state.portableHandoff);
      many("History", state.latestTaskHandoffs);
      break;
    case "Skills":
      many("Repository skills", array(state.skills).filter((skill) => skill.scope !== "global"));
      many("Global skills", array(state.skills).filter((skill) => skill.scope === "global"));
      break;
    case "Tools":
      one("Repository", `Agent Bridge: ${object(state.config).enabled === false ? "DISABLED" : "ENABLED"}`, { enabled: object(state.config).enabled !== false, scope: "This repository only", effect: "Disabling removes Bridge hooks and managed instructions, stops the watcher and orchestration scheduling, and preserves data. Start a new agent session to discard context already loaded." });
      one("Watcher", `File watcher: ${state.watcherRunning ? "running" : "stopped"}`, { running: state.watcherRunning });
      one("Tools", "Installed optional tools", state.optionalTools);
      one("Hooks", "Claude hooks", state.claudeHookStatus);
      one("Hooks", "Codex hooks", state.codexHookStatus);
      one("Hooks", "Antigravity hooks", state.antigravityHookStatus);
      one("Settings", "CLI approval policies", object(state.config).cliApprovalPolicies);
      one("Settings", "Workspace configuration", state.config);
      one("Credentials", "Credential references", state.credentialRefs);
      break;
  }
  return entries;
}
