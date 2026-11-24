export const screens = ["Work Board", "Orchestrator", "Knowledge", "Context", "Graph", "Handoff", "Skills", "Tools"] as const;
export type Screen = typeof screens[number];
export interface Field {
  key: string;
  label: string;
  required: boolean;
  kind: "text" | "number" | "boolean" | "json";
  choices?: string[];
  choiceLabels?: Record<string, string>;
  multiple?: boolean;
  allowCustom?: boolean;
  initial?: string;
  group?: string;
}
export interface Action {
  screen: Screen;
  label: string;
  method: "GET" | "POST";
  path: string;
  fields: Field[];
  destructive: boolean;
}

function fields(spec: string): Field[] {
  return spec.split(" ").filter(Boolean).map((token) => {
    const [definition, initial] = token.split("=");
    const [raw, options] = definition.split(":");
    const key = raw.replace(/[!#?@]/g, "");
    return {
      key,
      label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (s) => s.toUpperCase()),
      required: raw.includes("!"),
      kind: raw.includes("#") ? "number" : raw.includes("?") ? "boolean" : raw.includes("@") ? "json" : "text",
      choices: options?.split("|"),
      initial,
    };
  });
}

const actions: Action[] = [];
function add(screen: Screen, label: string, path: string, spec = "", method: "GET" | "POST" = "POST", destructive = false): void {
  actions.push({ screen, label, path: `/api/${path}`, fields: fields(spec), method, destructive });
}
const task = "taskId!";
const leader = "leaderProvider!:codex|claude|antigravity|gemini=codex leaderMode:cli|api|manual=cli leaderModel leaderReasoning leaderCommand";
const agent = "name! description provider!:codex|claude|antigravity|gemini|openai-compatible|deepseek|kimi|glm|manual|generic=codex mode!:cli|api|manual=cli command model reasoningEffort capabilities baseUrl credentialRef";

add("Work Board", "Start task", "task/start", "title! agent:codex|claude|antigravity|generic=codex createGoal?=false goal");
add("Work Board", "Start session", "session/start", `${task} agent:codex|claude|antigravity|generic=codex`);
add("Work Board", "Open agent terminal", "session/terminal", "sessionId taskId agent!:codex|claude|antigravity=codex sessionMode:transfer|clone=clone transferOwnership?=false createGoal?=false");
actions[actions.length - 1].fields.find((field) => field.key === "sessionMode")!.label = "When changing agent";
add("Work Board", "Focus agent terminal", "session/focus", "taskId sessionId agent");
add("Work Board", "Delete session", "session/delete", "sessionId!", "POST", true);
add("Work Board", "Bind terminal window", "session/window", "sessionId! windowId! pid# hwnd");
add("Work Board", "Save session summary", "session/summary", `${task} agent=codex text!`);
add("Work Board", "End session", "session/end", "taskId agent=codex");
add("Work Board", "Send task prompt", "task/prompt", `${task} text! agent sessionId`);
add("Work Board", "Create request", "orchestration/request", `${task} title! type:question|approval|command|merge=question payload agent sessionId`);
add("Work Board", "Delete request", "request/delete", "requestId!", "POST", true);
add("Work Board", "Clear requests", "request/clear", "taskId status:pending|resolved|rejected=pending ids@", "POST", true);
add("Work Board", "Set task lane", "orchestration/lane", `${task} mode:patch|worktree=patch baseRef baseCommit worktreePath status:active|merged|discarded|conflict=active`);
add("Work Board", "Acquire file lease", "orchestration/lease/acquire", `${task} path! mode:read|write=write agent=codex sessionId ttl#=3600`);
add("Work Board", "Release file lease", "orchestration/lease/release", `${task} leaseId! agent=codex sessionId`);
add("Work Board", "Record file change", "orchestration/change", `${task} path! changeType:added|modified|deleted|renamed=modified diffSummary status:pending|accepted|discarded|conflict=pending baseHash currentHash`);

add("Orchestrator", "Start orchestration", "workforce/orchestration/start", `prompt! ${leader} autonomy:manual|approve-each|auto=manual maxParallel#=3 maxCycles#=8 maxQuestionRounds# createGoal?=false`);
for (const [name, route] of [["Advance one step", "step"], ["Pause", "pause"], ["Resume", "resume"], ["Stop", "stop"]]) {
  add("Orchestrator", name, `workforce/orchestration/${route}`, task, "POST", route === "stop");
}
add("Orchestrator", "Generate report", "workforce/orchestration/report", `${task} forceFallback?=false`);
add("Orchestrator", "Answer questions", "workforce/orchestration/answer-questions", `${task} answers@ dismiss?=false`);
add("Orchestrator", "Approve or reject spawn", "workforce/orchestration/approve-spawn", `${task} requestId! approve?=true agentId note`);
add("Orchestrator", "Set auto-run", "workforce/orchestration/auto-run", `${task} enabled?=true`);
add("Orchestrator", "Set autonomy", "workforce/orchestration/autonomy", `${task} autonomy!:manual|approve-each|auto=manual`);
add("Orchestrator", "Change leader", "workforce/orchestration/leader", `${task} ${leader}`);
add("Orchestrator", "Request changes", "workforce/orchestration/request-changes", `${task} request!`);
add("Orchestrator", "Add cycles", "workforce/orchestration/add-cycles", `${task} additionalCycles!#=1`);
add("Orchestrator", "Add subtask and spawn", "workforce/subtask/add-and-spawn", `${task} title! goal criteria provider!:codex|claude|antigravity|gemini|openai-compatible|deepseek|kimi|glm|manual|generic=codex mode:cli|api|manual=cli model reasoningEffort`);
add("Orchestrator", "Read run log", "workforce/run/log", "run! tail#=200", "GET");
add("Orchestrator", "Stop agent run", "workforce/run/stop", "runId! reason cancelSubtask?=false", "POST", true);
add("Orchestrator", "Change run model", "workforce/run/set-model", "runId! model! reasoningEffort");
add("Orchestrator", "Adopt external session", "workforce/run/adopt", "sessionId! role! taskId agentId subtaskId");
add("Orchestrator", "Register agent", "workforce/agent", agent);
add("Orchestrator", "Edit agent", "workforce/agent/update", `agentId! ${agent.replace(/!/g, "").replace(/=\w+/g, "")}`);
add("Orchestrator", "Enable or disable agent", "workforce/agent/toggle", "agentId! enabled?=true");
add("Orchestrator", "Delete agent", "workforce/agent/delete", "agentId!", "POST", true);
add("Orchestrator", "Enable or disable provider", "workforce/agents/provider-enabled", "provider!=codex enabled?=true");
add("Orchestrator", "Create agent preset", "workforce/default-agent/create", `label! ${agent.replace("name! ", "")}`);
add("Orchestrator", "Edit agent preset", "workforce/default-agent/update", `presetKey! label! ${agent.replace("name! ", "")}`);
add("Orchestrator", "Select agent preset", "workforce/default-agent/toggle", "presetKey! selected?=true");
add("Orchestrator", "Delete agent preset", "workforce/default-agent/delete", "presetKey!", "POST", true);
add("Orchestrator", "Restore default presets", "workforce/default-agent/restore");
add("Orchestrator", "Discover provider models", "workforce/catalog", "provider", "GET");
add("Knowledge", "Add memory", "memory/add", "content! scope:task|repo=task taskId type=note tags importance#=3 agent");
add("Knowledge", "Search memories", "memory/search", "q!", "GET");
add("Knowledge", "Edit repository memory", "repo-memory/update", "id! content! type!=note importance!#=3 tags");
add("Knowledge", "Delete repository memory", "repo-memory/delete", "id!", "POST", true);
add("Knowledge", "Review memory candidate", "repo-memory/candidates/review", "id! action!:promote|reject=promote");
add("Context", "Compile context", "context/compile", `${task} budget#`);
add("Context", "Save context", "context/save", `${task} content!`);
add("Graph", "Build graph", "graph/build", "root includePaths ignorePaths");
add("Graph", "Refresh all file briefs", "graph/brief-auto-all");
add("Graph", "Save file brief", "graph/brief", "path! summary! manualPriority# ranges taskEdited?=false taskId");
add("Graph", "Graph settings", "config/graph", "enabled? watchAutoBrief? repoMapLimit# includePaths ignorePaths");
add("Handoff", "Save handoff", "handoff/save", `${task} from summary! done next risks filesChanged`);
add("Handoff", "Browse handoff history", "handoff/history", "offset#=0 limit#=50", "GET");
add("Skills", "Save skill", "skills/save", "scope!:repo|global=repo name description content!");
add("Skills", "Delete skill", "skills/delete", "scope!:repo|global=repo name!", "POST", true);
add("Skills", "Search GitHub skills", "skills/github/search", "q!", "GET");
add("Skills", "Install GitHub skill", "skills/github/install", "repository! path! ref scope!:repo|global=repo overwrite?=false");
add("Tools", "Install tool", "tools/install", "name!:repomix|ccusage=repomix");
add("Tools", "Enable or disable Agent Bridge in this repo", "repo/enabled", "enabled!?=true");
add("Tools", "Install Claude hooks", "claude/install-hooks");
add("Tools", "Install Codex hooks", "codex/install-hooks");
add("Tools", "Install Antigravity hooks", "antigravity/install-hooks");
add("Tools", "Start watcher", "watch/start");
add("Tools", "Stop watcher", "watch/stop");
add("Tools", "Save optimization baseline", "optimize/baseline", "limit#=40 focus");
add("Tools", "Cache usage report", "cache-report", "days#=7", "GET");
add("Tools", "CLI approval settings", "config/cli-approvals", "codex:default|auto-review|never|bypass codexSandbox:read-only|workspace-write|danger-full-access antigravity:default|bypass antigravityMode:default|auto|accept-edits|plan claude:manual|auto|accept-edits|dont-ask|plan|bypass");
for (const field of actions[actions.length - 1].fields) {
  field.group = field.key.startsWith("codex") ? "Codex" : field.key.startsWith("antigravity") ? "Antigravity" : "Claude";
  field.label = field.key === "codexSandbox" ? "Sandbox" : field.key === "antigravityMode" ? "Mode" : "Policy";
}
add("Tools", "Check for updates", "update/status", "refresh#=1", "GET");
add("Tools", "Apply update", "update/apply", "", "POST", true);
add("Tools", "Update progress", "update/progress", "", "GET");

export const dashboardActions: readonly Action[] = actions;

export function parseValues(action: Action, values: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of action.fields) {
    const value = values[field.key] ?? "";
    if (!value.trim()) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (field.multiple) {
      const selected: unknown = JSON.parse(value);
      if (!Array.isArray(selected) || selected.some((item) => typeof item !== "string" || !field.choices?.includes(item))) throw new Error(`${field.label}: choose items from the list`);
      if (field.required && !selected.length) throw new Error(`${field.label} is required`);
      result[field.key] = [...new Set(selected)];
      continue;
    }
    if (field.choices && !field.allowCustom && !field.choices.includes(value)) throw new Error(`${field.label}: choose ${field.choices.join(", ")}`);
    if (field.kind === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number`);
      result[field.key] = number;
    } else if (field.kind === "boolean") {
      if (value !== "true" && value !== "false") throw new Error(`${field.label} must be true or false`);
      result[field.key] = value === "true";
    } else if (field.kind === "json") {
      result[field.key] = JSON.parse(value);
    } else {
      result[field.key] = value;
    }
  }
  return result;
}
