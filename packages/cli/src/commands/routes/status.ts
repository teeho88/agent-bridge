import { defaultTokenStackModules } from "@agent-bridge/core";
import { openStore } from "../../workspace.js";
import { parseBaselineRun } from "../../optimize-baseline.js";
import { commandExists } from "./terminal.js";

// Environment probes shown on the dashboard: which optional CLIs are present
// and what the token stack currently reports.

export const installableTools = new Map([
  ["repomix", "repomix"],
  ["ccusage", "ccusage"],
]);

export function optionalToolsStatus(): Array<{
  name: string;
  purpose: string;
  usage: string;
  installed: boolean;
  installable: boolean;
  command?: string;
}> {
  return [
    {
      name: "repomix",
      purpose: "Pack repository context for agents",
      usage:
        "Run repomix in a project to create compact repository context for Claude/Codex.",
      installed: commandExists("repomix"),
      installable: true,
      command: "repomix --help",
    },
    {
      name: "ccusage",
      purpose: "Inspect Claude Code token/cost usage",
      usage: "Run ccusage to inspect Claude Code token and cost history.",
      installed: commandExists("ccusage"),
      installable: true,
      command: "ccusage --help",
    },
  ];
}

export function tokenStackStatus(): Array<{
  id: string;
  label: string;
  purpose: string;
  usage: string;
  enabled: boolean;
  installed?: boolean;
  installable: boolean;
  installName?: string;
}> {
  const installedByName = new Map(
    optionalToolsStatus().map((tool) => [tool.name, tool.installed]),
  );
  return defaultTokenStackModules().map((module) => ({
    ...module,
    installed:
      module.id === "repomix" || module.id === "ccusage"
        ? (installedByName.get(module.id) ?? false)
        : true,
    installable: module.id === "repomix" || module.id === "ccusage",
    installName:
      module.id === "repomix" || module.id === "ccusage"
        ? module.id
        : undefined,
  }));
}

// Cheap, DB-only optimize stats for the live dashboard: the compiled-context size
// trend and the recorded `optimize baseline` savings trend. No file IO here — the
// live baseline measurement is run on demand via POST /api/optimize/baseline.
export function optimizeStats(store: ReturnType<typeof openStore>): {
  compiled: {
    count: number;
    latest: number;
    average: number;
    min: number;
    max: number;
  } | null;
  baseline: {
    count: number;
    latest: ReturnType<typeof parseBaselineRun>;
    averagePct: number;
    history: NonNullable<ReturnType<typeof parseBaselineRun>>[];
  } | null;
} {
  const runs = store.listRuns({ limit: 100 });
  const compiledTokens = runs
    .filter(
      (run) =>
        run.command !== "optimize baseline" &&
        typeof run.tokenEstimate === "number",
    )
    .map((run) => run.tokenEstimate as number);
  const compiled = compiledTokens.length
    ? {
        count: compiledTokens.length,
        latest: compiledTokens[0],
        average: Math.round(
          compiledTokens.reduce((total, value) => total + value, 0) /
            compiledTokens.length,
        ),
        min: Math.min(...compiledTokens),
        max: Math.max(...compiledTokens),
      }
    : null;

  const points = runs
    .map(parseBaselineRun)
    .filter((point): point is NonNullable<typeof point> => point !== null);
  const baseline = points.length
    ? {
        count: points.length,
        latest: points[0],
        averagePct:
          Math.round(
            (points.reduce((total, point) => total + point.savedPct, 0) /
              points.length) *
              10,
          ) / 10,
        history: points.slice(0, 10),
      }
    : null;

  return { compiled, baseline };
}
