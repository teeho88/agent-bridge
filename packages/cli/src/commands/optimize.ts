import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { compressLog, loadOptionalTokenizer } from "@agent-bridge/core";
import { openStore, parseList, paths, readConfig, resolveCurrentTaskId } from "../workspace.js";
import { computeBaseline, formatBaselineRunSummary, parseBaselineRun } from "../optimize-baseline.js";

const fmt = (value: number): string => value.toLocaleString("en-US");

export function registerOptimize(program: Command): void {
  const optimize = program.command("optimize").description("Token saving utilities");

  optimize
    .command("report")
    .description("Show recorded compiled-context token usage over time")
    .option("--task <taskId>", "filter by task id")
    .option("--all", "report across all tasks")
    .option("--baseline", "report recorded `optimize baseline` savings instead of compiled-context size")
    .option("--limit <limit>", "number of runs to inspect", "50")
    .action((options: { task?: string; all?: boolean; baseline?: boolean; limit: string }) => {
      const store = openStore();
      try {
        const taskId = options.all ? undefined : options.task ?? resolveCurrentTaskId() ?? undefined;
        const runs = store.listRuns({ taskId, limit: Number(options.limit) });

        if (options.baseline) {
          const points = runs.map(parseBaselineRun).filter((point): point is NonNullable<typeof point> => point !== null);
          if (!points.length) {
            console.log("No recorded baseline runs yet. Run `optimize baseline --record` first.");
            return;
          }
          const pcts = points.map((point) => point.savedPct);
          const avg = pcts.reduce((total, value) => total + value, 0) / pcts.length;
          console.log(`Baseline runs: ${points.length}`);
          console.log(`Latest saved: ${points[0].savedPct}% (${fmt(points[0].savedTokens)} tokens, ${points[0].fileCount} files)`);
          console.log(`Average saved: ${Math.round(avg * 10) / 10}%`);
          console.log(`Min / Max saved: ${Math.min(...pcts)}% / ${Math.max(...pcts)}%`);
          for (const point of points.slice(0, 10)) {
            console.log(`- ${point.createdAt} [${point.agent ?? "?"}] ${point.savedPct}% (${fmt(point.savedTokens)} tokens)`);
          }
          return;
        }

        // Compiled-context trend: exclude baseline runs so the two signals do not mix.
        const compiled = runs.filter(
          (run) => run.command !== "optimize baseline" && typeof run.tokenEstimate === "number"
        );
        if (!compiled.length) {
          console.log("No recorded runs with token estimates yet. Run `context compile` first.");
          return;
        }
        const tokens = compiled.map((run) => run.tokenEstimate as number);
        const sum = tokens.reduce((total, value) => total + value, 0);
        console.log(`Runs: ${compiled.length}`);
        console.log(`Latest: ${tokens[0]} tokens`);
        console.log(`Average: ${Math.round(sum / tokens.length)} tokens`);
        console.log(`Min / Max: ${Math.min(...tokens)} / ${Math.max(...tokens)} tokens`);
        for (const run of compiled.slice(0, 10)) {
          console.log(`- ${run.createdAt} [${run.agent ?? "?"}] ${run.tokenEstimate} tokens`);
        }
      } finally {
        store.close();
      }
    });

  optimize
    .command("baseline")
    .description(
      "Measure real token savings: reading the repo-map files' raw source vs. the compact repo map index that lets an agent navigate without reading them"
    )
    .option("--limit <n>", "max files to compare (default: config graph.repoMapLimit or 40)")
    .option("--focus <paths>", "comma-separated path substrings to focus on")
    .option("--root <path>", "repo root to read files from (default: cwd)")
    .option("--precise", "count tokens with a real tokenizer if AGENT_BRIDGE_TOKENIZER_MODULE is set")
    .option("--top <n>", "how many most-expensive files to list", "10")
    .option("--json", "print machine-readable JSON")
    .option("--record", "record the comparison as a run for `optimize report`")
    .action(
      async (options: {
        limit?: string;
        focus?: string;
        root?: string;
        precise?: boolean;
        top: string;
        json?: boolean;
        record?: boolean;
      }) => {
        const root = options.root ?? paths().cwd;
        const store = openStore();
        try {
          if (store.getGraphStats().files === 0) {
            console.log("No graph yet. Run `agent-bridge graph build` first.");
            return;
          }

          const config = readConfig();
          const limit = Number(options.limit ?? config.graph?.repoMapLimit ?? 40);
          const focusPaths = options.focus ? parseList(options.focus) : undefined;
          const count = options.precise ? (await loadOptionalTokenizer()) ?? undefined : undefined;

          const result = computeBaseline(store, root, { limit, focusPaths, count, topN: Number(options.top) });
          if (!result) {
            console.log("Repo map is empty for that focus. Nothing to compare.");
            return;
          }
          const { summary, topFiles, skipped, precise } = result;

          if (options.record) {
            store.addRun({
              taskId: resolveCurrentTaskId() ?? undefined,
              agent: config.defaultAgent,
              command: "optimize baseline",
              resultSummary: formatBaselineRunSummary(summary),
              tokenEstimate: summary.optimizedTokens
            });
          }

          if (options.json) {
            console.log(JSON.stringify({ ...summary, precise, skipped, topFiles, limit, focus: focusPaths }, null, 2));
            return;
          }

          console.log("Token savings baseline (repo understanding)");
          console.log("Model: an agent reading these files in full vs. the repo map index that replaces that reading.");
          console.log(
            `Files compared: ${summary.fileCount}${skipped.length ? ` (skipped ${skipped.length}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""})` : ""}`
          );
          console.log(`Tokenizer: ${precise ? "precise" : "heuristic"}`);
          console.log("");
          console.log(`Baseline    (read raw source):  ${fmt(summary.baselineTokens)} tokens`);
          console.log(`agent-bridge (repo map index):  ${fmt(summary.optimizedTokens)} tokens`);
          console.log(`Saved:                          ${fmt(summary.savedTokens)} tokens (${summary.savedPct}%)`);
          if (topFiles.length) {
            console.log("");
            console.log("Most expensive files if read raw:");
            for (const file of topFiles) console.log(`  ${fmt(file.tokens).padStart(8)}  ${file.path}`);
          }
        } finally {
          store.close();
        }
      }
    );

  optimize
    .command("logs")
    .argument("<file>", "log file")
    .option("--max-lines <lines>", "max output lines", "80")
    .option("--max-chars <chars>", "max output chars", "8000")
    .option("--keep-errors", "keep error lines", true)
    .option("--output <file>", "write compressed output")
    .action((file: string, options: { maxLines: string; maxChars: string; keepErrors: boolean; output?: string }) => {
      const compressed = compressLog(readFileSync(file, "utf8"), {
        maxLines: Number(options.maxLines),
        maxChars: Number(options.maxChars),
        keepErrors: options.keepErrors
      });
      if (options.output) {
        writeFileSync(options.output, `${compressed}\n`, "utf8");
        console.log(`Wrote compressed log: ${options.output}`);
      } else {
        console.log(compressed);
      }
    });
}
