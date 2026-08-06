import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteMemoryStore } from "@agent-bridge/memory";
import { reapAgentRuns, resolveShowTerminal, spawnAgentRun, stopAgentRun } from "./process-runner.js";
import type { AgentInvocation } from "./invocation.js";

async function waitForStatus(
  store: SQLiteMemoryStore,
  runId: string,
  statuses: string[],
  timeoutMs = 5000,
): Promise<ReturnType<SQLiteMemoryStore["getAgentRun"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = store.getAgentRun(runId);
    if (run && statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join("/")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function nodeInvocation(script: string, promptPath: string): AgentInvocation {
  return {
    adapter: "generic",
    mode: "cli",
    provider: "generic",
    agentId: "agent-1",
    agentName: "test-node-agent",
    executable: process.execPath,
    args: ["-e", script],
    stdinFilePath: promptPath,
    description: "test invocation",
    promptArtifactPath: promptPath,
    cwd: process.cwd(),
  };
}

describe("resolveShowTerminal", () => {
  it("defaults to off under the vitest test runner (VITEST is set here)", () => {
    expect(process.env.VITEST || process.env.VITEST_WORKER_ID).toBeTruthy();
    expect(resolveShowTerminal(undefined)).toBe(false);
  });

  it("lets an explicit true/false override the test-runner default", () => {
    expect(resolveShowTerminal(true)).toBe(true);
    expect(resolveShowTerminal(false)).toBe(false);
  });
});

function claudeStreamJsonInvocation(script: string, promptPath: string): AgentInvocation {
  return {
    adapter: "claude",
    mode: "cli",
    provider: "claude",
    agentId: "agent-1",
    agentName: "test-claude-agent",
    executable: process.execPath,
    // `--` stops node from trying to parse the trailing flags itself (it
    // otherwise rejects "--output-format" as an unrecognized node option);
    // isClaudeStreamJson only checks that "stream-json" is present anywhere
    // in args, so this still exercises the real detection path.
    args: ["-e", script, "--", "--output-format", "stream-json"],
    stdinFilePath: promptPath,
    description: "test invocation",
    promptArtifactPath: promptPath,
    cwd: process.cwd(),
  };
}

describe("spawnAgentRun", () => {
  it("spawns without blocking and records a successful exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: nodeInvocation('console.log("hello from run"); process.exit(0);', promptPath),
      });

      expect(run.status).toBe("running");
      expect(run.pid).toBeGreaterThan(0);
      expect(run.logPath).toBeTruthy();

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      expect(finished?.status).toBe("done");
      expect(finished?.exitCode).toBe(0);
      expect(readFileSync(finished!.logPath!, "utf8")).toContain("hello from run");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns a claude --output-format stream-json run into a readable log instead of raw NDJSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "claude-agent", provider: "claude", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      const events = [
        { type: "assistant", message: { content: [{ type: "text", text: "Planning the change" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "index.html" } }] } },
        { type: "result", result: '```json\n{"a":1}\n```' },
      ];
      const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n") + "\nprocess.exit(0);";

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: claudeStreamJsonInvocation(script, promptPath),
      });

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      expect(finished?.status).toBe("done");
      const log = readFileSync(finished!.logPath!, "utf8");
      expect(log).toContain("Planning the change");
      expect(log).toContain("→ Write(index.html)");
      expect(log).toContain('```json\n{"a":1}\n```');
      expect(log).not.toContain('"type":"assistant"');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders agy's stream-json events as live progress and keeps the final reply parseable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "agy-agent", provider: "antigravity", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      // Shapes captured from a real `agy --output-format stream-json` run.
      const events = [
        { event: "init", init: { model: "gemini-3.1-pro-high", cwd: dir, tools: ["browser_click_element", "write_to_file"] } },
        { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
        {
          event: "step_update",
          step_update: {
            step_index: 3,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: { name: "write_to_file", parameters: { TargetFile: "index.html" } },
          },
        },
        // The DONE repeat of the same tool must not print a second line.
        {
          event: "step_update",
          step_update: {
            step_index: 3,
            state: "DONE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: { name: "write_to_file", parameters: { TargetFile: "index.html" } },
          },
        },
        { event: "step_update", step_update: { step_index: 7, state: "ACTIVE", step_type: "agent_response", text_delta: '```json\n{"a"' } },
        { event: "result", result: { status: "SUCCESS", response: '```json\n{"a":1}\n```' } },
      ];
      const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n") + "\nprocess.exit(0);";

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: {
          ...nodeInvocation(script, promptPath),
          adapter: "antigravity",
          provider: "antigravity",
          args: ["-e", script, "--", "--output-format", "stream-json"],
          // agy takes its prompt as argv, never on stdin.
          stdinFilePath: undefined,
        },
      });

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      expect(finished?.status).toBe("done");
      const log = readFileSync(finished!.logPath!, "utf8");
      expect(log).toContain("· agy gemini-3.1-pro-high");
      expect(log).toContain("→ write_to_file(index.html)");
      // One line per tool, not one per state transition.
      expect(log.match(/→ write_to_file/g)).toHaveLength(1);
      // The raw NDJSON never reaches the log, and the 60-entry tools array from
      // the init event certainly must not.
      expect(log).not.toContain('"step_update"');
      expect(log).not.toContain("browser_click_element");
      // extractJsonBlock anchors on the LAST ```json fence, so the streamed
      // fragment above must not be the one a contract parser lands on.
      expect(log.trimEnd().endsWith('```json\n{"a":1}\n```')).toBe(true);
      // The partial delta is streamed live, then completed by the final reply.
      expect(log.match(/```json/g)).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write agy's reply into the log twice when the stream already spelled it out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "agy-agent", provider: "antigravity", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      // The common case: agy streams the whole answer in deltas and then repeats
      // it verbatim in `result.response`.
      const events = [
        { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "The sky is " } },
        { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "blue." } },
        { event: "result", result: { status: "SUCCESS", response: "The sky is blue." } },
      ];
      const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n") + "\nprocess.exit(0);";

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: {
          ...nodeInvocation(script, promptPath),
          adapter: "antigravity",
          provider: "antigravity",
          args: ["-e", script, "--", "--output-format", "stream-json"],
          stdinFilePath: undefined,
        },
      });

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      const log = readFileSync(finished!.logPath!, "utf8");
      expect(log.match(/The sky is blue\./g)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes agy's failure reason into the log instead of leaving it empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "agy-agent", provider: "antigravity", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      // A failed agy turn sends an EMPTY response and puts the reason in `error`.
      // Captured verbatim from a live run whose account had run out of quota.
      const events = [
        { event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "error_message" } },
        {
          event: "result",
          result: {
            status: "ERROR",
            response: "",
            error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 150h9m32s.",
          },
        },
      ];
      const script = events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n") + "\nprocess.exit(1);";

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: {
          ...nodeInvocation(script, promptPath),
          adapter: "antigravity",
          provider: "antigravity",
          args: ["-e", script, "--", "--output-format", "stream-json"],
          stdinFilePath: undefined,
        },
      });

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      expect(finished?.status).toBe("failed");
      const log = readFileSync(finished!.logPath!, "utf8");
      // Without this the run showed up as "failed" with a 0-byte log and the
      // orchestrator only ever said "No JSON found in the reply".
      expect(log).toContain("Individual quota reached");
      expect(log).toContain("[agy ERROR]");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still records the exit code after the caller has closed its own store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const dbPath = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(dbPath);
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      const run = spawnAgentRun(
        store,
        {
          taskId: task.id,
          agentId: agent.id,
          runsDir: join(dir, "runs"),
          preview: nodeInvocation("setTimeout(() => process.exit(7), 200);", promptPath),
        },
        { reopenStore: () => new SQLiteMemoryStore(dbPath) },
      );

      // Exactly what an HTTP handler or one-shot CLI command does: reply, close,
      // and leave the agent running. Every exit event used to hit this closed
      // handle and be dropped, so no run ever recorded how it ended.
      store.close();

      const checker = new SQLiteMemoryStore(dbPath);
      try {
        const finished = await waitForStatus(checker, run.id, ["done", "failed"]);
        expect(finished?.status).toBe("failed");
        expect(finished?.exitCode).toBe(7);
      } finally {
        checker.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // already closed above
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a failed exit with a non-zero exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "do the thing", "utf8");

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: nodeInvocation('console.error("boom"); process.exit(3);', promptPath),
      });

      const finished = await waitForStatus(store, run.id, ["done", "failed"]);
      expect(finished?.status).toBe("failed");
      expect(finished?.exitCode).toBe(3);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for a non-CLI invocation preview", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-runner-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "api-agent", provider: "deepseek", mode: "api", model: "deepseek-chat" });
      const task = store.createTask({ title: "Run task", ownerAgent: "codex" });
      expect(() =>
        spawnAgentRun(store, {
          taskId: task.id,
          agentId: agent.id,
          runsDir: join(dir, "runs"),
          preview: {
            adapter: "deepseek",
            mode: "api",
            provider: "deepseek",
            agentId: agent.id,
            agentName: agent.name,
            promptArtifactPath: join(dir, "prompt.md"),
            description: "api preview",
            cwd: dir,
          },
        }),
      ).toThrow("CLI-mode");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stopAgentRun", () => {
  it("kills a long-running process and marks the run stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-stop-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Long task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "wait", "utf8");

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: nodeInvocation("setTimeout(() => process.exit(0), 60000);", promptPath),
      });
      expect(run.pid).toBeGreaterThan(0);

      const stopped = await stopAgentRun(store, run.id);
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.endedAt).toBeTruthy();
      // Give the OS a moment to finish tearing the process down.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("is a no-op for a run that already finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-stop-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Task", ownerAgent: "codex" });
      const run = store.createAgentRun({ taskId: task.id, agentId: agent.id, status: "done" });

      const result = await stopAgentRun(store, run.id);
      expect(result?.status).toBe("done");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for an unknown run id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-stop-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      expect(await stopAgentRun(store, "run-missing")).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reapAgentRuns", () => {
  it("marks a run as detached once its process is no longer alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-reaper-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Orphaned task", ownerAgent: "codex" });
      const run = store.createAgentRun({ taskId: task.id, agentId: agent.id, status: "running" });
      // A pid that is astronomically unlikely to be alive on this machine.
      store.updateAgentRun(run.id, { pid: 999999 });

      const reaped = reapAgentRuns(store, { taskId: task.id });
      expect(reaped).toHaveLength(1);
      expect(reaped[0]?.status).toBe("detached");
      expect(store.getAgentRun(run.id)?.status).toBe("detached");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites the real exit status of a run this process is still watching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-reaper-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Quick failure", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "fail fast", "utf8");

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: nodeInvocation("process.exit(1);", promptPath),
      });

      // The window the reaper used to win: the OS process is gone but node has
      // not delivered "exit" yet. Reaping here stamped "detached", which the
      // orchestrator reads as "probably finished fine, send it to review" — so
      // an agent that failed outright (out of quota, bad flag) was treated as a
      // success and its work went to a reviewer that had nothing to review.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        reapAgentRuns(store, { taskId: task.id });
        if (store.getAgentRun(run.id)?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const finished = await waitForStatus(store, run.id, ["done", "failed", "detached"]);
      expect(finished?.status).toBe("failed");
      expect(finished?.exitCode).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a live run untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-reaper-"));
    const store = new SQLiteMemoryStore(join(dir, "memories.db"));
    try {
      const agent = store.createRegisteredAgent({ name: "node-agent", provider: "generic", mode: "cli", command: process.execPath });
      const task = store.createTask({ title: "Long task", ownerAgent: "codex" });
      const promptPath = join(dir, "prompt.md");
      writeFileSync(promptPath, "wait", "utf8");

      const run = spawnAgentRun(store, {
        taskId: task.id,
        agentId: agent.id,
        runsDir: join(dir, "runs"),
        preview: nodeInvocation("setTimeout(() => process.exit(0), 2000);", promptPath),
      });

      const reaped = reapAgentRuns(store, { taskId: task.id });
      expect(reaped).toHaveLength(0);
      expect(store.getAgentRun(run.id)?.status).toBe("running");

      await waitForStatus(store, run.id, ["done", "failed"], 4000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
