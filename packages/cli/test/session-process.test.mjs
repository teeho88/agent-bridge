import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSessionProcessStart, sessionProcessLiveness } from "../dist/session-process.js";
import { cleanupStaleAgentSessions, ensureWorkspace, openStore, readConfig, startAgentSession, writeConfig } from "../dist/workspace.js";
import { handleCodexHook } from "../dist/commands/codex.js";
import { request, loadDashboard } from "../dist/tui/service.js";
import { screenEntries } from "../dist/tui/view.js";

test("process identity distinguishes a live agent, an exited agent and a reused PID", () => {
  const binding = { pid: 101, processStartedAt: "2026-11-16T01:00:00.000Z" };
  assert.equal(sessionProcessLiveness(binding, () => binding.processStartedAt), "running");
  assert.equal(sessionProcessLiveness(binding, () => null), "ended");
  assert.equal(sessionProcessLiveness(binding, () => "2026-11-16T02:00:00.000Z"), "ended");
  assert.equal(sessionProcessLiveness(binding, () => undefined), "unknown");
  assert.equal(sessionProcessLiveness(undefined, () => binding.processStartedAt), "unknown");
});

test("legacy process bindings reject a PID created after registration", () => {
  const binding = { pid: 102, updatedAt: "2026-11-16T01:00:00.000Z" };
  assert.equal(sessionProcessLiveness(binding, () => "2026-11-16T00:00:00.000Z"), "unknown");
  assert.equal(sessionProcessLiveness(binding, () => "2026-11-16T02:00:00.000Z"), "ended");
});

test("an unverified session never highlights its task as active", () => {
  const state = { tasks: [{ id: "task", status: "in_progress" }], activeSessionEvents: [
    { taskId: "task", sessionId: "native", kind: "prompt_submitted", liveness: "unknown" },
  ] };
  assert.ok(screenEntries("Work Board", state, {}).every((entry) => !entry.active));
});

test("Codex changing threads cannot close a different tab sharing its window and task", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-shared-window-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  const originalTerminal = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
  try {
    const task = store.createTask({ title: "Shared work", ownerAgent: "codex" });
    store.updateTask(task.id, { status: "in_progress" });
    for (const id of ["tab-a", "tab-b"]) {
      startAgentSession(id, task.id, fixture, "codex");
      store.recordSessionEvent({ sessionId: id, taskId: task.id, agent: "codex", kind: "prompt_submitted" });
    }
    const config = readConfig(fixture);
    config.terminalNativeSessions = { "tab-a": "native-old" };
    config.sessionWindows = Object.fromEntries(["tab-a", "tab-b"].map((id, index) => [id, {
      hwnd: "shared", windowId: "shared-window", pid: 100 + index, processStartedAt: "2026-11-16T01:00:00.000Z",
      taskId: task.id, agent: "codex", updatedAt: new Date().toISOString(),
    }]));
    writeConfig(config, fixture);
    process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = "tab-a";
    await handleCodexHook({ cwd: fixture, session_id: "native-new" }, "SessionStart");
    const tabB = store.listSessionEvents({ sessionId: "tab-b", limit: 1 })[0];
    assert.equal(tabB.kind, "prompt_submitted");
    assert.equal(readConfig(fixture).sessionTasks["tab-b"], task.id);
    assert.equal(store.getTask(task.id).status, "in_progress");
    assert.notEqual(readConfig(fixture).sessionTasks["tab-a"], task.id);
  } finally {
    if (originalTerminal === undefined) delete process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID;
    else process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID = originalTerminal;
    store.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("real Windows processes sharing a window end only their own sessions", { skip: process.platform !== "win32" }, async (t) => {
  if (!readSessionProcessStart(process.pid, true)) {
    t.skip("Windows process inspection is unavailable in this sandbox");
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "session-process-live-"));
  ensureWorkspace(fixture);
  const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" }));
  const store = openStore(fixture);
  try {
    await Promise.all(children.map((child) => once(child, "spawn")));
    for (const [index, child] of children.entries()) {
      const task = store.createTask({ title: `Independent tab ${index}`, ownerAgent: "codex" });
      startAgentSession(`tab-${index}`, task.id, fixture, "codex");
      store.recordSessionEvent({ sessionId: `tab-${index}`, taskId: task.id, agent: "codex", kind: "session_started", createdAt: "2020-01-01T00:00:00Z" });
      await request(fixture, "POST", "/api/session/window", { sessionId: `tab-${index}`, windowId: "shared-window", hwnd: "1234", pid: child.pid });
    }
    const config = readConfig(fixture);
    assert.ok(config.sessionWindows["tab-0"].processStartedAt);
    assert.ok(config.sessionWindows["tab-1"].processStartedAt);
    assert.notEqual(config.sessionWindows["tab-0"].pid, config.sessionWindows["tab-1"].pid);
    assert.equal(cleanupStaleAgentSessions(store, fixture), 0);
    const exit = once(children[0], "exit");
    children[0].kill();
    await exit;
    readSessionProcessStart(children[0].pid, true);
    assert.equal(cleanupStaleAgentSessions(store, fixture), 1);
    assert.deepEqual(store.listActiveSessionEvents().map((event) => event.sessionId), ["tab-1"]);
    const { state } = await loadDashboard(fixture);
    const rows = screenEntries("Work Board", state, {});
    assert.equal(rows.filter((entry) => entry.group === "Tasks" && entry.active).length, 1);
    assert.equal(rows.filter((entry) => entry.group === "Sessions" && entry.active).length, 1);
    assert.equal(rows.find((entry) => entry.group === "Sessions" && entry.active).data.sessionId, "tab-1");
    const secondExit = once(children[1], "exit");
    children[1].kill();
    await secondExit;
    readSessionProcessStart(children[1].pid, true);
    assert.equal(cleanupStaleAgentSessions(store, fixture), 1);
    assert.deepEqual(store.listActiveSessionEvents(), []);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    store.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
