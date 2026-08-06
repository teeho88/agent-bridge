import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopAgentRun } from "@agent-bridge/adapters";
import { openStore, paths } from "../workspace.js";
import { listAdoptableSessions, respawnRun } from "./run.js";

describe("respawnRun", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "agent-bridge-run-cli-"));
    const cwd = mkdtempSync(join(tmpdir(), "agent-bridge-run-cwd-"));
    const store = openStore(cwd);
    return { store, cwd };
  }

  it("stops the old run, writes a resume artifact, and spawns a new run with restartedFromRunId set", async () => {
    const { store, cwd } = setup();
    try {
      const agent = store.createRegisteredAgent({
        name: "codex-implementer",
        provider: "codex",
        mode: "cli",
        command: process.execPath,
        model: "gpt-5.4",
      });
      const task = store.createTask({ title: "Ship feature", ownerAgent: "codex" });
      const subtask = store.createSubtask({
        parentTaskId: task.id,
        title: "Implement the thing",
        acceptanceCriteria: ["Tests pass"],
      });
      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const assignment = store.createAssignment({
        taskId: task.id,
        subtaskId: subtask.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Implement the thing end to end.",
        status: "running",
      });
      const oldRun = store.createAgentRun({
        taskId: task.id,
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        model: "gpt-5.4",
        phase: "implement",
      });
      // No real pid: this test only exercises respawnRun's own bookkeeping
      // (stop/resume-artifact/spawn), not process termination — a real pid
      // here would make stopAgentRun try to kill an actual OS process.
      store.updateAgentRun(oldRun.id, { status: "running" });

      const { oldRun: stopped, newRun } = await respawnRun(store, oldRun.id, {
        model: "gpt-5.6",
        reasoningEffort: "high",
      });

      expect(stopped.status).toBe("stopped");
      expect(newRun.restartedFromRunId).toBe(oldRun.id);
      expect(newRun.model).toBe("gpt-5.6");
      expect(newRun.reasoningEffort).toBe("high");
      expect(newRun.assignmentId).toBe(assignment.id);
      expect(newRun.subtaskId).toBe(subtask.id);

      // respawnRun resolves artifact paths via paths() (process.cwd()), the
      // same convention dispatch.ts already uses — not the tmp workspace cwd
      // the store was opened against — so read/clean up from there too.
      const resumePath = join(paths().artifacts, "runs", `${oldRun.id}-resume.md`);
      try {
        const resumeContent = readFileSync(resumePath, "utf8");
        expect(resumeContent).toContain("Implement the thing end to end.");
        expect(resumeContent).toContain("Tests pass");
        expect(resumeContent).toContain("Continue this assignment");
      } finally {
        rmSync(resumePath, { force: true });
        if (newRun.logPath) rmSync(newRun.logPath, { force: true });
      }

      expect(store.listAssignments({ taskId: task.id }).find((candidate) => candidate.id === assignment.id)?.status).toBe(
        "running",
      );

      // The freshly spawned process (an invalid CLI invocation in this test)
      // will fail almost immediately; stop it defensively so it can't linger.
      await stopAgentRun(store, newRun.id);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("clones the agent into a new variant when the current agent is still in use elsewhere", async () => {
    const { store, cwd } = setup();
    try {
      const agent = store.createRegisteredAgent({
        name: "shared-codex",
        provider: "codex",
        mode: "cli",
        command: process.execPath,
        model: "gpt-5.4",
      });
      const task = store.createTask({ title: "Shared agent task", ownerAgent: "codex" });
      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const assignment = store.createAssignment({
        taskId: task.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Do work.",
      });
      const targetRun = store.createAgentRun({ taskId: task.id, assignmentId: assignment.id, agentId: agent.id });
      // No real pid on either run: only status/bookkeeping is under test here.
      store.updateAgentRun(targetRun.id, { status: "running" });

      // A second, unrelated run still actively using the same agent.
      const otherAssignment = store.createAssignment({
        taskId: task.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Other work.",
      });
      const otherRun = store.createAgentRun({ taskId: task.id, assignmentId: otherAssignment.id, agentId: agent.id });
      store.updateAgentRun(otherRun.id, { status: "running" });

      const { newRun } = await respawnRun(store, targetRun.id, { model: "gpt-5.6" });

      expect(newRun.agentId).not.toBe(agent.id);
      const variant = store.getRegisteredAgent(newRun.agentId);
      expect(variant?.model).toBe("gpt-5.6");
      expect(store.getRegisteredAgent(agent.id)?.model).toBe("gpt-5.4");

      await stopAgentRun(store, newRun.id);
      rmSync(join(paths().artifacts, "runs", `${targetRun.id}-resume.md`), { force: true });
      if (newRun.logPath) rmSync(newRun.logPath, { force: true });
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when the run has no assignment to resume", async () => {
    const { store, cwd } = setup();
    try {
      const agent = store.createRegisteredAgent({ name: "codex", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "No assignment task", ownerAgent: "codex" });
      const run = store.createAgentRun({ taskId: task.id, agentId: agent.id });

      await expect(respawnRun(store, run.id, { model: "gpt-5.6" })).rejects.toThrow("no assignment");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("listAdoptableSessions", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces an active session not yet part of any team, and hides it once adopted", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-bridge-adopt-"));
    const store = openStore(dir);
    try {
      const task = store.createTask({ title: "External task", ownerAgent: "claude" });
      store.recordSessionEvent({
        sessionId: "external-session-1",
        taskId: task.id,
        agent: "claude",
        kind: "session_started",
      });
      store.recordSessionEvent({
        sessionId: "external-session-1",
        taskId: task.id,
        agent: "claude",
        kind: "assistant_summary",
        summary: "Refactoring the parser",
      });

      const adoptable = listAdoptableSessions(store);
      expect(adoptable.map((event) => event.sessionId)).toContain("external-session-1");

      const agent = store.createRegisteredAgent({
        name: "adopted-external",
        provider: "claude",
        mode: "manual",
        capabilities: ["adopted"],
      });
      const roles = store.ensureDefaultWorkforceRoles();
      const implementerRole = roles.find((role) => role.name === "implementer")!;
      const subtask = store.createSubtask({ parentTaskId: task.id, title: "External work: refactor parser" });
      const assignment = store.createAssignment({
        taskId: task.id,
        subtaskId: subtask.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        prompt: "Adopted session.",
      });
      const run = store.createAgentRun({
        taskId: task.id,
        subtaskId: subtask.id,
        assignmentId: assignment.id,
        agentId: agent.id,
        roleId: implementerRole.id,
        origin: "adopted",
        sessionId: "external-session-1",
        status: "detached",
      });

      expect(listAdoptableSessions(store).map((event) => event.sessionId)).not.toContain("external-session-1");

      const released = store.updateAgentRun(run.id, { status: "stopped", endedAt: new Date().toISOString() });
      expect(released?.status).toBe("stopped");
      expect(released?.origin).toBe("adopted");
    } finally {
      store.close();
    }
  });

  it("does not surface a session whose latest event indicates it already ended", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-bridge-adopt-"));
    const store = openStore(dir);
    try {
      const task = store.createTask({ title: "Finished external task", ownerAgent: "codex" });
      store.recordSessionEvent({ sessionId: "external-session-2", taskId: task.id, agent: "codex", kind: "session_started" });
      store.recordSessionEvent({ sessionId: "external-session-2", taskId: task.id, agent: "codex", kind: "session_ended" });

      expect(listAdoptableSessions(store).map((event) => event.sessionId)).not.toContain("external-session-2");
    } finally {
      store.close();
    }
  });
});
