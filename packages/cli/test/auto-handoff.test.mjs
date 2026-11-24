import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { antigravityRulesSection, claudeManagedSection, codexManagedSection } from "@agent-bridge/adapters";
import { handleCodexHook } from "../dist/commands/codex.js";
import { handleAntigravityHook } from "../dist/commands/antigravity.js";
import { handleClaudeHook } from "../dist/commands/claude.js";
import { writeHandoffArtifacts } from "../dist/commands/handoff.js";
import { contextSessionDirectory, locateContext } from "../dist/context-runtime.js";
import { ensureWorkspace, openStore, readConfig, startAgentSession, writeConfig } from "../dist/workspace.js";

async function fixture(agent, run) {
  const cwd = mkdtempSync(join(tmpdir(), "auto-handoff-"));
  const sessionId = `${agent}-handoff-session`;
  const savedEnv = Object.fromEntries(["AGENT_BRIDGE_TERMINAL_SESSION_ID", "AGENT_BRIDGE_SPAWNED_RUN", "AGENT_BRIDGE_ORCHESTRATION"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  try {
    ensureWorkspace(cwd);
    const store = openStore(cwd);
    const task = store.createTask({ title: "Implement handoff", goal: "Preserve task state", ownerAgent: agent });
    const other = store.createTask({ title: "Unrelated task", ownerAgent: agent });
    store.addMemory({ taskId: task.id, type: "constraint", content: "Do not change acceptance criteria", importance: 5 });
    store.close();
    startAgentSession(sessionId, task.id, cwd, agent);
    const stop = async (response) => {
      if (agent === "codex") return handleCodexHook({ cwd, session_id: sessionId, last_assistant_message: response }, "Stop");
      if (agent === "claude") return handleClaudeHook({ cwd, session_id: sessionId, last_assistant_message: response, hook_event_name: "Stop" });
      const transcriptPath = join(cwd, "transcript.jsonl");
      writeFileSync(transcriptPath, response == null ? "" : JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: response }) + "\n");
      return handleAntigravityHook({ cwd, workspacePaths: [cwd], conversationId: sessionId, transcriptPath }, "Stop");
    };
    const read = () => {
      const store = openStore(cwd);
      try { return store.getLatestHandoff(task.id); } finally { store.close(); }
    };
    await run({ cwd, sessionId, task, other, stop, read });
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

for (const agent of ["codex", "antigravity", "claude"]) {
  test(`${agent} Stop creates and replaces task-bound auto-handoff without archives or context publication`, async () => {
    await fixture(agent, async ({ cwd, sessionId, task, other, stop, read }) => {
      await stop("Đã cập nhật handoff.\n- Next: verify receiver");
      const first = read();
      assert.equal(first.auto, true);
      assert.equal(first.fromAgent, agent);
      assert.equal(first.taskId, task.id);
      assert.match(first.summary, /Đã cập nhật/);
      assert.deepEqual(first.next, ["Next: verify receiver"]);
      assert.deepEqual(first.risks, ["Do not change acceptance criteria"]);
      assert.match(readFileSync(join(cwd, ".handoff/CURRENT.md"), "utf8"), /Next: verify receiver/);
      await stop("Updated state.\n- Next: review the result");
      const second = read();
      assert.notEqual(second.id, first.id);
      assert.equal(second.summary, "Updated state.\n- Next: review the result");
      const portable = readFileSync(join(cwd, ".handoff/CURRENT.md"), "utf8");
      await stop(null);
      assert.deepEqual(read(), second);
      assert.equal(readFileSync(join(cwd, ".handoff/CURRENT.md"), "utf8"), portable);
      assert.deepEqual(readdirSync(join(cwd, ".handoff/history")), []);
      assert.equal(existsSync(join(cwd, ".handoff/INDEX.md")), false);
      const store = openStore(cwd);
      try {
        assert.equal(store.getLatestHandoff(other.id), undefined);
        assert.equal(store.listCheckpoints(task.id, 10).length, 0);
        assert.equal(store.getTask(task.id).status, task.status);
        assert.equal(existsSync(join(contextSessionDirectory(cwd, sessionId), "metadata.json")), false);
      } finally { store.close(); }
    });
  });

  test(`${agent} Stop preserves authored handoff and portable artifacts`, async () => {
    await fixture(agent, async ({ cwd, task, stop, read }) => {
      const store = openStore(cwd);
      const authored = store.upsertTaskHandoff({ taskId: task.id, summary: "Reviewed manual handoff", fromAgent: agent, next: ["Keep this plan"] });
      store.close();
      writeHandoffArtifacts(cwd, authored, { archive: true, task });
      const current = readFileSync(join(cwd, ".handoff/CURRENT.md"), "utf8");
      const index = readFileSync(join(cwd, ".handoff/INDEX.md"), "utf8");
      const history = readdirSync(join(cwd, ".handoff/history"));
      await stop("Automatic response.\n- Next: another plan");
      assert.deepEqual(read(), authored);
      assert.equal(readFileSync(join(cwd, ".handoff/CURRENT.md"), "utf8"), current);
      assert.equal(readFileSync(join(cwd, ".handoff/INDEX.md"), "utf8"), index);
      assert.deepEqual(readdirSync(join(cwd, ".handoff/history")), history);
    });
  });

  test(`${agent} Stop skips missing and blank responses`, async () => {
    await fixture(agent, async ({ cwd, stop, read }) => {
      for (const response of [undefined, null, "", "  \n "]) await stop(response);
      assert.equal(read(), undefined);
      assert.equal(existsSync(join(cwd, ".handoff/CURRENT.md")), false);
    });
  });

  test(`${agent} Stop skips auto-handoff in single workflow`, async () => {
    await fixture(agent, async ({ cwd, stop, read }) => {
      writeConfig({ ...readConfig(cwd), workflow: { mode: "single" } }, cwd);
      await stop("Finished this turn.\n- Next: verify");
      assert.equal(read(), undefined);
      assert.equal(existsSync(join(cwd, ".handoff/CURRENT.md")), false);
    });
  });

  test(`${agent} spawned Stop does not publish a parent handoff`, async () => {
    await fixture(agent, async ({ cwd, stop, read }) => {
      process.env.AGENT_BRIDGE_SPAWNED_RUN = "run-test";
      await stop("Sub-agent result");
      assert.equal(read(), undefined);
      assert.equal(existsSync(join(cwd, ".handoff/CURRENT.md")), false);
    });
  });
}

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const runContext = (cwd, ...args) => execFileSync(process.execPath, [cli, "context", ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});

for (const agent of ["codex", "claude", "antigravity"]) {
  test(`${agent} startup, prompts, compaction and task switch do not preload context`, async () => {
    await fixture(agent, async ({ cwd, sessionId, task, other, stop }) => {
      const transcript = join(cwd, "requests.jsonl");
      const submit = async (prompt) => {
        if (agent === "codex") return handleCodexHook({ cwd, session_id: sessionId, prompt }, "UserPromptSubmit");
        if (agent === "claude") return handleClaudeHook({ cwd, session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt });
        writeFileSync(transcript, JSON.stringify({ type: "USER_INPUT", content: prompt }) + "\n");
        return handleAntigravityHook({ cwd, workspacePaths: [cwd], conversationId: sessionId, transcriptPath: transcript }, "PreInvocation");
      };
      if (agent === "codex") {
        await handleCodexHook({ cwd, session_id: sessionId }, "SessionStart");
      } else if (agent === "claude") {
        assert.equal(handleClaudeHook({ cwd, session_id: sessionId, hook_event_name: "SessionStart" }), undefined);
      }
      for (const prompt of ["Implement handoff", "What is a lease?"]) {
        const response = await submit(prompt);
        assert.equal(response?.hookSpecificOutput?.additionalContext, undefined);
      }
      await stop("Agent progress.");
      if (agent === "claude") {
        assert.equal(handleClaudeHook({ cwd, session_id: sessionId, hook_event_name: "SessionStart", source: "compact" }), undefined);
      }
      const metadataPath = join(contextSessionDirectory(cwd, sessionId), "metadata.json");
      assert.equal(readConfig(cwd).sessionTasks[sessionId], task.id);
      assert.equal(existsSync(metadataPath), false);
      startAgentSession(sessionId, other.id, cwd, agent);
      await submit("Work on the selected task");
      assert.equal(readConfig(cwd).sessionTasks[sessionId], other.id);
      assert.equal(existsSync(metadataPath), false);
    });
  });
}

test("history lookup finds a completed task and reads only requested historical items without publishing context", async () => {
  await fixture("codex", async ({ cwd, sessionId, task }) => {
    const store = openStore(cwd);
    const historic = store.createTask({ title: "Đồng bộ lease", ownerAgent: "claude" });
    store.bindTaskIdentity(historic.id, { repositoryId: realpathSync.native(cwd), branch: "archive/leases" });
    store.updateTask(historic.id, { status: "done" });
    const memory = store.addMemory({ taskId: historic.id, type: "note", content: "LeaseFence prevents two writers", importance: 5 });
    store.addMemory({ taskId: historic.id, type: "note", content: "PrivateTokenHint", importance: 5, tags: ["private"] });
    store.upsertTaskHandoff({ taskId: historic.id, fromAgent: "claude", summary: "Preserved fencing during renewal", next: ["Check generation"] });
    const foreign = store.createTask({ title: "Đồng bộ lease", ownerAgent: "claude" });
    store.bindTaskIdentity(foreign.id, { repositoryId: "different-repository", branch: "main" });
    store.close();

    const find = JSON.parse(runContext(cwd, "find", "dong bo lease", "--limit", "3"));
    assert.deepEqual(find.items, [{ taskId: historic.id, title: historic.title, status: "done", matchedFields: ["title"] }]);
    const bySymbol = JSON.parse(runContext(cwd, "find", "LeaseFence"));
    assert.deepEqual(bySymbol.items.map((item) => item.taskId), [historic.id]);
    assert.deepEqual(JSON.parse(runContext(cwd, "find", "PrivateTokenHint")), { items: [] });
    const result = JSON.parse(runContext(cwd, "query", "LeaseFence", "--task", historic.id));
    assert.deepEqual(result.items.map((item) => item.id), [memory.id]);
    assert.match(JSON.parse(runContext(cwd, "expand", memory.id, "--task", historic.id)).content, /two writers/);
    assert.match(JSON.parse(runContext(cwd, "handoff", "--task", historic.id)).summary, /fencing/);
    assert.throws(() => runContext(cwd, "handoff", "--task", foreign.id), (error) => /another repository/.test(error.stderr));
    assert.equal(readConfig(cwd).sessionTasks[sessionId], task.id);
    assert.equal(existsSync(join(contextSessionDirectory(cwd, sessionId), "metadata.json")), false);
    const saved = openStore(cwd);
    try { assert.equal(saved.getTask(historic.id).branch, "archive/leases"); }
    finally { saved.close(); }

    assert.match(runContext(cwd, "startup", "--agent", "codex", "--session", sessionId), /Implement handoff/);
    assert.equal(locateContext(cwd, "codex", sessionId).taskId, task.id);
  });
});

test("managed instructions for all providers describe selective retrieval and ambiguity", () => {
  for (const render of [codexManagedSection, claudeManagedSection, antigravityRulesSection]) {
    const instructions = render();
    assert.match(instructions, /Do not load compiled context automatically/);
    assert.match(instructions, /context find/);
    assert.match(instructions, /ask one focused question before searching history/);
    assert.match(instructions, /ask which one before opening details/);
  }
});
