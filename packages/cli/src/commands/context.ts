import { mkdirSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { antigravityArtifact, claudeManagedSection, codexManagedSection, patchManagedSection } from "@agent-bridge/adapters";
import { compileContext, loadOptionalTokenizer } from "@agent-bridge/core";
import { writeAntigravityRules } from "./antigravity.js";
import { renderRepoMap, type AgentKind } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
  paths,
  policyBudgets,
  readConfig,
  readStdinUtf8,
  resolveTokenBudget,
  syncCurrentTaskArtifact
} from "../workspace.js";

export function registerContext(program: Command): void {
  const context = program.command("context").description("Compile agent context");

  context
    .command("compile")
    .option("--agent <agent>", "target agent")
    .option("--budget <budget>", "token budget")
    .option("--task <taskId>", "task id")
    .option("--assignment <assignmentId>", "assignment id to inject into the compiled context")
    .option("--output <path>", "output markdown path")
    .option("--precise", "also report an exact token count via a real tokenizer (if configured)")
    .option("--no-repo-map", "do not inject the knowledge-graph repo map")
    .option("--repo-map-limit <n>", "max files in the injected repo map", "30")
    .action(
      async (options: {
        agent?: AgentKind;
        budget?: string;
        task?: string;
        assignment?: string;
        output?: string;
        precise?: boolean;
        repoMap?: boolean;
        repoMapLimit?: string;
      }) => {
      const config = readConfig();
      const agent = options.agent ?? config.defaultAgent;
      const budget = resolveTokenBudget(
        process.cwd(),
        options.budget === undefined ? undefined : Number(options.budget),
      );
      const store = openStore();
      try {
        const taskId = getActiveTaskId(store, undefined, options.task, agent);
        syncCurrentTaskArtifact(store, taskId);
        // Inject the repo map when the graph has been built (and neither the
        // --no-repo-map flag nor config disables it), so the agent gets a
        // token-frugal repo overview without reading files.
        let repoMap: string | undefined;
        const injectEnabled = options.repoMap !== false && config.graph?.injectRepoMap !== false;
        if (injectEnabled && store.getGraphStats().files > 0) {
          const limit = Number(options.repoMapLimit ?? config.graph?.repoMapLimit ?? 30);
          const handoff = store.getLatestHandoff(taskId);
          const task = store.getTask(taskId);
          repoMap = renderRepoMap(
            store.buildRepoMap({
              limit,
              recentTaskFiles: handoff?.filesChanged,
              task: task ? { id: task.id, title: task.title, goal: task.goal } : undefined
            })
          );
        }
        const pack = compileContext(store, { taskId, agent, tokenBudget: budget, repoMap, assignmentId: options.assignment, ...policyBudgets() });
        const output = options.output ?? paths().compiledContext;
        writeFileSync(output, `${pack.renderedMarkdown}\n`, "utf8");

        let reportedTokens = pack.tokenEstimate;
        if (options.precise) {
          const counter = await loadOptionalTokenizer();
          if (counter) reportedTokens = counter(pack.renderedMarkdown);
        }

        if (agent === "codex") patchManagedSection("AGENTS.md", codexManagedSection());
        if (agent === "claude") patchManagedSection("CLAUDE.md", claudeManagedSection());
        if (agent === "antigravity") {
          writeAntigravityRules(process.cwd());
          const p = paths();
          mkdirSync(p.artifacts, { recursive: true });
          writeFileSync(
            `${p.artifacts}/antigravity-artifact.json`,
            `${JSON.stringify(antigravityArtifact(pack), null, 2)}\n`,
            "utf8"
          );
        }

        // Record the real compiled-token cost so `optimize report` can show a
        // trend over time instead of a one-off self-referential estimate.
        store.addRun({
          taskId,
          agent,
          command: "context compile",
          resultSummary: `Compiled for ${agent}`,
          tokenEstimate: reportedTokens
        });

        console.log(`Compiled context for ${agent}: ${output}`);
        if (options.precise && reportedTokens !== pack.tokenEstimate) {
          console.log(`Precise tokens: ${reportedTokens} (heuristic: ${pack.tokenEstimate})`);
        } else {
          if (options.precise) {
            console.log("Precise tokenizer not configured (set AGENT_BRIDGE_TOKENIZER_MODULE); showing heuristic.");
          }
          console.log(`Estimated tokens: ${pack.tokenEstimate}`);
        }
      } finally {
        store.close();
      }
    });

  context
    .command("edit")
    .argument("[content]", "compiled context markdown (omit when using --stdin)")
    .option("--stdin", "read compiled context from stdin as raw UTF-8")
    .option("--output <path>", "output markdown path")
    .action(async (content: string | undefined, options: { stdin?: boolean; output?: string }) => {
      const text = options.stdin ? await readStdinUtf8() : content;
      if (!text) throw new Error("No context content. Provide <content> or pipe text with --stdin.");
      const output = options.output ?? paths().compiledContext;
      writeFileSync(output, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      console.log(`Saved compiled context: ${output}`);
    });
}

