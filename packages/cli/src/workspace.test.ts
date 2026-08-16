import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleClaudeHook, installClaudeHooks } from "./commands/claude.js";
import {
  ensureWorkspace,
  consumePendingNewTask,
  initializeWorkspace,
  openStore,
  policyBudgets,
  readConfig,
  readTokenPolicy,
  readStdinUtf8,
  rememberSessionWindowHandle,
  rememberSessionTask,
  resolveCurrentTaskId,
  resolveTokenBudget,
  setCurrentTask,
  startAgentSession,
  syncAgentSession,
  endAgentSession,
  cleanupStaleAgentSessions,
  writeConfig,
} from "./workspace.js";

describe("initializeWorkspace", () => {
  it("creates local memory files and managed agent sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-cli-"));
    try {
      const output = initializeWorkspace(dir).join("\n");
      expect(output).toContain("Initialized agent-bridge");
      expect(output).toContain("Initialized git repository.");
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
        "agent-bridge:start",
      );
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain(
        "Claude Efficiency Rules",
      );
      expect(
        readFileSync(join(dir, ".agent-memory", "config.json"), "utf8"),
      ).toContain("currentTaskId");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs Claude hooks and captures first prompt as current task", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-claude-"));
    try {
      installClaudeHooks(dir);
      const settings = readFileSync(
        join(dir, ".claude", "settings.local.json"),
        "utf8",
      );
      expect(settings).toContain("UserPromptSubmit");

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the login session persistence bug",
      });

      const currentTask = readFileSync(
        join(dir, ".agent-memory", "current-task.md"),
        "utf8",
      );
      expect(currentTask).toContain("Fix the login session persistence bug");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a new task for the first prompt of a new Claude session", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-new-session-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-one",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the original issue",
      });
      const firstTaskId = resolveCurrentTaskId(dir, undefined, "claude");

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-two",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Build a separate feature",
      });
      const secondTaskId = resolveCurrentTaskId(dir, undefined, "claude");

      expect(secondTaskId).toBeTruthy();
      expect(secondTaskId).not.toBe(firstTaskId);
      const store = openStore(dir);
      expect(store.getTask(secondTaskId as string)?.title).toBe(
        "Build a separate feature",
      );
      expect(store.getTask(firstTaskId as string)?.title).toBe(
        "Fix the original issue",
      );
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent Claude sessions in separate in-progress tasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-concurrent-claude-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-one",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-one",
        prompt: "Implement the first feature",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-two",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-two",
        prompt: "Implement the second feature",
      });

      const store = openStore(dir);
      const tasks = store.listTasks(10).filter((task) => task.ownerAgent === "claude");
      const first = tasks.find((task) => task.goal === "Implement the first feature");
      const second = tasks.find((task) => task.goal === "Implement the second feature");
      expect(tasks).toHaveLength(2);
      expect(first?.status).toBe("in_progress");
      expect(second?.status).toBe("in_progress");
      store.close();

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "TaskCompleted",
        session_id: "session-one",
      });

      const afterCompletion = openStore(dir);
      expect(afterCompletion.getTask(first?.id as string)?.status).toBe("done");
      expect(afterCompletion.getTask(second?.id as string)?.status).toBe("in_progress");
      afterCompletion.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures explicitly repo-wide Claude instructions as shared memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-repo-memory-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "repo-memory-session",
        prompt: "Repository rule: never edit generated SDK files by hand.",
      });

      const store = openStore(dir);
      const repoMemory = store.listRepoMemories();
      expect(repoMemory).toHaveLength(1);
      expect(repoMemory[0]?.content).toContain("never edit generated SDK files");
      expect(repoMemory[0]?.tags).toContain("auto-captured");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists substantive Claude findings as task memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-task-finding-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "finding-session",
        prompt: "Investigate the failing firmware build",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        session_id: "finding-session",
        last_assistant_message: "Root cause: the generated config was stale. Fixed it and verified the build.",
      });

      const taskId = resolveCurrentTaskId(dir, undefined, "claude") as string;
      const store = openStore(dir);
      expect(store.listMemoriesForTask(taskId).some((memory) => memory.tags.includes("task-finding"))).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits legacy Claude session mappings that share one task", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-shared-claude-task-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-one",
        prompt: "Keep the original task",
      });
      const firstTaskId = resolveCurrentTaskId(dir, undefined, "claude") as string;
      rememberSessionTask("session-two", firstTaskId, dir);

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-two",
        prompt: "Split the second task",
      });

      const store = openStore(dir);
      const tasks = store.listTasks(10).filter((task) => task.ownerAgent === "claude");
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.goal === "Keep the original task")?.status).toBe("in_progress");
      expect(tasks.find((task) => task.goal === "Split the second task")?.status).toBe("in_progress");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the original task when an earlier Claude session is resumed", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-resume-session-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-one",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-one",
        prompt: "Fix the original issue",
      });
      const firstTaskId = resolveCurrentTaskId(dir, undefined, "claude");

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-two",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-two",
        prompt: "Build a separate feature",
      });
      const secondTaskId = resolveCurrentTaskId(dir, undefined, "claude");
      expect(secondTaskId).not.toBe(firstTaskId);

      // Switch back to the first session: its task must become current again
      // instead of being overwritten or duplicated.
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "SessionStart",
        session_id: "session-one",
      });
      expect(resolveCurrentTaskId(dir, undefined, "claude")).toBe(firstTaskId);
      expect(consumePendingNewTask(dir, "claude")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist raw Claude user prompts as durable task memories", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-no-prompt-memory-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix noisy Claude prompt memory",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Also check whether follow-up prompts pollute top memory",
      });

      const taskId = resolveCurrentTaskId(dir, undefined, "claude");
      const store = openStore(dir);
      const promptMemories = store
        .listMemoriesForTask(taskId as string, 20)
        .filter((memory) => memory.tags.includes("prompt"));
      store.close();

      expect(promptMemories).toHaveLength(0);
      const compiled = readFileSync(
        join(dir, ".agent-memory", "compiled-context.md"),
        "utf8",
      );
      expect(compiled).not.toContain(
        "Also check whether follow-up prompts pollute top memory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures the assistant response from transcript_path when Stop omits last_assistant_message", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-stop-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Investigate the failing hook",
      });

      const transcript = join(dir, "transcript.jsonl");
      const lines = [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Root cause found and patched." }],
          },
        }),
      ];
      writeFileSync(transcript, `${lines.join("\n")}\n`, "utf8");

      // Claude Code's real Stop payload has transcript_path but no last_assistant_message.
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        transcript_path: transcript,
      });

      const compiled = readFileSync(
        join(dir, ".agent-memory", "compiled-context.md"),
        "utf8",
      );
      expect(compiled).toContain("Root cause found and patched.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats Claude latest response as replaceable state", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-latest-response-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Keep only the current Claude response",
      });

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        last_assistant_message: "first response",
      });
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        last_assistant_message: "second response",
      });

      const taskId = resolveCurrentTaskId(dir, undefined, "claude");
      const store = openStore(dir);
      const latest = store
        .listMemoriesForTask(taskId as string, 20)
        .filter((memory) => memory.tags.includes("latest-response"));
      store.close();

      expect(latest).toHaveLength(1);
      expect(latest[0]?.content).toContain("second response");
      expect(latest[0]?.importance).toBe(3);

      const compiled = readFileSync(
        join(dir, ".agent-memory", "compiled-context.md"),
        "utf8",
      );
      expect(compiled).toContain("second response");
      expect(compiled).not.toContain("first response");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-generates a handoff from accumulated memory on Stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-autohandoff-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the broken Stop hook",
      });

      const transcript = join(dir, "transcript.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Patched the hook.\n- Next: add a regression test\n- implement auto handoff",
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        transcript_path: transcript,
      });

      const handoff = readFileSync(
        join(dir, ".agent-memory", "handoff.md"),
        "utf8",
      );
      expect(handoff).not.toContain("No handoff has been created yet.");
      expect(handoff).toContain("Patched the hook.");
      expect(handoff).toContain("Handled task: Fix the broken Stop hook");
      expect(handoff).toContain("add a regression test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes stale current-task artifacts during auto handoff, context compile, and completion hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-stale-task-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Knowledge graph scan scoping",
      });

      const currentTaskPath = join(dir, ".agent-memory", "current-task.md");
      writeFileSync(
        currentTaskPath,
        [
          "# Current Task",
          "",
          "## Title",
          "tiếp tục p1.2",
          "",
          "## Status",
          "in_progress",
          "",
        ].join("\n"),
        "utf8",
      );

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        last_assistant_message:
          "Knowledge graph work completed.\n- Next: add a regression test",
      });

      const compiled = readFileSync(
        join(dir, ".agent-memory", "compiled-context.md"),
        "utf8",
      );
      expect(readFileSync(currentTaskPath, "utf8")).not.toContain(
        "tiếp tục p1.2",
      );
      expect(compiled).toContain("- Title: Knowledge graph scan scoping");
      expect(compiled).toContain("- Task: in_progress");
      expect(
        readFileSync(join(dir, ".agent-memory", "handoff.md"), "utf8"),
      ).toContain("Knowledge graph work completed.");

      handleClaudeHook({ cwd: dir, hook_event_name: "TaskCompleted" });

      expect(readFileSync(currentTaskPath, "utf8")).toContain(
        "## Status\ndone",
      );
      expect(
        readFileSync(join(dir, ".agent-memory", "compiled-context.md"), "utf8"),
      ).toContain("- Task: done");

      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Follow-up task after graph completion",
      });

      const nextCurrentTask = readFileSync(currentTaskPath, "utf8");
      expect(nextCurrentTask).toContain(
        "Follow-up task after graph completion",
      );
      expect(nextCurrentTask).toContain("## Status\nin_progress");
      expect(nextCurrentTask).not.toContain("Knowledge graph scan scoping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a manual handoff when Stop fires", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-manualhandoff-"));
    try {
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt: "Work item",
      });
      const taskId = resolveCurrentTaskId(dir, undefined, "claude");
      expect(taskId).toBeTruthy();

      const store = openStore(dir);
      store.createHandoff({
        taskId: taskId as string,
        summary: "MANUAL handoff text",
        fromAgent: "claude",
      });
      store.close();

      const transcript = join(dir, "transcript.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "auto response" }],
          },
        })}\n`,
        "utf8",
      );
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "Stop",
        transcript_path: transcript,
      });

      const store2 = openStore(dir);
      const latest = store2.getLatestHandoff(taskId as string);
      store2.close();
      expect(latest?.summary).toBe("MANUAL handoff text");
      expect(latest?.auto).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures Unicode prompts without replacing characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-unicode-"));
    try {
      const prompt = "Sửa lỗi đăng nhập tiếng Việt";
      handleClaudeHook({
        cwd: dir,
        hook_event_name: "UserPromptSubmit",
        prompt,
      });

      const currentTask = readFileSync(
        join(dir, ".agent-memory", "current-task.md"),
        "utf8",
      );
      expect(currentTask).toContain(prompt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores the database files via a generated .gitignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-gitignore-"));
    try {
      ensureWorkspace(dir);
      const gitignore = readFileSync(
        join(dir, ".agent-memory", ".gitignore"),
        "utf8",
      );
      expect(gitignore).toContain("memories.db");
      expect(gitignore).toContain("memories.db-wal");
      expect(gitignore).toContain("memories.db-shm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readTokenPolicy", () => {
  it("reads per-section budgets from the generated token-policy.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-policy-"));
    try {
      ensureWorkspace(dir);
      const policy = readTokenPolicy(dir);
      expect(policy.maxMemoryTokens).toBe(800);
      expect(policy.maxFileSnippetTokens).toBe(1200);
      expect(policyBudgets(dir)).toEqual({
        memoryTokenBudget: 800,
        fileTokenBudget: 1200,
        handoffTokenBudget: 600,
        repoMapTokenBudget: 1000,
        constraintTokenBudget: 400,
        decisionTokenBudget: 400,
      });
      expect(resolveTokenBudget(dir)).toBe(4000);
      expect(resolveTokenBudget(dir, 1500)).toBe(1500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reflects edits to max_memory_tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-policy-edit-"));
    try {
      ensureWorkspace(dir);
      writeFileSync(
        join(dir, ".agent-memory", "token-policy.yaml"),
        ["token_policy:", "  max_memory_tokens: 123", ""].join("\n"),
        "utf8",
      );
      expect(readTokenPolicy(dir).maxMemoryTokens).toBe(123);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("per-agent current task", () => {
  it("keeps separate current tasks per agent without clobbering", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-multi-"));
    try {
      ensureWorkspace(dir);
      setCurrentTask("task-claude", dir, "claude");
      setCurrentTask("task-codex", dir, "codex");
      expect(resolveCurrentTaskId(dir, undefined, "claude")).toBe(
        "task-claude",
      );
      expect(resolveCurrentTaskId(dir, undefined, "codex")).toBe("task-codex");
      // explicit always wins
      expect(resolveCurrentTaskId(dir, "explicit", "claude")).toBe("explicit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears only the new session's agent task association", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-session-"));
    try {
      ensureWorkspace(dir);
      setCurrentTask("task-claude", dir, "claude");
      setCurrentTask("task-codex", dir, "codex");
      expect(syncAgentSession("session-1", dir, "claude")).toBe(true);
      expect(resolveCurrentTaskId(dir, undefined, "codex")).toBe("task-codex");
      expect(consumePendingNewTask(dir, "claude")).toBe(true);
      expect(consumePendingNewTask(dir, "claude")).toBe(false);
      expect(syncAgentSession("session-1", dir, "claude")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks manually instrumented Codex and Antigravity sessions separately", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-manual-session-"));
    try {
      ensureWorkspace(dir);
      startAgentSession("codex-session", "task-codex", dir, "codex");
      startAgentSession("antigravity-session", "task-antigravity", dir, "antigravity");

      expect(readConfig(dir).activeSessions).toEqual({
        "codex-session": "codex",
        "antigravity-session": "antigravity",
      });
      expect(resolveCurrentTaskId(dir, undefined, "codex")).toBe("task-codex");
      expect(resolveCurrentTaskId(dir, undefined, "antigravity")).toBe("task-antigravity");

      endAgentSession("codex-session", dir);
      expect(readConfig(dir).activeSessions).toEqual({ "antigravity-session": "antigravity" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes the remembered terminal window for a resumed session task", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-window-resume-"));
    try {
      ensureWorkspace(dir);
      rememberSessionWindowHandle(
        "codex-session",
        "task-old",
        "codex",
        dir,
        "111",
      );
      rememberSessionWindowHandle(
        "codex-session",
        "task-resumed",
        "codex",
        dir,
        "222",
      );

      expect(readConfig(dir).sessionWindows?.["codex-session"]).toMatchObject({
        hwnd: "222",
        taskId: "task-resumed",
        agent: "codex",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends a live session immediately when its captured terminal window is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-dead-window-"));
    try {
      ensureWorkspace(dir);
      const seedStore = openStore(dir);
      const task = seedStore.createTask({
        title: "Tracked Codex task",
        ownerAgent: "codex",
      });
      seedStore.close();
      startAgentSession("codex-session", task.id, dir, "codex");
      writeConfig({
        ...readConfig(dir),
        sessionWindows: {
          "codex-session": {
            hwnd: "123",
            taskId: task.id,
            agent: "codex",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }, dir);

      const store = openStore(dir);
      try {
        store.recordSessionEvent({
          sessionId: "codex-session",
          taskId: task.id,
          agent: "codex",
          kind: "session_started",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const closed = cleanupStaleAgentSessions(store, dir, {
          now: new Date("2026-01-01T00:00:01.000Z"),
          staleAfterMs: 60_000,
          isSessionWindowAlive: () => false,
        });

        expect(closed).toBe(1);
        expect(store.listActiveSessionEvents()).toHaveLength(0);
        expect(readConfig(dir).activeSessions?.["codex-session"]).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an old live session when its captured terminal window still exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-live-window-"));
    try {
      ensureWorkspace(dir);
      const seedStore = openStore(dir);
      const task = seedStore.createTask({
        title: "Tracked Codex task",
        ownerAgent: "codex",
      });
      seedStore.close();
      startAgentSession("codex-session", task.id, dir, "codex");
      writeConfig({
        ...readConfig(dir),
        sessionWindows: {
          "codex-session": {
            hwnd: "123",
            taskId: task.id,
            agent: "codex",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }, dir);

      const store = openStore(dir);
      try {
        store.recordSessionEvent({
          sessionId: "codex-session",
          taskId: task.id,
          agent: "codex",
          kind: "session_started",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const closed = cleanupStaleAgentSessions(store, dir, {
          now: new Date("2026-01-01T01:00:00.000Z"),
          staleAfterMs: 60_000,
          isSessionWindowAlive: () => true,
        });

        expect(closed).toBe(0);
        expect(store.listActiveSessionEvents()).toHaveLength(1);
        expect(readConfig(dir).activeSessions?.["codex-session"]).toBe("codex");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a terminal session while its registered process is alive and ends it when the process closes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-terminal-process-"));
    try {
      ensureWorkspace(dir);
      const store = openStore(dir);
      const task = store.createTask({ title: "Tracked terminal", ownerAgent: "antigravity" });
      startAgentSession("agy-terminal", task.id, dir, "antigravity");
      writeConfig({
        ...readConfig(dir),
        sessionWindows: {
          "agy-terminal": {
            windowId: "agy-terminal",
            pid: 1234,
            taskId: task.id,
            agent: "antigravity",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }, dir);
      store.recordSessionEvent({
        sessionId: "agy-terminal",
        taskId: task.id,
        agent: "antigravity",
        kind: "session_started",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      expect(cleanupStaleAgentSessions(store, dir, {
        now: new Date("2026-01-01T01:00:00.000Z"),
        staleAfterMs: 1,
        isSessionProcessAlive: () => true,
      })).toBe(0);
      expect(cleanupStaleAgentSessions(store, dir, {
        now: new Date("2026-01-01T01:00:01.000Z"),
        staleAfterMs: 1,
        isSessionProcessAlive: () => false,
      })).toBe(1);
      expect(store.listActiveSessionEvents()).toHaveLength(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches live terminal window checks across cleanup polls", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-window-cache-"));
    try {
      ensureWorkspace(dir);
      const seedStore = openStore(dir);
      const task = seedStore.createTask({
        title: "Cached terminal task",
        ownerAgent: "codex",
      });
      seedStore.close();
      startAgentSession("codex-session-cache", task.id, dir, "codex");
      writeConfig({
        ...readConfig(dir),
        sessionWindows: {
          "codex-session-cache": {
            hwnd: "789",
            taskId: task.id,
            agent: "codex",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }, dir);

      const store = openStore(dir);
      try {
        store.recordSessionEvent({
          sessionId: "codex-session-cache",
          taskId: task.id,
          agent: "codex",
          kind: "session_started",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        let checks = 0;
        const options = {
          staleAfterMs: 1,
          windowCheckIntervalMs: 60_000,
          isSessionWindowAlive: () => {
            checks += 1;
            return true;
          },
        };

        expect(
          cleanupStaleAgentSessions(store, dir, {
            ...options,
            now: new Date("2026-01-01T01:00:00.000Z"),
          }),
        ).toBe(0);
        expect(
          cleanupStaleAgentSessions(store, dir, {
            ...options,
            now: new Date("2026-01-01T01:00:05.000Z"),
          }),
        ).toBe(0);

        expect(checks).toBe(1);
        expect(store.listActiveSessionEvents()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes untracked active-looking session events after a short grace", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-untracked-session-"));
    try {
      ensureWorkspace(dir);
      const store = openStore(dir);
      try {
        const task = store.createTask({
          title: "Untracked request task",
          ownerAgent: "codex",
        });
        store.recordSessionEvent({
          sessionId: "request-session",
          taskId: task.id,
          agent: "codex",
          kind: "request_resolved",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const closed = cleanupStaleAgentSessions(store, dir, {
          now: new Date("2026-01-01T00:00:10.000Z"),
          untrackedStaleAfterMs: 1_000,
        });

        expect(closed).toBe(1);
        expect(store.listActiveSessionEvents()).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readStdinUtf8", () => {
  it("gives up on a pipe that never delivers anything, instead of hanging the caller forever", async () => {
    // A spawned agent CLI can hand its own still-open stdin down to the shell it
    // runs agent-bridge in. Waiting on that pipe blocks the command, which blocks
    // the agent, which leaves the whole run stuck at "running" with an empty log.
    const never = new PassThrough();
    const started = Date.now();
    expect(await readStdinUtf8(120, never)).toBe("");
    expect(Date.now() - started).toBeLessThan(3000);
    // The stream is torn down too: a merely paused pipe is still an active
    // handle, so the process would refuse to exit after printing its error.
    expect(never.destroyed).toBe(true);
  });

  it("never truncates a slow pipe once the first byte has arrived", async () => {
    const slow = new PassThrough();
    slow.write("phan dau ");
    setTimeout(() => slow.end("va phan cuoi den rat muon"), 240);
    expect(await readStdinUtf8(80, slow)).toBe("phan dau va phan cuoi den rat muon");
  });

  it("reads a pipe that closes normally", async () => {
    const quick = new PassThrough();
    quick.end("  noi dung  ");
    expect(await readStdinUtf8(1000, quick)).toBe("noi dung");
  });
});
