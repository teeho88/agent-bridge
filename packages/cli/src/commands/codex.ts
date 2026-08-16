import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { AgentRequest, AgentRequestType } from "@agent-bridge/memory";
import {
  adoptContinuationTask,
  ensureWorkspace,
  openStore,
  readConfig,
  redactIfEnabled,
  rememberSessionWindowHandle,
  rememberSessionTask,
  resolveActiveTaskId,
  setCurrentTask,
  startAgentSession,
  syncAgentSession,
  syncTerminalNativeSession,
  writeCompiledContextFor,
  writeCurrentTaskArtifact
} from "../workspace.js";
import {
  applyTaskLabelSuggestion,
  firstTaskLabelSource,
  placeholderTaskTitle,
  rememberTaskLabelSource,
} from "../task-suggestions.js";

type CodexHookInput = {
  cwd?: string;
  session_id?: string;
  thread_id?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  notification?: string;
  title?: string;
  notification_type?: string;
  notificationType?: string;
  type?: string;
  name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  tool?: { name?: string; input?: Record<string, unknown>; tool_input?: Record<string, unknown> };
  tool_use?: { name?: string; input?: Record<string, unknown>; tool_input?: Record<string, unknown> };
  toolUse?: { name?: string; input?: Record<string, unknown>; toolInput?: Record<string, unknown> };
  event?: string;
  hook_event_name?: string;
};

export function registerCodex(program: Command): void {
  const codex = program.command("codex").description("Codex lifecycle integration helpers");
  codex.command("install-hooks").option("--project <path>", "project path", process.cwd()).action((options: { project: string }) => {
    console.log(installCodexHooks(resolve(options.project)).join("\n"));
  });
  codex.command("hook", { hidden: true }).option("--event <event>", "Codex hook event").action(async (options: { event?: string }) => {
    const output = await handleCodexHook(await readHookJson(), options.event);
    writeHookOutput(output);
  });
}

export function installCodexHooks(projectPath: string): string[] {
  ensureWorkspace(projectPath);
  const codexDir = join(projectPath, ".codex");
  const hooksDir = join(codexDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const script = join(hooksDir, "agent-bridge-codex-hook.ps1");
  writeFileSync(script, renderPowerShellHook(currentCliEntry()), "utf8");
  const hooksPath = join(codexDir, "hooks.json");
  const existing = readJson(hooksPath);
  const hooks = (existing.hooks && typeof existing.hooks === "object" ? existing.hooks : {}) as Record<string, unknown>;
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
  for (const event of ["SessionStart", "UserPromptSubmit", "Notification", "PermissionRequest", "PostToolUse", "Stop"]) {
    const prior = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...prior.filter((entry) => !JSON.stringify(entry).includes("agent-bridge-codex-hook.ps1")), {
      hooks: [{
        type: "command",
        command: `node "${currentCliEntry()}" codex hook --event ${event}`,
        commandWindows: `${command} ${event}`,
        timeout: 10
      }]
    }];
  }
  writeFileSync(hooksPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`, "utf8");
  return ["Installed Codex hooks for agent-bridge.", `Project: ${projectPath}`, `Hooks: ${hooksPath}`, "Trust the project hook in Codex (/hooks), then start a new Codex thread."];
}

export async function handleCodexHook(input: CodexHookInput, forcedEvent?: string): Promise<Record<string, unknown> | undefined> {
  const cwd = input.cwd ? resolve(input.cwd) : process.cwd();
  const event = forcedEvent ?? codexHookEventName(input);
  // A Work Board launcher has already created the task/card for this terminal.
  // Keep that stable id instead of letting the CLI-native thread id fork a
  // second task when the first prompt arrives.
  const terminalSessionId = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID?.trim();
  const nativeSessionId = input.session_id || input.thread_id;
  const sessionId = terminalSessionId || nativeSessionId || readConfig(cwd).currentSessions?.codex || `codex-${randomUUID()}`;
  ensureWorkspace(cwd);
  const store = openStore(cwd);
  try {
    if (event === "SessionStart") {
      if (!terminalSessionId && !nativeSessionId) return undefined;
      if (terminalSessionId && nativeSessionId) {
        const transition = syncTerminalNativeSession(terminalSessionId, nativeSessionId, cwd);
        if (transition === "changed") {
          const previousTaskId = resolveCodexSessionTask(store, cwd, sessionId);
          if (previousTaskId) {
            const source = firstTaskLabelSource(store, previousTaskId);
            if (source) {
              applyTaskLabelSuggestion(store, previousTaskId, {
                titleText: source,
                goalText: source,
                status: "done",
              });
            } else {
              store.updateTask(previousTaskId, { status: "done" });
            }
            store.recordSessionEvent({
              sessionId,
              taskId: previousTaskId,
              agent: "codex",
              kind: "session_ended",
              summary: "Codex task completed when the terminal started a new thread.",
            });
          }
          const task = store.createTask({ title: placeholderTaskTitle("codex"), ownerAgent: "codex" });
          startAgentSession(sessionId, task.id, cwd, "codex");
          rememberSessionWindowHandle(sessionId, task.id, "codex", cwd);
          store.recordSessionEvent({
            sessionId,
            taskId: task.id,
            agent: "codex",
            kind: "session_started",
            summary: "Codex started a new task after /clear.",
          });
          writeCurrentTaskArtifact(task, cwd);
          return undefined;
        }
      }
      const needsTask = syncAgentSession(sessionId, cwd, "codex", store);
      const existingTaskId = resolveCodexSessionTask(store, cwd, sessionId);
      if (!needsTask && existingTaskId) {
        rememberSessionWindowHandle(sessionId, existingTaskId, "codex", cwd);
        store.recordSessionEvent({ sessionId, taskId: existingTaskId, agent: "codex", kind: "session_resumed", summary: "Codex session resumed." });
        return undefined;
      }
      // A new thread gets a provisional task immediately so it is visible before
      // Codex has a chance to run the task-start command from AGENTS.md.
      const task = store.createTask({ title: placeholderTaskTitle("codex"), ownerAgent: "codex" });
      startAgentSession(sessionId, task.id, cwd, "codex");
      rememberSessionWindowHandle(sessionId, task.id, "codex", cwd);
      store.recordSessionEvent({ sessionId, taskId: task.id, agent: "codex", kind: "session_started", summary: "Codex session started." });
      writeCurrentTaskArtifact(task, cwd);
      return undefined;
    }

    let taskId = resolveCodexSessionTask(store, cwd, sessionId) ?? resolveActiveTaskId(store, cwd, undefined, "codex");

    if (event === "UserPromptSubmit") {
      const prompt = (input.prompt || input.user_prompt || "").trim();
      // The prompt may be continuing a task another agent left a handoff on;
      // adopting it here is what makes that handoff reachable from Codex.
      if (prompt) {
        taskId = adoptContinuationTask(store, cwd, {
          prompt,
          agent: "codex",
          sessionId,
          currentTaskId: taskId,
        }).taskId;
      }
      if (!taskId) {
        if (!prompt) return undefined;
        const task = store.createTask({ title: placeholderTaskTitle("codex"), ownerAgent: "codex" });
        taskId = task.id;
        startAgentSession(sessionId, task.id, cwd, "codex");
        rememberSessionWindowHandle(sessionId, task.id, "codex", cwd);
        store.recordSessionEvent({ sessionId, taskId: task.id, agent: "codex", kind: "session_started", summary: "Codex session started." });
      }
      if (prompt) rememberTaskLabelSource(store, taskId, redactIfEnabled(prompt, cwd), "codex");
      const task = store.updateTask(taskId, { status: "in_progress" });
      rememberSessionTask(sessionId, taskId, cwd);
      rememberSessionWindowHandle(sessionId, taskId, "codex", cwd);
      setCurrentTask(taskId, cwd, "codex");
      store.recordSessionEvent({ sessionId, taskId, agent: "codex", kind: "prompt_submitted", summary: "Codex received a prompt." });
      if (task) writeCurrentTaskArtifact(task, cwd);
      // Codex reads .agent-memory/compiled-context.md instead of receiving
      // injected context, so refresh it on every prompt — otherwise it keeps
      // the compile from session start, or whatever another agent wrote there.
      writeCompiledContextFor(store, cwd, taskId, "codex");
      return undefined;
    }

    if (!taskId) return undefined;

    if (event === "Notification" || event === "PermissionRequest") {
      createRequestFromCodexNotification(store, cwd, sessionId, taskId, input, event);
      return undefined;
    }

    if (event === "PostToolUse") {
      resolveAcceptedCodexToolRequest(store, sessionId, taskId, input);
      return undefined;
    }

    if (event === "Stop") {
      const source = firstTaskLabelSource(store, taskId);
      const task = source
        ? applyTaskLabelSuggestion(store, taskId, { titleText: source, goalText: source })
        : store.getTask(taskId);
      if (task) writeCurrentTaskArtifact(task, cwd);
      store.recordSessionEvent({ sessionId, taskId, agent: "codex", kind: "assistant_summary", summary: "Codex completed a turn." });
    }
    return undefined;
  } finally { store.close(); }
}

function resolveCodexSessionTask(
  store: ReturnType<typeof openStore>,
  cwd: string,
  sessionId: string,
): string | null {
  const taskId = readConfig(cwd).sessionTasks?.[sessionId];
  const task = taskId ? store.getTask(taskId) : undefined;
  return task && task.status !== "done" && task.status !== "cancelled" ? task.id : null;
}

function createRequestFromCodexNotification(
  store: ReturnType<typeof openStore>,
  cwd: string,
  sessionId: string,
  taskId: string,
  input: CodexHookInput,
  event?: string,
): AgentRequest | undefined {
  const message = codexNotificationMessage(input, event);
  if (!message) return undefined;
  const redactedMessage = redactIfEnabled(message, cwd);
  const type = classifyCodexNotification(redactedMessage, input, event);
  const title = titleFromCodexNotification(type);
  const payload = codexNotificationPayload(type, input);
  const duplicate = store.listAgentRequests({ taskId, status: "pending", limit: 50 })
    .find((request) =>
      request.agent === "codex" &&
      request.sessionId === sessionId &&
      request.type === type && (
        (request.title === title && request.payload === payload) ||
        Boolean(codexToolName(input) && payloadHasTool(request.payload, codexToolName(input)!))
      )
    );
  if (duplicate) return duplicate;
  const request = store.createAgentRequest({ taskId, sessionId, agent: "codex", type, title, payload });
  store.recordSessionEvent({ sessionId, taskId, agent: "codex", kind: "request_created", summary: request.title });
  return request;
}

function payloadHasTool(payload: string | undefined, toolName: string): boolean {
  if (!payload) return false;
  return payload.includes(`Tool: ${toolName}`) || payload.includes(`Tool:\n${toolName}`);
}
function codexNotificationMessage(input: CodexHookInput, event?: string): string | undefined {
  const toolName = codexToolName(input);
  const notificationType = codexNotificationType(input);
  const candidates = [
    input.message,
    input.notification,
    input.title,
    typeof input.prompt === "string" ? input.prompt : undefined,
    toolName ? `Permission request for ${toolName}.` : undefined,
    event === "PermissionRequest" ? "Permission request." : undefined,
    notificationType?.includes("permission") ? "Permission request." : undefined,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return undefined;
}

function classifyCodexNotification(message: string, input: CodexHookInput, event?: string): AgentRequestType {
  const toolName = codexToolName(input);
  const text = `${message} ${toolName ?? ""} ${codexNotificationType(input) ?? ""} ${event ?? ""}`.toLowerCase();
  if (/\b(permission|approve|approval|allow|authorize|confirm|run command|execute|bash|write|edit)\b/.test(text)) {
    return toolName === "Bash" ? "command" : "approval";
  }
  return "question";
}

function titleFromCodexNotification(type: AgentRequestType): string {
  return type === "question" ? "Codex question" : type === "command" ? "Codex command request" : "Codex tool request";
}

function codexNotificationPayload(type: AgentRequestType, input: CodexHookInput): string {
  const notificationType = codexNotificationType(input);
  const toolName = codexToolName(input);
  const details = [
    section("Agent", "codex"),
    section("Request type", type),
    notificationType ? section("Notification type", notificationType) : undefined,
    toolName ? section("Tool", toolName) : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.join("\n\n");
}

function section(label: string, value: string): string {
  return `${label}:\n${value.trim()}`;
}

function resolveAcceptedCodexToolRequest(
  store: ReturnType<typeof openStore>,
  sessionId: string,
  taskId: string,
  input: CodexHookInput,
): void {
  const toolName = codexToolName(input);
  if (!toolName) return;
  const request = store.listAgentRequests({ taskId, status: "pending", limit: 100 })
    .find((candidate) =>
      candidate.agent === "codex" &&
      candidate.sessionId === sessionId &&
      (candidate.type === "approval" || candidate.type === "command") &&
      payloadHasTool(candidate.payload, toolName)
    );
  if (!request) return;
  const resolved = store.resolveAgentRequest(request.id, "accepted", `Accepted directly in Codex: ${toolName} completed.`);
  if (!resolved) return;
  store.recordSessionEvent({ sessionId, taskId, agent: "codex", kind: "request_resolved", summary: `${resolved.title}: accepted in Codex` });
}

function codexHookEventName(input: CodexHookInput): string | undefined { return firstString(input.hook_event_name, input.event); }
function codexNotificationType(input: CodexHookInput): string | undefined { return firstString(input.notification_type, input.notificationType, input.type); }
function codexToolName(input: CodexHookInput): string | undefined {
  return firstString(input.tool_name, input.toolName, input.tool?.name, input.tool_use?.name, input.toolUse?.name, input.name);
}
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}
function oneLine(text: string, max: number): string { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max).trim()}...` : flat; }
function currentCliEntry(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js"); }
function readJson(path: string): Record<string, unknown> { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {}; } catch { return {}; } }
async function readHookJson(): Promise<CodexHookInput> { const encoded = process.env.AGENT_BRIDGE_HOOK_JSON_B64; if (encoded) return JSON.parse(Buffer.from(encoded, "base64").toString("utf8") || "{}") as CodexHookInput; const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks).toString("utf8").trim(); return raw ? JSON.parse(raw) as CodexHookInput : {}; }

function writeHookOutput(output: Record<string, unknown> | undefined): void {
  if (!output) return;
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
  const body = { ...output };
  delete body.exitCode;
  if (Object.keys(body).length > 0) console.log(JSON.stringify(body));
  if (exitCode !== undefined) process.exitCode = exitCode;
}

function renderPowerShellHook(cli: string): string {
  return `$ErrorActionPreference = "SilentlyContinue"
try {
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()
  $env:AGENT_BRIDGE_HOOK_JSON_B64 = [Convert]::ToBase64String($bytes)
  node "${cli.replace(/"/g, '`"')}" codex hook --event $args[0]
  $code = $LASTEXITCODE
  Remove-Item Env:\\AGENT_BRIDGE_HOOK_JSON_B64 -ErrorAction SilentlyContinue
  exit $code
} catch {
  exit 0
}
`;
}



