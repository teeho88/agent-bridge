import { makeOrchestratorDeps } from "../workforce.js";
import { generateReport } from "../report.js";
import { stepOrchestration } from "@agent-bridge/core";
import { reapAgentRuns } from "@agent-bridge/adapters";
import { openStore } from "../../workspace.js";

// The orchestration auto-run loop: one timer per orchestration, stepping it
// until it halts. The timer map lives here so a route never reaches into
// command scope for it.

// Server-side equivalent of `agent-bridge workforce watch`: keeps calling
// stepOrchestration until the orchestration finishes, so the dashboard can
// drive a whole run without the user clicking Step for every single
// transition (or keeping a terminal open).
export const autoRunTimers = new Map<string, NodeJS.Timeout>();

export const AUTO_RUN_INTERVAL_MS = 5000;

export const AUTO_RUN_HALTED = new Set(["done", "failed", "paused"]);

// A run that is still going; the only kind whose log tail is worth re-sending.
export const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

export function isAutoRunning(orchestrationId: string): boolean {
  return autoRunTimers.has(orchestrationId);
}

export function stopAutoRun(orchestrationId: string): void {
  const timer = autoRunTimers.get(orchestrationId);
  if (!timer) return;
  clearTimeout(timer);
  autoRunTimers.delete(orchestrationId);
}

// Auto-run only ever lived in this process's timer map, so closing the tool
// mid-run left the orchestration frozen: the rows still said "executing", the
// UI still offered Step, but nothing advanced again until the user noticed and
// re-armed the toggle by hand. Autonomy is the durable record of who advances
// the run — anything but "manual" means the server does — so honour it at
// startup. An approve-each run resumes too: it steps up to its next gate and
// waits there, which is exactly where the user left it.
export function resumeAutoRuns(cwd: string): string[] {
  const store = openStore(cwd);
  try {
    const resumable = store
      .listOrchestrations({ limit: 100 })
      .filter((orchestration) => orchestration.autonomy !== "manual" && !AUTO_RUN_HALTED.has(orchestration.status));
    for (const orchestration of resumable) startAutoRun(cwd, orchestration.id);
    if (resumable.length) {
      console.log(`Resumed auto-run for ${resumable.length} orchestration(s) left running.`);
    }
    return resumable.map((orchestration) => orchestration.id);
  } finally {
    store.close();
  }
}

export function startAutoRun(cwd: string, orchestrationId: string): void {
  if (autoRunTimers.has(orchestrationId)) return;

  const tick = (): void => {
    const store = openStore(cwd);
    let keepGoing = false;
    try {
      const orchestration = store.getOrchestration(orchestrationId);
      if (orchestration && !AUTO_RUN_HALTED.has(orchestration.status)) {
        reapAgentRuns(store, { taskId: orchestration.taskId });
        if (orchestration.status === "reporting") {
          // stepOrchestration deliberately no-ops here, so a loop that only
          // stepped would spin forever one click short of the finish line.
          // Drive the reporter too: generateReport spawns it, then consumes
          // its output on a later tick and flips the orchestration to done.
          const report = generateReport(store, { taskId: orchestration.taskId, cwd });
          keepGoing = report.status !== "written";
        } else {
          const stepped = stepOrchestration(store, orchestrationId, makeOrchestratorDeps(store, cwd));
          keepGoing = !AUTO_RUN_HALTED.has(stepped.orchestration.status);
          // Waiting for an approve-each decision is a durable running state.
          // Do not silently disarm the server loop after an arbitrary idle
          // period: long agent runs and overnight reviews are normal, and once
          // the loop disappeared later review/adjudicate gates were never
          // reached unless the user noticed and stepped manually.
          void stepped.awaitingApprovalSince;
        }
      }
    } catch (error) {
      // A throwing step is a real fault, not a transient one — retrying it on
      // a timer would just spin. Stop and leave the reason on the board.
      keepGoing = false;
      try {
        store.updateOrchestration(orchestrationId, {
          lastError: `Auto-run stopped: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // the store is already in trouble; the loop still has to stop cleanly
      }
    } finally {
      store.close();
    }

    // A Stop/Remove between ticks deletes the entry; don't resurrect it.
    if (keepGoing && autoRunTimers.has(orchestrationId)) {
      autoRunTimers.set(orchestrationId, setTimeout(tick, AUTO_RUN_INTERVAL_MS).unref());
    } else {
      autoRunTimers.delete(orchestrationId);
    }
  };

  autoRunTimers.set(orchestrationId, setTimeout(tick, 0).unref());
}
