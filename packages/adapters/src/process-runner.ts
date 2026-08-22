import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { redactSecrets } from "@agent-bridge/core";
import type { AgentRun, CreateAgentRunInput, MemoryStore } from "@agent-bridge/memory";
import type { AgentInvocation } from "./invocation.js";

const execFileAsync = promisify(execFile);

// Child processes spawned by THIS Node process, keyed by agent_runs.id. Only
// populated while the spawning process is alive — a fresh `agent-bridge`
// invocation always starts with an empty map, which is why stopAgentRun and
// the reaper both fall back to OS-level PID checks instead of relying on it.
const liveProcesses = new Map<string, ChildProcess>();

export type SpawnAgentRunInput = Omit<CreateAgentRunInput, "command" | "cwd" | "logPath" | "status"> & {
  preview: AgentInvocation;
  runsDir: string;
};

export type SpawnAgentRunOptions = {
  redact?: (text: string) => string;
  onExit?: (run: AgentRun) => void;
  // Opens a separate, visible terminal window that tails the run's log file
  // live. View-only: it never receives the CLI's real stdin, so it cannot
  // interfere with the piped process this function actually tracks. Defaults
  // to false — the Orchestrator tab's Runs board streams the same log inline,
  // so popping a window per agent is just clutter. Opt in per call, or set
  // AGENT_BRIDGE_SHOW_TERMINAL=1 to bring the windows back globally.
  showTerminal?: boolean;
  // Reopens the workspace store, for recording the run's final status after the
  // caller's own handle is gone.
  //
  // This is not an edge case, it is the norm: an HTTP handler or a one-shot CLI
  // command closes its store the moment it has replied, while the agent keeps
  // running for minutes. Every exit event then hit a closed handle and was
  // silently dropped, so no run ever recorded its exit code — a later poll
  // reaped it as "detached", which the orchestrator reads as "probably finished
  // fine". A run that failed outright (agy out of quota, a rejected flag) was
  // indistinguishable from one that succeeded.
  reopenStore?: () => MemoryStore;
};

// Resolves the effective showTerminal default. Off unless the caller asks for
// it or AGENT_BRIDGE_SHOW_TERMINAL is set to a truthy value; the Runs board is
// the primary way to watch an agent now. Never on under the vitest runner, so
// `vitest run` can't pop up real windows even if the env var is set.
export function resolveShowTerminal(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) return false;
  const flag = process.env.AGENT_BRIDGE_SHOW_TERMINAL;
  return flag === "1" || flag === "true";
}

// Opens a best-effort, view-only terminal window that tails `logPath` live.
// Never throws and never blocks the caller — a missing terminal emulator (or
// a headless environment) just means no window appears, nothing more.
function openLiveLogTerminal(logPath: string, title: string): void {
  try {
    if (process.platform === "win32") {
      const psCommand = `Get-Content -LiteralPath '${logPath.replace(/'/g, "''")}' -Wait -Tail 500`;
      const child = spawn(
        "cmd.exe",
        ["/c", "start", title, "powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-Command", psCommand],
        { detached: true, stdio: "ignore", windowsHide: false },
      );
      child.on("error", () => undefined);
      child.unref();
      return;
    }
    if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "tail -f '${logPath.replace(/'/g, "'\\''")}'"`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
      return;
    }
    // Best-effort on Linux desktops; silently does nothing if unavailable.
    const child = spawn("x-terminal-emulator", ["-e", `tail -f "${logPath}"`], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Never let a terminal-launch failure affect the actual agent run.
  }
}

// Claude Code's default `--print` output is plain text, which the CLI fully
// buffers instead of flushing incrementally the moment stdout isn't a real
// TTY (verified live: a single chunk arrives right before the process exits,
// however long the run takes). Piping through `--output-format stream-json
// --verbose` instead makes it emit one NDJSON event per turn as it happens,
// which this turns into a short human-readable line so a live-tailed log
// window shows real progress instead of sitting blank the whole run.
function isClaudeStreamJson(preview: AgentInvocation): boolean {
  return preview.provider === "claude" && (preview.args ?? []).includes("stream-json");
}

// agy buffers plain `--print` text the same way, so it gets the same treatment
// with its own event vocabulary.
function isAgyStreamJson(preview: AgentInvocation): boolean {
  return preview.provider === "antigravity" && (preview.args ?? []).includes("stream-json");
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  // Lower-case keys are claude's; the PascalCase ones are agy's.
  const key = [
    "file_path",
    "path",
    "command",
    "pattern",
    "query",
    "url",
    "TargetFile",
    "AbsolutePath",
    "CommandLine",
    "SearchDirectory",
    "Query",
  ].find((candidate) => typeof record[candidate] === "string");
  if (!key) return "";
  const value = String(record[key]);
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

// Returns a stateful line formatter: feed it raw stdout chunks (which can
// split a JSON line across chunk boundaries) and it returns whatever
// complete, human-readable lines are ready so far. Any line that isn't valid
// JSON (or isn't a type this cares about) is silently skipped rather than
// corrupting the log — this only ever adds a readable summary, it never
// replaces the final `result` text that parseLeaderTurn still needs.
function createClaudeStreamJsonFormatter(): (chunk: string) => string {
  let buffer = "";
  return (chunk: string): string => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "assistant") {
        const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            out.push(block.text.trim());
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const arg = summarizeToolInput(block.input);
            out.push(`→ ${block.name}${arg ? `(${arg})` : ""}`);
          }
        }
      } else if (event.type === "result" && typeof event.result === "string") {
        out.push(event.result);
      }
    }
    return out.length ? `${out.join("\n")}\n` : "";
  };
}

// agy's NDJSON vocabulary, captured from a live run:
//   {"event":"init","init":{"model":…,"cwd":…,"tools":[…]}}
//   {"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE|DONE",
//      "step_type":"tool|agent_response|checkpoint|user_input|unknown",
//      "tool_name":"write_to_file","tool_info":{"parameters":{…}},
//      "text_delta":"…","duration_seconds":…,"usage":{…}}}
//   {"event":"result","result":{"status":"SUCCESS","response":"…"}}
//
// Only `result.response` is the complete final reply, and it is emitted last —
// which is what makes streaming the partial `text_delta`s safe: extractJsonBlock
// anchors on the LAST ```json fence, so the whole reply always wins over the
// fragments that preceded it.
function createAgyStreamJsonFormatter(): (chunk: string) => string {
  let buffer = "";
  let sawText = false;
  // What the deltas have spelled out since the last tool line. agy's final
  // `result.response` is usually the very same text, and printing both wrote
  // every reply into the log twice — harmless for parsing but it doubles a
  // 10KB plan and makes the tail unreadable.
  let streamed = "";
  return (chunk: string): string => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.event === "init") {
        const init = event.init as { model?: unknown } | undefined;
        // Never the tools array — it is ~60 entries of noise on every run.
        if (typeof init?.model === "string") out += `· agy ${init.model}\n`;
        continue;
      }
      if (event.event === "step_update") {
        const step = event.step_update as
          | { state?: unknown; step_type?: unknown; tool_name?: unknown; tool_info?: unknown; text_delta?: unknown }
          | undefined;
        if (!step) continue;
        // Tools are announced on ACTIVE and repeated on DONE; one line each.
        if (step.step_type === "tool" && step.state === "ACTIVE" && typeof step.tool_name === "string") {
          const info = step.tool_info as { parameters?: unknown } | undefined;
          const arg = summarizeToolInput(info?.parameters);
          out += `${sawText ? "\n" : ""}→ ${step.tool_name}${arg ? `(${arg})` : ""}\n`;
          sawText = false;
          streamed = "";
          continue;
        }
        // Deltas are fragments of one growing message: appended raw, without a
        // newline apiece, or the reply arrives shredded across hundreds of lines.
        if (typeof step.text_delta === "string" && step.text_delta) {
          out += step.text_delta;
          streamed += step.text_delta;
          sawText = true;
        }
        continue;
      }
      if (event.event === "result") {
        const result = event.result as { response?: unknown; status?: unknown; error?: unknown } | undefined;
        // A failed agy turn carries an EMPTY response and puts the reason in
        // `error` — so printing only the response wrote a completely blank log
        // and the run just looked broken. Observed live: every Gemini model on
        // the account answering "Individual quota reached … Resets in 150h9m32s"
        // while the dashboard showed an empty failed run and the orchestrator
        // reported "No JSON found in the reply".
        if (typeof result?.error === "string" && result.error.trim()) {
          out += `${sawText ? "\n" : ""}[agy ${typeof result.status === "string" ? result.status : "ERROR"}] ${result.error.trim()}\n`;
          sawText = false;
          streamed = "";
          continue;
        }
        if (typeof result?.response === "string" && result.response.trim()) {
          // Only repeat the final reply when the stream did not already spell it
          // out in full. A partial stream must still be followed by the whole
          // thing: extractJsonBlock takes the LAST fence, so the complete copy
          // has to be the one that ends the log.
          out += result.response.trim() === streamed.trim() ? "\n" : `${sawText ? "\n" : ""}${result.response}\n`;
        } else if (typeof result?.status === "string") {
          out += `\n[agy ${result.status}]\n`;
        }
        sawText = false;
        streamed = "";
      }
    }
    return out;
  };
}

// Replaces the old execFileSync-based spawn: this returns as soon as the
// process is launched (status "running"), never blocking on completion.
// Callers observe progress/completion by polling agent_runs or via onExit.
export function spawnAgentRun(
  store: MemoryStore,
  input: SpawnAgentRunInput,
  options: SpawnAgentRunOptions = {},
): AgentRun {
  const { preview, runsDir, ...runInput } = input;
  if (preview.mode !== "cli" || !preview.executable) {
    throw new Error("spawnAgentRun requires a CLI-mode invocation preview with an executable.");
  }
  const redact = options.redact ?? redactSecrets;
  const showTerminal = resolveShowTerminal(options.showTerminal);

  let run = store.createAgentRun({
    ...runInput,
    // Stamp what this run was actually launched with. Without it the row keeps
    // provider/model/effort empty and the board can only guess from the agent
    // record, which hides the effort level and lies once the agent is edited.
    provider: runInput.provider ?? preview.provider,
    model: runInput.model ?? preview.model,
    reasoningEffort: runInput.reasoningEffort ?? preview.reasoningEffort,
    command: preview.command,
    cwd: preview.cwd,
    status: "starting",
    startedAt: new Date().toISOString(),
  });

  const logPath = join(runsDir, `${run.id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "", "utf8");
  run = store.updateAgentRun(run.id, { logPath }) ?? run;

  if (showTerminal) {
    openLiveLogTerminal(logPath, `Agent Bridge - ${preview.agentName} (${input.phase ?? "run"})`);
  }

  const child = spawn(preview.executable, preview.args ?? [], {
    cwd: preview.cwd || process.cwd(),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    // A spawned agent CLI running in a workspace that has agent-bridge hooks
    // installed fires those hooks itself — and the Claude hook's normal job
    // is "a human typed a prompt, so open a task for it and make it active".
    // For an orchestrated sub-agent that is exactly wrong: it invents a task
    // named after the leader's own prompt and steals the active-task slot
    // from the orchestration that spawned it, which then makes the whole
    // Orchestrator board (keyed off the active task) render empty. This env
    // marker lets the hook recognize "I am a spawned run, not a human
    // session" and stay read-only.
    // AGENT_BRIDGE_ORCHESTRATION rides along so the CLI's spawned-run guard can
    // name the context folder this agent should be writing instead of the
    // workboard it just tried to write.
    env: {
      ...process.env,
      AGENT_BRIDGE_SPAWNED_RUN: run.id,
      ...(input.orchestrationId ? { AGENT_BRIDGE_ORCHESTRATION: input.orchestrationId } : {}),
    },
  });

  liveProcesses.set(run.id, child);
  // Let a one-shot CLI invocation (spawn, then immediately close its store
  // handle and exit) return to the shell right away instead of hanging until
  // the agent finishes. A long-lived caller (the future orchestrator watch
  // loop) that keeps its own event loop busy is unaffected and still
  // receives every stdout/exit event normally.
  child.unref();
  run =
    store.updateAgentRun(run.id, {
      status: "running",
      pid: child.pid,
      heartbeatAt: new Date().toISOString(),
    }) ?? run;

  if (preview.stdinFilePath) {
    try {
      child.stdin?.end(readFileSync(preview.stdinFilePath, "utf8"));
    } catch {
      child.stdin?.end();
    }
  } else {
    child.stdin?.end();
  }

  // These callbacks fire whenever the OS schedules them, which can be after
  // the caller's own `try { ... } finally { store.close() }` has already run
  // (a store handle can outlive the command that opened it for as long as
  // the child's stdio pipes keep the event loop alive). A closed better-sqlite3
  // handle throws synchronously on any call, and a throw inside an event
  // callback is an uncaught exception — so every store touch here must be
  // guarded rather than allowed to crash the process.
  const safeUpdateAgentRun: typeof store.updateAgentRun = (id, patch) => {
    try {
      return store.updateAgentRun(id, patch);
    } catch {
      return undefined;
    }
  };

  // Same guard, but it reopens the workspace rather than dropping the write.
  // Only for the one update that must not be lost — heartbeats can afford to
  // vanish, the final status cannot, and opening a database handle per stdout
  // chunk would be absurd.
  const recordFinalStatus: typeof store.updateAgentRun = (id, patch) => {
    const updated = safeUpdateAgentRun(id, patch);
    if (updated || !options.reopenStore) return updated;
    let reopened: MemoryStore | undefined;
    try {
      reopened = options.reopenStore();
      return reopened.updateAgentRun(id, patch);
    } catch {
      return undefined;
    } finally {
      try {
        reopened?.close();
      } catch {
        // nothing left to salvage; the run status is best-effort at this point
      }
    }
  };

  // Each stream needs its own StringDecoder: a chunk boundary can fall inside a
  // multi-byte UTF-8 sequence, and decoding a chunk on its own turns that one
  // character into two or three U+FFFD replacement chars. Agent output is
  // routinely non-ASCII (Vietnamese prose, box drawing, emoji) and the run log
  // is what the final report is built from, so the partial bytes have to be
  // held back until the rest of the sequence arrives.
  const logAppender = () => {
    const decoder = new StringDecoder("utf8");
    return (chunk: Buffer) => {
      appendFileSync(logPath, redact(decoder.write(chunk)));
      safeUpdateAgentRun(run.id, { heartbeatAt: new Date().toISOString() });
    };
  };
  const appendLog = logAppender();
  const appendStderrLog = logAppender();
  const streamFormatter = isClaudeStreamJson(preview)
    ? createClaudeStreamJsonFormatter()
    : isAgyStreamJson(preview)
      ? createAgyStreamJsonFormatter()
      : undefined;
  if (streamFormatter) {
    const formatChunk = streamFormatter;
    const stdoutDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      const formatted = formatChunk(stdoutDecoder.write(chunk));
      if (formatted) {
        appendFileSync(logPath, redact(formatted));
        safeUpdateAgentRun(run.id, { heartbeatAt: new Date().toISOString() });
      }
    });
  } else {
    child.stdout?.on("data", appendLog);
  }
  child.stderr?.on("data", appendStderrLog);

  const finalize = (status: "done" | "failed", exitCode: number | undefined, note?: string) => {
    liveProcesses.delete(run.id);
    if (note) appendFileSync(logPath, redact(`\n${note}\n`));
    const finished = recordFinalStatus(run.id, {
      status,
      exitCode,
      endedAt: new Date().toISOString(),
    });
    if (finished) options.onExit?.(finished);
  };

  child.on("exit", (code) => finalize(code === 0 ? "done" : "failed", code ?? undefined));
  child.on("error", (error) => finalize("failed", -1, `[spawn error] ${error.message}`));

  return run;
}

// The child_process handle for a run this process itself spawned, if any.
// stopAgentRun (W3) uses this for a fast in-process kill before falling back
// to killing by PID.
export function getLiveProcess(runId: string): ChildProcess | undefined {
  return liveProcesses.get(runId);
}

export function forgetLiveProcess(runId: string): void {
  liveProcesses.delete(runId);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the OS found the process but denied the signal — it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Kills a process (and, on posix, its whole process group — spawnAgentRun
// starts children detached precisely so this negative-pid kill reaches any
// grandchildren an agent CLI itself forks). Escalates to SIGKILL if the
// process ignores SIGTERM past killTimeoutMs.
export async function killProcessTree(pid: number, killTimeoutMs = 5000): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + killTimeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

export type StopAgentRunOptions = {
  killTimeoutMs?: number;
};

// Stops a live run's process and marks it terminal. Callers that also need
// to cancel the assignment/subtask or record an orchestration event do that
// afterward — this function only owns the process lifecycle.
export async function stopAgentRun(
  store: MemoryStore,
  runId: string,
  options: StopAgentRunOptions = {},
): Promise<AgentRun | undefined> {
  const run = store.getAgentRun(runId);
  if (!run) return undefined;
  if (["done", "failed", "stopped", "detached"].includes(run.status)) return run;

  store.updateAgentRun(runId, { status: "stopping" });
  if (run.pid != null) await killProcessTree(run.pid, options.killTimeoutMs);
  forgetLiveProcess(runId);

  return store.updateAgentRun(runId, {
    status: "stopped",
    endedAt: new Date().toISOString(),
  });
}

// Detects runs whose process died without this store ever hearing about it —
// e.g. the CLI process that spawned it exited, or the machine was interrupted.
// Any CLI/orchestrator entrypoint should call this before trusting run status.
export function reapAgentRuns(
  store: MemoryStore,
  options: { taskId?: string } = {},
): AgentRun[] {
  const candidates = [
    ...store.listAgentRuns({ taskId: options.taskId, status: "running" }),
    ...store.listAgentRuns({ taskId: options.taskId, status: "starting" }),
  ];
  const reaped: AgentRun[] = [];
  for (const run of candidates) {
    if (run.pid != null && isProcessAlive(run.pid)) continue;
    // This process spawned it and still holds the handle, so its "exit" event
    // is milliseconds away with the real exit code. Reaping here would race that
    // and stamp a guess on top: a run that exited 1 (agy out of quota, say)
    // would be recorded as "detached", which the orchestrator reads as "probably
    // finished fine, send it to review" instead of blocking it. "detached" is
    // for runs nobody in this process is watching.
    if (liveProcesses.has(run.id)) continue;
    const updated = store.updateAgentRun(run.id, {
      status: run.pid == null ? "failed" : "detached",
      exitCode: run.exitCode,
      endedAt: run.endedAt ?? new Date().toISOString(),
    });
    if (updated) reaped.push(updated);
  }
  return reaped;
}
