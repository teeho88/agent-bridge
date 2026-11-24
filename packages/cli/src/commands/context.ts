import { acknowledgeContext, locateContext, publishContextAsync, synchronizeContext } from "../context-runtime.js";
import { randomUUID } from "node:crypto";
import { runtimeCapabilities } from "../runtime-capabilities.js";
import { expandContext, queryContext, readContextHandoff, searchContextTasks } from "../context-retrieval.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { antigravityArtifact, claudeManagedSection, codexGoalContractSection, codexManagedSection, patchManagedSection } from "@agent-bridge/adapters";
import { loadOptionalTokenizer } from "@agent-bridge/core";
import { writeAntigravityRules } from "./antigravity.js";
import { type AgentKind } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
  paths,
  readConfig,
  readStdinUtf8,
  resolveTokenBudget,
} from "../workspace.js";

export function registerContext(program: Command): void {
  const context = program.command("context").description("Compile agent context");
  context.command("capabilities").action(() => console.log(JSON.stringify(runtimeCapabilities)));
  context.command("goal-guide").description("Goal contract for an explicit user goal request")
    .action(() => console.log(codexGoalContractSection()));

  context.command("find").description("Find matching tasks in this repository, including completed tasks")
    .argument("<query>").option("--limit <limit>")
    .action((query: string, options: { limit?: string }) => {
      if (readConfig().contextEfficiency?.query === false) throw new Error("Context retrieval is disabled");
      const store = openStore();
      try { console.log(JSON.stringify(searchContextTasks(store, process.cwd(), query, options.limit === undefined ? undefined : Number(options.limit)))); }
      finally { store.close(); }
    });

  context.command("handoff").description("Show a short handoff for one task")
    .requiredOption("--task <taskId>")
    .action((options: { task: string }) => {
      if (readConfig().contextEfficiency?.query === false) throw new Error("Context retrieval is disabled");
      const store = openStore();
      try { console.log(JSON.stringify(readContextHandoff(store, process.cwd(), options.task))); }
      finally { store.close(); }
    });

  context.command("startup").description("Show a revision-bound task and handoff brief in one call")
    .option("--agent <agent>").option("--session <sessionId>").option("--task <taskId>")
    .option("--refresh", "rebuild context even when the hook already published it")
    .action(async (options: { agent?: AgentKind; session?: string; task?: string; refresh?: boolean }) => {
      const config = readConfig();
      const agent = options.agent ?? config.defaultAgent;
      const terminalSession = process.env.AGENT_BRIDGE_TERMINAL_SESSION_ID?.trim();
      const activeSessions = Object.entries(config.activeSessions ?? {})
        .filter(([, provider]) => provider === agent).map(([id]) => id);
      if (!options.session && !terminalSession && activeSessions.length > 1)
        throw new Error("Ambiguous startup context session. Pass --session <sessionId>.");
      const sessionId = options.session ?? terminalSession ??
        (activeSessions.length === 1 ? activeSessions[0] : config.currentSessions?.[agent]);
      const boundTask = sessionId ? config.sessionTasks?.[sessionId] : undefined;
      if (options.session && !boundTask) throw new Error("Unknown startup session");
      if (options.task && boundTask && options.task !== boundTask) throw new Error("Session/task mismatch");
      const store = openStore();
      try {
        const taskId = boundTask ?? getActiveTaskId(store, undefined, options.task, agent);
        let manifest: ReturnType<typeof locateContext> | undefined;
        let compiledPath: string | undefined;
        if (boundTask && !options.refresh) {
          try { manifest = locateContext(process.cwd(), agent, sessionId); }
          catch (error) {
            if (!(error instanceof Error) || !/Missing context publication|Context sources (changed|revision missing)/.test(error.message)) throw error;
          }
        }
        if (!manifest) {
          const pack = await publishContextAsync(store, process.cwd(), taskId, agent, { sessionId: boundTask ? sessionId : undefined });
          compiledPath = pack.contextPath;
          if (boundTask) manifest = locateContext(process.cwd(), agent, sessionId);
        }
        const contextPath = manifest?.contextPath ?? compiledPath!;
        const markdown = readFileSync(contextPath, "utf8");
        const handoff = store.getLatestHandoff(taskId);
        console.log([`Task: ${taskId}`, `Session: ${boundTask ? sessionId : "none"}`,
          `Revision: ${manifest?.revision ?? "task-scoped"}`,
          `Context: ${contextPath}`, `Handoff: ${handoff ? ".handoff/CURRENT.md" : "none"}`,
          "", markdown.trimEnd()].join("\n"));
      } finally { store.close(); }
    });

  context.command("ack").requiredOption("--session <sessionId>").requiredOption("--revision <revision>")
    .requiredOption("--epoch <epoch>").option("--agent <agent>")
    .action((options: { session: string; revision: string; epoch: string; agent?: AgentKind }) => {
      acknowledgeContext(process.cwd(), options.agent ?? readConfig().defaultAgent, options.session, options.revision, options.epoch);
      console.log(JSON.stringify({ acknowledged: options.revision, applied: "unknown" }));
    });
  context.command("sync").requiredOption("--session <sessionId>").option("--agent <agent>")
    .option("--context-retained", "runtime attests the acknowledged context is still retained")
    .action((options: { session: string; agent?: AgentKind; contextRetained?: boolean }) => {
      console.log(JSON.stringify(synchronizeContext(process.cwd(), options.agent ?? readConfig().defaultAgent, options.session, { contextRetained: options.contextRetained })));
    });
  context.command("reset").requiredOption("--session <sessionId>").option("--agent <agent>")
    .action(async (options: { session: string; agent?: AgentKind }) => {
      const agent = options.agent ?? readConfig().defaultAgent;
      const taskId = readConfig().sessionTasks?.[options.session];
      if (!taskId) throw new Error("Unknown context session");
      const store = openStore();
      try { await publishContextAsync(store, process.cwd(), taskId, agent, { sessionId: options.session, epoch: randomUUID(), bootstrap: true }); }
      finally { store.close(); }
      console.log(JSON.stringify(synchronizeContext(process.cwd(), agent, options.session)));
    });

  context.command("bootstrap").option("--agent <agent>").option("--session <sessionId>")
    .option("--task <taskId>").option("--budget <budget>").option("--epoch <epoch>")
    .option("--request <request>")
    .action(async (options: { agent?: AgentKind; session?: string; task?: string; budget?: string; epoch?: string; request?: string }) => {
      const config = readConfig();
      const agent = options.agent ?? config.defaultAgent;
      const store = openStore();
      try {
        const sessionTask = options.session ? config.sessionTasks?.[options.session] : undefined;
        if (options.session && (!sessionTask || (options.task && options.task !== sessionTask))) throw new Error("Session/task mismatch");
        const taskId = sessionTask ?? getActiveTaskId(store, undefined, options.task, agent);
        const pack = await publishContextAsync(store, process.cwd(), taskId, agent, { bootstrap: true, sessionId: options.session, budget: options.budget === undefined ? undefined : Number(options.budget), epoch: options.epoch, currentRequest: options.request });
        console.log(JSON.stringify({ taskId, epoch: options.session ? locateContext(process.cwd(), agent, options.session).epoch : undefined, revision: pack.revision, path: pack.contextPath, tokens: pack.tokenEstimate, tokenCounter: pack.tokenCounter }));
      } finally { store.close(); }
    });

  for (const name of ["query", "expand"] as const) {
    context.command(name).argument("<value>", name === "query" ? "query text" : "memory id")
      .option("--task <taskId>").option("--session <sessionId>").option("--agent <agent>")
      .option("--budget <budget>").option("--limit <limit>")
      .option("--include-repo", "include repository memories in query results")
      .action((value: string, options: { task?: string; session?: string; agent?: AgentKind; budget?: string; limit?: string; includeRepo?: boolean }) => {
        const config = readConfig();
        if (config.contextEfficiency?.query === false) throw new Error("Context retrieval is disabled");
        const store = openStore();
        try {
          const sessionTask = options.session ? config.sessionTasks?.[options.session] : undefined;
          if (options.session && (!sessionTask || (options.task && options.task !== sessionTask))) throw new Error("Session/task mismatch");
          const taskId = sessionTask ?? getActiveTaskId(store, undefined, options.task, options.agent ?? config.defaultAgent);
          const budget = options.budget === undefined ? undefined : Number(options.budget);
          console.log(JSON.stringify(name === "query" ? queryContext(store, process.cwd(), taskId, value, { budget, includeRepo: options.includeRepo, limit: options.limit === undefined ? undefined : Number(options.limit) }) : expandContext(store, process.cwd(), taskId, value, budget)));
        } finally { store.close(); }
      });
  }

  context
    .command("compile")
    .option("--agent <agent>", "target agent")
    .option("--session <sessionId>", "context session")
    .option("--refresh-instructions", "explicitly update managed instructions")
    .option("--manual-lifecycle", "generate manual session instructions when refreshing instructions (hooks disabled)")
    .option("--budget <budget>", "token budget")
    .option("--task <taskId>", "task id")
    .option("--assignment <assignmentId>", "assignment id to inject into the compiled context")
    .option("--output <path>", "output markdown path")
    .option("--precise", "also report an exact token count via a real tokenizer (if configured)")
    .option("--no-repo-map", "deprecated: graph data is never injected into task context")
    .option("--repo-map-limit <n>", "deprecated: use graph map --limit for on-demand navigation")
    .action(
      async (options: {
        agent?: AgentKind;
        session?: string;
        refreshInstructions?: boolean;
        manualLifecycle?: boolean;
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
      if (options.manualLifecycle && !options.refreshInstructions) throw new Error("--manual-lifecycle requires --refresh-instructions");
      const budget = resolveTokenBudget(
        process.cwd(),
        options.budget === undefined ? undefined : Number(options.budget),
      );
      const store = openStore();
      try {
        const taskId = options.session ? config.sessionTasks?.[options.session] : getActiveTaskId(store, undefined, options.task, agent);
        if (!taskId) throw new Error("Unknown context session");
        const countTokens = options.precise ? (await loadOptionalTokenizer()) ?? undefined : undefined;
        const sessionTask = options.session ? config.sessionTasks?.[options.session] : undefined;
        if (options.session && !sessionTask) throw new Error("Unknown session");
        if (options.task && sessionTask && options.task !== sessionTask) throw new Error("Session/task mismatch");
        const pack = await publishContextAsync(store, process.cwd(), sessionTask ?? taskId, agent, {
          sessionId: options.session, budget: options.budget === undefined ? undefined : budget,
          repoMap: options.repoMap, repoMapLimit: options.repoMapLimit === undefined ? undefined : Number(options.repoMapLimit),
          assignmentId: options.assignment, countTokens,
        });
        const output = options.output ?? pack.contextPath;
        if (options.output) writeFileSync(output, pack.renderedMarkdown, "utf8");
        const reportedTokens = pack.tokenEstimate;

        if (options.refreshInstructions) {
        if (agent === "codex") patchManagedSection("AGENTS.md", codexManagedSection({ hooked: !options.manualLifecycle }));
        if (agent === "claude") patchManagedSection("CLAUDE.md", claudeManagedSection({ hooked: !options.manualLifecycle }));
        if (agent === "antigravity") {
          writeAntigravityRules(process.cwd(), { hooked: !options.manualLifecycle });
          const p = paths();
          mkdirSync(p.artifacts, { recursive: true });
          writeFileSync(
            `${p.artifacts}/antigravity-artifact.json`,
            `${JSON.stringify(antigravityArtifact(pack), null, 2)}\n`,
            "utf8"
          );
        }

        }

        // Record the compiled-token estimate so `optimize report` can show a
        // trend over time instead of a one-off self-referential estimate.
        store.addRun({
          taskId,
          agent,
          command: "context compile",
          resultSummary: `Compiled for ${agent}`,
          tokenEstimate: reportedTokens
        });

        console.log(`Compiled context for ${agent}: ${output}`);
        if (countTokens) {
          console.log(`Configured tokenizer tokens: ${reportedTokens}`);
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

  context.command("locate").option("--agent <agent>").option("--session <sessionId>")
    .action((options: { agent?: AgentKind; session?: string }) => {
      const manifest = locateContext(process.cwd(), options.agent ?? readConfig().defaultAgent, options.session);
      console.log(JSON.stringify({ path: manifest.contextPath, mode: manifest.mode,
        taskId: manifest.taskId, agent: manifest.agent, session: manifest.sessionId,
        revision: manifest.revision, requestRevision: manifest.requestRevision,
        budget: manifest.budget, tokens: manifest.tokenEstimate, tokenCounter: manifest.tokenCounter,
        tokenizer: manifest.tokenizer, omitted: manifest.omitted, detailsPath: manifest.detailsPath }));
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

