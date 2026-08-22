import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  answeredQuestionRouting,
  assertUiPageFreshness,
  filterWorkBoardSessionEvents,
  inferContextAgent,
  isAutoRunning,
  parseUiPort,
  prepareUiWorkspace,
  readPortableHandoffState,
  recordDirectSubtaskRunOutcome,
  resumeAutoRuns,
  startAutoRun,
  stopAutoRun,
  taskChangesWithWriteLeases,
} from "./ui.js";
import { readLogTail } from "./routes/files.js";
import { openStore } from "../workspace.js";
import { renderDashboardHtml } from "../ui-page.js";

// The dashboard script is served from /ui-client/main.js, not inlined in the
// page, so behaviour assertions read the client source directly.
const clientJs = readFileSync(new URL("../ui-client/main.ts", import.meta.url), "utf8");

// Tests that mix markup and behaviour assertions read the pair the dashboard
// actually ships: the page shell plus that client module.
function renderDashboardPage(workspace?: string): string {
  return renderDashboardHtml(workspace) + clientJs;
}

function createUiPackage(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-ui-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "src", "ui-page.ts"), "export {};\n");
  writeFileSync(join(root, "dist", "ui-page.js"), "export {};\n");
  return root;
}

describe("assertUiPageFreshness", () => {
  it("allows a dashboard build that is at least as new as its source", () => {
    const root = createUiPackage();
    try {
      const timestamp = new Date("2025-01-01T00:00:00.000Z");
      utimesSync(join(root, "src", "ui-page.ts"), timestamp, timestamp);
      utimesSync(join(root, "dist", "ui-page.js"), timestamp, timestamp);

      expect(() => assertUiPageFreshness(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the dashboard when ui-page.ts is newer than its compiled module", () => {
    const root = createUiPackage();
    try {
      // A build script that just touches dist/ui-page.js: enough to prove the
      // stale bundle is rebuilt instead of the launch being refused.
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "ui-freshness-fixture",
          scripts: { build: "node -e \"require('fs').writeFileSync('dist/ui-page.js','export {};\\n')\"" },
        }),
      );
      utimesSync(
        join(root, "dist", "ui-page.js"),
        new Date("2025-01-01T00:00:00.000Z"),
        new Date("2025-01-01T00:00:00.000Z"),
      );
      utimesSync(
        join(root, "src", "ui-page.ts"),
        new Date("2025-01-01T00:00:01.000Z"),
        new Date("2025-01-01T00:00:01.000Z"),
      );

      expect(() => assertUiPageFreshness(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks the UI when the stale dashboard cannot be rebuilt", () => {
    const root = createUiPackage();
    try {
      utimesSync(
        join(root, "dist", "ui-page.js"),
        new Date("2025-01-01T00:00:00.000Z"),
        new Date("2025-01-01T00:00:00.000Z"),
      );
      utimesSync(
        join(root, "src", "ui-page.ts"),
        new Date("2025-01-01T00:00:01.000Z"),
        new Date("2025-01-01T00:00:01.000Z"),
      );

      expect(() => assertUiPageFreshness(root)).toThrow(
        "pnpm --filter @agent-bridge/cli build",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readPortableHandoffState", () => {
  it("returns only archived handoffs for the selected task", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-handoff-state-"));
    const history = join(root, ".handoff", "history");
    mkdirSync(history, { recursive: true });
    try {
      writeFileSync(join(history, "new.md"), [
        "# Handoff — New packet",
        "",
        "Date: 2026-08-20T16:00:00.000Z",
        "Task: task-a",
        "State: in_progress",
        "",
        "## Current state",
        "Ready for the next action.",
        "",
        "## Completed",
        "- Core flow",
      ].join("\n"));
      writeFileSync(join(history, "other.md"), "# Handoff — Other\n\nTask: task-b\n");

      expect(readPortableHandoffState(root, "task-a").history).toEqual([
        expect.objectContaining({
          path: ".handoff/history/new.md",
          title: "New packet",
          state: "in_progress",
          summary: "Ready for the next action.",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("parseUiPort", () => {
  it("accepts a valid TCP port", () => {
    expect(parseUiPort("4783")).toBe(4783);
  });

  it("rejects invalid TCP ports", () => {
    expect(() => parseUiPort("0")).toThrow("1 to 65535");
    expect(() => parseUiPort("65536")).toThrow("1 to 65535");
    expect(() => parseUiPort("abc")).toThrow("1 to 65535");
  });
});

describe("prepareUiWorkspace", () => {
  it("prepares the selected project workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-ui-project-"));
    try {
      const project = prepareUiWorkspace(root);

      expect(project).toBe(root);
      expect(existsSync(join(root, ".agent-memory", "config.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("taskChangesWithWriteLeases", () => {
  it("shows active write leases as pending task changes before task scan runs", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-workgit-"));
    try {
      writeFileSync(join(root, "src.ts"), "export const value = 1;\n");

      const changes = taskChangesWithWriteLeases(root, [], [
        {
          id: "lease-1",
          taskId: "task-1",
          path: "src.ts",
          mode: "write",
          expiresAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(changes).toMatchObject([
        {
          id: "lease-change-lease-1",
          taskId: "task-1",
          path: "src.ts",
          changeType: "modified",
          status: "pending",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("auto-run loop", () => {
  it("advances an orchestration on its own and stops once it halts", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-autorun-"));
    try {
      const store = openStore(root);
      let orchestrationId: string;
      try {
        // "manual" mode: stepOrchestration will throw rather than launch a real
        // CLI, which is exactly the fault path the loop has to survive.
        const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
        const task = store.createTask({ title: "Auto-run me", ownerAgent: "codex" });
        orchestrationId = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id }).id;
      } finally {
        store.close();
      }

      expect(isAutoRunning(orchestrationId)).toBe(false);
      startAutoRun(root, orchestrationId);
      expect(isAutoRunning(orchestrationId)).toBe(true);

      // The first tick is scheduled immediately; it throws (manual agent), so
      // the loop must stop itself instead of retrying forever.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(isAutoRunning(orchestrationId)).toBe(false);

      const check = openStore(root);
      try {
        expect(check.getOrchestration(orchestrationId)?.lastError).toContain("Auto-run stopped");
      } finally {
        check.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes auto-run for orchestrations the last server left running, and only those", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-autorun-"));
    try {
      const store = openStore(root);
      const ids: Record<string, string> = {};
      try {
        const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
        for (const [name, autonomy, status] of [
          ["running", "auto", "executing"],
          // approve-each also has the server stepping it — it just parks at
          // each gate — so it has to come back after a restart too, otherwise
          // approving a request would advance nothing.
          ["gated", "approve-each", "executing"],
          ["manual", "manual", "executing"],
          ["finished", "auto", "done"],
        ] as const) {
          const task = store.createTask({ title: `Task ${name}`, ownerAgent: "codex" });
          const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id, autonomy });
          store.updateOrchestration(orchestration.id, { status });
          ids[name] = orchestration.id;
        }
      } finally {
        store.close();
      }

      // Closing the tool used to lose the loop entirely: the rows still said
      // "executing" but nothing ever stepped them again.
      expect(resumeAutoRuns(root).sort()).toEqual([ids.running, ids.gated].sort());
      expect(isAutoRunning(ids.running!)).toBe(true);
      expect(isAutoRunning(ids.gated!)).toBe(true);
      expect(isAutoRunning(ids.manual!)).toBe(false);
      expect(isAutoRunning(ids.finished!)).toBe(false);
      for (const id of Object.values(ids)) stopAutoRun(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stopAutoRun cancels a scheduled loop and is safe to call twice", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-autorun-"));
    try {
      const store = openStore(root);
      let orchestrationId: string;
      try {
        const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
        const task = store.createTask({ title: "Cancel me", ownerAgent: "codex" });
        orchestrationId = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id }).id;
      } finally {
        store.close();
      }

      startAutoRun(root, orchestrationId);
      stopAutoRun(orchestrationId);
      expect(isAutoRunning(orchestrationId)).toBe(false);
      expect(() => stopAutoRun(orchestrationId)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps approve-each auto-run armed while an approval waits longer than 15 minutes", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-autorun-approval-"));
    let orchestrationId = "";
    try {
      const store = openStore(root);
      try {
        const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
        const task = store.createTask({ title: "Wait for my approval", ownerAgent: "codex" });
        orchestrationId = store.createOrchestration({
          taskId: task.id,
          leaderAgentId: leader.id,
          autonomy: "approve-each",
        }).id;
      } finally {
        store.close();
      }

      startAutoRun(root, orchestrationId);
      vi.advanceTimersByTime(16 * 60 * 1000);

      expect(isAutoRunning(orchestrationId)).toBe(true);
      const check = openStore(root);
      try {
        expect(check.getOrchestration(orchestrationId)?.autonomy).toBe("approve-each");
        expect(check.listAgentRequests({ status: "pending" }).filter((request) => request.type === "approval")).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      if (orchestrationId) stopAutoRun(orchestrationId);
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readLogTail", () => {
  it("returns only the last lines, skipping blanks", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-logtail-"));
    try {
      const logPath = join(root, "run.log");
      writeFileSync(logPath, "one\n\ntwo\nthree\n\nfour\n");

      expect(readLogTail(logPath, 2)).toBe("three\nfour");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads only the tail of a large log and drops the partial first line", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-logtail-"));
    try {
      const logPath = join(root, "run.log");
      // Far bigger than maxBytes: an implementer log routinely is.
      writeFileSync(logPath, `${"x".repeat(50_000)}\nlast line\n`);

      const tail = readLogTail(logPath, 5, 1_000);
      expect(tail).toBe("last line");
      expect(tail).not.toContain("x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty string rather than throwing for a missing log", () => {
    expect(readLogTail(undefined)).toBe("");
    expect(readLogTail(join(tmpdir(), "agent-bridge-does-not-exist.log"))).toBe("");
  });
});

describe("recordDirectSubtaskRunOutcome", () => {
  it("persists success and failure on the assignment, subtask, and activity feed", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-direct-subtask-"));
    const store = openStore(root);
    try {
      const agent = store.createRegisteredAgent({ name: "worker", provider: "codex", mode: "manual" });
      const role = store.ensureDefaultWorkforceRoles().find((item) => item.name === "implementer")!;
      const task = store.createTask({ title: "Direct subtask", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: agent.id });

      for (const [status, expectedAssignment, expectedSubtask, expectedEvent] of [
        ["done", "done", "review", "run_ended"],
        ["failed", "failed", "blocked", "error"],
      ] as const) {
        const subtask = store.createSubtask({ parentTaskId: task.id, title: `${status} work`, status: "in_progress" });
        const assignment = store.createAssignment({
          taskId: task.id,
          subtaskId: subtask.id,
          agentId: agent.id,
          roleId: role.id,
          status: "running",
          prompt: "work",
        });
        const createdRun = store.createAgentRun({
          orchestrationId: orchestration.id,
          taskId: task.id,
          subtaskId: subtask.id,
          assignmentId: assignment.id,
          agentId: agent.id,
          roleId: role.id,
          cycle: orchestration.cycle,
          phase: "implement",
          status,
        });
        const run = store.updateAgentRun(createdRun.id, { exitCode: status === "done" ? 0 : 1 })!;

        recordDirectSubtaskRunOutcome(store, run);

        expect(store.listAssignments({ subtaskId: subtask.id })[0]?.status).toBe(expectedAssignment);
        const updatedSubtask = store.listSubtasks({ parentTaskId: task.id }).find((item) => item.id === subtask.id);
        expect(updatedSubtask?.status).toBe(expectedSubtask);
        expect(updatedSubtask?.statusReason).toBe(status === "failed" ? "Agent process failed with exit code 1." : undefined);
        expect(store.listOrchestrationEvents({ orchestrationId: orchestration.id })[0]?.kind).toBe(expectedEvent);
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("filterWorkBoardSessionEvents", () => {
  it("keeps direct sessions and excludes every session owned by an orchestrated task", () => {
    const events = [
      { id: "e1", sessionId: "human", taskId: "task-direct", agent: "codex", kind: "session_started", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "e2", sessionId: "worker", taskId: "task-orchestrated", agent: "claude", kind: "session_started", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "e3", sessionId: "unbound", agent: "generic", kind: "session_started", createdAt: "2026-01-01T00:00:02.000Z" },
    ] as const;

    expect(filterWorkBoardSessionEvents([...events], new Set(["task-orchestrated"])).map((event) => event.sessionId)).toEqual([
      "human",
      "unbound",
    ]);
  });
});

describe("inferContextAgent", () => {
  it("prefers the active task session, then owner, then the configured default", () => {
    const task = { id: "task-1", ownerAgent: "codex" } as const;
    const sessions = [
      { id: "e1", sessionId: "claude-live", taskId: "task-1", agent: "claude", kind: "session_started", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "e2", sessionId: "other", taskId: "task-2", agent: "antigravity", kind: "session_started", createdAt: "2026-01-01T00:00:01.000Z" },
    ] as const;

    expect(inferContextAgent(task, [...sessions], "generic")).toBe("claude");
    expect(inferContextAgent(task, [], "generic")).toBe("codex");
    expect(inferContextAgent({ id: "task-1" }, [], "generic")).toBe("generic");
  });
});

describe("dashboard overview", () => {
  it("renders a compact live-task dashboard with active-task styling", () => {
    const html = renderDashboardPage();
    expect(html).not.toContain("Selected Live Task");
    expect(renderDashboardHtml("D:\\repo")).toContain("D:\\repo");
    expect(html).toContain("join('\\n')");
    expect(html).not.toContain("join('\n')");
    expect(html).toContain("Live Task Board");
    expect(html).not.toContain("Target agent");
    expect(html).toContain("Agent Terminals");
    expect(html).toContain('data-view="skills"');
    expect(html).toContain('id="view-skills"');
    expect(html).toContain('id="skillDropZone"');
    expect(html).toContain('id="skillFile"');
    expect(html).toContain("/api/skills/save");
    expect(html).toContain("/api/skills/delete");
    expect(html).toContain('id="githubSkillSearchForm"');
    expect(html).toContain('id="githubSkillScope"');
    expect(html).toContain("/api/skills/github/search");
    expect(html).toContain("/api/skills/github/install");
    expect(html).toContain("result.repositoryUrl");
    expect(html).toContain("result.description || 'No repository description.'");
    expect(html).toContain("★ ' + escapeHtml(stars) + ' stars · updated ");
    expect(html).not.toContain("const directory = String(result.path || '')");
    expect(html).not.toContain("'<strong>$' + escapeHtml(directory)");
    expect(html).toContain('class="modal-backdrop" id="githubTokenHelpModal" hidden');
    expect(html).toContain('aria-labelledby="githubTokenHelpTitle"');
    expect(html).toContain('$env:GITHUB_TOKEN = Read-Host "GitHub token" -MaskInput');
    expect(html).toContain('Read-Host "GitHub token" -AsSecureString');
    expect(html).toContain("set /p GITHUB_TOKEN=GitHub token:");
    expect(html).toContain('[Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")');
    expect(html).toContain("An existing terminal and UI process cannot see variables added later.");
    expect(html).toContain("Do not add angle brackets around a token in CMD");
    expect(html).toContain("GitHub token is not visible to the running Agent Bridge process.");
    expect(html).toContain("if (isGitHubTokenMissing(error)) openGitHubTokenHelp(error)");
    expect(html).toContain("if (event.target === els.githubTokenHelpModal) closeGitHubTokenHelp()");
    expect(html).not.toContain('data-tip="Searches public GitHub code for SKILL.md files.');
    expect(html).toContain("Replace the existing skill?");
    expect(html).toContain("populateSkillFromFile");
    expect(html).toContain("dataTransfer && event.dataTransfer.files[0]");
    // The client is no longer inlined: the page loads it as a module and tsc
    // checks its syntax at build time. Guard the wiring, and parse the
    // compiled output when a build is present.
    expect(html).toContain('<script type="module" src="/ui-client/main.js"></script>');
    expect(html).not.toMatch(/<script>[\s\S]*?<\/script>/);
    const builtClient = new URL("../../dist/ui-client/main.js", import.meta.url);
    if (existsSync(builtClient)) {
      const compiled = readFileSync(builtClient, "utf8");
      expect(() => new Function(compiled)).not.toThrow();
    }
    expect(html).toContain('class="secondary open-agent-terminal" data-agent="claude"');
    expect(html).toContain('class="secondary open-agent-terminal" data-agent="codex"');
    expect(html).toContain('class="secondary open-agent-terminal" data-agent="antigravity"');
    expect(html).toContain("/api/session/terminal");
    expect(html).toContain("window ID ");
    expect(html).toContain("Each terminal gets its own live task card and window ID.");
    expect(html).toContain("session.hasWindow && session.agent === task.ownerAgent");
    expect(html).toContain("session.sessionId + ':' + session.hasWindow");
    expect(html).toContain("liveTaskSummary");
    expect(html).not.toContain("select-live-task");
    expect(html).not.toContain(">Inspect</button>");
    expect(html).toContain("task-carousel-shell");
    expect(html).toContain("liveTaskPrev");
    expect(html).toContain("liveTaskNext");
    expect(html).toContain("liveTaskCard");
    expect(html).toContain("selectLiveTask(liveTaskCard.dataset.taskId");
    expect(html).toContain("scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', inline: 'center'");
    expect(html).toContain(".live-task-grid::-webkit-scrollbar { display: none; }");
    expect(html).toContain("tabindex=\"0\" role=\"button\"");
    expect(html).toContain("is-before");
    expect(html).toContain("is-after");
    expect(html).toContain("Session Tracking");
    expect(html).toContain("/api/session/");
    expect(html).toContain("const actionButton = event.currentTarget;");
    expect(html).toContain("Only direct agent sessions are shown");
    expect(html).toContain("Orchestrator agents stay in Orchestrator → Runs");
    expect(html).toContain("Task Requests");
    expect(html).not.toContain("agentTeams");
    expect(html).not.toContain("Team: ");
    // The Workforce tab is gone; agent management moved into the Orchestrator
    // tab's Agents pane and everything else it offered was dead weight.
    expect(html).not.toContain('data-view="workforce"');
    expect(html).not.toContain('id="view-workforce"');
    expect(html).not.toContain('Teams, Members & Roles');
    expect(html).not.toContain('member-delete');
    expect(html).not.toContain('/api/workforce/member');
    expect(html).not.toContain('/api/workforce/role');
    expect(html).not.toContain('/api/workforce/dispatch/');
    expect(html).not.toContain('/api/workforce/team-task');
    expect(html).toContain('data-orch-tab="agents"');
    expect(html).toContain('id="workforceAgentForm"');
    expect(html).toContain('class="modal-backdrop" id="workforceAgentModal" hidden');
    expect(html).toContain('id="workforceAgentOpen"');
    expect(html).toContain('aria-labelledby="workforceAgentModalTitle"');
    expect(html).toContain("els.workforceAgentModal.hidden = false");
    expect(html).toContain("if (event.target === els.workforceAgentModal) closeAgentEditor()");
    expect(html).toContain('id="defaultAgentPresets"');
    expect(html).toContain('id="defaultAgentPresetsModal" hidden');
    expect(html).toContain('id="defaultAgentPresetsOpen"');
    expect(html).toContain('id="defaultAgentPresetsClose"');
    expect(html).toContain('id="defaultAgentSelectAll"');
    expect(html).toContain('class="default-agent-select-all"');
    expect(html).toContain('els.defaultAgentSelectAll.indeterminate = selectedPresetCount > 0');
    expect(html).toContain("qsa(els.defaultAgentPresets, '.default-agent-preset')");
    expect(html).toContain('class="default-agent-preset"');
    expect(html).toContain('class="card default-agent-option"');
    expect(html).toContain('.default-agent-option input[type="checkbox"]');
    expect(html).toContain('width: 16px; height: 16px; min-height: 0; margin: 2px 0 0; padding: 0;');
    expect(html).toContain('/api/workforce/default-agent/toggle');
    expect(html).toContain('Your edits will be preserved and restored');
    expect(html).toContain('/api/workforce/agent');
    expect(html).toContain('No pending agent requests.');
    expect(html).toContain('Open Task Window');
    expect(html).toContain('open-task-window');
    expect(html).toContain('data-session-id');
    expect(html).toContain('Focusing task terminal');
    expect(html).toContain('agent-bridge session start --agent ');
    expect(html).toContain(' --task ');
    expect(html).not.toContain("Task Control");
    expect(html).not.toContain("Pending Agent Requests");
    expect(html).not.toContain("Selected Task Controls");
    expect(html).not.toContain('id="taskPromptForm"');
    expect(html).not.toContain("request.payload");
    expect(html).toContain("Work-Git");
    expect(html).toContain("open-workgit");
    expect(html).toContain("data-lease-card");
    expect(html).toContain("data-task-id=\"' + escapeHtml(lease.taskId || '') + '\"");
    expect(html).toContain("Releasing lease...");
    expect(html).toContain("Release failed: ");
    expect(html).toContain("if (taskId && els.taskDetailModal && !els.taskDetailModal.hidden) openWorkGitDetail(taskId);");
    expect(html).toContain("sessionId: openTaskWindow.dataset.sessionId || undefined");
    expect(html).toContain("open-token");
    expect(html).toContain("read/write leases");
    expect(html).toContain("line changes");
    expect(html).toContain("git-diff");
    expect(html).toContain("Save Current Handoff");
    expect(html).toContain("Save Current &amp; Archive");
    expect(html).toContain("Created by");
    expect(html).not.toContain('name="to"');
    expect(html).toContain('id="handoffHistory"');
    expect(html).toContain(".handoff/CURRENT.md");
    expect(html).toContain("/api/handoff/save");
    expect(html).not.toContain("latestHandoffEditForm");
    expect(html).not.toContain("/api/handoff/update");
    expect(html).toContain("populateTaskSelects(state.tasks || [], current?.id)");
    expect(html).toContain("bindForm('compileForm', '/api/context/compile', { reset: false");
    expect(html).toContain("selectedLiveTaskId = data.pack.task.id");
    expect(html).toContain("contextEditTouched = true");
    expect(html).toContain("els.compiledEditor.value = data.pack.renderedMarkdown");
    expect(html).toContain("live-task-card.is-active");
    expect(html).not.toContain("Recent Memories");
    expect(html).toContain("Token Savings");
    expect(html).toContain('id="tokenSavings"');
    expect(html).not.toContain("Compiled brief tokens");
    expect(html).toContain("Repository Memory Inbox");
    expect(html).toContain('id="repoMemoryEditForm"');
    expect(html).toContain('class="modal-backdrop" id="repoMemoryEditModal" hidden');
    expect(html).toContain('aria-labelledby="repoMemoryEditTitle"');
    expect(html).toContain("els.repoMemoryEditModal.hidden = false");
    expect(html).toContain("if (event.target === els.repoMemoryEditModal) closeRepoMemoryEditor()");
    expect(html).toContain("edit-repo-memory");
    expect(html).toContain("delete-repo-memory");
    expect(html).toContain("/api/repo-memory/update");
    expect(html).toContain("/api/repo-memory/delete");
    expect(html).toContain("review-candidate");
    expect(html).toContain("data-request-id");
    expect(html).toContain("/api/session/focus");
    expect(html).not.toContain("select-request-task");
  });

  it("renders the Team Board (Orchestrator) view wired to the workforce API", () => {
    const html = renderDashboardPage();
    expect(html).toContain('data-view="orchestrator"');
    expect(html).toContain('id="view-orchestrator"');
    expect(html).toContain('id="orchestratorStartForm"');
    expect(html).toContain('id="orchestratorSubtaskForm"');
    // Both forms share one panel, switched by a tab strip; Start is the
    // default because Add Subtask only makes sense once one exists.
    expect(html).toContain('data-orch-tab="start"');
    expect(html).toContain('data-orch-tab="subtask"');
    expect(html).toContain('data-orch-panel="start"');
    expect(html).toContain('data-orch-panel="subtask" hidden');
    expect(html).toContain('class="tab-button active" data-orch-tab="start"');
    expect(html).toContain("function selectOrchestratorFormTab(name)");
    // The standalone Add Subtask panel is gone, not duplicated.
    expect(html).not.toContain("<h2>Add Subtask");
    expect(html.match(/id="orchestratorSubtaskForm"/g)).toHaveLength(1);
    expect(html).not.toContain('<label>Role <input name="role"');
    expect(html).not.toContain("role: form.role.value");
    // The removed Workforce feature must not leak back into orchestration.
    expect(html).not.toContain('name="workforceName"');
    expect(html).not.toContain("Workforce name");
    expect(html).toContain(".label-row { display: flex; align-items: center; gap: 6px; }");
    // Providers moved into the Agents tab as a bulk enable/disable of every
    // agent of one provider; the start form no longer carries an allowlist.
    expect(html).not.toContain('id="orchestratorTeamProviders"');
    expect(clientJs).not.toContain("function renderTeamProviders(installed)");
    expect(clientJs).toContain("function renderProviderToggles()");
    expect(clientJs).toContain("class=\"provider-toggle\"");
    expect(html).toContain('id="orchestratorRuns"');
    expect(html).toContain('id="orchestratorAdoptable"');
    // Picker + Remove: the board must be reachable even when the active task
    // has no orchestration, and removable without hand-editing the database.
    expect(html).toContain('id="orchestratorPicker"');
    expect(html).toContain('id="orchestratorRemoveButton"');
    // Without this button an orchestration parks in "reporting" forever —
    // Step deliberately no-ops there and the CLI was the only way out.
    expect(html).toContain('id="orchestratorReportButton"');
    expect(html).toContain("/api/workforce/orchestration/report");
    expect(html).toContain("Generate report");
    // Request changes reopens the SAME orchestration; without it a finished
    // project could only be revised by starting a second task.
    expect(html).toContain('id="orchestratorRequestChangesButton"');
    expect(html).toContain('id="orchestratorChangeForm"');
    expect(html).toContain("/api/workforce/orchestration/request-changes");
    // Auto-run is no longer its own button: Autonomy decides whether the server
    // steps (auto/approve-each) or the user does (manual), so the old toggle was
    // a second control for the same decision. What is left is a read-out, which
    // also makes a loop that stopped itself on an unanswered approval visible.
    expect(html).toContain("function renderAutoRunState(active)");
    expect(html).toContain("label.textContent = active ? 'auto-run: on' : 'auto-run: off';");
    expect(html).not.toContain('id="orchestratorAutoRunButton"');
    // Leader questions are answered inline; the answers become settled
    // requirements in the next plan turn.
    expect(html).toContain('id="orchestratorQuestions"');
    expect(html).toContain('id="orchestratorAnswerButton"');
    // Options become radio picks; free text is the fallback, not the default.
    expect(html).toContain("function questionOptions(question)");
    expect(html).toContain('data-option-for');
    expect(html).toContain("Something else…");
    expect(html).toContain('id="orchestratorDismissQuestionsButton"');
    expect(html).toContain("/api/workforce/orchestration/answer-questions");
    expect(html).toContain("renderLeaderQuestions(data.questions || [])");
    // Inbox requests can be resolved without deleting their audit history. An
    // orchestration request also resumes through resumeStatusFor, so an
    // adjudicate failure returns to adjudicating rather than planning.
    expect(html).toContain('class="ghost request-resolve"');
    expect(html).toContain("Resolve &amp; Resume");
    expect(html).toContain("'/api/orchestration/request/' + encodeURIComponent(requestResolve.dataset.requestId) + '/resolve'");
    expect(html).toContain("response: resume ? 'Resolved and resumed from dashboard.'");
    // Pause/Resume is one button whose direction follows the orchestration's
    // own status, and long agent text is clamped so it can't crowd out the UI.
    expect(html).toContain('id="orchestratorPauseToggle"');
    expect(html).not.toContain('id="orchestratorPauseButton"');
    expect(html).not.toContain('id="orchestratorResumeButton"');
    expect(html).toContain("renderPauseToggle(orchestration.status)");
    // Clamping is for the corner toast only — panels must show the full text.
    expect(html).toContain("function clampText(text, max)");
    expect(html).toContain("clampText(request.title || 'Task request', 140)");
    expect(html).not.toContain("clamped(");
    expect(html).toContain("escapeHtml(orchestration.lastError)");
    // The 3s poll must not rip a focused textarea out of the DOM.
    expect(html).toContain("if (list.dataset.signature === signature) return;");
    expect(html).toContain("if (list.contains(document.activeElement)) return;");
    // Options render as a connected chip group, not oversized stacked radios.
    expect(html).toContain('class="question-options"');
    expect(html).toContain('class="question-option"');
    expect(html).toContain(".question-option:has(input:checked)");
    // Autonomy is a live control on the running orchestration, not a field you
    // can only set at launch — and it is the only switch now.
    expect(html).toContain('id="orchestratorAutonomy"');
    expect(html).toContain("/api/workforce/orchestration/autonomy");
    // Providers are enabled/disabled per agent in the Agents tab now; the
    // per-orchestration Team providers allowlist is gone.
    expect(clientJs).not.toContain("/api/workforce/orchestration/team-providers");
    expect(html).toContain('id="workforceProviderToggles"');
    expect(clientJs).toContain("/api/workforce/agents/provider-enabled");
    expect(html).toContain('<option value="auto">Auto');
    expect(html).toContain('<option value="manual">Manual');
    // approve-each is a real mode: it gates every agent spawn.
    expect(html).toContain('<option value="approve-each">Approve each');
    expect(html).toContain('id="orchestratorApprovals"');
    expect(html).toContain("/api/workforce/orchestration/approve-spawn");
    expect(html).toContain("approve-spawn");
    expect(html).toContain("reject-spawn");
    // Approving is a three-way answer: yes, no, or "yes but this agent does it".
    expect(html).toContain("class=\"approve-agent\"");
    expect(html).toContain("picker.value !== picker.dataset.intended");
    // Rejecting one subtask assignment must not read as "stop the project":
    // the confirm says which of the two it is before anything is sent.
    expect(html).toContain("function rejectEffect(approval)");
    expect(html).toContain("button.dataset.rejectEffect === 'skip'");
    expect(html).toContain("renderSpawnApprovals(data.approvals || [], data.registeredAgents || [])");
    expect(html).toContain("renderAutoRunState(Boolean(data.autoRun))");
    expect(html).toContain("/api/task/delete");
    expect(html).toContain("/api/workforce/catalog");
    expect(html).toContain("/api/workforce/catalog?provider=");
    expect(html).toContain("refreshProviderCatalog(providerSelect.value)");
    expect(html).not.toContain("loadOrchestratorCatalog(true)");
    expect(html).not.toContain("60 * 60 * 1000");
    // The agent form's CLI model field is a picker filled from the catalog at
    // runtime, so the served HTML ships it empty — no baked-in model list.
    expect(html).toContain('<select name="model" id="workforceAgentModel"></select>');
    expect(html).toContain("setAgentModelValue(editedModel)");
    expect(html).not.toContain('<option value="gpt-5.6-sol">');
    expect(html).toContain("/api/workforce/board?task=");
    expect(html).toContain("/api/workforce/orchestration/start");
    expect(html).toContain("/api/workforce/orchestration/step");
    // One toggle builds the path from the current status, so the endpoint
    // names appear as the shared prefix plus the branch.
    expect(html).toContain("'/api/workforce/orchestration/' + path");
    expect(html).toContain("? 'resume' : 'pause'");
    expect(html).toContain("/api/workforce/orchestration/stop");
    expect(html).toContain("/api/workforce/subtask/add-and-spawn");
    expect(html).toContain("/api/workforce/run/stop");
    expect(html).toContain("/api/workforce/run/set-model");
    expect(html).toContain("/api/workforce/run/adopt");
    // Runs board is a 2x3 card grid with live log tails, paged by hover-only
    // arrows, running agents first.
    expect(html).toContain('id="orchestratorRunsShell"');
    expect(html).toContain('id="orchestratorRunsPrev"');
    expect(html).toContain('id="orchestratorRunsNext"');
    expect(html).toContain("grid-template-rows: repeat(2, minmax(0, 1fr))");
    expect(html).toContain("grid-auto-columns: calc((100% - 24px) / 3)");
    expect(html).toContain(".run-carousel-shell:hover .task-carousel-button:not(:disabled)");
    expect(html).toContain("run-card-log");
    expect(html).toContain("run-live-dot");
    expect(html).toContain("function sortRunsForBoard");
    expect(html).toContain("function sortNewestFirst(items)");
    expect(html).toContain("const subtasks = sortNewestFirst(data.subtasks || []);");
    expect(html).toContain("const reviews = sortNewestFirst(data.reviews || []);");
    expect(html).toContain("scrollRunsByPage");
    expect(html).toContain("run.logTail");
    // Runs board defaults to Active: a finished orchestration leaves dozens of
    // done runs and scrolling past them to find the live one is the complaint.
    expect(html).toContain('data-runs-filter="active"');
    expect(html).toContain('data-runs-filter="cycle"');
    expect(html).toContain('data-runs-filter="all"');
    expect(html).toContain("function filterRunsForBoard(runs)");
    // "cycle" and "all" are resolved server-side, so the board only asks for
    // every run when the All tab is selected.
    expect(html).toContain("(runsFilter === 'all' ? '&runs=all' : '')");
    expect(html).toContain("data.runsTotal");
    expect(html).toContain("let runsFilter = 'active';");
    expect(html).toContain("Finished — open Full log to read it.");
    expect(html).toContain("function syncRunCompletionToasts(runs, agentsById)");
    expect(html).toContain("Process exited successfully; subtask is awaiting review.");
    expect(html).toContain("subtask.statusReason");
    expect(html).toContain("<strong>Reason:</strong>");
    expect(html).toContain(".run-toast.is-success");
    expect(html).toContain(".run-toast.is-failure");
    expect(html).toContain("run-stop");
    expect(html).toContain("run-set-model");
    expect(html).toContain("session-adopt");
  });
});














describe("answeredQuestionRouting", () => {
  it("routes answers back to the phase that asked instead of always to planning", () => {
    // Observed live: answering "finish now, write the defects into the report"
    // during adjudication consumed every plan run and re-planned the project.
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-answer-routing-"));
    const store = openStore(root);
    try {
      const agent = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
      const task = store.createTask({ title: "Route the board", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: agent.id });
      const record = (phase: string) =>
        store.recordOrchestrationEvent({
          orchestrationId: orchestration.id,
          cycle: orchestration.cycle,
          phase,
          kind: "leader_turn",
          summary: `${phase} turn`,
        });

      record("plan");
      expect(answeredQuestionRouting(store, orchestration.id)).toMatchObject({
        phase: "plan",
        resumeStatus: "planning",
        stalePhase: "plan",
      });

      record("adjudicate");
      expect(answeredQuestionRouting(store, orchestration.id)).toMatchObject({
        phase: "adjudicate",
        resumeStatus: "adjudicating",
        stalePhase: "adjudicate",
      });

      // A reviewer's question has no leader turn to redo, so nothing is consumed.
      record("review");
      const routing = answeredQuestionRouting(store, orchestration.id);
      expect(routing).toMatchObject({ phase: "review", resumeStatus: "executing" });
      expect(routing.stalePhase).toBeUndefined();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
