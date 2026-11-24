import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { dashboardActions, parseValues, screens } from "../dist/tui/actions.js";
import { TerminalDashboard as BaseTerminalDashboard } from "../dist/tui/app.js";
import { BackgroundRefresh } from "../dist/tui/background-refresh.js";
import { TerminalInput, mouseEnable, mouseDisable } from "../dist/tui/mouse.js";
import { cursorAt, editorLines, Surface, theme } from "../dist/tui/surface.js";
import { editHighlight } from "../dist/tui/edit-highlight.js";
import { readSessionProcessStart } from "../dist/session-process.js";
import { renderNetwork } from "../dist/tui/network.js";
import { buildGraphView } from "../dist/commands/routes/graph-view.js";
import { briefWatchedFile } from "../dist/commands/watch.js";
import { loadDashboard, performAction, request } from "../dist/tui/service.js";
import { cellWidth, clean, describe, fit, screenEntries, wrap } from "../dist/tui/view.js";
import { uiRouteManifest } from "../dist/commands/ui.js";
import { ensureWorkspace, readConfig } from "../dist/workspace.js";
import { openStore, writeConfig, readCliInvocationSettings, cleanupStaleAgentSessions, startAgentSession } from "../dist/workspace.js";
import { buildSpawnPreview } from "@agent-bridge/adapters";
import { initializeProject } from "../dist/commands/init.js";
import { graphEntries, graphPreview, screenSections, sectionEntries, sectionActions } from "../dist/tui/sections.js";
import { handleClaudeHook } from "../dist/commands/claude.js";
import { handleCodexHook, installCodexHooks } from "../dist/commands/codex.js";
import { handleAntigravityHook } from "../dist/commands/antigravity.js";
import { autoRunTimers, resumeAutoRuns } from "../dist/commands/routes/auto-run.js";
import { isWatcherRunning, startWatcher, watcherProcess } from "../dist/commands/routes/watcher.js";
import { repositoryEnabled } from "../dist/repository.js";
import { locateContext, publishContext } from "../dist/context-runtime.js";
import { compileContext } from "@agent-bridge/core";
import { prepareSessionReopen } from "../dist/commands/routes/session.js";
import { agentTerminalInvocation } from "../dist/commands/routes/terminal.js";
import { mergeSessionHistory } from "../dist/native-sessions.js";

test("session quick actions remain visible and target the selected session on narrow and wide terminals", async () => {
  for (const columns of [52, 72, 120]) {
    for (const path of ["session/focus", "session/delete"]) {
      const app = new TerminalDashboard(project, input(), output(columns, 30));
      app.state = { sessionHistory: [
        { sessionId: "first", taskId: "first-task", agent: "codex", kind: "session_ended" },
        { sessionId: "second", taskId: "second-task", agent: "claude", kind: "session_ended" },
      ] };
      app.selectSection("Sessions");
      app.selected = 1;
      await click(app, (target) => target.kind === "action" && target.path === path);
      assert.equal(app.form.values.sessionId, "second");
      if (path === "session/focus") {
        assert.equal(app.form.values.taskId, "second-task");
        assert.equal(app.form.values.agent, "claude");
      } else {
        assert.equal(app.form.action.destructive, true);
        app.review();
        assert.equal(app.mode, "confirm");
        assert.deepEqual(app.pending, { sessionId: "second" });
      }
    }
  }
});

test("deleting a session persists across refreshes and preserves task data and other sessions", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "session-delete-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  try {
    const task = store.createTask({ title: "Keep task", ownerAgent: "claude" });
    store.addMemory({ taskId: task.id, type: "note", content: "Keep memory", importance: 3, tags: [] });
    for (const sessionId of ["remove", "keep"]) store.recordSessionEvent({
      sessionId, taskId: task.id, agent: "claude", kind: "session_ended",
    });
    writeConfig({ ...readConfig(fixture), terminalNativeSessions: { remove: "native-remove" } }, fixture);
    await assert.rejects(request(fixture, "POST", "/api/session/delete", {}), /sessionId/);
    await assert.rejects(request(fixture, "POST", "/api/session/delete", { sessionId: "missing" }), /Session not found/);
    const result = await request(fixture, "POST", "/api/session/delete", { sessionId: "remove" });
    assert.equal(result.ok, true);
    for (let index = 0; index < 2; index++) {
      const state = await request(fixture, "GET", "/api/state/details");
      assert.deepEqual(state.sessionHistory.map((row) => row.sessionId), ["keep"]);
    }
    assert.equal(store.getTask(task.id).title, "Keep task");
    assert.equal(store.listMemoriesForTask(task.id)[0].content, "Keep memory");
    const config = readConfig(fixture);
    const native = { sessionId: "native:claude:native-remove", nativeSessionId: "native-remove", agent: "claude", source: "native" };
    assert.deepEqual(mergeSessionHistory([], [native], config), []);
    assert.deepEqual(mergeSessionHistory(store.listSessionHistory(), [native], config).map((row) => row.sessionId), ["keep"]);
    store.recordSessionEvent({ sessionId: "native:claude:only-native", taskId: task.id, agent: "claude", kind: "session_ended" });
    await request(fixture, "POST", "/api/session/delete", { sessionId: "native:claude:only-native" });
    assert.equal(readConfig(fixture).deletedSessionIds["claude:only-native"], true);
  } finally { store.close(); rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("session history retains all agents and ended sessions with one latest row per session", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "session-history-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  try {
    for (const agent of ["claude", "antigravity", "codex"]) {
      const task = store.createTask({ title: `${agent} history`, ownerAgent: agent });
      for (const kind of ["session_started", "session_ended"]) store.recordSessionEvent({
        sessionId: `${agent}-history`, taskId: task.id, agent, kind, createdAt: "2026-01-01T00:00:00Z",
      });
    }
    for (let index = 0; index < 120; index++) store.recordSessionEvent({
      sessionId: "noisy", agent: "codex", kind: "session_ended",
    });
    assert.equal(store.listSessionHistory().length, 4);
    assert.ok(store.listSessionHistory().every((event) => event.kind === "session_ended"));
    const state = await request(fixture, "GET", "/api/state/details");
    assert.equal(state.sessionHistory.length, 4);
    const rows = screenEntries("Work Board", state, {}).filter((row) => row.group === "Sessions");
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => !row.active));
    assert.ok(!screenSections["Work Board"].some((section) => section.name === "All"));
  } finally { store.close(); rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("reopening a session clones context independently or transfers the original task", () => {
  const fixture = mkdtempSync(join(tmpdir(), "session-reopen-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  try {
    const original = store.createTask({ title: "Saved work", goal: "Finish feature", ownerAgent: "claude" });
    store.addMemory({ taskId: original.id, type: "note", content: "Preserve compatibility", importance: 5, tags: [] });
    store.createHandoff({ taskId: original.id, fromAgent: "claude", summary: "Parser done", next: ["Check edge cases"] });
    store.recordSessionEvent({ sessionId: "old", taskId: original.id, agent: "claude", kind: "session_ended" });
    assert.throws(() => prepareSessionReopen(store, fixture, "old", "codex"), /Choose transfer or clone/);
    assert.throws(() => prepareSessionReopen(store, fixture, "old", "codex", "other"), /Choose transfer or clone/);
    assert.throws(() => prepareSessionReopen(store, fixture, "old", "codex", "clone", "wrong-task"), /does not belong/);
    const cloned = prepareSessionReopen(store, fixture, "old", "codex", "clone");
    assert.notEqual(cloned.task.id, original.id);
    assert.equal(cloned.task.goal, original.goal);
    assert.equal(cloned.task.ownerAgent, "codex");
    assert.equal(store.getTask(original.id).ownerAgent, "claude");
    assert.ok(store.listMemoriesForTask(cloned.task.id).some((memory) => memory.content === "Preserve compatibility"));
    assert.deepEqual(store.getLatestHandoff(cloned.task.id).next, ["Check edge cases"]);
    const transferred = prepareSessionReopen(store, fixture, "old", "antigravity", "transfer");
    assert.equal(transferred.task.id, original.id);
    assert.equal(store.getTask(original.id).ownerAgent, "antigravity");
    const native = "12345678-abcd-1234-abcd-123456789abc";
    writeConfig({ ...readConfig(fixture), terminalNativeSessions: { old: native } }, fixture);
    assert.equal(prepareSessionReopen(store, fixture, "old", "claude").nativeSessionId, native);
    assert.equal(prepareSessionReopen(store, fixture, "old", "codex", "clone").nativeSessionId, undefined);
  } finally { store.close(); rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("terminal reopening uses native resume flags or offers an on-demand task lookup", () => {
  for (const [agent, command, flag] of [["codex", "codex", "'resume'"], ["claude", "claude", "'--resume'"], ["antigravity", "agy", "'--conversation'"]]) {
    const line = agentTerminalInvocation(agent, command, { nativeSessionId: "native-id", continuedTaskId: "saved-task" });
    assert.ok(line.includes(flag));
    assert.ok(line.includes("'native-id'"));
    assert.ok(!line.includes("context query"));
    assert.ok(!line.includes("'--prompt-interactive'"));
    const switched = agentTerminalInvocation(agent, command, { continuedTaskId: "saved-task" });
    assert.ok(switched.includes("If the next request needs past work"));
    assert.ok(switched.includes("context handoff --task saved-task"));
    if (agent === "antigravity") assert.ok(switched.includes("'--prompt-interactive'"));
    assert.equal(agentTerminalInvocation(agent, command), `& '${command}'`);
  }
});

test("Work Board refresh preserves navigation made while a refresh is loading", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "selection-refresh-"));
  ensureWorkspace(fixture);
  try {
    for (const section of ["Tasks", "Sessions"]) {
      const app = new TerminalDashboard(fixture, input(), output());
      const state = { tasks: [{ id: "first", title: "First" }, { id: "second", title: "Second" }],
        sessionHistory: [{ sessionId: "first", taskId: "first", agent: "codex", kind: "prompt_submitted", liveness: "running" },
          { sessionId: "second", taskId: "second", agent: "claude", kind: "session_ended" }] };
      app.state = state;
      app.selectSection(section);
      app.catalogsLoaded = true;
      let finish;
      app.background = { request: () => new Promise((resolve) => { finish = resolve; }) };
      const refreshing = app.refresh();
      await app.handleKey("", { name: "down" });
      assert.equal(app.selected, 1);
      finish({ ...state, tasks: [...state.tasks, { id: "new", title: "New active task" }],
        sessionHistory: [...state.sessionHistory, { sessionId: "new", taskId: "new", agent: "antigravity",
          kind: "prompt_submitted", liveness: "running", createdAt: "2026-11-17T00:00:00Z" }] });
      await refreshing;
      assert.equal(app.selected, 2, section);
      assert.equal(app.entries()[0].active, true);
      const chosen = app.entries()[app.selected];
      assert.equal(section === "Sessions" ? chosen.data.sessionId : chosen.data.id, "second");
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("session reopening form uses the selected session and offers transfer or clone", async () => {
  const app = new TerminalDashboard(project, input(), output(72, 30));
  app.state = { sessionHistory: [{ sessionId: "saved-claude", taskId: "saved-task", agent: "claude", kind: "session_ended" }] };
  app.selectSection("Sessions");
  await click(app, (target) => target.kind === "action" && target.path === "session/terminal");
  assert.equal(app.form.values.sessionId, "saved-claude");
  assert.equal(app.form.values.taskId, "saved-task");
  assert.equal(app.form.values.agent, "claude");
  assert.deepEqual(app.form.fields.find((field) => field.key === "sessionMode").choices, ["transfer", "clone"]);
  assert.ok(!app.form.fields.some((field) => ["transferOwnership", "createGoal"].includes(field.key)));
});

test("CLI approval settings persist permissions and modes and reject invalid updates atomically", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "cli-approvals-"));
  try {
    ensureWorkspace(fixture);
    const settings = { codex: "auto-review", codexSandbox: "read-only", antigravity: "default", antigravityMode: "auto", claude: "manual" };
    const saved = await request(fixture, "POST", "/api/config/cli-approvals", settings);
    assert.deepEqual(saved.cliApprovalPolicies, settings);
    assert.deepEqual(readConfig(fixture).cliApprovalPolicies, settings);
    assert.deepEqual(readCliInvocationSettings(fixture, "codex"), { policy: "auto-review", codexSandbox: "read-only", antigravityMode: undefined });
    assert.deepEqual(readCliInvocationSettings(fixture, "antigravity"), { policy: "default", codexSandbox: undefined, antigravityMode: "auto" });
    for (const invalid of [
      { codex: "never", codexSandbox: "full-access" },
      { antigravityMode: "accept-edit" },
      { claude: "invalid" },
      { codex: "on-failure" },
    ]) {
      await assert.rejects(request(fixture, "POST", "/api/config/cli-approvals", invalid), /Invalid .* approval policy/);
      assert.deepEqual(readConfig(fixture).cliApprovalPolicies, settings);
    }
    await request(fixture, "POST", "/api/config/cli-approvals", { claude: "plan" });
    assert.deepEqual(readConfig(fixture).cliApprovalPolicies, { ...settings, claude: "plan" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("CLI approval form preserves legacy agy policies as separate modes", () => {
  const app = new TerminalDashboard(project, input(), output());
  for (const [legacy, mode] of [["accept-edits", "accept-edits"], ["plan", "plan"], ["default", "default"], ["bypass", "default"], [undefined, "accept-edits"]]) {
    app.state = { config: { cliApprovalPolicies: { antigravity: legacy } } };
    app.openForm(action("config/cli-approvals"));
    const values = app.form.values;
    assert.equal(values.antigravity, legacy === "bypass" ? "bypass" : "default");
    assert.equal(values.antigravityMode, mode);
    assert.equal(values.codexSandbox, "workspace-write");
    assert.doesNotThrow(() => parseValues(app.form.action, values));
  }
  app.state = { config: { cliApprovalPolicies: { codexSandbox: "danger-full-access", antigravity: "plan", antigravityMode: "auto" } } };
  app.openForm(action("config/cli-approvals"));
  assert.equal(app.form.values.antigravityMode, "auto");
  assert.equal(app.form.values.codexSandbox, "danger-full-access");
});

test("spawn arguments honor every supported policy, Codex sandbox and independent agy mode", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cli-permissions-"));
  const prompt = join(fixture, "prompt.md");
  writeFileSync(prompt, "Inspect the workspace");
  const agent = (provider) => ({ id: "test", name: "test", mode: "cli", provider });
  const flag = (args, key) => args[args.indexOf(key) + 1];
  try {
    for (const policy of ["default", "auto-review", "never", "bypass"]) {
      for (const sandbox of ["read-only", "workspace-write", "danger-full-access"]) {
        const preview = buildSpawnPreview(agent("codex"), prompt, fixture, { policy, codexSandbox: sandbox });
        assert.equal(preview.args.includes("--dangerously-bypass-approvals-and-sandbox"), policy === "bypass");
        if (policy === "bypass") {
          assert.equal(preview.args.includes("--sandbox"), false);
          assert.match(preview.description, /sandbox disabled/);
        } else {
          assert.equal(flag(preview.args, "--sandbox"), sandbox);
          assert.ok(preview.args.includes(`approval_policy="${policy === "never" ? "never" : "on-request"}"`));
          if (policy !== "never") assert.ok(preview.args.includes(`approvals_reviewer="${policy === "auto-review" ? "auto_review" : "user"}"`));
        }
      }
    }
    for (const policy of ["default", "accept-edits", "plan", "bypass"]) {
      const legacy = buildSpawnPreview(agent("antigravity"), prompt, fixture, policy);
      assert.equal(legacy.args.includes("--dangerously-skip-permissions"), policy === "bypass");
      assert.equal(legacy.args.includes("--mode"), policy === "accept-edits" || policy === "plan");
      for (const mode of ["default", "auto", "accept-edits", "plan"]) {
        const preview = buildSpawnPreview(agent("antigravity"), prompt, fixture, { policy, antigravityMode: mode });
        assert.equal(preview.args.includes("--dangerously-skip-permissions"), policy === "bypass");
        assert.equal(preview.args.includes("--mode"), mode !== "default");
        if (mode !== "default") assert.equal(flag(preview.args, "--mode"), mode);
        assert.deepEqual(preview.args.slice(-2), ["--print", "Inspect the workspace"]);
      }
    }
    for (const [policy, mode] of [["manual", "manual"], ["auto", "auto"], ["accept-edits", "acceptEdits"], ["dont-ask", "dontAsk"], ["plan", "plan"], ["bypass", undefined]]) {
      const preview = buildSpawnPreview(agent("claude"), prompt, fixture, policy);
      assert.equal(preview.args.includes("--dangerously-skip-permissions"), policy === "bypass");
      if (mode) assert.equal(flag(preview.args, "--permission-mode"), mode);
    }
    assert.equal(flag(buildSpawnPreview(agent("codex"), prompt, fixture).args, "--sandbox"), "workspace-write");
    assert.equal(flag(buildSpawnPreview(agent("antigravity"), prompt, fixture).args, "--mode"), "accept-edits");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("task context uses optional graph navigation without injecting graph data or reading briefs", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "graph-context-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "navigation.ts"), "export const navigation = 42;\n");
  const { task } = await request(fixture, "POST", "/api/task/start", { title: "navigation", agent: "codex" });
  await request(fixture, "POST", "/api/graph/build", {});
  const initial = readConfig(fixture);
  writeConfig({ ...initial, graph: { ...initial.graph, injectRepoMap: true } }, fixture);
  const store = openStore(fixture);
  try {
    store.upsertFileSummary({ path: "navigation.ts", summary: "GRAPH_BRIEF_SENTINEL", lastSeenHash: "outdated-hash" });
    for (const method of ["listFileSummaries", "getGraphStats", "buildRepoMap"])
      store[method] = () => { throw new Error(`Context must not query ${method}`); };
    for (const enabled of [true, false, true]) {
      const saved = await request(fixture, "POST", "/api/config/graph", { enabled });
      assert.equal(saved.graph.enabled, enabled);
      assert.equal(readConfig(fixture).graph.enabled, enabled);
      for (const pack of [
        publishContext(store, fixture, task.id, "codex", { repoMap: true, repoMapLimit: 500 }),
        (await request(fixture, "POST", "/api/context/compile", { taskId: task.id })).pack,
        compileContext(store, { taskId: task.id, agent: "codex", tokenBudget: 4000, graphEnabled: enabled, repoMap: "LEGACY_MAP_SENTINEL" }),
      ]) {
        assert.equal(pack.repoMap, undefined);
        assert.deepEqual(pack.relevantFiles, []);
        assert.doesNotMatch(pack.renderedMarkdown, /## Repo Map|GRAPH_BRIEF_SENTINEL|LEGACY_MAP_SENTINEL/);
        assert.match(pack.renderedMarkdown, /## Graph Navigation/);
        assert.equal(pack.renderedMarkdown.includes("graph search <query>"), enabled);
        assert.equal(pack.renderedMarkdown.includes("Graph navigation is disabled"), !enabled);
      }
    }
    const config = readConfig(fixture);
    delete config.graph.enabled;
    config.sessionTasks = { ...config.sessionTasks, "graph-context-session": task.id };
    config.activeSessions = { ...config.activeSessions, "graph-context-session": "codex" };
    writeConfig(config, fixture);
    const publication = publishContext(store, fixture, task.id, "codex", { sessionId: "graph-context-session" });
    assert.match(publication.renderedMarkdown, /graph search <query>/);
    assert.ok(publication.sessionId);
    locateContext(fixture, "codex", publication.sessionId);
    await request(fixture, "POST", "/api/config/graph", { enabled: false });
    assert.throws(() => locateContext(fixture, "codex", publication.sessionId), /Graph navigation setting changed/);
  } finally {
    store.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Tools installs Codex hooks and reports missing, current and damaged configuration", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-tools-hooks-"));
  try {
    ensureWorkspace(fixture);
    const hooksSection = screenSections.Tools.find((section) => section.name === "Hooks");
    assert.ok(sectionActions(dashboardActions.filter((item) => item.screen === "Tools"), hooksSection)
      .some((item) => item.path === "/api/codex/install-hooks"));
    let state = await request(fixture, "GET", "/api/state");
    assert.equal(state.codexHookStatus.installed, false);
    const result = await performAction(fixture, action("codex/install-hooks"), {});
    assert.equal(result.installed, true);
    assert.equal(result.codexHookStatus.current, true);
    assert.match(result.output.join("\n"), /Trust.*\/hooks/);
    state = await request(fixture, "GET", "/api/state");
    const entry = screenEntries("Tools", state, {}).find((item) => item.label === "Codex hooks");
    assert.equal(entry.group, "Hooks");
    assert.equal(entry.data.current, true);
    const hooksPath = join(fixture, ".codex", "hooks.json");
    const settings = JSON.parse(readFileSync(hooksPath, "utf8"));
    settings.hooks.Stop = [{ hooks: [{ type: "command", command: "custom-hook" }] }];
    writeFileSync(hooksPath, JSON.stringify(settings));
    state = await request(fixture, "GET", "/api/state");
    assert.equal(state.codexHookStatus.current, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const repaired = await performAction(fixture, action("codex/install-hooks"), {});
      assert.equal(repaired.codexHookStatus.current, true);
    }
    const repaired = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(repaired.hooks.Stop.length, 2);
    assert.equal(repaired.hooks.Stop[0].hooks[0].command, "custom-hook");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

class TerminalDashboard extends BaseTerminalDashboard {
  discoverModels = async (provider) => {
    const catalog = this.catalogs.find((item) => item.provider === provider);
    if (!catalog) throw new Error("No test catalog");
    return { models: catalog.models, reasoning: catalog.reasoning };
  };
}

const project = mkdtempSync(join(tmpdir(), "agent-bridge-tui-"));
after(() => rmSync(project, { recursive: true, force: true }));
ensureWorkspace(project);
const action = (path) => {
  const found = dashboardActions.find((item) => item.path === `/api/${path}`);
  assert.ok(found, path);
  return found;
};
const input = () => {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (raw) => { stream.isRaw = raw; return stream; };
  return stream;
};
const output = (columns = 100, rows = 30) => {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.text = "";
  stream.on("data", (data) => { stream.text += data.toString(); });
  return stream;
};
const mouse = (x, y, wheel = 0) => ({ x, y, button: 0, release: false, motion: false, wheel });
const click = async (app, predicate) => {
  const hit = app.hitRegions.find((region) => predicate(region.target));
  assert.ok(hit, "clickable target exists");
  await app.handleMouse(mouse(hit.x, hit.y));
};

test("terminal updates only changed rows and clears shortened rows", () => {
  const out = output();
  const app = new TerminalDashboard(project, input(), out);
  app.writeFrame("unchanged\r\nlong old value\r\nunchanged");
  out.text = "";
  app.writeFrame("unchanged\r\nnew\r\nunchanged");
  assert.equal(out.text, "\x1b[2;1Hnew\x1b[K");
  out.text = "";
  app.writeFrame("unchanged\r\nnew\r\nunchanged");
  assert.equal(out.text, "");
  app.previousFrame = "";
  app.writeFrame("resized");
  assert.equal(out.text, "\x1b[Hresized\x1b[J");
});

test("slow terminal output coalesces pending frames until drain", () => {
  const out = output();
  const writes = [];
  out.write = (chunk) => { writes.push(chunk); return writes.length !== 1; };
  const app = new TerminalDashboard(project, input(), out);
  app.writeFrame("header\r\nfirst");
  app.writeFrame("header\r\nintermediate");
  app.writeFrame("header\r\nlatest");
  assert.equal(writes.length, 1);
  app.onDrain();
  assert.deepEqual(writes, ["\x1b[Hheader\r\nfirst\x1b[J", "\x1b[2;1Hlatest\x1b[K"]);
  assert.equal(app.pendingFrame, undefined);
});

test("background state and graph refresh keep the event loop available and shut down cleanly", async () => {
  const background = new BackgroundRefresh(project);
  try {
    const state = background.request("/api/state/details");
    assert.equal(await Promise.race([state.then(() => "state"), new Promise((resolve) => setImmediate(() => resolve("input")))]), "input");
    const loaded = await state;
    assert.equal(loaded.workspace, project);
    assert.equal(loaded.dbError, undefined);
    const graph = await background.request("/api/graph?limit=120");
    assert.ok(Array.isArray(graph.nodes));
    await assert.rejects(background.request("/api/nonexistent"));
    const pending = background.request("/api/state/details");
    background.close();
    await assert.rejects(pending, /Dashboard closed/);
    await assert.rejects(background.request("/api/state/details"), /Dashboard closed/);
  } finally {
    background.close();
  }
});

test("Work Board quick terminals always launch a fresh task for the chosen agent", async () => {
  for (const width of [48, 72, 100, 140]) {
    const app = new TerminalDashboard(project, input(), output(width, 30));
    app.taskId = "selected-task";
    app.state = { currentTask: { id: "current-task" }, tasks: [{ id: "selected-task", title: "Existing task" }] };
    app.selection = { group: "Tasks", label: "Existing task", data: { id: "selected-task" } };
    const launches = [];
    app.execute = async () => {
      launches.push({ path: app.form.action.path, values: { ...app.form.values }, pending: { ...app.pending } });
      app.mode = "browse";
    };
    for (const section of ["Tasks", "Sessions"]) {
      app.selectSection(section);
      for (const agent of ["codex", "antigravity", "claude"]) {
        app.render();
        assert.equal(app.hitRegions.filter((region) => region.target.kind === "new-task").length, 1);
        assert.ok(!app.hitRegions.some((region) => region.target.kind === "new-terminal"));
        await click(app, (target) => target.kind === "new-task");
        const hit = app.hitRegions.find((region) => region.target.kind === "new-terminal" && region.target.agent === agent);
        assert.ok(hit, `${section}: ${agent} at ${width} columns`);
        assert.ok(hit.x + hit.width <= width);
        await click(app, (target) => target.kind === "new-terminal" && target.agent === agent);
        assert.deepEqual(launches.at(-1), { path: "/api/session/terminal", values: { agent }, pending: { agent } });
      }
    }
    await click(app, (target) => target.kind === "new-task");
    const count = launches.length;
    await click(app, (target) => target.kind === "command" && target.name === "back");
    assert.equal(app.mode, "browse");
    assert.equal(launches.length, count);
    await click(app, (target) => target.kind === "new-task");
    await app.handleKey("", { name: "down" });
    await app.handleKey("", { name: "return" });
    assert.deepEqual(launches.at(-1).pending, { agent: "antigravity" });
    app.screen = 1;
    app.render();
    assert.ok(!app.hitRegions.some((region) => region.target.kind === "new-terminal"));
    assert.ok(!app.hitRegions.some((region) => region.target.kind === "new-task"));
  }
});

test("dashboard actions cover retained routes across eight terminal screens", async () => {
  const manifest = new Set(uiRouteManifest());
  const covered = new Set(["GET /api/state", "GET /api/state/details", "GET /api/workforce/board", "GET /api/graph"]);
  for (const item of dashboardActions) {
    const route = `${item.method} ${item.path}`;
    assert.ok(manifest.has(route), route);
    assert.ok(screens.includes(item.screen));
    covered.add(route);
    assert.equal(new Set(item.fields.map((field) => field.key)).size, item.fields.length, item.label);
  }
  assert.deepEqual([...manifest].filter((route) => !covered.has(route)), []);
  for (const operation of ["update", "delete", "stop"]) {
    const path = `/api/task/${operation}`;
    assert.ok(!manifest.has(`POST ${path}`));
    await assert.rejects(request(project, "POST", path, {}), /Unknown dashboard action/);
  }
  assert.equal(screens.length, 8);
  assert.ok(!screens.includes("Task"));
  assert.ok(!Object.hasOwn(screenSections, "Task"));
  assert.ok(!manifest.has("GET /"));
  assert.ok(dashboardActions.length >= 70);
});

test("forms validate required fields, numbers, booleans and choices while retaining Unicode and newlines", () => {
  const add = action("memory/add");
  assert.throws(() => parseValues(add, {}), /Content is required/);
  assert.throws(() => parseValues(add, { content: "x", importance: "NaN" }), /number/);
  assert.throws(() => parseValues(action("task/start"), { title: "x", createGoal: "yes" }), /true or false/);
  assert.throws(() => parseValues(add, { content: "x", scope: "unknown" }), /choose/);
  const content = "Đổi giao diện\nGiữ nguyên tiếng Việt 🚀";
  assert.deepEqual(parseValues(add, { content, importance: "0", tags: "" }), { content, importance: 0 });
  assert.deepEqual(parseValues(action("request/clear"), { ids: '["one","two"]' }), { ids: ["one", "two"] });
  assert.equal(action("context/save").fields.find((field) => field.required && field.key === "content")?.key, "content");
});

test("Work Board ranks active tasks and sessions first, then latest activity, and marks active rows without colors", () => {
  const state = {
    tasks: [
      { id: "finished-new", title: "Finished", status: "done", updatedAt: "2026-11-15T12:00:00Z" },
      { id: "running-old", title: "Running old", status: "in_progress", updatedAt: "2026-11-01T00:00:00Z" },
      { id: "running-recent", title: "Running recent", status: "in_progress", updatedAt: "2026-11-02T00:00:00Z" },
      { id: "finished-active-event", title: "Finished event", status: "done", updatedAt: "2026-11-01T00:00:00Z", lastActivityAt: "2026-11-15T13:00:00Z" },
      { id: "missing-time", title: "Unknown", status: "paused" },
    ],
    activeSessionEvents: [
      { sessionId: "session-old", taskId: "running-old", kind: "session_started", createdAt: "2026-11-03T00:00:00Z" },
      { sessionId: "session-ended", kind: "session_ended", createdAt: "2026-11-15T14:00:00Z" },
      { sessionId: "session-recent", taskId: "running-recent", kind: "prompt_submitted", createdAt: "2026-11-14T00:00:00Z" },
    ],
  };
  const before = JSON.stringify(state);
  const rows = screenEntries("Work Board", state, {});
  assert.deepEqual(rows.filter((row) => row.group === "Tasks").map((row) => row.data.id),
    ["running-recent", "running-old", "finished-active-event", "finished-new", "missing-time"]);
  assert.deepEqual(rows.filter((row) => row.group === "Sessions").map((row) => row.data.sessionId),
    ["session-recent", "session-old", "session-ended"]);
  assert.deepEqual(rows.map((row) => row.active), [true, true, true, true, false, false, false, false]);
  assert.equal(rows.find((row) => row.data.id === "running-recent").lastActivityAt, "2026-11-14T00:00:00Z");
  assert.equal(JSON.stringify(state), before);
  const app = new TerminalDashboard(project, input(), output(100, 30));
  app.state = state;
  app.output.isTTY = false;
  for (const section of ["Tasks", "Sessions"]) {
    app.output.text = "";
    app.selectSection(section);
    assert.match(app.output.text, /\[ACTIVE\]/);
    assert.doesNotMatch(app.output.text, /\x1b\[38;2/);
  }
});

test("Work Board loads older tasks with active sessions and records latest activity after a session ends", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "work-board-activity-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  let old;
  let ended;
  const activity = new Date(Date.now() + 1000).toISOString();
  try {
    old = store.createTask({ title: "Old running task", ownerAgent: "codex" });
    ended = store.createTask({ title: "Ended session task", ownerAgent: "claude" });
    store.db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", old.id);
    for (let index = 0; index < 35; index++) store.createTask({ title: `Recent ${index}`, ownerAgent: "codex" });
    assert.ok(!store.listTasks(30).some((task) => task.id === old.id));
    store.recordSessionEvent({ sessionId: "old-live-session", taskId: old.id, agent: "codex", kind: "prompt_submitted", createdAt: activity });
    startAgentSession("old-live-session", old.id, fixture, "codex");
    const tracked = readConfig(fixture);
    tracked.sessionWindows = { "old-live-session": { pid: process.pid, processStartedAt: readSessionProcessStart(process.pid), taskId: old.id, agent: "codex", updatedAt: new Date().toISOString() } };
    writeConfig(tracked, fixture);
    store.recordSessionEvent({ sessionId: "ended-session", taskId: ended.id, agent: "claude", kind: "session_ended", createdAt: activity });
    store.updateTask(ended.id, { status: "done" });
    store.db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", ended.id);
  } finally { store.close(); }
  try {
    const { state } = await loadDashboard(fixture);
    assert.equal(state.tasks.find((task) => task.id === old.id).lastActivityAt, activity);
    assert.equal(state.tasks.find((task) => task.id === ended.id).lastActivityAt, activity);
    const tasks = screenEntries("Work Board", state, {}).filter((entry) => entry.group === "Tasks");
    const running = tasks.find((entry) => entry.data.id === old.id);
    assert.equal(running.active, Boolean(readSessionProcessStart(process.pid)));
    if (running.active) assert.equal(tasks[0].data.id, old.id);
    assert.equal(tasks.find((entry) => entry.data.id === ended.id).active, false);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("Work Board does not mark an in-progress task active after its last session closes", () => {
  const task = { id: "unfinished", status: "in_progress", title: "Unfinished work" };
  for (const sessions of [[], [{ sessionId: "closed", taskId: task.id, kind: "session_ended" }],
    [{ sessionId: "paused", taskId: task.id, kind: "session_paused" }]]) {
    const rows = screenEntries("Work Board", { tasks: [task], activeSessionEvents: sessions }, {});
    assert.equal(rows.find((entry) => entry.group === "Tasks").active, false);
    assert.ok(rows.every((entry) => !entry.active));
  }
  const rows = screenEntries("Work Board", { tasks: [task], activeSessionEvents: [
    { sessionId: "closed", taskId: task.id, kind: "session_ended" },
    { sessionId: "open", taskId: task.id, kind: "prompt_submitted" },
  ] }, {});
  assert.equal(rows.find((entry) => entry.group === "Tasks").active, true);
});

test("closed tabs and windows end their sessions while idle live terminals remain active", () => {
  const fixture = mkdtempSync(join(tmpdir(), "work-board-closed-terminals-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  try {
    const task = store.createTask({ title: "Keep unfinished work", ownerAgent: "codex" });
    store.updateTask(task.id, { status: "in_progress" });
    const cases = [
      { id: "closed-tab", pid: 101, hwnd: "201", processAlive: false, windowAlive: true },
      { id: "closed-window", pid: 102, hwnd: "202", processAlive: false, windowAlive: false },
      { id: "live-tab", pid: 103, hwnd: "201", processAlive: true, windowAlive: true },
      { id: "live-process", pid: 104, processAlive: true },
      { id: "legacy-closed-tab", hwnd: "201", windowAlive: true },
    ];
    for (const item of cases) {
      startAgentSession(item.id, task.id, fixture, "codex");
      store.recordSessionEvent({ sessionId: item.id, taskId: task.id, agent: "codex", kind: "session_started", createdAt: "2020-01-01T00:00:00Z" });
    }
    const config = readConfig(fixture);
    config.sessionWindows = Object.fromEntries(cases.map((item) => [item.id, {
      pid: item.pid, hwnd: item.hwnd, windowId: item.id, taskId: task.id, agent: "codex", updatedAt: "2020-01-01T00:00:00Z",
    }]));
    writeConfig(config, fixture);
    const options = {
      windowCheckIntervalMs: 0,
      isSessionProcessAlive: (pid) => cases.find((item) => item.pid === pid).processAlive,
      isSessionWindowAlive: (hwnd) => cases.find((item) => item.hwnd === hwnd).windowAlive,
    };
    assert.equal(cleanupStaleAgentSessions(store, fixture, options), 2);
    assert.deepEqual(store.listActiveSessionEvents().map((event) => event.sessionId).sort(), ["legacy-closed-tab", "live-process", "live-tab"]);
    assert.deepEqual(Object.keys(readConfig(fixture).activeSessions).sort(), ["legacy-closed-tab", "live-process", "live-tab"]);
    assert.equal(readConfig(fixture).sessionWindows["closed-tab"], undefined);
    assert.equal(readConfig(fixture).sessionWindows["closed-window"], undefined);
    assert.ok(readConfig(fixture).sessionWindows["legacy-closed-tab"]);
    assert.equal(store.getTask(task.id).status, "in_progress");
    assert.equal(cleanupStaleAgentSessions(store, fixture, options), 0);
  } finally {
    store.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an unrelated foreground window cannot end a recently active native session", () => {
  const fixture = mkdtempSync(join(tmpdir(), "work-board-native-window-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  try {
    const task = store.createTask({ title: "Native session", ownerAgent: "codex" });
    startAgentSession("native", task.id, fixture, "codex");
    store.recordSessionEvent({ sessionId: "native", taskId: task.id, agent: "codex", kind: "prompt_submitted" });
    const config = readConfig(fixture);
    config.sessionWindows = { native: { hwnd: "unrelated-window", taskId: task.id, agent: "codex", updatedAt: new Date().toISOString() } };
    writeConfig(config, fixture);
    assert.equal(cleanupStaleAgentSessions(store, fixture, { windowCheckIntervalMs: 0, isSessionWindowAlive: () => false }), 0);
    assert.equal(store.listActiveSessionEvents()[0].sessionId, "native");
    config.sessionWindows.native.pid = 4242;
    writeConfig(config, fixture);
    assert.equal(cleanupStaleAgentSessions(store, fixture, {
      now: new Date(Date.now() + 16 * 60 * 1000), windowCheckIntervalMs: 0,
      isSessionProcessAlive: () => true, isSessionWindowAlive: () => false,
    }), 0);
    delete config.sessionWindows.native.pid;
    writeConfig(config, fixture);
    assert.equal(cleanupStaleAgentSessions(store, fixture, {
      now: new Date(Date.now() + 16 * 60 * 1000), windowCheckIntervalMs: 0, isSessionWindowAlive: () => true,
    }), 0);
  } finally {
    store.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("terminal output strips control sequences and fits wide Unicode safely", () => {
  assert.equal(clean("\x1b[2Jhello\x1b]0;title\x07\x00"), "hello");
  assert.equal(fit("界a", 4), "界a ");
  assert.deepEqual(wrap("界ab\nĐã sửa", 3), ["界a", "b", "Đã ", "sửa"]);
  assert.match(describe({ title: "Đã sửa", content: "line 1\nline 2" }), /line 1\nline 2/);
});

test("in-process actions persist task, memory, context, handoff and repository skill data", async () => {
  const first = await performAction(project, action("task/start"), { title: "TUI kiểm thử", agent: "codex" });
  const firstId = first.task.id;
  const second = await performAction(project, action("task/start"), { title: "Another task", agent: "codex" });
  await performAction(project, action("memory/add"), { taskId: firstId, content: "Chỉ thuộc task thứ nhất", type: "note" });
  await performAction(project, action("context/save"), { taskId: firstId, content: "# Context\nTiếng Việt" });
  await performAction(project, action("handoff/save"), { taskId: firstId, summary: "Đã chuyển TUI", from: "codex" });
  await performAction(project, action("skills/save"), { scope: "repo", name: "tui-check", description: "Terminal check", content: "---\nname: tui-check\ndescription: Terminal check\n---\n\nKiểm tra TUI.\n" });
  const originalCurrent = readConfig(project).currentTaskId;
  const selected = await loadDashboard(project, firstId);
  assert.equal(selected.state.currentTask.id, firstId);
  assert.equal(selected.state.memories.some((item) => item.content === "Chỉ thuộc task thứ nhất"), true);
  assert.match(selected.state.compiledContext, /Tiếng Việt/);
  assert.equal(selected.state.handoff.summary, "Đã chuyển TUI");
  assert.equal(selected.state.skills.some((item) => item.name === "tui-check"), true);
  assert.equal(readConfig(project).currentTaskId, originalCurrent);
  assert.equal(originalCurrent, second.task.id);
  for (const screen of screens) assert.ok(Array.isArray(screenEntries(screen, selected.state, selected.board)));
  await assert.rejects(request(project, "POST", "/api/task/start", {}), /title is required/);
  await assert.rejects(request(project, "GET", "/"), /Unknown dashboard action/);
  const acquired = await performAction(project, action("orchestration/lease/acquire"), { taskId: firstId, path: "file.ts", agent: "codex" });
  assert.equal(acquired.acquired, true);
  await assert.rejects(performAction(project, action("orchestration/lease/release"), { taskId: firstId, leaseId: acquired.lease.id, agent: "claude" }), /ownership conflict/);
  const released = await performAction(project, action("orchestration/lease/release"), { taskId: firstId, leaseId: acquired.lease.id, agent: "codex" });
  assert.ok(released.lease.releasedAt);
  await assert.rejects(performAction(project, action("orchestration/lease/acquire"), { taskId: firstId, path: "../escape", agent: "codex" }), /repository-relative/);
});

test("keyboard navigation, filtering and multiline form editing preserve values during refresh", async () => {
  const out = output();
  const app = new TerminalDashboard(project, input(), out);
  await app.refresh();
  await app.handleKey("3", { name: "3" });
  assert.equal(app.currentScreen, "Knowledge");
  await app.handleKey("9", { name: "9" });
  assert.equal(app.currentScreen, "Knowledge");
  await app.handleKey("a", { name: "a" });
  await app.handleKey("/", { name: "/" });
  await app.handleKey("Add", {});
  assert.equal(app.entries().length, 1);
  await app.handleKey("\r", { name: "return" });
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.mode, "form");
  await app.handleKey("Đã sửa q", {});
  await app.handleKey("\n", { ctrl: true, name: "j" });
  await app.handleKey("Dòng hai", {});
  assert.equal(app.form.values.content, "Đã sửa q\nDòng hai");
  await app.refresh();
  assert.equal(app.form.values.content, "Đã sửa q\nDòng hai");
  await app.handleKey("\x13", { ctrl: true, name: "s" });
  assert.equal(app.mode, "confirm");
  await app.handleKey("\x1b", { name: "escape" });
  assert.equal(app.mode, "form");
  assert.equal(app.form.values.content, "Đã sửa q\nDòng hai");
  await app.handleKey("\x13", { ctrl: true, name: "s" });
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.mode, "detail");
  assert.match(app.detail, /Đã sửa q/);
  assert.match(out.text, /AGENT BRIDGE/);
  assert.ok(!app.closed);
  app.openForm(action("memory/add"));
  await app.handleKey(undefined, { name: "paste-start" });
  await app.handleKey("q\r\nĐổi toàn bộ\rTUI", {});
  await app.handleKey(undefined, { name: "paste-end" });
  assert.equal(app.form.values.content, "q\nĐổi toàn bộ\nTUI");
  assert.equal(app.mode, "form");
  assert.ok(!app.closed);
});

test("context editor submits the backend content field and prefills the selected task", async () => {
  const app = new TerminalDashboard(project, input(), output(72, 20));
  await app.refresh();
  app.state.compiledContext = "Nội dung hiện có";
  app.openForm(action("context/save"));
  assert.equal(app.form.values.content, "Nội dung hiện có");
  assert.equal(app.form.values.taskId, app.state.currentTask.id);
  await app.handleKey("\x13", { ctrl: true, name: "s" });
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.mode, "detail");
  assert.match(app.state.compiledContext, /Nội dung hiện có/);
});

test("all screens render within terminal bounds, including resize and small terminals", async () => {
  const out = output(100, 30);
  const app = new TerminalDashboard(project, input(), out);
  await app.refresh();
  for (const columns of [48, 72, 100, 140]) {
    out.columns = columns;
    for (let index = 0; index < screens.length; index++) {
      app.screen = index;
      app.render();
      const frame = out.text.split("\x1b[H").at(-1);
      assert.ok(frame.split("\r\n").length <= out.rows);
    }
  }
  out.columns = 30;
  app.render();
  assert.match(out.text, /Enlarge terminal/);
});

test("raw terminal lifecycle restores cursor, alternate screen and signal listeners", async () => {
  const incoming = input();
  const outgoing = output();
  const before = process.listenerCount("SIGINT");
  const app = new TerminalDashboard(project, incoming, outgoing);
  const done = app.run();
  assert.equal(incoming.isRaw, true);
  await app.refresh();
  incoming.write("\x03");
  await done;
  assert.equal(incoming.isRaw, false);
  assert.equal(process.listenerCount("SIGINT"), before);
  assert.match(outgoing.text, /\x1b\[\?1049h/);
  assert.match(outgoing.text, /\x1b\[\?25h\x1b\[\?1049l/);
  assert.equal(incoming.listenerCount("keypress"), 0);
});

test("opening the TUI starts the watcher by default, manual Stop survives refresh, and reopening starts it again", async () => {
  const fixture = mkdtempSync(join(project, "watch-default-"));
  ensureWorkspace(fixture);
  assert.equal(readConfig(fixture).graph.watchAutoBrief, true);
  const app = new TerminalDashboard(fixture, input(), output());
  const done = app.run();
  const child = watcherProcess;
  assert.ok(child);
  const stopped = once(child, "close");
  try {
    assert.equal(isWatcherRunning(), true);
    assert.equal(app.state.watcherRunning, true);
    await request(fixture, "POST", "/api/watch/stop", {});
    await stopped;
    await app.refresh();
    await app.refresh();
    assert.equal(isWatcherRunning(), false);
    assert.equal(watcherProcess, null);
    assert.equal(readConfig(fixture).graph.watchAutoBrief, true);
  } finally {
    app.close();
    await done;
    await stopped;
  }
  const reopened = new TerminalDashboard(fixture, input(), output());
  const resumed = reopened.run();
  const next = watcherProcess;
  assert.ok(next);
  const exited = once(next, "close");
  try {
    assert.notEqual(next, child);
    assert.equal(isWatcherRunning(), true);
  } finally {
    reopened.close();
    await resumed;
    await exited;
  }
  assert.equal(isWatcherRunning(), false);
});

test("TUI startup does not start the watcher when Watch Auto Brief or the repository is disabled", async () => {
  for (const setting of ["watchAutoBrief", "enabled"]) {
    const fixture = mkdtempSync(join(project, "watch-opt-out-"));
    ensureWorkspace(fixture);
    const config = readConfig(fixture);
    writeConfig(setting === "enabled" ? { ...config, enabled: false } : { ...config, graph: { ...config.graph, watchAutoBrief: false } }, fixture);
    const app = new TerminalDashboard(fixture, input(), output());
    const done = app.run();
    try {
      assert.equal(isWatcherRunning(), false);
      assert.equal(watcherProcess, null);
      await app.refresh();
      assert.equal(isWatcherRunning(), false);
    } finally {
      app.close();
      await done;
    }
  }
});

test("a standalone watcher exits when the repository is disabled from another process", async () => {
  const fixture = mkdtempSync(join(project, "watch-disable-"));
  ensureWorkspace(fixture);
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "watch", "--project", fixture], { cwd: fixture, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Watcher did not start")), 10000);
      child.once("error", reject);
      child.stdout.on("data", (data) => {
        if (data.toString().includes("agent-bridge watch: watching")) { clearTimeout(timer); resolve(); }
      });
    });
    execFileSync(process.execPath, [cli, "repo", "disable"], { cwd: fixture, stdio: "pipe", timeout: 10000 });
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Disabled watcher did not exit")), 10000); }),
    ]);
    assert.equal(result[0], 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await closed;
  }
});

test("snapshot and ui alias work through the real CLI without opening a web server", () => {
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  for (const command of ["tui", "ui"]) {
    const text = execFileSync(process.execPath, [cli, command, "--project", project, "--snapshot"], { encoding: "utf8", timeout: 30000 });
    for (const screen of screens) assert.ok(text.includes(screen), `${command}: ${screen}`);
    assert.ok(!text.includes("http://127.0.0.1"));
    assert.ok(!text.includes("\x1b["));
  }
  assert.throws(() => execFileSync(process.execPath, [cli, "tui"], { encoding: "utf8", stdio: "pipe", timeout: 30000 }), /interactive terminal/);
});

test("bare command opens the TUI and initializes a fresh repository with the standard integrations", () => {
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const fresh = mkdtempSync(join(project, "fresh-"));
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: fresh, encoding: "utf8", stdio: "pipe", timeout: 30000 });
  assert.match(run(["--help"]), /Usage: agent-bridge/);
  assert.match(run(["--version"]), /\d+\.\d+\.\d+/);
  assert.ok(!existsSync(join(fresh, ".agent-memory")));
  assert.throws(() => run([]), /TUI requires an interactive terminal/);
  const snapshot = run(["--snapshot"]);
  for (const screen of screens) assert.ok(snapshot.includes(screen));
  for (const path of [".git", ".agent-memory/config.json", ".agent-memory/memories.db", "AGENTS.md", "CLAUDE.md", ".claude/settings.local.json", ".agents/hooks.json"]) {
    assert.ok(existsSync(join(fresh, path)), path);
  }
  const configPath = join(fresh, ".agent-memory/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.tokenBudget = 1234;
  writeFileSync(configPath, JSON.stringify(config));
  const agentsPath = join(fresh, "AGENTS.md");
  const authored = readFileSync(agentsPath, "utf8") + "\nPersonal repository rules.\n";
  writeFileSync(agentsPath, authored);
  const hooksPath = join(fresh, ".claude/settings.local.json");
  const hooks = readFileSync(hooksPath, "utf8");
  run(["--snapshot"]);
  assert.equal(readConfig(fresh).tokenBudget, 1234);
  assert.equal(readFileSync(agentsPath, "utf8"), authored);
  assert.equal(readFileSync(hooksPath, "utf8"), hooks);
});

test("default TUI accepts an explicit project without initializing the caller directory", () => {
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const caller = mkdtempSync(join(project, "caller-"));
  const target = mkdtempSync(join(project, "target-"));
  const text = execFileSync(process.execPath, [cli, "--project", target, "--snapshot"], { cwd: caller, encoding: "utf8", timeout: 30000 });
  assert.ok(text.includes(target));
  assert.ok(existsSync(join(target, ".agent-memory/memories.db")));
  assert.ok(!existsSync(join(caller, ".agent-memory")));
});

test("mouse parser separates fragmented SGR and legacy clicks from Unicode keyboard input", () => {
  let keyboard = "";
  const events = [];
  const parser = new TerminalInput((text) => { keyboard += text; }, (event) => events.push(event));
  const text = "Đổi 🚀\x1b[<0;25;7M\x1b[<0;25;7m\x1b[<65;130;12M\x1b[A";
  for (const byte of Buffer.from(text)) parser.feed(Buffer.from([byte]));
  assert.equal(keyboard, "Đổi 🚀\x1b[A");
  assert.deepEqual(events[0], mouse(24, 6));
  assert.equal(events[1].release, true);
  assert.equal(events[2].wheel, 1);
  assert.equal(events[2].x, 129);
  parser.feed("\x1b[M" + String.fromCharCode(32, 43, 39));
  assert.deepEqual(events[3], mouse(10, 6));
  parser.close();
});

test("paste contents stay keyboard input and Escape remains available", async () => {
  let keyboard = "";
  const events = [];
  const parser = new TerminalInput((text) => { keyboard += text; }, (event) => events.push(event));
  const paste = "\x1b[200~q\nĐã sửa\x1b[<0;20;4M\x1b[201~";
  for (const byte of Buffer.from(paste)) parser.feed(Buffer.from([byte]));
  assert.equal(keyboard, paste);
  assert.equal(events.length, 0);
  parser.feed("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(keyboard, paste + "\x1b");
  parser.close();
});

test("mouse navigation, record selection and double-click work without shifting the clicked row", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 32));
  app.state = { tasks: Array.from({ length: 30 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, status: "todo" })) };
  app.render();
  await click(app, (target) => target.kind === "row" && target.index === 3);
  assert.equal(app.selected, 3);
  assert.equal(app.mode, "browse");
  await click(app, (target) => target.kind === "row" && target.index === 3);
  assert.equal(app.mode, "detail");
  assert.match(app.detail, /Task 3/);
  await click(app, (target) => target.kind === "screen" && target.index === screens.indexOf("Skills"));
  assert.equal(app.currentScreen, "Skills");
  assert.equal(app.mode, "browse");
  await click(app, (target) => target.kind === "command" && target.name === "actions");
  await click(app, (target) => target.kind === "row" && target.index === 0);
  assert.equal(app.mode, "form");
  assert.equal(app.form.action.label, "Save skill");
});

test("clicking fields, options and text caret edits the form; mouse review keeps execution explicit", async () => {
  const app = new TerminalDashboard(project, input(), output(120, 32));
  app.openForm(action("task/start"));
  app.render();
  await click(app, (target) => target.kind === "field" && target.index === 1);
  await click(app, (target) => target.kind === "choice" && target.value === "claude");
  assert.equal(app.form.values.agent, "claude");
  await click(app, (target) => target.kind === "field" && target.index === 0);
  await app.handleKey("Đổi TUI", {});
  const editor = app.hitRegions.find((region) => region.target.kind === "editor");
  await app.handleMouse(mouse(editor.x + 3, editor.y));
  await app.handleKey("!", {});
  assert.equal(app.form.values.title, "Đổi! TUI");
  await click(app, (target) => target.kind === "command" && target.name === "review");
  assert.equal(app.mode, "confirm");
  assert.ok(app.hitRegions.some((region) => region.target.kind === "command" && region.target.name === "execute"));
  await click(app, (target) => target.kind === "command" && target.name === "back");
  assert.equal(app.mode, "form");
  assert.equal(app.form.values.title, "Đổi! TUI");
  await click(app, (target) => target.kind === "command" && target.name === "help");
  await click(app, (target) => target.kind === "command" && target.name === "back");
  assert.equal(app.mode, "form");
});

test("wheel and scrollbar scroll lists, inspector and detail panes independently", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 28));
  app.state = { tasks: Array.from({ length: 40 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, goal: "A long goal.\n".repeat(50) })) };
  app.render();
  const listBar = app.hitRegions.findLast((region) => region.target.kind === "scroll" && region.target.area === "list");
  await app.handleMouse(mouse(listBar.x, listBar.y));
  assert.equal(app.selected, 39);
  const selected = app.selected;
  const previewBar = app.hitRegions.findLast((region) => region.target.kind === "scroll" && region.target.area === "preview");
  assert.ok(previewBar);
  const before = app.previewScroll;
  await app.handleMouse(mouse(previewBar.x - 3, previewBar.y - 3, 1));
  assert.ok(app.previewScroll > before);
  assert.equal(app.selected, selected);
  await app.handleKey("\r", { name: "return" });
  await app.handleMouse(mouse(50, 12, 1));
  assert.ok(app.scroll > 0);
  await app.handleMouse({ ...mouse(50, 12), release: true });
  assert.equal(app.mode, "detail");
});

test("all navigation tabs and controls remain clickable and inside resized terminal bounds", () => {
  for (const columns of [48, 72, 100, 140]) {
    const out = output(columns, 24);
    const app = new TerminalDashboard(project, input(), out);
    app.render();
    assert.equal(app.hitRegions.filter((region) => region.target.kind === "screen").length, screens.length);
    for (const hit of app.hitRegions) {
      assert.ok(hit.x >= 0 && hit.y >= 0);
      assert.ok(hit.x + hit.width <= columns);
      assert.ok(hit.y + hit.height <= out.rows);
    }
    const frame = out.text.split("\x1b[H").at(-1);
    for (const line of clean(frame).split("\n")) {
      const cells = [...line].reduce((sum, char) => sum + cellWidth(char), 0);
      assert.ok(cells < columns, `${columns}: ${cells}`);
    }
  }
  assert.deepEqual(editorLines("界ab\nĐổi", 3), [{ text: "界a", start: 0 }, { text: "b", start: 2 }, { text: "Đổi", start: 4 }]);
  assert.equal(cursorAt("界a", 2), 1);
});

test("raw mouse events drive the app without leaking escape sequences into text fields", async () => {
  const incoming = input();
  const outgoing = output(120, 30);
  const app = new TerminalDashboard(project, incoming, outgoing);
  const done = app.run();
  await app.refresh();
  const sendClick = async (predicate) => {
    const hit = app.hitRegions.find((region) => predicate(region.target));
    assert.ok(hit);
    const sequence = `\x1b[<0;${hit.x + 1};${hit.y + 1}M\x1b[<0;${hit.x + 1};${hit.y + 1}m`;
    for (const byte of Buffer.from(sequence)) incoming.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await sendClick((target) => target.kind === "command" && target.name === "actions");
  await sendClick((target) => target.kind === "row" && target.index === 0);
  assert.equal(app.mode, "form");
  incoming.write("Tiếng Việt");
  await sendClick((target) => target.kind === "field" && target.index === 1);
  assert.equal(app.form.values.title, "Tiếng Việt");
  assert.ok(!app.form.values.title.includes("[<"));
  incoming.write("\x03");
  await done;
  assert.ok(outgoing.text.includes(mouseEnable));
  assert.ok(outgoing.text.includes(mouseDisable));
  assert.equal(incoming.listenerCount("data"), 0);
});

test("screen clusters cover every record and action and Orchestrator isolates team, approvals and run controls", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.screen = 1;
  app.state = { config: {}, registeredAgents: [{ id: "worker-a", name: "Implementer", provider: "codex", mode: "cli", model: "local-model", enabled: true }], defaultAgentPresets: [{ key: "preset-a", label: "Preset", provider: "codex" }] };
  app.board = { taskTitle: "Build UI", orchestration: { taskId: "orchestration-task", cycle: 2, maxCycles: 8, status: "executing", autonomy: "manual" }, leaderAgent: { provider: "codex", model: "local-model" },
    orchestrations: [{ taskId: "orchestration-task", taskTitle: "Build UI" }], runs: [{ id: "run-a", planTitle: "Implement UI", taskId: "orchestration-task", status: "running" }],
    questions: [{ id: "question-a", title: "Which layout?", taskId: "orchestration-task" }], approvals: [{ id: "approval-a", title: "Approve spawn", taskId: "orchestration-task" }], subtasks: [{ id: "subtask-a", title: "Implement UI" }], reviews: [{ id: "review-a", summary: "Review result" }], events: [{ kind: "started", summary: "Cycle started" }], adoptable: [{ sessionId: "external-a" }] };
  app.render();
  for (const name of ["Runs", "Team", "Presets", "Questions", "Approvals", "Plan", "Reviews", "Activity", "Settings", "All"]) assert.ok(app.hitRegions.some((hit) => hit.target.kind === "section" && hit.target.name === name), name);
  await click(app, (target) => target.kind === "section" && target.name === "Team");
  assert.deepEqual(app.entries().map((entry) => entry.group), ["Agents"]);
  await click(app, (target) => target.kind === "action" && target.path === "workforce/agent/update");
  assert.equal(app.form.values.agentId, "worker-a");
  assert.equal(app.form.values.model, "local-model");
  app.selectSection("Approvals");
  await click(app, (target) => target.kind === "action" && target.path === "workforce/orchestration/approve-spawn");
  assert.equal(app.form.values.requestId, "approval-a");
  assert.equal(app.form.values.taskId, "orchestration-task");
  app.selectSection("Questions");
  await click(app, (target) => target.kind === "action" && target.path.endsWith("answer-questions"));
  assert.ok(app.form.fields.some((field) => field.key === "answer:question-a"));
  for (const screen of screens) {
    const all = screen === "Graph" ? graphEntries({}, {}) : screenEntries(screen, app.state, app.board);
    const covered = new Set(screenSections[screen].flatMap((section) => sectionEntries(all, section)));
    for (const entry of all) assert.ok(covered.has(entry), `${screen}/${entry.group}`);
    const actions = dashboardActions.filter((action) => action.screen === screen);
    const available = new Set(screenSections[screen].flatMap((section) => sectionActions(actions, section)));
    for (const action of actions) assert.ok(available.has(action), action.label);
  }
});

test("delete agent and preset forms select named records and review the matching API identifiers", async () => {
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.screen = 1;
  app.state = {
    registeredAgents: [{ id: "worker-a", name: "Implementer", provider: "codex", model: "model-a" }, { id: "worker-b", name: "Reviewer", provider: "claude", model: "model-b" }],
    defaultAgentPresets: [{ key: "custom:first", label: "First preset", provider: "codex" }, { key: "custom:second", label: "Second preset", provider: "claude" }],
  };
  app.openForm(action("workforce/agent/delete"));
  assert.equal(app.form.values.agentId, "[]");
  await app.handleKey(" ", { name: "space" });
  assert.deepEqual(JSON.parse(app.form.values.agentId), ["worker-a"]);
  await app.handleKey("", { name: "down" });
  await app.handleKey(" ", { name: "space" });
  assert.deepEqual(JSON.parse(app.form.values.agentId), ["worker-a", "worker-b"]);
  await app.handleKey("bad-id", {});
  assert.deepEqual(JSON.parse(app.form.values.agentId), ["worker-a", "worker-b"]);
  app.render();
  assert.match(out.text, /Reviewer · claude · model-b/);
  await app.handleKey("", { ctrl: true, name: "s" });
  assert.equal(app.mode, "confirm");
  assert.deepEqual(app.pending, { agentId: ["worker-a", "worker-b"] });
  assert.match(out.text, /1\. Implementer · codex · model-a/);
  assert.match(out.text, /2\. Reviewer · claude · model-b/);
  app.openForm(action("workforce/default-agent/delete"));
  app.render();
  await click(app, (target) => target.kind === "choice" && target.value === "custom:second");
  await click(app, (target) => target.kind === "choice" && target.value === "custom:first");
  await click(app, (target) => target.kind === "choice" && target.value === "custom:second");
  assert.deepEqual(JSON.parse(app.form.values.presetKey), ["custom:first"]);
  await click(app, (target) => target.kind === "command" && target.name === "select-all");
  await app.handleKey("", { ctrl: true, name: "s" });
  assert.deepEqual(app.pending, { presetKey: ["custom:first", "custom:second"] });
  assert.match(out.text, /2\. Second preset · claude/);
  assert.equal(action("workforce/agent/delete").fields[0].choices, undefined);
});

test("delete pickers preselect the highlighted record and handle empty lists", async () => {
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.screen = 1;
  app.state = { registeredAgents: [{ id: "worker-a", name: "Implementer", provider: "codex" }], defaultAgentPresets: [{ key: "preset-a", label: "Preset", provider: "codex" }] };
  app.selectSection("Team");
  app.openAction("workforce/agent/delete");
  assert.deepEqual(JSON.parse(app.form.values.agentId), ["worker-a"]);
  app.selectSection("Presets");
  app.openAction("workforce/default-agent/delete");
  assert.deepEqual(JSON.parse(app.form.values.presetKey), ["preset-a"]);
  await app.handleKey("", { ctrl: true, name: "u" });
  assert.equal(app.form.values.presetKey, "[]");
  await assert.rejects(app.handleKey("", { ctrl: true, name: "s" }), /is required/);
  await app.handleKey("", { ctrl: true, name: "a" });
  assert.deepEqual(JSON.parse(app.form.values.presetKey), ["preset-a"]);
  app.state = {};
  for (const path of ["workforce/agent/delete", "workforce/default-agent/delete"]) {
    app.openForm(action(path));
    await app.handleKey("", { name: "down" });
    assert.equal(app.form.values[app.form.fields[0].key], "[]");
    app.render();
    assert.match(out.text, /No items available to delete/);
    await assert.rejects(app.handleKey("", { ctrl: true, name: "s" }), /is required/);
    assert.equal(app.mode, "form");
  }
});

test("bulk deletion executes all selected agents, retains unselected agents and reports individual failures", async () => {
  const fixture = mkdtempSync(join(project, "bulk-delete-"));
  ensureWorkspace(fixture);
  const store = openStore(fixture);
  let agents;
  try {
    agents = ["First", "Second", "Keep"].map((name) => store.createRegisteredAgent({ name, provider: "manual", mode: "manual", capabilities: [] }));
  } finally { store.close(); }
  const app = new TerminalDashboard(fixture, input(), output(140, 36));
  app.screen = 1;
  app.state = { registeredAgents: [agents[0], { id: "missing-agent", name: "Missing" }, agents[1], agents[2]] };
  app.openForm(action("workforce/agent/delete"));
  app.render();
  for (const id of [agents[0].id, "missing-agent", agents[1].id]) await click(app, (target) => target.kind === "choice" && target.value === id);
  await app.handleKey("", { ctrl: true, name: "s" });
  const before = openStore(fixture);
  try { assert.ok(before.listRegisteredAgents().some((agent) => agent.id === agents[0].id)); }
  finally { before.close(); }
  await app.handleKey("", { name: "return" });
  assert.equal(app.mode, "detail");
  assert.match(app.detail, /succeeded: 2/);
  assert.match(app.detail, /failed: 1/);
  assert.match(app.detail, /Agent not found/);
  const after = openStore(fixture);
  try {
    const ids = after.listRegisteredAgents().map((agent) => agent.id);
    assert.ok(!ids.includes(agents[0].id));
    assert.ok(!ids.includes(agents[1].id));
    assert.ok(ids.includes(agents[2].id));
  } finally { after.close(); }
});

const modelCatalogs = () => [
  { provider: "codex", defaultCommand: "codex", models: [{ value: "codex-fast", label: "Fast", reasoning: [{ value: "low", label: "Low" }] }, { value: "codex-deep", label: "Deep", reasoning: [{ value: "high", label: "High" }] }], reasoning: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
  { provider: "claude", defaultCommand: "claude", models: [{ value: "claude-test", label: "Claude test" }], reasoning: [{ value: "medium", label: "Medium" }] },
];

test("all Orchestrator model forms offer provider-specific model and reasoning suggestions", () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.catalogs = modelCatalogs();
  app.board = { leaderAgent: { provider: "codex" } };
  const actions = dashboardActions.filter((action) => action.screen === "Orchestrator" && action.fields.some((field) => field.key === "model" || field.key === "leaderModel"));
  assert.ok(actions.length >= 7);
  for (const item of actions) {
    app.openForm(item);
    const model = app.form.fields.find((field) => field.key === "model" || field.key === "leaderModel");
    const providerKey = model.key === "leaderModel" ? "leaderProvider" : "provider";
    if (app.form.fields.some((field) => field.key === providerKey)) app.form.values[providerKey] = "codex";
    app.render();
    assert.deepEqual(model.choices, ["", "codex-fast", "codex-deep"], item.label);
    assert.equal(model.allowCustom, true);
    assert.equal(item.fields.find((field) => field.key === model.key).choices, undefined);
    if (app.form.fields.some((field) => field.key === providerKey)) {
      app.form.values[model.key] = "codex-deep";
      app.form.values[providerKey] = "claude";
      app.render();
      assert.equal(app.form.values[model.key], "");
      assert.deepEqual(model.choices, ["", "claude-test"]);
    }
  }
});

test("model picker supports mouse, keyboard, custom models and dependent reasoning levels", async () => {
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.catalogs = modelCatalogs();
  app.openForm(action("workforce/agent"));
  app.form.values.name = "Test worker";
  assert.equal(app.form.values.command, "codex");
  app.focusField(app.form.fields.findIndex((field) => field.key === "model"));
  app.render();
  await click(app, (target) => target.kind === "choice" && target.value === "codex-fast");
  const reasoning = app.form.fields.find((field) => field.key === "reasoningEffort");
  assert.deepEqual(reasoning.choices, ["", "low"]);
  app.form.values.reasoningEffort = "low";
  await click(app, (target) => target.kind === "choice" && target.value === "codex-deep");
  assert.equal(app.form.values.reasoningEffort, "");
  assert.deepEqual(reasoning.choices, ["", "high"]);
  app.focusField(app.form.fields.findIndex((field) => field.key === "provider"));
  app.render();
  await click(app, (target) => target.kind === "choice" && target.value === "claude");
  assert.equal(app.form.values.model, "");
  assert.equal(app.form.values.command, "claude");
  app.focusField(app.form.fields.findIndex((field) => field.key === "model"));
  app.render();
  await app.handleKey("", { name: "down" });
  assert.equal(app.form.values.model, "claude-test");
  await app.handleKey("", { ctrl: true, name: "u" });
  await app.handleKey("my-private-model", {});
  assert.equal(app.form.values.model, "my-private-model");
  assert.match(out.text, /Type or pick: my-private-model/);
  await app.handleKey("", { ctrl: true, name: "s" });
  assert.equal(app.pending.provider, "claude");
  assert.equal(app.pending.model, "my-private-model");
});

test("editing agents and run models preserves existing models and resolves providers from run agents", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.screen = 1;
  app.catalogs = modelCatalogs();
  app.state = { registeredAgents: [{ id: "agent-a", name: "Worker", provider: "claude", model: "custom-existing", command: "custom-cli", reasoningEffort: "medium" }] };
  app.selectSection("Team");
  app.openAction("workforce/agent/update");
  assert.equal(app.form.values.provider, "claude");
  assert.equal(app.form.values.model, "custom-existing");
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "claude-test"]);
  app.form.values.provider = "codex";
  app.render();
  assert.equal(app.form.values.command, "custom-cli");
  app.board = { runs: [{ id: "run-a", agentId: "agent-a", model: "custom-existing", reasoningEffort: "medium" }] };
  app.selectSection("Runs");
  app.openAction("workforce/run/set-model");
  assert.equal(app.form.values.model, "custom-existing");
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "claude-test"]);
  app.form.values.runId = "other-run";
  app.board.runs.push({ id: "other-run", provider: "codex" });
  app.render();
  assert.equal(app.form.values.model, "");
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "codex-fast", "codex-deep"]);
  app.openForm(action("workforce/default-agent/create"));
  app.form.values.provider = "manual";
  app.render();
  assert.equal(app.form.fields.find((field) => field.key === "model").choices, undefined);
  app.focusField(app.form.fields.findIndex((field) => field.key === "model"));
  await app.handleKey("local-model", {});
  assert.equal(app.form.values.model, "local-model");
});

test("model suggestions automatically discover the selected CLI without losing typed form values", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.catalogs = modelCatalogs();
  const calls = [];
  let finish;
  app.discoverModels = (provider, command, timeout) => {
    calls.push({ provider, command, timeout });
    return new Promise((resolve) => { finish = resolve; });
  };
  app.openForm(action("workforce/default-agent/create"));
  app.form.values.label = "Unsaved preset";
  app.form.values.model = "custom-unsaved";
  app.render();
  assert.match(app.form.catalogSource, /loading from CLI/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, [{ provider: "codex", command: "codex", timeout: 15000 }]);
  finish({ models: [{ value: "cli-fresh", label: "Fresh from CLI" }], reasoning: [{ value: "max", label: "Max" }] });
  await app.form.catalogRequest;
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "cli-fresh"]);
  assert.equal(app.form.values.label, "Unsaved preset");
  assert.equal(app.form.values.model, "custom-unsaved");
  assert.match(app.form.catalogSource, /live CLI/);
  app.render();
  assert.equal(calls.length, 1);
});

test("model CLI discovery ignores stale responses and refresh button retries a failed query", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.catalogs = modelCatalogs();
  const requests = [];
  app.discoverModels = (provider, command) => new Promise((resolve, reject) => requests.push({ provider, command, resolve, reject }));
  app.openForm(action("workforce/agent"));
  app.refreshFormModels(true);
  const oldRequest = app.form.catalogRequest;
  app.form.values.provider = "claude";
  app.render();
  app.refreshFormModels(true);
  assert.deepEqual(requests.map((item) => item.provider), ["codex", "claude"]);
  requests[0].resolve({ models: [{ value: "stale-codex", label: "Stale" }] });
  await oldRequest;
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "claude-test"]);
  requests[1].reject(new Error("CLI is not logged in"));
  await app.form.catalogRequest;
  assert.match(app.form.catalogSource, /cached/);
  assert.match(app.status, /CLI is not logged in/);
  await click(app, (target) => target.kind === "command" && target.name === "refresh-models");
  requests[2].resolve({ models: [{ value: "claude-live", label: "Live" }] });
  await app.form.catalogRequest;
  assert.match(app.form.catalogSource, /live CLI/);
  assert.deepEqual(app.form.fields.find((field) => field.key === "model").choices, ["", "claude-live"]);
});

test("CLI model refresh uses custom commands, skips API mode and ignores canceled forms", async () => {
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.catalogs = modelCatalogs();
  const calls = [];
  let finish;
  app.discoverModels = (provider, command) => {
    calls.push([provider, command]);
    return new Promise((resolve) => { finish = resolve; });
  };
  app.openForm(action("workforce/orchestration/start"));
  app.form.values.leaderCommand = "custom-codex.exe";
  app.render();
  app.refreshFormModels(true);
  const pending = app.form.catalogRequest;
  assert.deepEqual(calls, [["codex", "custom-codex.exe"]]);
  await app.handleKey("", { name: "escape" });
  finish({ models: [{ value: "should-not-appear", label: "Canceled" }] });
  await pending;
  assert.ok(!app.catalogs[0].models.some((model) => model.value === "should-not-appear"));
  app.openForm(action("workforce/agent"));
  app.form.values.mode = "api";
  app.render();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 1);
});

test("Graph orders files and neighbors by total score, then latest edit, ignoring reads and brief updates", () => {
  const summaries = [
    { path: "high.ts", manualPriority: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
    { path: "read.ts", manualPriority: 4, lastTaskEditedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-10T00:00:00.000Z" },
    { path: "edit.ts", manualPriority: 4, lastTaskEditedAt: "2026-01-09T00:00:00.000Z", updatedAt: "2026-01-09T00:00:00.000Z" },
    { path: "tie-a.ts", manualPriority: 4, updatedAt: "2026-01-08T00:00:00.000Z" },
    { path: "tie-b.ts", manualPriority: 4, updatedAt: "2026-01-08T00:00:00.000Z" },
    { path: "low.ts", manualPriority: 1, updatedAt: "2026-01-11T00:00:00.000Z" },
    { path: "unscored.ts", updatedAt: "2026-01-12T00:00:00.000Z" },
    ...Array.from({ length: 32 }, (_, index) => ({ path: `recent-${index}.ts`, lastTaskEditedAt: new Date(Date.UTC(2026, 1, index + 1)).toISOString(), updatedAt: "2026-12-01T00:00:00.000Z" })),
  ];
  const files = [...summaries.map(({ path }) => ({ id: path, path, kind: "file" })), { id: "unseen.ts", path: "unseen.ts", kind: "file" }].reverse();
  const neighbors = ["low.ts", "tie-b.ts", "edit.ts", "high.ts", "read.ts", "tie-a.ts"];
  const store = {
    getGraphStats: () => ({ files: files.length }),
    buildRepoMap: () => [],
    listGraphFiles: () => files,
    listFileSummaries: () => summaries,
    getImports: (path) => ({ internal: path === "unseen.ts" ? neighbors : path === "low.ts" ? files.map((file) => file.path) : [], external: [] }),
    getDependents: () => neighbors,
    getFileSymbols: () => [],
  };
  const expected = ["high.ts", "edit.ts", "read.ts", "tie-a.ts", "tie-b.ts", "low.ts"];
  const view = buildGraphView(store, 100);
  assert.equal(view.nodes.find((node) => node.path === "high.ts").structuralScore, 10 * Math.log2(7) + 10);
  assert.deepEqual(view.nodes.slice(0, 6).map((node) => node.path), expected);
  assert.equal(view.nodes.at(-1).path, "unseen.ts");
  assert.equal(view.nodes.find((node) => node.path === "read.ts").recentKind, "edit");
  assert.equal(view.nodes.find((node) => node.path === "read.ts").lastEditedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(view.nodes.find((node) => node.path === "edit.ts").recentKind, "edit");
  assert.equal(view.nodes.find((node) => node.path === "unscored.ts").recentKind, undefined);
  for (const node of view.nodes) assert.ok(node.recentKind === undefined || node.recentKind === "edit");
  assert.equal(view.nodes.filter((node) => node.recentKind === "edit").length, 34);
  const unseen = view.nodes.find((node) => node.path === "unseen.ts");
  assert.deepEqual(unseen.outgoing, expected);
  assert.deepEqual(unseen.incoming, expected);
  assert.deepEqual(buildGraphView(store, 3).nodes.map((node) => node.path), expected.slice(0, 3));
  assert.deepEqual(buildGraphView(store, 100, ["read.ts", "edit.ts"]).nodes.map((node) => node.path), ["edit.ts", "read.ts"]);
  const entries = graphEntries(view, {}).filter((entry) => entry.group === "Files");
  assert.deepEqual(entries.map((entry) => entry.data.path), view.nodes.map((node) => node.path));
  const ui = new Surface(100, 26, false);
  renderNetwork(ui, view, unseen, 0, 0, 0, 100, 26);
  assert.deepEqual(ui.hits.filter((hit) => hit.target.kind === "network-node").map((hit) => hit.target.path), [...expected.slice(0, 4), ...expected.slice(0, 4), "unseen.ts"]);
});

test("Graph edit bonus raises scores and ordering with exact age boundaries and displays the total in Nodes", async () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const cases = [
    ["future.ts", -60_000, 20],
    ["fresh.ts", 0, 20],
    ["ten-minutes.ts", 10 * 60_000, 20],
    ["after-ten-minutes.ts", 10 * 60_000 + 1, 10],
    ["three-hours.ts", 3 * 60 * 60_000, 10],
    ["after-three-hours.ts", 3 * 60 * 60_000 + 1, 5],
    ["one-day.ts", 24 * 60 * 60_000, 5],
    ["older.ts", 24 * 60 * 60_000 + 1, 1],
  ];
  const summaries = [
    ...cases.map(([path, age]) => ({ path, lastTaskEditedAt: new Date(now - age).toISOString() })),
    { path: "priority.ts", manualPriority: 2, lastTaskEditedAt: new Date(now).toISOString() },
    { path: "hub.ts" },
    { path: "read.ts", updatedAt: new Date(now).toISOString() },
    { path: "invalid.ts", lastTaskEditedAt: "invalid" },
  ];
  const store = {
    getGraphStats: () => ({ files: summaries.length }),
    buildRepoMap: () => [],
    listGraphFiles: () => summaries.map(({ path }) => ({ id: path, path, kind: "file" })),
    listFileSummaries: () => summaries,
    getImports: () => ({ internal: [], external: [] }),
    getDependents: (path) => path === "hub.ts" ? ["read.ts"] : [],
    getFileSymbols: () => [],
  };
  const view = buildGraphView(store, 100, undefined, undefined, now);
  for (const [path, , bonus] of cases) {
    const node = view.nodes.find((node) => node.path === path);
    assert.equal(node.editScore, bonus, path);
    assert.equal(node.structuralScore, 0, path);
    assert.equal(node.score, bonus, path);
  }
  for (const path of ["read.ts", "invalid.ts"]) {
    assert.equal(view.nodes.find((node) => node.path === path).score, 0);
  }
  assert.equal(view.nodes[0].path, "priority.ts");
  assert.equal(view.nodes[0].score, 24);
  assert.equal(view.nodes.find((node) => node.path === "hub.ts").score, 10);
  assert.ok(view.nodes.findIndex((node) => node.path === "fresh.ts") < view.nodes.findIndex((node) => node.path === "hub.ts"));
  assert.equal(buildGraphView(store, 1, undefined, undefined, now).nodes[0].path, "priority.ts");
  assert.equal(buildGraphView(store, 1, ["older.ts"], undefined, now).nodes[0].score, 1);
  const later = buildGraphView(store, 100, undefined, undefined, now + 10 * 60_000 + 1);
  assert.equal(later.nodes.find((node) => node.path === "fresh.ts").score, 10);
  const entry = graphEntries(view, {}).find((entry) => entry.data.path === "priority.ts");
  assert.match(graphPreview(entry, now), /Score: 24\.00 · edit bonus: \+20/);
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.screen = screens.indexOf("Graph");
  app.graph = view;
  app.selectSection("Network");
  await app.handleKey("n", {});
  assert.match(clean(out.text.split("\x1b[H").at(-1)), /24\.00.*priority\.ts/);
  for (const [width, height] of [[100, 26], [40, 8], [40, 5]]) {
    const ui = new Surface(width, height, false);
    renderNetwork(ui, view, view.nodes[0], 0, 0, 0, width, height, now);
    assert.match(ui.frame(), /Score 24\.00/);
  }
});

test("Graph structural score counts distinct dependents across Focus and limits and displays the computed score", async () => {
  const fixture = mkdtempSync(join(project, "graph-score-"));
  ensureWorkspace(fixture);
  const sources = {
    "a.ts": 'import "./hub";\nimport { hub } from "./hub";\nimport "./pair";\nimport "./boosted";\nimport "./leaf";\n',
    "b.ts": 'import "./hub";\nimport "./pair";\n',
    "c.ts": 'import "./hub";\n',
    "hub.ts": "export const hub = 1;\n",
    "pair.ts": "export const pair = 1;\n",
    "boosted.ts": "export const boosted = 1;\n",
    "leaf.ts": "export const leaf = 1;\n",
    "manual.ts": "export const manual = 1;\n",
  };
  for (const [path, source] of Object.entries(sources)) writeFileSync(join(fixture, path), source);
  await request(fixture, "POST", "/api/graph/build", {});
  const store = openStore(fixture);
  try {
    store.upsertFileSummary({ path: "manual.ts", manualPriority: 5 });
    store.upsertFileSummary({ path: "boosted.ts", manualPriority: 3 });
  } finally {
    store.close();
  }
  const view = await request(fixture, "GET", "/api/graph?limit=100");
  const node = (path) => view.nodes.find((node) => node.path === path);
  assert.deepEqual(view.nodes.slice(0, 3).map((node) => node.path), ["hub.ts", "boosted.ts", "pair.ts"]);
  assert.equal(node("hub.ts").usedBy, 3);
  assert.equal(node("hub.ts").structuralScore, 20);
  assert.equal(node("boosted.ts").structuralScore, 16);
  assert.equal(node("pair.ts").structuralScore, 10 * Math.log2(3));
  assert.equal(node("manual.ts").structuralScore, 10);
  assert.equal(node("leaf.ts").structuralScore, 10);
  assert.equal(node("a.ts").structuralScore, 0);
  assert.deepEqual(node("a.ts").outgoing, ["hub.ts", "boosted.ts", "pair.ts", "leaf.ts"]);
  const focused = await request(fixture, "GET", "/api/graph?limit=1&focus=pair.ts");
  assert.equal(focused.nodes[0].structuralScore, node("pair.ts").structuralScore);
  assert.equal(focused.nodes[0].usedBy, 2);
  assert.equal(focused.edges.length, 0);
  const limited = await request(fixture, "GET", "/api/graph?limit=1");
  assert.equal(limited.nodes[0].path, "hub.ts");
  assert.equal(limited.nodes[0].structuralScore, 20);
  const entry = graphEntries(view, {}).find((entry) => entry.group === "Files" && entry.data.path === "pair.ts");
  assert.match(graphPreview(entry), /Structural score: 15\.85 · manual priority: 0/);
  for (const [width, height] of [[100, 26], [40, 8], [40, 5]]) {
    const ui = new Surface(width, height, false);
    renderNetwork(ui, view, node("pair.ts"), 0, 0, 0, width, height);
    assert.match(ui.frame(), /Score 15\.85/);
  }
});

test("watcher auto-briefs only content edits, ignores tool hooks and unchanged events, and respects its switch", async () => {
  const fixture = mkdtempSync(join(project, "watch-edits-"));
  ensureWorkspace(fixture);
  const path = join(fixture, "main.ts");
  const original = "export const original = 1;\n";
  writeFileSync(path, original);
  await request(fixture, "POST", "/api/graph/build", {});
  const store = openStore(fixture);
  try {
    const before = store.upsertFileSummary({ path: "main.ts", manualPriority: 4 });
    readFileSync(path, "utf8");
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), false);
    writeFileSync(path, original);
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), false);
    assert.deepEqual(store.getFileSummary("main.ts"), before);
    writeFileSync(path, "export const edited = 2;\n");
    for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      handleClaudeHook({ cwd: fixture, hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: path } });
      assert.deepEqual(store.getFileSummary("main.ts"), before, tool);
    }
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), true);
    const edited = store.getFileSummary("main.ts");
    assert.equal(edited.manualPriority, 4);
    assert.ok(edited.lastTaskEditedAt);
    assert.ok(edited.lastSeenHash);
    assert.match(edited.summary, /edited/);
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), false);
    readFileSync(path, "utf8");
    handleClaudeHook({ cwd: fixture, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: path } });
    assert.deepEqual(store.getFileSummary("main.ts"), edited);
    const config = readConfig(fixture);
    writeConfig({ ...config, graph: { ...config.graph, watchAutoBrief: false } }, fixture);
    writeFileSync(path, "export const paused = 3;\n");
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), false);
    assert.deepEqual(store.getFileSummary("main.ts"), edited);
    const saved = await request(fixture, "POST", "/api/config/graph", { autoBriefOnToolUse: true, watchAutoBrief: true });
    assert.equal(saved.graph.autoBriefOnToolUse, undefined);
    assert.equal(readConfig(fixture).graph.autoBriefOnToolUse, undefined);
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), true);
    assert.match(store.getFileSummary("main.ts").summary, /paused/);
    assert.equal(briefWatchedFile(store, fixture, "notes.txt"), false);
  } finally {
    store.close();
  }
});

test("task checkpoints retain lease checks and file evidence without automatically updating briefs", () => {
  const fixture = mkdtempSync(join(project, "checkpoint-watch-"));
  ensureWorkspace(fixture);
  const path = join(fixture, "main.ts");
  writeFileSync(path, "export const before = 1;\n");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: fixture, encoding: "utf8", stdio: "pipe", timeout: 15000 });
  run(["graph", "build"]);
  run(["task", "start", "Watcher-only checkpoint"]);
  const config = readConfig(fixture);
  const taskId = config.currentTaskId;
  const sessionId = config.currentSessions.codex;
  const checkpoint = ["task", "checkpoint", "--task", taskId, "--session", sessionId, "--agent", "codex", "--summary", "Saved edit", "--tests", "not_run", "--files", "main.ts"];
  assert.throws(() => run(checkpoint), /lease/i);
  const lease = JSON.parse(run(["file", "lease", "main.ts", "--task", taskId, "--session", sessionId, "--agent", "codex"]));
  assert.equal(lease.acquired, true);
  writeFileSync(path, "export const after = 2;\n");
  assert.ok(run(checkpoint));
  const store = openStore(fixture);
  try {
    assert.equal(store.getFileSummary("main.ts"), undefined);
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), true);
    assert.ok(store.getFileSummary("main.ts").lastTaskEditedAt);
  } finally {
    store.close();
  }
});

test("watcher keeps edit highlights, symbols, imports and brief hashes synchronized for edited and new files", async () => {
  const fixture = mkdtempSync(join(project, "watch-graph-sync-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "main.ts"), 'import "./lib";\nexport const before = 1;\n');
  writeFileSync(join(fixture, "lib.ts"), "export const lib = 1;\n");
  await request(fixture, "POST", "/api/graph/build", {});
  const store = openStore(fixture);
  try {
    writeFileSync(join(fixture, "main.ts"), 'import "./lib";\nexport const after = 2;\n');
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), true);
    writeFileSync(join(fixture, "new.ts"), 'import "./main";\nexport const created = 3;\n');
    assert.equal(briefWatchedFile(store, fixture, "new.ts"), true);
    const graph = buildGraphView(store, 100);
    assert.equal(graph.nodes.length, 3);
    for (const path of ["main.ts", "new.ts"]) {
      const node = graph.nodes.find((node) => node.path === path);
      assert.equal(node.briefStale, false);
      assert.equal(editHighlight(node).label, "EDIT ≤10m");
      assert.equal(briefWatchedFile(store, fixture, path), false);
    }
    assert.deepEqual(store.getImports("main.ts").internal, ["lib.ts"]);
    assert.deepEqual(store.getImports("new.ts").internal, ["main.ts"]);
    assert.ok(store.getFileSymbols("main.ts").some((symbol) => symbol.name === "after"));
    assert.ok(!store.getFileSymbols("main.ts").some((symbol) => symbol.name === "before"));
    assert.equal(graph.nodes.find((node) => node.path === "lib.ts").lastEditedAt, undefined);
    const editedAt = store.getFileSummary("main.ts").lastTaskEditedAt;
    store.replaceGraph({ nodes: [{ id: "main.ts", kind: "file", path: "main.ts", contentHash: "outdated" }], edges: [] }, ["main.ts"]);
    assert.equal(buildGraphView(store, 100).nodes.find((node) => node.path === "main.ts").briefStale, true);
    assert.equal(briefWatchedFile(store, fixture, "main.ts"), true);
    assert.equal(buildGraphView(store, 100).nodes.find((node) => node.path === "main.ts").briefStale, false);
    assert.equal(store.getFileSummary("main.ts").lastTaskEditedAt, editedAt);
    assert.deepEqual(store.getImports("main.ts").internal, ["lib.ts"]);
  } finally {
    store.close();
  }
});

test("running watcher refreshes an edited file without any agent tool hook", { timeout: 15000 }, async () => {
  const fixture = mkdtempSync(join(project, "watch-process-"));
  ensureWorkspace(fixture);
  const path = join(fixture, "main.ts");
  writeFileSync(path, "export const before = 1;\n");
  await request(fixture, "POST", "/api/graph/build", {});
  writeFileSync(path, "export const missedBeforeStartup = 2;\n");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "watch", "--project", fixture, "--debounce", "50"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      assert.ok(child.exitCode === null && child.signalCode === null, output);
      assert.ok(Date.now() < deadline, output || "Watcher did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await waitFor(() => output.includes("agent-bridge watch: watching"));
    await waitFor(() => output.includes("briefed main.ts"));
    output = "";
    readFileSync(path, "utf8");
    writeFileSync(path, "export const after = 2;\n");
    await waitFor(() => output.includes("briefed main.ts"));
    writeFileSync(join(fixture, "new.ts"), 'import "./main";\nexport const created = 3;\n');
    await waitFor(() => output.includes("briefed new.ts"));
    const store = openStore(fixture);
    try {
      const summary = store.getFileSummary("main.ts");
      assert.match(summary.summary, /after/);
      assert.ok(summary.lastTaskEditedAt);
      assert.equal(buildGraphView(store, 100).nodes[0].recentKind, "edit");
      assert.equal(buildGraphView(store, 100).nodes[0].briefStale, false);
      const created = buildGraphView(store, 100).nodes.find((node) => node.path === "new.ts");
      assert.equal(editHighlight(created).label, "EDIT ≤10m");
      assert.equal(created.briefStale, false);
    } finally {
      store.close();
    }
  } finally {
    child.kill();
    await closed;
  }
});

test("Graph loads real files and import relations automatically and exposes editable settings", async () => {
  const fixture = mkdtempSync(join(project, "graph-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "main.ts"), 'import { answer } from "./lib";\nexport const result = answer;\n');
  writeFileSync(join(fixture, "lib.ts"), "export const answer = 42;\n");
  await request(fixture, "POST", "/api/graph/build", {});
  const initial = readConfig(fixture);
  writeConfig({ ...initial, graph: { ...initial.graph, autoBriefOnToolUse: true, includePaths: ["main.ts"], ignorePaths: ["old-ignore"] } }, fixture);
  const out = output(140, 36);
  const app = new TerminalDashboard(fixture, input(), out);
  await app.handleKey("5", { name: "5" });
  assert.equal(app.currentSection.name, "Network");
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node"));
  assert.equal(app.entries().length, 2);
  const main = app.entries().find((entry) => entry.data.path === "main.ts");
  assert.ok(main);
  assert.ok(main.data.outgoing.includes("lib.ts"));
  assert.match(graphPreview(main), /→ lib.ts/);
  const lib = app.entries().find((entry) => entry.data.path === "lib.ts");
  assert.ok(lib.data.incoming.includes("main.ts"));
  assert.deepEqual(screenSections.Graph.map((section) => section.name), ["Network", "Repo map", "Settings"]);
  assert.ok(!app.allEntries().some((entry) => entry.group === "Relations"));
  app.selectSection("Repo map");
  assert.match(app.entries().find((entry) => entry.group === "Repo map").data, /main.ts|lib.ts/);
  assert.ok(app.entries().some((entry) => entry.group === "Graph statistics"));
  app.selectSection("Settings");
  assert.equal(app.entries().length, 5);
  await click(app, (target) => target.kind === "action" && target.path === "config/graph");
  assert.equal(app.form.values.enabled, "true");
  assert.equal(app.form.values.repoMapLimit, "30");
  app.form.values.enabled = "false";
  assert.ok(!app.form.fields.some((field) => field.key === "autoBriefOnToolUse"));
  app.form.values.watchAutoBrief = "false";
  app.form.values.repoMapLimit = "42";
  app.form.values.includePaths = "";
  app.form.values.ignorePaths = "vendor";
  await app.handleKey("", { ctrl: true, name: "s" });
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.mode, "detail");
  const settings = readConfig(fixture).graph;
  assert.equal(settings.enabled, false);
  assert.equal(settings.autoBriefOnToolUse, undefined);
  assert.equal(JSON.parse(readFileSync(join(fixture, ".agent-memory/config.json"), "utf8")).graph.autoBriefOnToolUse, undefined);
  assert.equal(settings.watchAutoBrief, false);
  assert.equal(settings.repoMapLimit, 42);
  assert.deepEqual(settings.includePaths, []);
  assert.deepEqual(settings.ignorePaths, ["vendor"]);
  app.selectSection("Network");
  await click(app, (target) => target.kind === "command" && target.name === "nodes");
  await app.handleKey("/", {});
  await app.handleKey("lib.ts", {});
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.mode, "browse");
  assert.equal(app.entries().length, 1);
  assert.ok(app.entries()[0].data.incoming.includes("main.ts"));
  await click(app, (target) => target.kind === "row" && target.index === 0);
  assert.equal(app.entries()[app.selected].data.path, "lib.ts");
  assert.equal(app.graph.nodes.length, 2);
  await click(app, (target) => target.kind === "graph-node" && target.path === "main.ts");
  assert.equal(app.graphListOpen, true);
  await app.handleKey("\r", { name: "return" });
  assert.equal(app.currentSection.name, "Network");
  assert.equal(app.graphListOpen, false);
  assert.equal(app.graph.nodes.length, 2);
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
});

test("Graph opens its network after Build and selects a node from the ranked list", async () => {
  const fixture = mkdtempSync(join(project, "visible-graph-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "main.ts"), 'import { answer } from "./lib";\nexport const result = answer;\n');
  writeFileSync(join(fixture, "lib.ts"), "export const answer = 42;\n");
  const app = new TerminalDashboard(fixture, input(), output(100, 24));
  app.screen = screens.indexOf("Graph");
  app.openForm(action("graph/build"));
  await app.handleKey("", { ctrl: true, name: "s" });
  await app.handleKey("", { name: "return" });
  assert.equal(app.mode, "browse");
  assert.equal(app.currentSection.name, "Network");
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node"));
  await click(app, (target) => target.kind === "command" && target.name === "nodes");
  assert.equal(app.graphListOpen, true);
  app.selected = app.entries().findIndex((entry) => entry.data.path === "main.ts");
  await app.handleKey("", { name: "return" });
  assert.equal(app.currentSection.name, "Network");
  assert.equal(app.graphListOpen, false);
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
  assert.equal(app.graph.nodes.length, 2);
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === "main.ts"));
});

test("Graph Nodes lists indexed files beyond the old display limit and requires confirmation after a click", async () => {
  const fixture = mkdtempSync(join(project, "graph-nodes-"));
  ensureWorkspace(fixture);
  const paths = Array.from({ length: 405 }, (_, index) => `f${String(index).padStart(3, "0")}.ts`);
  for (const path of paths) writeFileSync(join(fixture, path), "export const value = 1;\n");
  await request(fixture, "POST", "/api/graph/build", {});
  const out = output(140, 36);
  const app = new TerminalDashboard(fixture, input(), out);
  app.screen = screens.indexOf("Graph");
  await app.refresh();
  assert.equal(app.graph.nodes.length, paths.length);
  await click(app, (target) => target.kind === "command" && target.name === "nodes");
  assert.equal(app.graphListOpen, true);
  assert.deepEqual(app.entries().map((entry) => entry.data.path), paths);
  assert.match(clean(out.text.split("\x1b[H").at(-1)), /0\.00\s+f000\.ts/);
  assert.equal(app.hitRegions.filter((hit) => hit.target.kind === "command" && hit.target.name === "nodes").length, 1);
  assert.ok(!app.hitRegions.some((hit) => hit.target.kind === "section"));
  assert.ok(!app.hitRegions.some((hit) => hit.target.kind === "action" && hit.target.path === "graph"));
  assert.ok(!dashboardActions.some((action) => action.path === "/api/graph"));
  await app.handleKey("/", {});
  await app.handleKey("f404.ts", {});
  await app.handleKey("", { name: "return" });
  assert.equal(app.entries().length, 1);
  await click(app, (target) => target.kind === "row" && target.index === 0);
  assert.equal(app.graphListOpen, true);
  assert.equal(app.networkPath, "f000.ts");
  await click(app, (target) => target.kind === "command" && target.name === "open");
  assert.equal(app.graphListOpen, false);
  assert.equal(app.mode, "browse");
  assert.equal(app.currentSection.name, "Network");
  assert.equal(app.entries()[app.selected].data.path, "f404.ts");
  assert.equal(app.filter, "");
  assert.equal(app.graph.nodes.length, paths.length);
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === "f404.ts"));
});

test("Graph Nodes supports keyboard selection and cancel and preserves the chosen path when scores reorder", async () => {
  const fixture = mkdtempSync(join(project, "graph-selection-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "main.ts"), 'import "./lib";\n');
  writeFileSync(join(fixture, "lib.ts"), "export const value = 1;\n");
  await request(fixture, "POST", "/api/graph/build", {});
  const app = new TerminalDashboard(fixture, input(), output(140, 36));
  app.screen = screens.indexOf("Graph");
  await app.refresh();
  assert.equal(app.entries()[app.selected].data.path, "lib.ts");
  await app.handleKey("n", {});
  await app.handleKey("", { name: "down" });
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
  await app.handleKey("", { name: "escape" });
  assert.equal(app.graphListOpen, false);
  assert.equal(app.entries()[app.selected].data.path, "lib.ts");
  await app.handleKey("n", {});
  await app.handleKey("", { name: "down" });
  await app.handleKey("", { name: "return" });
  assert.equal(app.graphListOpen, false);
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
  const store = openStore(fixture);
  try { store.upsertFileSummary({ path: "main.ts", manualPriority: 5, markTaskEdited: true }); }
  finally { store.close(); }
  await app.refresh();
  assert.equal(app.selected, 0);
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
  await app.handleKey("/", {});
  assert.equal(app.graphListOpen, true);
  await app.handleKey("lib.ts", {});
  await app.handleKey("", { name: "return" });
  assert.equal(app.entries()[app.selected].data.path, "lib.ts");
  await app.refresh();
  await app.handleKey("", { name: "escape" });
  assert.equal(app.graphListOpen, false);
  assert.equal(app.entries()[app.selected].data.path, "main.ts");
  assert.equal(app.filter, "");
});

test("Graph Nodes stays reachable in small terminals and duplicate controls are consolidated", async () => {
  for (const columns of [48, 72, 100, 140]) {
    const out = output(columns, 24);
    const app = new TerminalDashboard(project, input(), out);
    app.screen = screens.indexOf("Graph");
    app.graph = { nodes: [{ path: "main.ts", structuralScore: 12.34 }] };
    app.render();
    await click(app, (target) => target.kind === "command" && target.name === "nodes");
    assert.equal(app.graphListOpen, true);
    assert.match(clean(out.text.split("\x1b[H").at(-1)), /12\.34\s+main\.ts/);
    for (const hit of app.hitRegions) {
      assert.ok(hit.x >= 0 && hit.y >= 0);
      assert.ok(hit.x + hit.width < columns);
      assert.ok(hit.y + hit.height <= out.rows);
    }
    assert.equal(app.hitRegions.filter((hit) => hit.target.kind === "command" && hit.target.name === "nodes").length, 1);
    assert.ok(!app.hitRegions.some((hit) => hit.target.kind === "command" && hit.target.name === "select"));
  }
  assert.ok(!screenSections.Tools.some((section) => section.name === "Updates"));
  const tools = screenSections.Tools.find((section) => section.name === "Tools");
  const actions = sectionActions(dashboardActions.filter((action) => action.screen === "Tools"), tools);
  for (const path of ["watch/start", "watch/stop", "update/status", "update/apply", "update/progress"]) assert.ok(actions.some((action) => action.path === `/api/${path}`));
  const app = new TerminalDashboard(project, input(), output(140, 36));
  app.screen = 1;
  app.board = { orchestrations: [{ taskId: "run-1", title: "One run" }] };
  app.selectSection("Tasks");
  assert.equal(app.hitRegions.filter((hit) => hit.target.kind === "command" && hit.target.name === "select").length, 1);
  app.screen = 0;
  app.state = { tasks: [{ id: "task-1", title: "One task" }] };
  app.selectSection("Tasks");
  assert.equal(app.hitRegions.filter((hit) => hit.target.kind === "command" && hit.target.name === "select").length, 1);
});

test("Graph Network draws directed relationships and requires confirmation to recenter", async () => {
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.screen = screens.indexOf("Graph");
  app.graph = {
    nodes: [
      { path: "src/main.ts", incoming: ["src/cli.ts"], outgoing: ["src/lib.ts"], language: "typescript", symbols: 3 },
      { path: "src/cli.ts", incoming: [], outgoing: ["src/main.ts"] },
      { path: "src/lib.ts", incoming: ["src/main.ts"], outgoing: [] },
      { path: "src/isolated.ts", incoming: [], outgoing: [] },
    ],
    edges: [{ source: "src/cli.ts", target: "src/main.ts" }, { source: "src/main.ts", target: "src/lib.ts" }],
  };
  app.selectSection("Network");
  assert.match(out.text, /USED BY/);
  assert.match(out.text, /IMPORTS/);
  assert.match(out.text, /▶/);
  assert.deepEqual(new Set(app.hitRegions.filter((hit) => hit.target.kind === "network-node").map((hit) => hit.target.path)), new Set(["src/main.ts", "src/cli.ts", "src/lib.ts"]));
  await click(app, (target) => target.kind === "network-node" && target.path === "src/lib.ts");
  assert.equal(app.graphListOpen, true);
  assert.equal(app.networkPath, "src/main.ts");
  await app.handleKey("", { name: "escape" });
  assert.equal(app.networkPath, "src/main.ts");
  await click(app, (target) => target.kind === "network-node" && target.path === "src/lib.ts");
  await app.handleKey("s", {});
  assert.equal(app.entries()[app.selected].data.path, "src/lib.ts");
  assert.equal(app.graphListOpen, false);
  assert.equal(app.graph.nodes.length, 4);
  await app.handleKey("", { name: "end" });
  assert.match(out.text, /Isolated file/);
  await app.handleKey("", { name: "return" });
  assert.equal(app.mode, "detail");
  assert.match(app.detail, /src\/isolated.ts/);
  await app.handleKey("", { name: "escape" });
  await app.handleKey("a", {});
  assert.ok(!app.hitRegions.some((hit) => hit.target.kind === "network-node"));
});

test("Graph Network paginates dense cyclic relationships and keeps hit regions inside resized panels", () => {
  const paths = Array.from({ length: 12 }, (_, index) => `src/目录/very-long-file-${index}.ts`);
  const selected = { path: "src/main.ts", incoming: paths, outgoing: ["src/main.ts", ...paths] };
  const graph = { nodes: [selected, ...paths.map((path) => ({ path }))], edges: [] };
  for (const [width, height] of [[104, 20], [40, 8], [40, 5], [65, 12], [62, 8], [62, 13]]) {
    let page = 0;
    const seen = new Set();
    for (;;) {
      const ui = new Surface(width + 4, height + 4, false);
      renderNetwork(ui, graph, selected, page, 2, 2, width, height);
      for (const hit of ui.hits) {
        assert.ok(hit.x >= 2 && hit.y >= 2);
        assert.ok(hit.x + hit.width <= 2 + width);
        assert.ok(hit.y + hit.height <= 2 + height);
        if (hit.target.kind === "network-node") seen.add(hit.target.path);
      }
      assert.equal(ui.frame().split("\r\n").length, height + 4);
      const frame = ui.frame().split("\r\n");
      assert.ok(frame.slice(0, 2).every((line) => !line.trim()));
      assert.ok(frame.slice(height + 2).every((line) => !line.trim()));
      assert.ok(frame.every((line) => !line.slice(0, 2).trim() && !line.slice(-2).trim()));
      const next = ui.hits.find((hit) => hit.target.kind === "network-page" && hit.target.page === page + 1);
      if (!next) break;
      page = next.target.page;
      assert.ok(page < 20);
    }
    assert.deepEqual(seen, new Set([selected.path, ...paths]));
  }
  const ui = new Surface(44, 12, false);
  renderNetwork(ui, {}, {}, 0, 2, 2, 40, 8);
  assert.match(ui.frame(), /No indexed files/);
  assert.ok(ui.hits.some((hit) => hit.target.kind === "action" && hit.target.path === "graph/build"));
});

test("Graph edit highlights use elapsed time with exact ten-minute, three-hour and daily boundaries", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const cases = [
    [0, "EDIT ≤10m", theme.editFresh],
    [10 * 60_000, "EDIT ≤10m", theme.editFresh],
    [10 * 60_000 + 1, "EDIT ≤3h", theme.success],
    [3 * 60 * 60_000, "EDIT ≤3h", theme.success],
    [3 * 60 * 60_000 + 1, "EDIT ≤24h", theme.editToday],
    [24 * 60 * 60_000, "EDIT ≤24h", theme.editToday],
    [24 * 60 * 60_000 + 1, "EDIT >24h", theme.muted],
  ];
  for (const [age, label, style] of cases) {
    const highlight = editHighlight({ lastEditedAt: new Date(now - age).toISOString(), recentKind: "edit", recentRank: 100 }, now);
    assert.equal(highlight.label, label);
    assert.equal(highlight.style, style);
  }
  const node = { lastEditedAt: new Date(now - 10 * 60_000).toISOString(), recentKind: "edit" };
  assert.equal(editHighlight(node, now).label, "EDIT ≤10m");
  assert.equal(editHighlight(node, now + 1).label, "EDIT ≤3h");
  assert.equal(editHighlight({ recentKind: "read", updatedAt: new Date(now).toISOString() }, now), undefined);
  assert.equal(editHighlight({}, now), undefined);
  assert.equal(editHighlight({ recentKind: "edit", lastEditedAt: "invalid" }, now).label, "EDIT");
  assert.equal(editHighlight({ lastEditedAt: new Date(now + 60_000).toISOString() }, now).label, "EDIT ≤10m");
});

test("Graph Network shows all edit-age levels with colors and plain labels while keeping STALE and selection visible", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const specs = [
    ["fresh.ts", 60_000, "≤10m", theme.editFresh],
    ["hour.ts", 60 * 60_000, "≤3h", theme.success],
    ["day.ts", 12 * 60 * 60_000, "≤24h", theme.editToday],
    ["old.ts", 48 * 60 * 60_000, ">24h", theme.muted],
  ];
  const selected = { path: "selected.ts", recentKind: "edit", lastEditedAt: new Date(now).toISOString(), incoming: specs.map(([path]) => path), outgoing: [] };
  const nodes = specs.map(([path, age]) => ({ path, recentKind: "edit", lastEditedAt: new Date(now - age).toISOString(), briefStale: path === "day.ts" }));
  const graph = { nodes: [selected, ...nodes], edges: [] };
  for (const colors of [false, true]) {
    const ui = new Surface(100, 32, colors);
    renderNetwork(ui, graph, selected, 0, 0, 0, 100, 32, now);
    const frame = ui.frame().split("\r\n");
    for (const [path, , age, style] of specs) {
      const hit = ui.hits.find((hit) => hit.target.path === path);
      assert.ok(clean(frame[hit.y]).includes(age), path);
      if (colors) assert.ok(frame[hit.y + 1].includes(`\x1b[${style}m│${path}`), path);
    }
    const stale = ui.hits.find((hit) => hit.target.path === "day.ts");
    assert.match(clean(frame[stale.y]), /STALE ≤24h/);
    if (colors) assert.ok(frame[stale.y].includes(`\x1b[${theme.danger}m`));
    else assert.ok(!ui.frame().includes("\x1b"));
    const active = ui.hits.find((hit) => hit.target.path === selected.path);
    assert.match(clean(frame[active.y]), /╔.*EDIT ≤10m.*╗/);
  }
  const small = new Surface(40, 10, false);
  renderNetwork(small, graph, selected, 0, 0, 0, 40, 10, now);
  assert.match(small.frame(), /SELECTED · EDIT ≤10m/);
  assert.match(small.frame(), /EDIT ≤3h/);
});

test("Graph Nodes displays edit-age labels and the last edit timestamp without adding read highlights", async () => {
  const now = Date.now();
  const nodes = [
    { path: "fresh.ts", lastEditedAt: new Date(now - 60_000).toISOString(), recentKind: "edit" },
    { path: "hour.ts", lastEditedAt: new Date(now - 60 * 60_000).toISOString(), recentKind: "edit" },
    { path: "day.ts", lastEditedAt: new Date(now - 12 * 60 * 60_000).toISOString(), recentKind: "edit", briefStale: true },
    { path: "old.ts", lastEditedAt: new Date(now - 48 * 60 * 60_000).toISOString(), recentKind: "edit" },
  ];
  const out = output(140, 36);
  const app = new TerminalDashboard(project, input(), out);
  app.screen = screens.indexOf("Graph");
  app.graph = { nodes, stats: { files: nodes.length } };
  app.selectSection("Network");
  await app.handleKey("n", {});
  const frame = clean(out.text.split("\x1b[H").at(-1));
  for (const age of ["≤10m", "≤3h", "≤24h", ">24h"]) assert.ok(frame.includes(`[EDIT ${age}]`), age);
  assert.ok(frame.includes("[STALE] [EDIT ≤24h]"));
  const entry = app.entries().find((entry) => entry.data.path === "day.ts");
  assert.match(graphPreview(entry, now), /Last edit: .* · EDIT ≤24h/);
  assert.ok(!frame.includes("READ"));
});

test("Graph Network separates duplicate filenames by directory and marks selection without colors", () => {
  const selected = { path: "packages/cli/main.ts", incoming: ["apps/desktop/main.ts", "apps/terminal/main.ts"], outgoing: ["packages/core/config.ts"] };
  const graph = { nodes: [selected, { path: selected.incoming[0], recentKind: "edit" }, { path: selected.outgoing[0], briefStale: true }], edges: [] };
  const ui = new Surface(100, 26, false);
  renderNetwork(ui, graph, selected, 0, 0, 0, 100, 26);
  const frame = ui.frame();
  assert.match(frame, /apps\/desktop\//);
  assert.match(frame, /apps\/terminal\//);
  assert.match(frame, /packages\/cli\//);
  assert.match(frame, /╔═+╗/);
  assert.match(frame, /EDIT/);
  assert.match(frame, /STALE/);
  assert.match(frame, /USED BY \(2\)/);
  assert.match(frame, /IMPORTS \(1\)/);
  assert.match(frame, /┐/);
  assert.match(frame, /▶/);
  assert.ok(!frame.includes("\x1b"));
  const active = ui.hits.find((hit) => hit.target.path === selected.path);
  assert.equal(active.height, 4);
});

test("Graph Network narrow layout merges mutual links and keeps an isolated file free of arrows", () => {
  const selected = { path: "src/main.ts", incoming: ["src/peer.ts"], outgoing: ["src/peer.ts"] };
  const ui = new Surface(40, 8, false);
  renderNetwork(ui, { nodes: [selected] }, selected, 0, 0, 0, 40, 8);
  assert.match(ui.frame(), /↔ both: src\/peer.ts/);
  assert.equal(ui.hits.filter((hit) => hit.target.path === "src/peer.ts").length, 1);
  const compact = new Surface(40, 5, false);
  renderNetwork(compact, { nodes: [{ path: "alone.ts" }] }, { path: "alone.ts" }, 0, 0, 0, 40, 5);
  assert.ok(!compact.frame().includes("▶"));
});

test("opening Graph indexes an empty repository once and immediately renders real links", async () => {
  const fixture = mkdtempSync(join(project, "graph-first-open-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "main.ts"), 'import { answer } from "./lib";\nexport const result = answer;\n');
  writeFileSync(join(fixture, "lib.ts"), "export const answer = 42;\n");
  const before = await loadDashboard(fixture);
  assert.ok(before.state);
  const app = new TerminalDashboard(fixture, input(), output(100, 24));
  await app.handleKey("5", { name: "5" });
  assert.equal(app.graph.stats.files, 2);
  assert.equal(app.graph.edges.length, 1);
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === "main.ts"));
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === "lib.ts"));
  writeFileSync(join(fixture, "unindexed.ts"), "export const value = 1;\n");
  await app.refresh();
  assert.equal(app.graph.stats.files, 2);
});

test("empty Graph always offers Build in a small terminal and does not repeatedly scan unsupported files", async () => {
  const fixture = mkdtempSync(join(project, "graph-empty-"));
  ensureWorkspace(fixture);
  writeFileSync(join(fixture, "readme.txt"), "No source files.\n");
  const app = new TerminalDashboard(fixture, input(), output(100, 24));
  await app.handleKey("5", { name: "5" });
  assert.equal(app.graph.stats.files, 0);
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "action" && hit.target.path === "graph/build"));
  writeFileSync(join(fixture, "later.ts"), "export const later = 1;\n");
  await app.refresh();
  assert.equal(app.graph.stats.files, 0);
  await click(app, (target) => target.kind === "action" && target.path === "graph/build");
  await app.handleKey("", { ctrl: true, name: "s" });
  await app.handleKey("", { name: "return" });
  assert.equal(app.graph.stats.files, 1);
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === "later.ts"));
});

test("Graph Network link paging is clickable and resets when selecting another file", async () => {
  const app = new TerminalDashboard(project, input(), output(100, 30));
  app.screen = screens.indexOf("Graph");
  const paths = Array.from({ length: 8 }, (_, index) => `file-${index}.ts`);
  app.graph = { nodes: [{ path: "main.ts", outgoing: paths }, ...paths.map((path) => ({ path, incoming: ["main.ts"], outgoing: [] }))], edges: paths.map((target) => ({ source: "main.ts", target })) };
  app.selectSection("Network");
  assert.ok(app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === paths[0]));
  await click(app, (target) => target.kind === "network-page" && target.page === 1);
  assert.ok(!app.hitRegions.some((hit) => hit.target.kind === "network-node" && hit.target.path === paths[0]));
  await app.handleKey("", { name: "down" });
  assert.equal(app.entries()[app.selected].data.path, paths[0]);
  assert.equal(app.networkPage, 0);
});

test("repository switch stops hooks and scheduling, blocks writes, preserves data and can be re-enabled", async () => {
  const fixture = mkdtempSync(join(project, "switch-"));
  initializeProject(fixture);
  installCodexHooks(fixture);
  const agentsPath = join(fixture, "AGENTS.md");
  writeFileSync(agentsPath, "Personal rules.\n\n" + readFileSync(agentsPath, "utf8"));
  const originalInstructions = readFileSync(agentsPath, "utf8").match(/<!-- agent-bridge:start -->[\s\S]*?<!-- agent-bridge:end -->/)[0];
  const codexHooksPath = join(fixture, ".codex/hooks.json");
  const codexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  const userHook = { type: "command", command: "echo user-owned-hook" };
  codexHooks.hooks.SessionStart[0].hooks.push(userHook);
  writeFileSync(codexHooksPath, JSON.stringify(codexHooks));
  const created = await request(fixture, "POST", "/api/task/start", { title: "Keep this task", agent: "codex" });
  const store = openStore(fixture);
  let orchestration;
  try {
    const agent = store.createRegisteredAgent({ name: "Manual leader", provider: "manual", mode: "manual", capabilities: [] });
    orchestration = store.createOrchestration({ taskId: created.task.id, leaderAgentId: agent.id, autonomy: "manual", maxParallel: 1, maxCycles: 2 });
  } finally { store.close(); }
  autoRunTimers.set(orchestration.id, setTimeout(() => {}, 60000));
  await request(fixture, "POST", "/api/repo/enabled", { enabled: false });
  assert.equal(repositoryEnabled(fixture), false);
  assert.equal(repositoryEnabled(project), true);
  assert.equal(autoRunTimers.has(orchestration.id), false);
  assert.deepEqual(resumeAutoRuns(fixture), []);
  assert.equal(startWatcher(fixture), false);
  assert.equal(handleClaudeHook({ cwd: fixture, hook_event_name: "SessionStart", session_id: "disabled-claude" }), undefined);
  assert.equal(await handleCodexHook({ cwd: fixture, hook_event_name: "SessionStart", session_id: "disabled-codex" }), undefined);
  assert.equal(handleAntigravityHook({ workspacePaths: [fixture], conversationId: "disabled-agy" }, "PreInvocation"), undefined);
  await assert.rejects(request(fixture, "POST", "/api/task/start", { title: "Must not be created" }), /disabled/);
  const readOnly = await loadDashboard(fixture);
  assert.ok(readOnly.state.tasks.some((task) => task.id === created.task.id));
  assert.equal(readOnly.state.activeSessionEvents.some((event) => String(event.sessionId).startsWith("disabled-")), false);
  assert.match(readFileSync(agentsPath, "utf8"), /Personal rules/);
  for (const name of ["AGENTS.md", "CLAUDE.md", ".agents/rules/agent-bridge.md"]) {
    assert.doesNotMatch(readFileSync(join(fixture, name), "utf8"), /agent-bridge|Agent Bridge|compiled-context/);
  }
  const disabledCodexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  assert.deepEqual(disabledCodexHooks.hooks.SessionStart[0].hooks, [userHook]);
  assert.doesNotMatch(JSON.stringify(disabledCodexHooks), /agent-bridge|codex hook --event/);
  assert.doesNotMatch(readFileSync(join(fixture, ".claude/settings.local.json"), "utf8"), /agent-bridge-claude-hook/);
  assert.equal(JSON.parse(readFileSync(join(fixture, ".agents/hooks.json"), "utf8"))["agent-bridge"], undefined);
  const contextBefore = readFileSync(join(fixture, ".agent-memory/compiled-context.md"), "utf8");
  assert.equal(await handleCodexHook({ cwd: fixture, hook_event_name: "UserPromptSubmit", session_id: "disabled-codex", prompt: "Must not compile" }), undefined);
  assert.equal(readFileSync(join(fixture, ".agent-memory/compiled-context.md"), "utf8"), contextBefore);
  await request(fixture, "POST", "/api/repo/enabled", { enabled: false });
  writeFileSync(agentsPath, readFileSync(agentsPath, "utf8") + "New personal rule.\n");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: fixture, encoding: "utf8", stdio: "pipe", timeout: 30000 });
  assert.equal(JSON.parse(run(["repo", "status"])).enabled, false);
  assert.throws(() => run(["task", "start", "Blocked task"]), /disabled/);
  assert.match(run(["--snapshot"]), /DISABLED/);
  assert.equal(JSON.parse(run(["repo", "enable"])).enabled, true);
  assert.equal(repositoryEnabled(fixture), true);
  assert.match(readFileSync(agentsPath, "utf8"), /Personal rules/);
  assert.match(readFileSync(agentsPath, "utf8"), /New personal rule/);
  assert.ok(readFileSync(agentsPath, "utf8").includes(originalInstructions));
  assert.doesNotMatch(readFileSync(agentsPath, "utf8"), /Agent Bridge disabled/);
  const restoredCodexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
  assert.equal(restoredCodexHooks.hooks.SessionStart.flatMap((entry) => entry.hooks).filter((hook) => hook.command === userHook.command).length, 1);
  assert.match(JSON.stringify(restoredCodexHooks), /agent-bridge-codex-hook/);
  assert.match(readFileSync(join(fixture, ".claude/settings.local.json"), "utf8"), /agent-bridge-claude-hook/);
  assert.ok(JSON.parse(readFileSync(join(fixture, ".agents/hooks.json"), "utf8"))["agent-bridge"]);
  assert.match(readFileSync(join(fixture, ".agents/rules/agent-bridge.md"), "utf8"), /^---\r?\ntrigger: always_on/);
  const resumed = await request(fixture, "POST", "/api/task/start", { title: "Enabled again", agent: "codex" });
  assert.equal(resumed.task.title, "Enabled again");
  const fresh = mkdtempSync(join(project, "disabled-fresh-"));
  run(["repo", "disable", "--project", fresh]);
  assert.match(run(["--project", fresh, "--snapshot"]), /DISABLED/);
  assert.equal(readConfig(fresh).enabled, false);
  assert.doesNotMatch(readFileSync(join(fresh, "AGENTS.md"), "utf8"), /agent-bridge|Agent Bridge/);
});

test("Tools repository button proposes the opposite state without affecting other repositories", async () => {
  const app = new TerminalDashboard(project, input(), output(120, 32));
  await app.refresh();
  app.screen = screens.indexOf("Tools");
  app.selectSection("Repository");
  await click(app, (target) => target.kind === "action" && target.path === "repo/enabled");
  assert.equal(app.form.values.enabled, "false");
  app.state.config.enabled = false;
  app.selectSection("Repository");
  await click(app, (target) => target.kind === "action" && target.path === "repo/enabled");
  assert.equal(app.form.values.enabled, "true");
  assert.equal(repositoryEnabled(project), true);
});
