import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { listNativeSessions, mergeSessionHistory, readNativeSessionContext, sessionBelongsToRepository } from "../dist/native-sessions.js";
import { defaultConfig, ensureWorkspace, openStore, readConfig } from "../dist/workspace.js";
import { importNativeSession, prepareSessionReopen } from "../dist/commands/routes/session.js";
import { TerminalDashboard } from "../dist/tui/app.js";
import { dashboardActions } from "../dist/tui/actions.js";
import { PassThrough } from "node:stream";

const Database = createRequire(import.meta.resolve("@agent-bridge/memory"))("better-sqlite3");
const jsonl = (path, rows) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "native-history-"));
  const repo = join(base, "repo"), other = join(base, "repo-other");
  mkdirSync(repo); mkdirSync(other);
  const roots = { claude: join(base, "claude"), codex: join(base, "codex"), antigravity: join(base, "agy") };
  for (const path of Object.values(roots)) mkdirSync(path);
  return { base, repo, other, roots, close: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
function seed(f) {
  const slug = f.repo.replace(/[^a-zA-Z0-9]/g, "-");
  const claude = join(f.roots.claude, "projects", slug, "claude-id.jsonl");
  jsonl(claude, [
    { type: "user", cwd: f.repo, sessionId: "claude-id", timestamp: "2026-10-01T00:00:00Z", message: { content: "Preserve parser compatibility" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Parser implemented. Test edge cases next." }, { type: "thinking", thinking: "hidden reasoning" }] } },
    { type: "ai-title", aiTitle: "Parser work" },
  ]);
  jsonl(join(f.roots.claude, "projects", `${slug}-collision`, "wrong.jsonl"), [
    { type: "user", cwd: f.other, sessionId: "wrong", message: { content: "Unrelated repo" } },
  ]);
  jsonl(join(f.roots.claude, "projects", slug, "agent-child.jsonl"), [
    { type: "user", cwd: f.repo, sessionId: "child", isSidechain: true },
  ]);
  const codex = new Database(join(f.roots.codex, "state_5.sqlite"));
  codex.exec("CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, rollout_path TEXT, source TEXT)");
  codex.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("codex-id", f.repo, "Codex work", 1790000000, 1790000500, "", "cli");
  codex.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("other", f.other, "Wrong repo", 1790000000, 1790000500, "", "cli");
  codex.close();
  const history = new Database(join(f.roots.codex, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)");
  for (const [ordinal, item] of [{ type: "userMessage", content: [{ type: "text", text: "Fix the query" }] }, { type: "agentMessage", text: "Query fixed; tests pending." }].entries()) {
    history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?)").run("codex-id", ordinal, item.type, JSON.stringify(item));
  }
  history.close();
  jsonl(join(f.roots.codex, "archived_sessions", "rollout-fallback.jsonl"), [
    { type: "session_meta", payload: { id: "archived-id", cwd: f.repo, timestamp: "2026-09-01T00:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Archived request" }] } },
  ]);
  const agy = new Database(join(f.roots.antigravity, "conversation_summaries.db"));
  agy.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, workspace_uris TEXT, last_modified_time TEXT, status TEXT, not_fully_idle INTEGER, killed INTEGER, parent_conversation_id TEXT, nesting_depth INTEGER)");
  agy.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("agy-id", "AGY work", "Implement validation", JSON.stringify([pathToFileURL(f.repo).href]), "2026-11-01T00:00:00Z", "CASCADE_RUN_STATUS_RUNNING", 1, 0, "", 0);
  agy.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("agy-child", "Child", "", JSON.stringify([pathToFileURL(f.repo).href]), "2026-11-01T00:00:00Z", "IDLE", 0, 0, "agy-id", 1);
  agy.close();
  return { claude };
}

test("discovers native Claude, Codex and AGY history without Bridge, scoped to the repository", async () => {
  const f = fixture();
  try {
    const { claude } = seed(f), original = readFileSync(claude);
    const sessions = listNativeSessions(f.repo, f.roots);
    assert.equal(sessions.length, 4);
    assert.deepEqual(new Set(sessions.map((s) => s.agent)), new Set(["claude", "codex", "antigravity"]));
    assert.equal(sessions[0].nativeSessionId, "agy-id");
    assert.equal(sessions[0].liveness, "running");
    assert.equal(sessions.find((s) => s.agent === "claude").title, "Parser work");
    for (const [id, expected] of [["claude-id", "Test edge cases next"], ["codex-id", "Query fixed"], ["archived-id", "Archived request"]]) {
      const context = await readNativeSessionContext(sessions.find((s) => s.nativeSessionId === id));
      assert.ok(context.includes(expected), id);
      assert.ok(!context.includes("hidden reasoning"));
    }
    assert.deepEqual(readFileSync(claude), original);
    assert.ok(!sessionBelongsToRepository(f.other, f.repo));
    assert.ok(sessionBelongsToRepository(join(f.repo, "src"), f.repo));
    assert.ok(sessionBelongsToRepository("file:///D:/Repo/src", "d:\\repo"));
    assert.ok(!sessionBelongsToRepository("D:/Repository", "D:/Repo"));
  } finally { f.close(); }
});

test("merges Bridge and native conversation IDs without duplicating the active session", () => {
  const f = fixture();
  try {
    seed(f);
    const native = listNativeSessions(f.repo, f.roots);
    const config = { ...defaultConfig(), terminalNativeSessions: { stable: "codex-id" } };
    const merged = mergeSessionHistory([{ sessionId: "stable", taskId: "task", agent: "codex", liveness: "running", kind: "prompt_submitted", createdAt: "2026-11-16T00:00:00Z" }], native, config);
    assert.equal(merged.length, native.length);
    const codex = merged.find((s) => s.nativeSessionId === "codex-id");
    assert.equal(codex.sessionId, "stable");
    assert.equal(codex.liveness, "running");
    assert.equal(codex.source, "native+bridge");
  } finally { f.close(); }
});

test("imports native context only when reopening, supports same-provider resume and cross-provider cloning", async () => {
  const f = fixture();
  try {
    seed(f); ensureWorkspace(f.repo);
    const store = openStore(f.repo);
    try {
      const native = listNativeSessions(f.repo, f.roots).find((s) => s.agent === "claude");
      assert.equal(store.listTasks().length, 0);
      const context = await readNativeSessionContext(native);
      importNativeSession(store, f.repo, native, native.sessionId, context);
      const config = readConfig(f.repo);
      assert.equal(config.terminalNativeSessions[native.sessionId], "claude-id");
      const resumed = prepareSessionReopen(store, f.repo, native.sessionId, "claude");
      assert.equal(resumed.nativeSessionId, "claude-id");
      const cloned = prepareSessionReopen(store, f.repo, native.sessionId, "codex", "clone");
      assert.notEqual(cloned.task.id, resumed.task.id);
      assert.ok(store.listMemoriesForTask(cloned.task.id).some((m) => m.content.includes("Test edge cases next")));
      importNativeSession(store, f.repo, native, native.sessionId, context);
      assert.equal(store.listMemoriesForTask(resumed.task.id).filter((m) => m.tags.includes("native-session-context")).length, 1);
    } finally { store.close(); }
  } finally { f.close(); }
});

test("native sessions without a Bridge task do not inherit the dashboard's selected task", () => {
  const app = new TerminalDashboard("unused", new PassThrough(), new PassThrough());
  app.taskId = "unrelated-task";
  app.state = { currentTask: { id: "unrelated-task" } };
  app.selection = { group: "Sessions", label: "Native", data: { sessionId: "native:claude:old", agent: "claude", source: "native" } };
  app.openForm(dashboardActions.find((action) => action.path === "/api/session/terminal"));
  assert.equal(app.form.values.taskId, "");
  assert.equal(app.form.values.agent, "claude");
  assert.equal(app.form.values.sessionId, "native:claude:old");
});

test("AGY native context decodes user and assistant messages without exposing thinking or tool metadata", async () => {
  const f = fixture();
  const varint = (number) => {
    const bytes = [];
    do { const byte = number % 128; number = Math.floor(number / 128); bytes.push(byte | (number ? 128 : 0)); } while (number);
    return Buffer.from(bytes);
  };
  const field = (number, value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(buffer.length), buffer]);
  };
  try {
    seed(f);
    const native = listNativeSessions(f.repo, f.roots).find((s) => s.agent === "antigravity");
    mkdirSync(join(f.roots.antigravity, "conversations"));
    const db = new Database(native.nativePath);
    db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)");
    db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(0, 14, field(19, field(2, "Tiếp tục kiểm tra dữ liệu")));
    db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(1, 15, field(20, Buffer.concat([
      field(1, "Validation implemented; run regression checks."), field(3, "Internal thinking must not be transferred"),
    ])));
    db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(2, 132, field(5, "Tool metadata"));
    db.close();
    const context = await readNativeSessionContext(native);
    assert.ok(context.includes("Tiếp tục kiểm tra dữ liệu"));
    assert.ok(context.includes("run regression checks"));
    assert.ok(!context.includes("Internal thinking"));
    assert.ok(!context.includes("Tool metadata"));
  } finally { f.close(); }
});
