import type { Action, Screen } from "./actions.js";
import { array, object, type Data } from "./service.js";
import { describe, type Entry } from "./view.js";
import { editHighlight } from "./edit-highlight.js";

export interface Section { name: string; groups: string[]; actions: string[] }
const section = (name: string, groups: string[], actions: string[] = []): Section => ({ name, groups, actions });
export const screenSections: Record<Screen, Section[]> = {
  "Work Board": [section("Tasks", ["Tasks"], ["task/", "session/terminal", "session/focus"]), section("Sessions", ["Sessions"], ["session/"]), section("Requests", ["Requests"], ["request/", "orchestration/request"]), section("Files", ["File leases", "File changes", "Task lanes"], ["orchestration/lane", "orchestration/lease/", "orchestration/change"])],
  Orchestrator: [
    section("Overview", ["Selected orchestration", "Orchestrations"], ["workforce/orchestration/"]),
    section("Tasks", ["Orchestrations"], ["workforce/orchestration/start"]),
    section("Runs", ["Runs"], ["workforce/run/log", "workforce/run/stop", "workforce/run/set-model"]),
    section("Team", ["Agents"], ["workforce/agent", "workforce/agents/", "workforce/catalog"]),
    section("Presets", ["Agent presets"], ["workforce/default-agent/"]),
    section("Questions", ["Questions"], ["workforce/orchestration/answer-questions"]),
    section("Approvals", ["Approvals"], ["workforce/orchestration/approve-spawn"]),
    section("Plan", ["Subtasks"], ["workforce/subtask/", "workforce/orchestration/request-changes"]),
    section("Reviews", ["Reviews"], ["workforce/orchestration/report", "workforce/orchestration/request-changes"]),
    section("Activity", ["Activity"], ["workforce/orchestration/report"]),
    section("External", ["External sessions"], ["workforce/run/adopt"]),
    section("Settings", ["Orchestration settings", "Leader"], ["workforce/orchestration/autonomy", "workforce/orchestration/auto-run", "workforce/orchestration/leader", "workforce/orchestration/add-cycles"]),
    section("All", []),
  ],
  Knowledge: [section("All", []), section("Task memory", ["Task memories"], ["memory/"]), section("Repo memory", ["Repository memories"], ["repo-memory/update", "repo-memory/delete", "memory/add"]), section("Inbox", ["Memory candidates"], ["repo-memory/candidates/"])],
  Context: [section("All", []), section("Document", ["Context"], ["context/"]), section("Savings", ["Token statistics", "Optimization"], ["optimize/", "cache-report"]), section("Token tools", ["Token stack"])],
  Graph: [section("Network", ["Files"], ["graph/"]), section("Repo map", ["Repo map", "Graph statistics"], ["graph/"]), section("Settings", ["Graph settings"], ["config/graph"])],
  Handoff: [section("All", []), section("Current", ["Current", "Portable state"], ["handoff/save"]), section("History", ["History"], ["handoff/history"])],
  Skills: [section("All", []), section("Repository", ["Repository skills"], ["skills/"]), section("Global", ["Global skills"], ["skills/"])],
  Tools: [section("All", []), section("Repository", ["Repository"], ["repo/"]), section("Tools", ["Tools", "Watcher"], ["tools/", "watch/", "update/"]), section("Hooks", ["Hooks"], ["claude/", "codex/", "antigravity/"]), section("Settings", ["Settings", "Credentials"], ["config/"])],
};

export function sectionEntries(entries: Entry[], current: Section): Entry[] {
  return current.groups.length ? entries.filter((entry) => current.groups.includes(entry.group)) : entries;
}

export function sectionActions(actions: readonly Action[], current: Section): Action[] {
  if (!current.groups.length) return [...actions];
  return actions.filter((action) => current.actions.some((prefix) => action.path.slice(5).startsWith(prefix)));
}

export function resolvedGraphSettings(config: Data): Data {
  const graph = { ...object(config.graph) };
  delete graph.autoBriefOnToolUse;
  delete graph.injectRepoMap;
  return { enabled: true, watchAutoBrief: true, repoMapLimit: 30, includePaths: [], ignorePaths: [], ...graph };
}

export function graphEntries(graph: Data, config: Data): Entry[] {
  const nodes = array(graph.nodes);
  const edges = array(graph.edges);
  return [
    { group: "Graph statistics", label: "Index statistics", data: { ...object(graph.stats), shownFiles: nodes.length, shownEdges: edges.length } },
    ...nodes.map((node) => ({ group: "Files", label: String(node.path), data: { ...node,
      outgoing: Array.isArray(node.outgoing) ? node.outgoing : edges.filter((edge) => edge.source === node.path).map((edge) => edge.target),
      incoming: Array.isArray(node.incoming) ? node.incoming : edges.filter((edge) => edge.target === node.path).map((edge) => edge.source),
    } })),
    { group: "Repo map", label: "Repository map", data: graph.repoMap || "Build the graph to generate a repository map." },
    ...Object.entries(resolvedGraphSettings(config)).map(([key, value]) => ({ group: "Graph settings", label: `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase())}: ${Array.isArray(value) ? value.join(", ") || "(none)" : value}`, data: { setting: key, value } })),
  ];
}

export function graphPreview(entry: Entry, now = Date.now()): string {
  const node = object(entry.data);
  if (entry.group !== "Files") return describe(entry.data);
  const lines = [String(node.path), `${node.language ?? "source"} · ${node.symbols ?? 0} symbols · imports ${node.imports ?? 0} · used by ${node.usedBy ?? 0}`, "", String(node.brief ?? "No brief yet. Use Edit brief or Refresh briefs."), "", "DEPENDENCIES"];
  if (typeof node.structuralScore === "number") lines.splice(2, 0, `Structural score: ${node.structuralScore.toFixed(2)} · manual priority: ${node.manualPriority ?? 0}`);
  if (typeof node.score === "number") lines.splice(2, 0, `Score: ${node.score.toFixed(2)} · edit bonus: +${node.editScore ?? 0}`);
  const edit = editHighlight(node, now);
  if (edit) lines.splice(2, 0, `Last edit: ${node.lastEditedAt ?? "unknown"} · ${edit.label}`);
  const outgoing = Array.isArray(node.outgoing) ? node.outgoing : [];
  const incoming = Array.isArray(node.incoming) ? node.incoming : [];
  lines.push(...(outgoing.length ? outgoing.map((path, index) => `${index === outgoing.length - 1 ? "└─" : "├─"} → ${path}`) : ["└─ No outgoing edges in this view"]));
  lines.push("", "IMPORTED BY", ...(incoming.length ? incoming.map((path, index) => `${index === incoming.length - 1 ? "└─" : "├─"} ← ${path}`) : ["└─ No incoming edges in this view"]));
  if (Array.isArray(node.external) && node.external.length) lines.push("", "EXTERNAL PACKAGES", ...node.external.map((path) => `  → ${path}`));
  if (node.briefStale) lines.push("", "Brief is stale. Refresh to match the current file.");
  return lines.join("\n");
}
