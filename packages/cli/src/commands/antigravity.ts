import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { antigravityRulesSection, patchManagedSection } from "@agent-bridge/adapters";
import { firstLineSummary } from "@agent-bridge/core";
import {
  adoptContinuationTask,
  endAgentSession,
  ensureWorkspace,
  openStore,
  readConfig,
  redactIfEnabled,
  rememberSessionTask,
  rememberSessionWindowHandle,
  setCurrentTask,
  startAgentSession,
  writeCompiledContextFor,
  writeConfig,
  writeCurrentTaskArtifact,
  writeNoCurrentTaskArtifact,
} from "../workspace.js";
import {
  applyTaskLabelSuggestion,
  firstTaskLabelSource,
  placeholderTaskTitle,
  rememberTaskLabelSource,
} from "../task-suggestions.js";

export const ANTIGRAVITY_HOOK_VERSION = "2026-08-15.agy-windows-encoded-command.v2";
const ANTIGRAVITY_HOOK_VERSION_PREFIX = "agent-bridge-hook-version:";
const HOOK_SCRIPT_NAME = "agent-bridge-antigravity-hook.ps1";
// The named entry agy reads our handlers from. Other named hooks in the same
// hooks.json belong to the user (or another plugin) and are preserved as-is.
const HOOK_NAME = "agent-bridge";
// agy's customization root. It also accepts .agent/_agents/_agent, but a fresh
// install has to pick one, and `.agents/` is the documented default.
const CUSTOMIZATION_DIR = ".agents";

// agy exposes no SessionStart/SessionEnd and no prompt text: PreInvocation
// fires before each model call, Stop when the execution loop terminates. Both
// carry only `conversationId` plus paths, so the prompt and the reply are read
// back out of the transcript rather than the payload.
type AntigravityHookInput = {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  invocationNum?: number;
  executionNum?: number;
  terminationReason?: string;
  error?: string;
  cwd?: string;
};

// The transcript is JSONL, one step per line, protojson-ish snake_case: the
// user's turn is `type: "USER_INPUT"` wrapped in <USER_REQUEST>, the model's
// prose is `type: "PLANNER_RESPONSE"` with a `content` string (tool-only steps
// have `tool_calls` and no content).
type TranscriptStep = {
  source?: string;
  type?: string;
  content?: string;
};

type AntigravityProcessRunner = (args: string[], cwd: string) => number;

export function registerAntigravity(program: Command): void {
  const antigravity = program
    .command("antigravity")
    .description("Antigravity (agy) lifecycle integration helpers");

  antigravity
    .command("install-hooks")
    .description("Install local agy lifecycle hooks for this project")
    .option("--project <path>", "project path", process.cwd())
    .action((options: { project: string }) => {
      console.log(installAntigravityHooks(resolve(options.project)).join("\n"));
    });

  antigravity
    .command("run")
    .description("Run agy interactively with a Work Board session")
    .allowUnknownOption(true)
    .argument("[agyArgs...]", "arguments passed to agy")
    .action((agyArgs: string[] = []) => {
      process.exitCode = runManagedAntigravity(process.cwd(), agyArgs);
    });

  antigravity
    .command("hook", { hidden: true })
    .description("Internal agy hook receiver")
    .option("--event <event>", "agy hook event")
    .action(async (options: { event?: string }) => {
      const output = handleAntigravityHook(await readHookJson(), options.event);
      // agy parses stdout as JSON for every event, so an empty body is not an
      // option — the neutral answer is `{}` (allow the tool, allow the stop).
      console.log(JSON.stringify(output ?? {}));
    });
}

export function runManagedAntigravity(
  projectPath: string,
  args: string[],
  runProcess: AntigravityProcessRunner = defaultAntigravityProcessRunner,
): number {
  const cwd = resolve(projectPath);
  ensureWorkspace(cwd);
  const previousConfig = readConfig(cwd);
  const previousCurrentTaskId = previousConfig.currentTaskId;
  const previousAntigravityTaskId = previousConfig.currentTasks?.antigravity;
  const sessionId = `antigravity-managed-${randomUUID()}`;
  const store = openStore(cwd);
  let taskId: string;
  const previousTask = previousCurrentTaskId
    ? store.getTask(previousCurrentTaskId)
    : undefined;
  try {
    const ensuredTaskId = ensureAntigravitySession(store, cwd, sessionId, {});
    if (!ensuredTaskId) throw new Error("Could not create a managed Antigravity session.");
    taskId = ensuredTaskId;
    store.updateTask(taskId, { status: "in_progress" });
    rememberSessionTask(sessionId, taskId, cwd);
    setCurrentTask(taskId, cwd, "antigravity");
  } finally {
    store.close();
  }

  let exitCode: number | undefined;
  let failure: unknown;
  try {
    exitCode = runProcess(args, cwd);
    return exitCode;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const finalStore = openStore(cwd);
    try {
      finalStore.recordSessionEvent({
        sessionId,
        taskId,
        agent: "antigravity",
        kind: "session_ended",
        summary: failure
          ? `Managed agy failed: ${oneLine(failure instanceof Error ? failure.message : String(failure), 120)}`
          : `Managed agy exited with code ${exitCode ?? 1}.`,
      });
      endAgentSession(sessionId, cwd);
      const config = readConfig(cwd);
      if (config.currentTaskId === taskId) {
        const currentTasks = { ...(config.currentTasks ?? {}) };
        if (currentTasks.antigravity === taskId) {
          if (previousAntigravityTaskId) currentTasks.antigravity = previousAntigravityTaskId;
          else delete currentTasks.antigravity;
        }
        writeConfig(
          { ...config, currentTaskId: previousCurrentTaskId, currentTasks },
          cwd,
        );
        if (previousTask) writeCurrentTaskArtifact(previousTask, cwd);
        else writeNoCurrentTaskArtifact(cwd);
      }
    } finally {
      finalStore.close();
    }
  }
}

function defaultAntigravityProcessRunner(args: string[], cwd: string): number {
  const child = spawnSync("agy", args, { cwd, stdio: "inherit", windowsHide: false });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

export function installAntigravityHooks(projectPath: string): string[] {
  ensureWorkspace(projectPath);
  const agentsDir = join(projectPath, CUSTOMIZATION_DIR);
  mkdirSync(agentsDir, { recursive: true });

  const script = join(agentsDir, HOOK_SCRIPT_NAME);
  writeFileSync(script, renderPowerShellHook(currentCliEntry()), "utf8");

  const hooksPath = join(agentsDir, "hooks.json");
  const existing = readJson(hooksPath);
  // PreInvocation and Stop are flat handler lists (matchers are ignored for
  // them). Only tool events use the matcher/hooks wrapper — and we install none,
  // because a node process per tool call would slow the whole agent loop down
  // for events whose payload carries neither the tool name nor the file path.
  const next = {
    ...existing,
    [HOOK_NAME]: {
      enabled: true,
      version: ANTIGRAVITY_HOOK_VERSION,
      PreInvocation: [handler(encodedPowerShellHookCommand(script, "PreInvocation"))],
      Stop: [handler(encodedPowerShellHookCommand(script, "Stop"))],
    },
  };
  writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  const rulesPath = writeAntigravityRules(projectPath);
  return [
    "Installed Antigravity (agy) hooks for agent-bridge.",
    `Project: ${projectPath}`,
    `Hook version: ${ANTIGRAVITY_HOOK_VERSION}`,
    `Hook script: ${script}`,
    `Hooks: ${hooksPath}`,
    `Rules: ${rulesPath}`,
    "",
    "Start a new agy session in this project; it shows up on the Work Board on its first model call.",
    "If agy does not load local hooks (notably on Windows), use: agent-bridge antigravity run",
  ];
}

// agy discovers `.agents/rules/*.md` on its own, so this is the only place we
// can tell it which agent name to use without touching the codex-facing
// AGENTS.md. Managed-section patched so a user's own notes in the file survive.
export function writeAntigravityRules(projectPath: string): string {
  const rulesDir = join(projectPath, CUSTOMIZATION_DIR, "rules");
  mkdirSync(rulesDir, { recursive: true });
  const rulesPath = join(rulesDir, "agent-bridge.md");
  patchManagedSection(rulesPath, antigravityRulesSection());
  const rules = readFileSync(rulesPath, "utf8");
  if (!rules.startsWith("---\n") && !rules.startsWith("---\r\n")) {
    writeFileSync(
      rulesPath,
      `---\ntrigger: always_on\ndescription: Agent Bridge lifecycle and work rules for Antigravity CLI\n---\n\n${rules}`,
      "utf8",
    );
  } else if (!/^---\r?\n[\s\S]*?\r?\n---/.exec(rules)?.[0].includes("trigger: always_on")) {
    writeFileSync(
      rulesPath,
      rules.replace(/^---\r?\n/, "---\ntrigger: always_on\n"),
      "utf8",
    );
  }
  return rulesPath;
}

export function getAntigravityHookStatus(projectPath = process.cwd()): {
  installed: boolean;
  current: boolean;
  installedVersion?: string;
  expectedVersion: string;
  hookPath: string;
} {
  const hookPath = join(projectPath, CUSTOMIZATION_DIR, "hooks.json");
  const status = { expectedVersion: ANTIGRAVITY_HOOK_VERSION, hookPath };
  if (!existsSync(hookPath)) return { installed: false, current: false, ...status };
  const entry = readJson(hookPath)[HOOK_NAME];
  if (!entry || typeof entry !== "object") return { installed: false, current: false, ...status };
  const installedVersion = (entry as Record<string, unknown>).version;
  const version = typeof installedVersion === "string" ? installedVersion : undefined;
  // The script is what actually runs; a hooks.json pointing at a deleted script
  // is worse than one that was never installed, so report it as not installed.
  if (!existsSync(join(projectPath, CUSTOMIZATION_DIR, HOOK_SCRIPT_NAME))) {
    return { installed: false, current: false, installedVersion: version, ...status };
  }
  // Without the rules file agy follows AGENTS.md and registers itself as codex,
  // so an install missing it is not a working install.
  const rulesInstalled = existsSync(
    join(projectPath, CUSTOMIZATION_DIR, "rules", "agent-bridge.md"),
  );
  return {
    installed: true,
    current: rulesInstalled && version === ANTIGRAVITY_HOOK_VERSION,
    installedVersion: version,
    ...status,
  };
}

export function handleAntigravityHook(
  input: AntigravityHookInput,
  forcedEvent?: string,
): Record<string, unknown> | undefined {
  // Spawned runs are already tracked in agent_runs by the orchestrator; letting
  // them through would create a second, session-shaped task for the same work.
  if (process.env.AGENT_BRIDGE_SPAWNED_RUN) return undefined;

  const cwd = resolveWorkspacePath(input);
  const event = forcedEvent ?? "PreInvocation";
  ensureWorkspace(cwd);

  const store = openStore(cwd);
  try {
    const sessionId =
      process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID?.trim() ||
      input.conversationId?.trim() ||
      readConfig(cwd).currentSessions?.antigravity ||
      `antigravity-${randomUUID()}`;
    const taskId = ensureAntigravitySession(store, cwd, sessionId, input);
    if (!taskId) return undefined;

    if (event === "Stop") {
      const reply = readLastAssistantMessage(input.transcriptPath);
      if (reply) {
        const compact =
          reply.length > 1200 ? `${reply.slice(0, 1200).trim()}\n...[truncated]` : reply;
        store.upsertLatestMemory(
          {
            taskId,
            type: "note",
            content: redactIfEnabled(`Antigravity latest response: ${compact}`, cwd),
            summary: redactIfEnabled(
              `Antigravity latest response: ${firstLineSummary(compact)}`,
              cwd,
            ),
            importance: 3,
            sourceAgent: "antigravity",
            tags: ["antigravity", "stop", "latest-response"],
          },
          {
            latestTag: "latest-response",
            legacyContentPrefix: "Antigravity latest response:",
          },
        );
      }
      const source = firstTaskLabelSource(store, taskId);
      const task = source
        ? applyTaskLabelSuggestion(store, taskId, { titleText: source, goalText: source })
        : store.getTask(taskId);
      if (task) writeCurrentTaskArtifact(task, cwd);
      store.recordSessionEvent({
        sessionId,
        taskId,
        agent: "antigravity",
        kind: "assistant_summary",
        summary: input.error
          ? `Antigravity turn ended with an error: ${oneLine(input.error, 120)}`
          : "Antigravity completed a turn.",
      });
      return {};
    }

    // PreInvocation / PostInvocation: the user's prompt is already on disk by
    // the time the model is called, so the transcript is what names the task.
    const prompt = readLastUserPrompt(input.transcriptPath);
    // A prompt that continues another agent's unfinished task must land on that
    // task, so its handoff reaches the compile below.
    const activeTaskId = prompt
      ? adoptContinuationTask(store, cwd, {
          prompt,
          agent: "antigravity",
          sessionId,
          currentTaskId: taskId,
        }).taskId ?? taskId
      : taskId;
    if (prompt) rememberTaskLabelSource(store, activeTaskId, redactIfEnabled(prompt, cwd), "antigravity");
    store.updateTask(activeTaskId, { status: "in_progress" });
    rememberSessionTask(sessionId, activeTaskId, cwd);
    setCurrentTask(activeTaskId, cwd, "antigravity");
    // agy gets no injected context either: the file it is told to read has to be
    // recompiled for this agent on every turn, not once at session start.
    writeCompiledContextFor(store, cwd, activeTaskId, "antigravity");
    return {};
  } finally {
    store.close();
  }
}

// Resolve the live task for this conversation, creating one (and the session
// events that put it on the Work Board) the first time we see the id. Any hook
// event can be the first one we receive, so this must be idempotent.
function ensureAntigravitySession(
  store: ReturnType<typeof openStore>,
  cwd: string,
  sessionId: string,
  input: AntigravityHookInput,
): string | undefined {
  const config = readConfig(cwd);
  const knownTaskId = config.sessionTasks?.[sessionId];
  const knownTask = knownTaskId ? store.getTask(knownTaskId) : undefined;
  if (knownTask && knownTask.status !== "done" && knownTask.status !== "cancelled") {
    return knownTask.id;
  }

  // agy never tells us a session is over, so a finished conversation would stay
  // "live" on the Work Board forever. Closing the previous one when a new
  // conversation starts keeps at most one stale agy session visible.
  const previous = config.currentSessions?.antigravity;
  if (previous && previous !== sessionId) {
    const previousTaskId = config.sessionTasks?.[previous];
    store.recordSessionEvent({
      sessionId: previous,
      taskId: previousTaskId,
      agent: "antigravity",
      kind: "session_ended",
      summary: "Antigravity session replaced by a newer conversation.",
    });
    endAgentSession(previous, cwd);
  }

  const task = store.createTask({
    title: placeholderTaskTitle("antigravity"),
    ownerAgent: "antigravity",
  });
  startAgentSession(sessionId, task.id, cwd, "antigravity");
  rememberSessionWindowHandle(sessionId, task.id, "antigravity", cwd);
  store.recordSessionEvent({
    sessionId,
    taskId: task.id,
    agent: "antigravity",
    kind: "session_started",
    summary: input.modelName
      ? `Antigravity session started (${input.modelName}).`
      : "Antigravity session started.",
  });
  writeCurrentTaskArtifact(task, cwd);
  return task.id;
}

// The hook command runs with its working directory set to the folder holding
// hooks.json (`<project>/.agents`), so process.cwd() alone would open a store
// one level below the project.
function resolveWorkspacePath(input: AntigravityHookInput): string {
  const fromPayload = input.cwd || input.workspacePaths?.find((path) => path.trim());
  if (fromPayload) return resolve(fromPayload);
  const here = process.cwd();
  return basename(here) === CUSTOMIZATION_DIR ? dirname(here) : here;
}

function readLastAssistantMessage(transcriptPath?: string): string | undefined {
  return lastTranscriptContent(
    transcriptPath,
    (step) => step.source === "MODEL" && step.type === "PLANNER_RESPONSE",
  );
}

function readLastUserPrompt(transcriptPath?: string): string | undefined {
  const raw = lastTranscriptContent(transcriptPath, (step) => step.type === "USER_INPUT");
  if (!raw) return undefined;
  // agy wraps the typed prompt in <USER_REQUEST> and appends metadata blocks
  // (local time, model changes) that would otherwise become the task title.
  const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw)?.[1] ?? raw;
  return request.replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, "").trim() || undefined;
}

function lastTranscriptContent(
  transcriptPath: string | undefined,
  match: (step: TranscriptStep) => boolean,
): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(line) as TranscriptStep;
    } catch {
      continue;
    }
    const content = step.content?.trim();
    if (content && match(step)) return content;
  }
  return undefined;
}

function handler(command: string): Record<string, unknown> {
  return { type: "command", command, timeout: 20 };
}

function encodedPowerShellHookCommand(script: string, event: string): string {
  const source = `& ${psString(script)} ${psString(event)}`;
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trim()}...` : flat;
}

function currentCliEntry(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

function readJson(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readHookJson(): Promise<AntigravityHookInput> {
  const encoded = process.env.AGENT_BRIDGE_HOOK_JSON_B64;
  if (encoded) {
    return JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8") || "{}",
    ) as AntigravityHookInput;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as AntigravityHookInput) : {};
}

function renderPowerShellHook(cli: string): string {
  return `# ${ANTIGRAVITY_HOOK_VERSION_PREFIX} ${ANTIGRAVITY_HOOK_VERSION}
$ErrorActionPreference = "SilentlyContinue"
try {
  # Read stdin as raw bytes: agy sends UTF-8 JSON, and decoding through
  # [Console]::In would apply the console code page and corrupt it.
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()
  $env:AGENT_BRIDGE_HOOK_JSON_B64 = [Convert]::ToBase64String($bytes)
  node "${cli.replace(/"/g, '`"')}" antigravity hook --event $args[0]
  $code = $LASTEXITCODE
  Remove-Item Env:\\AGENT_BRIDGE_HOOK_JSON_B64 -ErrorAction SilentlyContinue
  exit $code
} catch {
  # A hook that fails must never take the agent down with it.
  Write-Output "{}"
  exit 0
}
`;
}
