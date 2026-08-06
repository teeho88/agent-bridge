import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { compileContext } from "@agent-bridge/core";
import { isGraphSourceFile, renderRepoMap } from "@agent-bridge/memory";
import type { AgentRequest, AgentRequestType, CreateHandoffInput, Handoff } from "@agent-bridge/memory";
import { refreshBriefs } from "../graph-brief.js";
import { writeHandoffArtifacts } from "./handoff.js";
import { applyTaskLabelSuggestion } from "../task-suggestions.js";
import {
  ensureWorkspace,
  endAgentSession,
  consumePendingNewTask,
  openStore,
  paths,
  policyBudgets,
  readConfig,
  redactIfEnabled,
  rememberSessionWindowHandle,
  rememberSessionTask,
  resolveActiveTaskId,
  resolveCurrentTaskId,
  setCurrentTask,
  syncAgentSession,
  syncCurrentTaskArtifact,
  writeCurrentTaskArtifact,
} from "../workspace.js";

export const CLAUDE_HOOK_VERSION = "2026-06-30.permission-request-display.v1";
const CLAUDE_HOOK_VERSION_PREFIX = "agent-bridge-hook-version:";

type ClaudeHookInput = {
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [key: string]: unknown };
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  last_assistant_message?: string;
  compact_summary?: string;
  message?: string;
  notification?: string;
  title?: string;
  notification_type?: string;
};

export function registerClaude(program: Command): void {
  const claude = program
    .command("claude")
    .description("Claude Code integration helpers");

  claude
    .command("install-hooks")
    .description("Install local Claude Code hooks for this project")
    .option("--project <path>", "project path", process.cwd())
    .option("--settings <file>", "settings file name", "settings.local.json")
    .action((options: { project: string; settings: string }) => {
      const project = resolve(options.project);
      const result = installClaudeHooks(project, options.settings);
      console.log(result.join("\n"));
    });

  claude
    .command("hook", { hidden: true })
    .description("Internal Claude Code hook receiver")
    .action(async () => {
      const input = await readStdinJson();
      const output = handleClaudeHook(input);
      writeHookOutput(output);
    });
}

export function installClaudeHooks(
  projectPath: string,
  settingsFile = "settings.local.json",
): string[] {
  ensureWorkspace(projectPath);
  const claudeDir = join(projectPath, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const hookScript = join(hooksDir, "agent-bridge-claude-hook.ps1");
  const cliEntry = currentCliEntry();
  writeFileSync(hookScript, renderPowerShellHook(cliEntry), "utf8");

  const settingsPath = join(claudeDir, settingsFile);
  const settings = readJsonFile(settingsPath);
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${hookScript}"`;
  const nextSettings = withAgentBridgeHooks(settings, command);
  writeFileSync(
    settingsPath,
    `${JSON.stringify(nextSettings, null, 2)}\n`,
    "utf8",
  );

  return [
    "Installed Claude Code hooks for agent-bridge.",
    `Project: ${projectPath}`,
    `Hook version: ${CLAUDE_HOOK_VERSION}`,
    `Hook script: ${hookScript}`,
    `Settings: ${settingsPath}`,
    "",
    "Restart Claude Code in this project, or run /hooks to verify the hooks are active.",
  ];
}

export function getClaudeHookStatus(projectPath = process.cwd()): {
  installed: boolean;
  current: boolean;
  installedVersion?: string;
  expectedVersion: string;
  hookPath: string;
} {
  const hookPath = join(projectPath, ".claude", "hooks", "agent-bridge-claude-hook.ps1");
  if (!existsSync(hookPath)) {
    return { installed: false, current: false, expectedVersion: CLAUDE_HOOK_VERSION, hookPath };
  }
  let text = "";
  try {
    text = readFileSync(hookPath, "utf8");
  } catch {
    return { installed: true, current: false, expectedVersion: CLAUDE_HOOK_VERSION, hookPath };
  }
  const versionMatch = new RegExp(`${CLAUDE_HOOK_VERSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*([^\\r\\n]+)`).exec(text);
  const installedVersion = versionMatch?.[1]?.trim();
  return {
    installed: true,
    current: installedVersion === CLAUDE_HOOK_VERSION,
    installedVersion,
    expectedVersion: CLAUDE_HOOK_VERSION,
    hookPath
  };
}

export function handleClaudeHook(
  input: ClaudeHookInput,
): Record<string, unknown> | undefined {
  // An agent spawned by the orchestrator/dispatch runs inside the same
  // workspace, so it fires these hooks too — but it is not a human starting
  // a piece of work. Letting it through would create a task named after the
  // leader's own prompt and hijack the active-task slot from the
  // orchestration that spawned it (which then blanks the Orchestrator board,
  // since that board is keyed off the active task). The run is already
  // tracked in agent_runs by spawnAgentRun, so there is nothing to record
  // here — stay completely read-only for these.
  if (process.env.AGENT_BRIDGE_SPAWNED_RUN) return undefined;

  const cwd = input.cwd ? resolve(input.cwd) : process.cwd();
  ensureWorkspace(cwd);

  const store = openStore(cwd);
  try {
    const eventName = input.hook_event_name;
    if (eventName === "SessionStart") {
      if (input.session_id && syncAgentSession(input.session_id, cwd, "claude", store)) {
        store.recordSessionEvent({
          sessionId: input.session_id,
          agent: "claude",
          kind: "session_started",
          summary: "Claude session started; awaiting its first prompt."
        });
        return undefined;
      }
      const taskId = resolveClaudeSessionTask(store, cwd, input.session_id);
      if (input.session_id) {
        store.recordSessionEvent({
          sessionId: input.session_id,
          taskId: taskId ?? undefined,
          agent: "claude",
          kind: "session_started",
          summary: "Claude session resumed."
        });
      }
      if (!taskId) return undefined;
      markTaskInProgress(store, taskId);
      activateClaudeTask(store, cwd, taskId);
      if (input.session_id) {
        rememberSessionWindowHandle(input.session_id, taskId, "claude", cwd);
      }
      return contextOutput(store, cwd, eventName, taskId);
    }

    if (eventName === "UserPromptSubmit") {
      const rawPrompt = input.prompt?.trim();
      if (!rawPrompt) return undefined;
      const prompt = redactIfEnabled(rawPrompt, cwd);
      const pendingNewTask = consumePendingNewTask(cwd, "claude");
      const sharedSessionTask = isClaudeSessionTaskShared(cwd, input.session_id);
      let taskId = pendingNewTask || sharedSessionTask
        ? null
        : resolveClaudeSessionTask(store, cwd, input.session_id);
      if (!taskId) {
        const task = store.createTask({
          title: titleFromPrompt(prompt),
          goal: prompt,
          ownerAgent: "claude",
        });
        taskId = task.id;
      }
      markTaskInProgress(store, taskId);
      activateClaudeTask(store, cwd, taskId);
      rememberSessionTask(input.session_id, taskId, cwd);
      if (input.session_id) {
        rememberSessionWindowHandle(input.session_id, taskId, "claude", cwd);
      }
      const promptEvent = input.session_id
        ? store.recordSessionEvent({
            sessionId: input.session_id,
            taskId,
            agent: "claude",
            kind: "prompt_submitted",
            summary: "Claude received a user prompt."
          })
        : undefined;
      captureRepoMemory(store, cwd, prompt, "user-instruction", taskId, promptEvent?.id);
      return contextOutput(store, cwd, eventName, taskId);
    }

    if (eventName === "TaskCreated") {
      const rawSubject = input.task_subject?.trim();
      if (!rawSubject) return undefined;
      const subject = redactIfEnabled(rawSubject, cwd);
      const description = input.task_description
        ? redactIfEnabled(input.task_description, cwd)
        : undefined;
      const task = store.createTask({
        title: subject,
        goal: description,
        ownerAgent: "claude",
      });
      markTaskInProgress(store, task.id);
      activateClaudeTask(store, cwd, task.id);
      rememberSessionTask(input.session_id, task.id, cwd);
      if (input.session_id) {
        rememberSessionWindowHandle(input.session_id, task.id, "claude", cwd);
      }
      const taskEvent = input.session_id
        ? store.recordSessionEvent({
            sessionId: input.session_id,
            taskId: task.id,
            agent: "claude",
            kind: "prompt_submitted",
            summary: "Claude created a task from the submitted task description."
          })
        : undefined;
      if (description) captureRepoMemory(store, cwd, description, "task-description", task.id, taskEvent?.id);
      store.addMemory({
        taskId: task.id,
        type: "task",
        content: description ? `${subject}: ${description}` : subject,
        importance: 5,
        sourceAgent: "claude",
        tags: ["claude-code", "task-created"],
      });
      return contextOutput(store, cwd, eventName, task.id);
    }

    if (eventName === "TaskCompleted") {
      const taskId = resolveClaudeSessionTask(store, cwd, input.session_id);
      if (!taskId) return undefined;
      const task = store.updateTaskStatus(taskId, "done");
      if (input.session_id) {
        store.recordSessionEvent({
          sessionId: input.session_id,
          taskId,
          agent: "claude",
          kind: "assistant_summary",
          summary: "Claude marked this task completed."
        });
      }
      if (task) {
        if (resolveCurrentTaskId(cwd, undefined, "claude") === taskId) {
          writeCurrentTaskArtifact(task, cwd);
        }
        writeCompiledContext(store, cwd, taskId);
      }
      store.addMemory({
        taskId,
        type: "handoff",
        content: redactIfEnabled(
          input.task_description ||
            input.task_subject ||
            "Claude Code marked task completed.",
          cwd,
        ),
        importance: 4,
        sourceAgent: "claude",
        tags: ["claude-code", "task-completed"],
      });
      return undefined;
    }

    if (eventName === "Notification" || eventName === "PermissionRequest") {
      createRequestFromClaudeNotification(store, cwd, input);
      return undefined;
    }

    if (eventName === "Stop" || eventName === "SessionEnd") {
      const taskId = resolveClaudeSessionTask(store, cwd, input.session_id) ??
        (input.session_id ? readConfig(cwd).sessionTasks?.[input.session_id] ?? null : null);
      if (!taskId) {
        if (eventName === "SessionEnd" && input.session_id) {
          store.recordSessionEvent({ sessionId: input.session_id, agent: "claude", kind: "session_ended", summary: "Claude session ended." });
          endAgentSession(input.session_id, cwd);
        }
        return undefined;
      }
      // Claude Code lazily writes a friendly session title into the transcript
      // (a `type:"summary"` line). It does not exist at task-creation time, so we
      // upgrade the provisional title to it here, on every turn, once it appears.
      maybeUpgradeTaskTitle(store, cwd, taskId, input.transcript_path);
      // Claude Code's Stop/SessionEnd payload does not include the assistant
      // text — only transcript_path. Fall back to reading the transcript so we
      // keep capturing each response, not just whatever rare event carries it.
      const summary =
        input.last_assistant_message?.trim() ||
        readLastAssistantMessage(input.transcript_path);
      if (summary) {
        const compact =
          summary.length > 1200
            ? `${summary.slice(0, 1200).trim()}\n...[truncated]`
            : summary;
        store.upsertLatestMemory(
          {
            taskId,
            type: "note",
            content: redactIfEnabled(`Claude latest response: ${compact}`, cwd),
            importance: 3,
            sourceAgent: "claude",
            tags: ["claude-code", eventName.toLowerCase(), "latest-response"],
          },
          {
            latestTag: "latest-response",
            legacyContentPrefix: "Claude latest response:",
          },
        );
        const summaryEvent = input.session_id
          ? store.recordSessionEvent({
              sessionId: input.session_id,
              taskId,
              agent: "claude",
              kind: "assistant_summary",
              summary: "Claude produced an assistant summary."
            })
          : undefined;
        captureTaskFindings(store, taskId, compact);
        captureRepoMemory(store, cwd, summary, "assistant-summary", taskId, summaryEvent?.id);
        // Mode C: auto-assemble a handoff from accumulated memory on every Stop,
        // so the next agent inherits a populated handoff without anyone typing it.
        // Skip if the latest handoff is a manual one — never clobber authored work.
        const latest = store.getLatestHandoff(taskId);
        if (!latest || latest.auto) {
          const handoff = store.upsertAutoHandoff(
            buildAutoHandoffInput(store, cwd, taskId, summary),
          );
          writeHandoffArtifacts(cwd, handoff);
        }
      }
      writeCompiledContext(store, cwd, taskId);
      // This must be the final event for the session: a SessionEnd may include a
      // last assistant summary, but the session is no longer live afterwards.
      if (eventName === "SessionEnd" && input.session_id) {
        store.recordSessionEvent({
          sessionId: input.session_id,
          taskId,
          agent: "claude",
          kind: "session_ended",
          summary: "Claude session ended."
        });
        endAgentSession(input.session_id, cwd);
      }
      return undefined;
    }

    if (eventName === "PostToolUse") {
      resolveAcceptedClaudeToolRequest(store, cwd, input);
      briefTouchedFile(store, cwd, input);
      return undefined;
    }

    if (eventName === "PostCompact") {
      const taskId = resolveClaudeSessionTask(store, cwd, input.session_id);
      const summary = input.compact_summary?.trim();
      if (taskId && summary) {
        store.addMemory({
          taskId,
          type: "note",
          content: redactIfEnabled(`Claude compact summary: ${summary}`, cwd),
          importance: 4,
          sourceAgent: "claude",
          tags: ["claude-code", "compact"],
        });
      }
      return undefined;
    }

    return undefined;
  } finally {
    store.close();
  }
}

function createRequestFromClaudeNotification(
  store: ReturnType<typeof openStore>,
  cwd: string,
  input: ClaudeHookInput,
): AgentRequest | undefined {
  const message = claudeNotificationMessage(input);
  if (!message) return undefined;
  if (isIgnoredClaudeNotification(input)) return undefined;
  const taskId = resolveClaudeSessionTask(store, cwd, input.session_id) ??
    resolveActiveTaskId(store, cwd, undefined, "claude") ??
    undefined;
  const redactedMessage = redactIfEnabled(message, cwd);
  const type = classifyClaudeNotification(redactedMessage, input);
  const title = titleFromClaudeNotification(type);
  const payload = claudeNotificationPayload(type, input);
  const duplicate = store.listAgentRequests({ taskId, status: "pending", limit: 50 })
    .find((request) =>
      request.agent === "claude" &&
      request.sessionId === input.session_id &&
      request.type === type && (
        (request.title === title && request.payload === payload) ||
        Boolean(input.tool_name && payloadHasTool(request.payload, input.tool_name))
      )
    );
  if (duplicate) return duplicate;
  const request = store.createAgentRequest({
    taskId,
    sessionId: input.session_id,
    agent: "claude",
    type,
    title,
    payload
  });
  store.recordSessionEvent({
    sessionId: input.session_id ?? "claude-notification",
    taskId,
    agent: "claude",
    kind: "request_created",
    summary: request.title
  });
  return request;
}

function payloadHasTool(payload: string | undefined, toolName: string): boolean {
  if (!payload) return false;
  return payload.includes(`Tool: ${toolName}`) || payload.includes(`Tool:\n${toolName}`);
}

function requestMentionsTool(request: AgentRequest, toolName: string): boolean {
  const haystack = `${request.title}\n${request.payload ?? ""}`.toLowerCase();
  return haystack.includes(toolName.toLowerCase());
}

function isGenericClaudePermissionRequest(request: AgentRequest): boolean {
  const haystack = `${request.title}\n${request.payload ?? ""}`.toLowerCase();
  return haystack.includes("claude needs your permission") ||
    haystack.includes("notification type:\npermission_prompt") ||
    haystack.includes("notification type: permission_prompt");
}

function isIgnoredClaudeNotification(input: ClaudeHookInput): boolean {
  return input.notification_type?.trim().toLowerCase() === "idle_prompt";
}

function claudeNotificationMessage(input: ClaudeHookInput): string | undefined {
  const candidates = [
    input.message,
    input.notification,
    input.title,
    typeof input.prompt === "string" ? input.prompt : undefined,
    input.tool_name ? `Permission request for ${input.tool_name}.` : undefined,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return undefined;
}

function classifyClaudeNotification(message: string, input: ClaudeHookInput): AgentRequestType {
  const text = `${message} ${input.tool_name ?? ""}`.toLowerCase();
  if (/\b(permission|approve|approval|allow|authorize|confirm|run command|execute|bash|write|edit)\b/.test(text)) {
    return input.tool_name === "Bash" ? "command" : "approval";
  }
  return "question";
}

function titleFromClaudeNotification(type: AgentRequestType): string {
  return type === "question" ? "Claude question" : type === "command" ? "Claude command request" : "Claude tool request";
}

function claudeNotificationPayload(type: AgentRequestType, input: ClaudeHookInput): string {
  const details = [
    section("Agent", "claude"),
    section("Request type", type),
    input.notification_type ? section("Notification type", input.notification_type) : undefined,
    input.tool_name ? section("Tool", input.tool_name) : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.join("\n\n");
}

function section(label: string, value: string): string {
  return `${label}:\n${value.trim()}`;
}

function writeHookOutput(output: Record<string, unknown> | undefined): void {
  if (!output) return;
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
  const body = { ...output };
  delete body.exitCode;
  if (Object.keys(body).length > 0) console.log(JSON.stringify(body));
  if (exitCode !== undefined) process.exitCode = exitCode;
}

function resolveAcceptedClaudeToolRequest(
  store: ReturnType<typeof openStore>,
  cwd: string,
  input: ClaudeHookInput,
): void {
  if (!input.tool_name) return;
  const toolName = input.tool_name;
  const taskId = resolveClaudeSessionTask(store, cwd, input.session_id) ??
    resolveActiveTaskId(store, cwd, undefined, "claude") ??
    undefined;
  const candidates = store.listAgentRequests({ status: "pending", limit: 100 })
    .filter((candidate) =>
      candidate.agent === "claude" &&
      (!input.session_id || !candidate.sessionId || candidate.sessionId === input.session_id) &&
      (!taskId || !candidate.taskId || candidate.taskId === taskId) &&
      (candidate.type === "approval" || candidate.type === "command")
    );
  const toolMatches = candidates.filter((candidate) =>
    payloadHasTool(candidate.payload, toolName) || requestMentionsTool(candidate, toolName)
  );
  const genericMatches = toolMatches.length
    ? candidates.filter(isGenericClaudePermissionRequest)
    : [];
  const requests = uniqueRequests([
    ...toolMatches,
    ...genericMatches,
    ...(toolMatches.length === 0 && candidates.length === 1 ? candidates : []),
  ]);
  for (const request of requests) {
    const resolved = store.resolveAgentRequest(
      request.id,
      "accepted",
      `Accepted directly in Claude Code: ${toolName} completed.`,
    );
    if (!resolved) continue;
    store.recordSessionEvent({
      sessionId: resolved.sessionId ?? input.session_id ?? "claude-request",
      taskId: resolved.taskId,
      agent: "claude",
      kind: "request_resolved",
      summary: `${resolved.title}: accepted in Claude Code`
    });
  }
}

function uniqueRequests(requests: AgentRequest[]): AgentRequest[] {
  const seen = new Set<string>();
  const out: AgentRequest[] = [];
  for (const request of requests) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    out.push(request);
  }
  return out;
}

function contextOutput(
  store: ReturnType<typeof openStore>,
  cwd: string,
  eventName: string,
  taskId?: string,
): Record<string, unknown> | undefined {
  const activeTaskId = taskId ?? resolveActiveTaskId(store, cwd, undefined, "claude");
  if (!activeTaskId) return undefined;
  const pack = writeCompiledContext(store, cwd, activeTaskId);
  const context = [
    "agent-bridge synced this Claude Code session.",
    `Current task: ${pack.task.title}`,
    "Use .agent-memory/compiled-context.md for compact project memory.",
    "When you discover durable facts, mention them clearly so the hook can persist them.",
  ].join("\n");

  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

function resolveClaudeSessionTask(
  store: ReturnType<typeof openStore>,
  cwd: string,
  sessionId: string | undefined,
): string | null {
  if (!sessionId) return resolveActiveTaskId(store, cwd, undefined, "claude");
  const taskId = readConfig(cwd).sessionTasks?.[sessionId];
  const task = taskId ? store.getTask(taskId) : undefined;
  return task && task.status !== "done" && task.status !== "cancelled" ? task.id : null;
}

// Older hook versions could map multiple Claude sessions to one task. Split
// that stale association on the next prompt so already-running sessions heal
// themselves instead of continuing to overwrite one another.
function isClaudeSessionTaskShared(cwd: string, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const sessionTasks = readConfig(cwd).sessionTasks ?? {};
  const taskId = sessionTasks[sessionId];
  return Boolean(taskId && Object.entries(sessionTasks).some(([id, value]) => id !== sessionId && value === taskId));
}

function captureRepoMemory(
  store: ReturnType<typeof openStore>,
  cwd: string,
  text: string,
  source: "user-instruction" | "task-description" | "assistant-summary",
  taskId?: string,
  sessionEventId?: string,
): void {
  if (readConfig(cwd).repoMemory?.autoCapture === false) return;
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => line.length >= 24 && line.length <= 700)
    .filter(isRepoWideInstruction)
    .slice(0, 3);
  for (const content of candidates) {
    const type = /decision|architecture|quyết định|kiến trúc/i.test(content) ? "decision" : "constraint";
    store.createMemoryCandidate({
      taskId,
      sessionEventId,
      type,
      content,
      importance: 4,
      tags: ["repo-memory", "auto-captured", source],
      sourceAgent: "claude",
    });
  }
}

function isRepoWideInstruction(text: string): boolean {
  return /\b(always|never|must|should not|do not|don't|only|require|architecture|convention|repository|repo)\b|\b(lưu ý|luôn|không bao giờ|bắt buộc|không được|chỉ dùng|quy ước|quy định|kiến trúc|toàn repo)\b/i.test(text);
}

function captureTaskFindings(
  store: ReturnType<typeof openStore>,
  taskId: string,
  summary: string,
): void {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => line.length >= 24)
    .filter((line) => /\b(fixed|implemented|root cause|decision|test|verified|constraint|risk|next)\b|\b(đã làm|đã sửa|nguyên nhân|quyết định|kiểm tra|xác minh|rủi ro|tiếp theo|hoàn tất)\b/i.test(line))
    .slice(0, 5);
  if (!lines.length) return;
  const content = lines.join("\n").slice(0, 1200);
  store.addMemory({
    taskId,
    type: "note",
    content,
    summary: content,
    importance: 4,
    tags: ["claude-code", "task-finding"],
    sourceAgent: "claude",
  });
}

function markTaskInProgress(store: ReturnType<typeof openStore>, taskId: string): void {
  if (store.getTask(taskId)?.status === "todo") store.updateTaskStatus(taskId, "in_progress");
}

function activateClaudeTask(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
): void {
  const task = store.getTask(taskId);
  if (!task) return;
  setCurrentTask(task.id, cwd, "claude");
  writeCurrentTaskArtifact(task, cwd);
}

function writeCompiledContext(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
) {
  const config = readConfig(cwd);
  syncCurrentTaskArtifact(store, taskId, cwd);
  const repoMap = config.graph?.injectRepoMap !== false && store.getGraphStats().files > 0
    ? renderRepoMap(store.buildRepoMap({ limit: config.graph?.repoMapLimit ?? 30 }))
    : undefined;
  const pack = compileContext(store, {
    taskId,
    agent: "claude",
    tokenBudget: config.tokenBudget,
    ...policyBudgets(cwd),
    repoMap,
  });
  writeFileSync(
    paths(cwd).compiledContext,
    `${pack.renderedMarkdown}\n`,
    "utf8",
  );
  const taskContextPath = join(paths(cwd).tasks, taskId, "compiled-context.md");
  mkdirSync(dirname(taskContextPath), { recursive: true });
  writeFileSync(taskContextPath, `${pack.renderedMarkdown}\n`, "utf8");
  return pack;
}

function withAgentBridgeHooks(
  settings: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const matchers: Record<string, string> = {
    SessionStart: "startup|resume",
    PostToolUse: "Edit|Write|MultiEdit|NotebookEdit|Read|Bash",
  };
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Notification",
    "PermissionRequest",
    "TaskCreated",
    "TaskCompleted",
    "Stop",
    "SessionEnd",
    "PostCompact",
  ];
  for (const eventName of events) {
    const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    hooks[eventName] = upsertHook(existing, matchers[eventName], command, 10);
  }
  return { ...settings, hooks, agentBridgeHookVersion: CLAUDE_HOOK_VERSION };
}

function upsertHook(
  existing: unknown[],
  matcher: string | undefined,
  command: string,
  timeout: number,
): unknown[] {
  const filtered = existing.filter(
    (entry) =>
      JSON.stringify(entry).includes("agent-bridge-claude-hook.ps1") === false,
  );
  const entry: Record<string, unknown> = {
    hooks: [{ type: "command", command, timeout }],
  };
  if (matcher) entry.matcher = matcher;
  return [...filtered, entry];
}

function renderPowerShellHook(cliEntry: string): string {
  return `# ${CLAUDE_HOOK_VERSION_PREFIX} ${CLAUDE_HOOK_VERSION}
$ErrorActionPreference = "SilentlyContinue"
try {
  # Read stdin as raw bytes. Claude Code sends UTF-8 JSON; decoding through
  # [Console]::In would apply the console code page (often not UTF-8) and
  # corrupt multibyte characters before we ever see them.
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()
  if ($bytes.Length -eq 0) { exit 0 }
  $env:AGENT_BRIDGE_HOOK_JSON_B64 = [Convert]::ToBase64String($bytes)
  node "${escapePowerShellPath(cliEntry)}" claude hook
  $code = $LASTEXITCODE
  Remove-Item Env:\\AGENT_BRIDGE_HOOK_JSON_B64 -ErrorAction SilentlyContinue
  exit $code
} catch {
  exit 0
}
`;
}

function currentCliEntry(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..", "index.js");
}

function titleFromPrompt(prompt: string): string {
  return prompt
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
    .replace(/[.?!,:;]+$/g, "");
}

// On every Edit/Write/Read, regenerate the brief for the touched file so the graph
// index stays warm for the handful of files a session works on repeatedly. Edits
// mark the file as task-edited (importance 4, promotes the task to in_progress);
// reads keep the lower read importance. Best-effort: any failure is swallowed so a
// brief never disrupts the agent's tool flow.
function briefTouchedFile(
  store: ReturnType<typeof openStore>,
  cwd: string,
  input: ClaudeHookInput,
): void {
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path;
  if (!toolName || !filePath) return;
  if (readConfig(cwd).graph?.autoBriefOnToolUse === false) return;
  const abs = resolve(
    filePath.startsWith("~") ? join(homedir(), filePath.slice(1)) : filePath,
  );
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) return;
  if (!isGraphSourceFile(rel) || !existsSync(abs)) return;
  try {
    if (statSync(abs).size > 1_000_000) return;
  } catch {
    return;
  }
  const edited = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName);
  const taskId = resolveClaudeSessionTask(store, cwd, input.session_id) ?? undefined;
  try {
    refreshBriefs(store, cwd, { paths: [rel], taskId, taskEdited: edited });
  } catch {
    // Briefing is best-effort; never break the tool that just ran.
  }
}

// Replace the provisional title (truncated first prompt) with Claude Code's own
// auto-generated session title once it lands in the transcript. Never clobbers a
// title set any other way — a manual rename or a TaskCreated subject won't match
// the provisional form, so it is left untouched.
function maybeUpgradeTaskTitle(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
  transcriptPath: string | undefined,
): void {
  const sessionTitle = readSessionTitle(transcriptPath);
  if (!sessionTitle) return;
  const task = store.getTask(taskId);
  if (!task || task.title === sessionTitle) return;
  const updated = applyTaskLabelSuggestion(store, taskId, { titleText: sessionTitle, replaceAutoTitle: true });
  if (updated && updated.title === sessionTitle) writeCurrentTaskArtifact(updated, cwd);
}

// Scan the transcript for Claude Code's auto-generated session title, stored as a
// `{"type":"summary","summary":"..."}` line. Returns the most recent one.
function readSessionTitle(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  const path = transcriptPath.startsWith("~")
    ? join(homedir(), transcriptPath.slice(1))
    : transcriptPath;
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; summary?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type === "summary" && typeof entry.summary === "string") {
      const title = entry.summary.replace(/\s+/g, " ").trim();
      if (title) return title;
    }
  }
  return undefined;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePowerShellPath(value: string): string {
  return value.replace(/`/g, "``").replace(/"/g, '`"');
}

// Heuristically assemble a handoff from what the store already knows about the
// current task — no LLM. summary = the latest assistant response; done = recent
// task title/goal; risks = recorded constraints; next = action bullets parsed
// from the response; filesChanged = git working-tree changes (empty if no repo).
function buildAutoHandoffInput(
  store: ReturnType<typeof openStore>,
  cwd: string,
  taskId: string,
  latestResponse: string,
): CreateHandoffInput {
  const memories = store.listMemoriesForTask(taskId, 120);
  const byTimeDesc = [...memories].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  const task = store.getTask(taskId);

  const taskLabel = task ? oneLine(task.goal || task.title, 100) : undefined;
  const done = taskLabel ? [`Handled task: ${taskLabel}`] : [];

  const risks = dedupeStrings(
    byTimeDesc
      .filter((m) => m.type === "constraint")
      .map((m) => oneLine(m.content, 120)),
  ).slice(0, 5);

  const next = nextActionsFromText(latestResponse);
  const filesChanged = gitChangedFiles(cwd);
  const summary =
    latestResponse.length > 800
      ? `${latestResponse.slice(0, 800).trim()}\n...[truncated]`
      : latestResponse;

  return {
    taskId,
    fromAgent: "claude",
    summary: redactIfEnabled(summary, cwd),
    done: done.map((d) => redactIfEnabled(d, cwd)),
    next: next.map((n) => redactIfEnabled(n, cwd)),
    risks: risks.map((r) => redactIfEnabled(r, cwd)),
    filesChanged,
  };
}

function nextActionsFromText(text: string): string[] {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim())
    .filter((line) =>
      /\b(next|todo|then|fix|add|implement|tiếp|còn|cần|sửa|làm)\b/i.test(line),
    );
  return dedupeStrings(bullets.map((b) => oneLine(b, 120))).slice(0, 5);
}

function gitChangedFiles(cwd: string): string[] {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trim()}…` : flat;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function readLastAssistantMessage(
  transcriptPath: string | undefined,
): string | undefined {
  if (!transcriptPath) return undefined;
  const path = transcriptPath.startsWith("~")
    ? join(homedir(), transcriptPath.slice(1))
    : transcriptPath;
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

async function readStdinJson(): Promise<ClaudeHookInput> {
  const encoded = process.env.AGENT_BRIDGE_HOOK_JSON_B64;
  if (encoded) {
    const raw = Buffer.from(encoded, "base64").toString("utf8").trim();
    return raw ? (JSON.parse(raw) as ClaudeHookInput) : {};
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as ClaudeHookInput) : {};
}



