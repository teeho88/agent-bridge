import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderFallbackReport } from "@agent-bridge/core";
import { openStore, paths } from "../workspace.js";
import { buildReportContext, extractFinalAgentMessage, finalizeReport, generateReport, resolveReporterAgent } from "./report.js";

describe("report generate helpers", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("builds a context with subtasks, reviews, and the plan file's content", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Ship the thing", goal: "Ship the thing end to end", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      const subtask = store.createSubtask({ parentTaskId: task.id, title: "Implement it", acceptanceCriteria: ["tests pass"] });
      store.updateSubtask(subtask.id, { status: "done" });
      store.createReview({ taskId: task.id, subtaskId: subtask.id, verdict: "pass", score: 95, summary: "Looks solid." });

      const context = buildReportContext(store, task.id);
      expect(context.task.id).toBe(task.id);
      expect(context.orchestration?.id).toBe(orchestration.id);
      expect(context.subtasks).toHaveLength(1);
      expect(context.reviews).toHaveLength(1);
      expect(context.planMarkdown).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("writes the fallback report to .agent-memory/reports and marks the orchestration done", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    let reportPath: string | undefined;
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Finish the module", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const context = buildReportContext(store, task.id);
      const result = finalizeReport(store, task.id, context, renderFallbackReport(context), "fallback");

      expect(result.status).toBe("written");
      expect(result.source).toBe("fallback");
      reportPath = result.reportPath;
      const content = readFileSync(result.reportPath, "utf8");
      expect(content).toContain("Finish the module — Project Report");
      expect(store.getOrchestration(orchestration.id)?.status).toBe("done");
      expect(store.getOrchestration(orchestration.id)?.reportPath).toBe(result.reportPath);
      expect(store.listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 10 })).toContainEqual(
        expect.objectContaining({
          phase: "report",
          kind: "run_ended",
          summary: "Final project report written from the deterministic fallback.",
        }),
      );
    } finally {
      store.close();
      if (reportPath) rmSync(reportPath, { force: true });
    }
  });

  it("writes the report into the requested project, not the process's own cwd", () => {
    // The UI server runs from wherever it was launched but serves
    // --project <path>; without an explicit cwd the report (and the reporter
    // agent's run logs) land in the tool's own repo instead of the project.
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Scoped report", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const result = generateReport(store, { taskId: task.id, cwd, forceFallback: true });

      expect(result.status).toBe("written");
      if (result.status !== "written") return;
      expect(result.reportPath.startsWith(cwd)).toBe(true);
      expect(result.reportPath.startsWith(paths().memoryDir)).toBe(false);
      expect(readFileSync(result.reportPath, "utf8")).toContain("Scoped report");
      expect(store.getOrchestration(orchestration.id)?.status).toBe("done");
    } finally {
      store.close();
    }
  });

  it("consumes a detached reporter run instead of spawning another one", () => {
    // Reaped CLI runs land in "detached", not "done". Treating that as
    // unfinished made every Generate report click spawn a fresh reporter and
    // left the orchestration stuck in "reporting" forever.
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Detached reporter", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const logPath = join(cwd, "reporter.log");
      writeFileSync(logPath, "# Detached reporter — Project Report\n\nAll done.\n", "utf8");
      const run = store.createAgentRun({ taskId: task.id, orchestrationId: orchestration.id, agentId: leader.id, phase: "report", logPath });
      store.updateAgentRun(run.id, { status: "detached" });

      const result = generateReport(store, { taskId: task.id, cwd });

      expect(result.status).toBe("written");
      if (result.status !== "written") return;
      expect(result.source).toBe("reporter");
      expect(readFileSync(result.reportPath, "utf8")).toContain("All done.");
      expect(store.listAgentRuns({ taskId: task.id, limit: 20 }).filter((item) => item.phase === "report")).toHaveLength(1);
      expect(store.getOrchestration(orchestration.id)?.status).toBe("done");
    } finally {
      store.close();
    }
  });

  it("requires approval before spawning a reporter in approve-each mode", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const reporter = store.createRegisteredAgent({
        name: "reporter",
        provider: "codex",
        mode: "cli",
        command: "codex",
        capabilities: ["report"],
      });
      const task = store.createTask({ title: "Approval-gated report", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({
        taskId: task.id,
        leaderAgentId: reporter.id,
        autonomy: "approve-each",
      });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const first = generateReport(store, { taskId: task.id, cwd });
      const second = generateReport(store, { taskId: task.id, cwd });

      expect(first.status).toBe("pending");
      expect(second.status).toBe("pending");
      expect(store.listAgentRuns({ taskId: task.id, limit: 20 })).toHaveLength(0);
      const approvals = store.listAgentRequests({ taskId: task.id, status: "pending", limit: 20 });
      expect(approvals).toHaveLength(1);
      expect(JSON.parse(approvals[0]!.payload ?? "{}")).toMatchObject({
        type: "spawn-approval",
        key: "report:initial",
        orchestrationId: orchestration.id,
        agentId: reporter.id,
      });
      const reportEvents = store
        .listOrchestrationEvents({ orchestrationId: orchestration.id, limit: 20 })
        .filter((event) => event.phase === "report");
      expect(reportEvents).toHaveLength(1);
      expect(reportEvents[0]).toMatchObject({
        kind: "user_action",
        summary: 'Approval requested: spawn reporter "reporter" for the final project report.',
      });
    } finally {
      store.close();
    }
  });

  it("ignores a reporter run from before a change request reopened the orchestration", () => {
    // Request changes reopens the SAME orchestration, so the previous round's
    // reporter run is still on the task. Reusing it republishes a report that
    // predates the change the user just asked for.
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      // "manual" mode keeps this test from launching a real CLI: generateReport
      // falls back to the deterministic report instead of spawning a process.
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
      const task = store.createTask({ title: "Reopened project", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      const staleLog = join(cwd, "stale-report.log");
      writeFileSync(staleLog, "# Stale report\n\nFrom the previous round.\n", "utf8");
      const staleRun = store.createAgentRun({ taskId: task.id, orchestrationId: orchestration.id, agentId: leader.id, phase: "report", logPath: staleLog });
      store.updateAgentRun(staleRun.id, { status: "done" });

      store.recordOrchestrationEvent({
        orchestrationId: orchestration.id,
        cycle: 1,
        phase: "plan",
        kind: "user_action",
        summary: "change-request: add sound",
        payload: JSON.stringify({ type: "change-request", request: "Add sound." }),
      });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const result = generateReport(store, { taskId: task.id, cwd });

      // The stale run was skipped entirely: had it been reused, the result
      // would be source "reporter" carrying "From the previous round."
      expect(result.status).toBe("written");
      if (result.status !== "written") return;
      expect(result.source).toBe("fallback");
      const content = readFileSync(result.reportPath, "utf8");
      expect(content).not.toContain("From the previous round.");
      expect(content).toContain("Reopened project");
    } finally {
      store.close();
    }
  });

  it("keeps only the reporter's final message, not the echoed prompt and banner", () => {
    const log = [
      "OpenAI Codex v0.145.0",
      "--------",
      "workdir: D:\\project",
      "--------",
      "user",
      "# Reporter Turn",
      "Reply with ONLY the markdown report.",
      "tokens used",
      "35,010",
      "codex",
      "# Report",
      "draft body",
      "tokens used",
      "20,335",
      "# Report",
      "final body",
    ].join("\n");

    const message = extractFinalAgentMessage(log);
    expect(message).toBe("# Report\nfinal body");
    expect(message).not.toContain("Reporter Turn");
    expect(message).not.toContain("OpenAI Codex");
  });

  it("falls back to the whole log when there is no tokens-used footer", () => {
    expect(extractFinalAgentMessage("  # Just a report\n\nbody\n")).toBe("# Just a report\n\nbody");
  });

  it("reads the plan file's content into the context when the orchestration has one", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    const planPath = join(paths().memoryDir, "plans-test.md");
    try {
      writeFileSync(planPath, "# Plan\n\nDo the thing.", "utf8");
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "cli", command: "codex" });
      const task = store.createTask({ title: "Task with plan", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { planPath });

      const context = buildReportContext(store, task.id);
      expect(context.planMarkdown).toContain("Do the thing.");
    } finally {
      store.close();
      rmSync(planPath, { force: true });
    }
  });

  it("selects reporters by report capability", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
      const reporter = store.createRegisteredAgent({
        name: "codex-reporter",
        provider: "codex",
        mode: "manual",
        capabilities: ["report"],
      });
      const task = store.createTask({ title: "Scoped reporter", ownerAgent: "codex" });
      store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });

      expect(resolveReporterAgent(store, task.id, undefined)?.id).toBe(reporter.id);
      expect(() => resolveReporterAgent(store, task.id, leader.id)).toThrow(/does not have capability `report`/);
    } finally {
      store.close();
    }
  });

  it("uses a deterministic report instead of an unqualified leader", () => {
    cwd = mkdtempSync(join(tmpdir(), "agent-bridge-report-"));
    const store = openStore(cwd);
    try {
      const leader = store.createRegisteredAgent({ name: "leader", provider: "codex", mode: "manual" });
      const task = store.createTask({ title: "No reporter capability", ownerAgent: "codex" });
      const orchestration = store.createOrchestration({ taskId: task.id, leaderAgentId: leader.id });
      store.updateOrchestration(orchestration.id, { status: "reporting" });

      const result = generateReport(store, { taskId: task.id, cwd });
      expect(result.status).toBe("written");
      if (result.status !== "written") return;
      expect(result.source).toBe("fallback");
      expect(result.note).toContain("capability `report`");
      expect(store.listAgentRuns({ taskId: task.id, limit: 20 }).filter((run) => run.phase === "report")).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
