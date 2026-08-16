import type { Command } from "commander";
import { extractGraph, renderRepoMap, type AgentKind } from "@agent-bridge/memory";
import { contentHash, refreshBriefs } from "../graph-brief.js";
import {
  getActiveTaskId,
  openStore,
  parseList,
  paths,
  readConfig,
  readStdinUtf8,
  redactIfEnabled,
  resolveActiveTaskId
} from "../workspace.js";

export function registerGraph(program: Command): void {
  const graph = program.command("graph").description("Repository knowledge graph for fast, token-frugal repo understanding");

  graph
    .command("build")
    .description("Scan the repo and (re)build the knowledge graph")
    .option("--root <path>", "repo root to scan (default: cwd)")
    .option("--include <paths>", "comma/newline/semicolon-separated repo paths to scan (default: config graph.includePaths)")
    .option("--ignore <paths>", "comma/newline/semicolon-separated extra paths to skip")
    .action((options: { root?: string; include?: string; ignore?: string }) => {
      const root = options.root ?? paths().cwd;
      const config = readConfig();
      const include = options.include != null ? parseList(options.include) : config.graph?.includePaths ?? [];
      const ignore = [
        ...(config.security?.ignorePaths ?? []),
        ...(config.graph?.ignorePaths ?? []),
        ...parseList(options.ignore)
      ];
      const extracted = extractGraph(root, { ignore, include });
      const store = openStore();
      try {
        const result = store.replaceGraph(extracted);
        const stats = store.getGraphStats();
        console.log(`Built graph: ${result.nodes} nodes, ${result.edges} edges.`);
        if (include.length) console.log(`Scan include: ${include.join(", ")}`);
        if (ignore.length) console.log(`Scan ignore: ${ignore.join(", ")}`);
        console.log(`Files: ${stats.files} · Symbols: ${stats.symbols} · Internal edges: ${stats.internalEdges} · External: ${stats.externalEdges}`);
      } finally {
        store.close();
      }
    });

  graph
    .command("brief")
    .description("Create or update a file brief used by the repo map")
    .argument("<path>", "repo-relative file path")
    .argument("[summary]", "short file brief (omit when using --stdin)")
    .option("--stdin", "read brief from stdin as raw UTF-8")
    .option("--priority <n>", "manual priority 1-5 (optional)")
    .option("--ranges <ranges>", "comma/newline/semicolon-separated important ranges, e.g. 10-30")
    .option("--task <taskId>", "task id for --task-edited marker")
    .option("--agent <agent>", "resolve the active task for this agent (defaults to the configured default agent)")
    .option("--task-edited", "mark this file as recently edited by the current task")
    .action(
      async (
        filePath: string,
        summary: string | undefined,
        options: { stdin?: boolean; priority?: string; ranges?: string; task?: string; agent?: AgentKind; taskEdited?: boolean }
      ) => {
        const root = paths().cwd;
        const normalizedPath = filePath.replace(/\\/g, "/");
        const text = options.stdin ? await readStdinUtf8() : summary;
        if (!text) throw new Error("No brief. Provide [summary] or pipe text with --stdin.");
        const store = openStore();
        try {
          const taskId = options.taskEdited
            ? getActiveTaskId(store, undefined, options.task, options.agent)
            : options.task;
          if (options.taskEdited) assertWriteLeases(store, taskId, [normalizedPath]);
          const file = store.upsertFileSummary({
            path: normalizedPath,
            summary: redactIfEnabled(text),
            manualPriority: options.priority == null ? undefined : Number(options.priority),
            importantRanges: parseList(options.ranges),
            lastSeenHash: contentHash(root, normalizedPath),
            lastTaskId: taskId,
            markTaskEdited: options.taskEdited
          });
          console.log(`Saved brief for ${file.path}${file.manualPriority == null ? "" : ` (priority ${file.manualPriority})`}.`);
        } finally {
          store.close();
        }
      }
    );

  graph
    .command("brief-auto")
    .description("Automatically generate sparse file briefs from the graph index")
    .argument("[paths...]", "repo-relative file path(s); omit when using --all")
    .option("--all", "refresh briefs for every file indexed in the graph")
    .option("--priority <n>", "manual priority 1-5; omitted values are preserved")
    .option("--task <taskId>", "task id for task association")
    .option("--agent <agent>", "resolve the active task for this agent (defaults to the configured default agent)")
    .option("--task-edited", "mark these files as recently edited by the current task")
    .action((filePaths: string[], options: { all?: boolean; priority?: string; task?: string; agent?: AgentKind; taskEdited?: boolean }) => {
      const root = paths().cwd;
      const store = openStore();
      try {
        if (options.all) {
          if (store.getGraphStats().files === 0) {
            console.log("No graph yet. Run `agent-bridge graph build`.");
            return;
          }
        } else if (!filePaths.length) {
          throw new Error("Provide <paths...> or use --all.");
        }

        // Resolve against the calling agent's own current task. Without the
        // agent this falls back to the default agent's task, so a lease taken
        // as `--agent claude` looked like another task's lease and blocked the
        // very edit it was meant to authorise.
        const taskId = options.task ?? resolveActiveTaskId(store, undefined, undefined, options.agent) ?? undefined;
        const targetPaths = options.all ? store.listGraphFiles(5000).map((file) => file.path) : filePaths.map((filePath) => filePath.replace(/\\/g, "/"));
        if (options.taskEdited) assertWriteLeases(store, taskId, targetPaths);
        const results = refreshBriefs(store, root, {
          paths: targetPaths,
          all: false,
          manualPriority: options.priority != null ? Number(options.priority) : undefined,
          taskId,
          taskEdited: options.taskEdited
        });

        if (options.all) console.log(`Refreshed ${results.length} briefs.`);
        else
          results.forEach((file) =>
            console.log(
              `${file.reused ? "Reused cached brief for" : "Saved auto brief for"} ${file.path}${file.manualPriority == null ? "" : ` (priority ${file.manualPriority})`}.`
            )
          );
      } finally {
        store.close();
      }
    });

  graph
    .command("stats")
    .description("Show graph size")
    .action(() => {
      const store = openStore();
      try {
        const stats = store.getGraphStats();
        if (!stats.files) {
          console.log("No graph yet. Run `agent-bridge graph build`.");
          return;
        }
        console.log(
          `Files: ${stats.files}\nSymbols: ${stats.symbols}\nImport edges: ${stats.edges} (internal ${stats.internalEdges}, external ${stats.externalEdges})`
        );
      } finally {
        store.close();
      }
    });

  graph
    .command("neighbors")
    .description("Show what a file imports (out) and which files import it (in)")
    .argument("<path>", "repo-relative file path")
    .action((path: string) => {
      const store = openStore();
      try {
        const imports = store.getImports(path);
        const dependents = store.getDependents(path);
        console.log(`# ${path}`);
        console.log(`\nImports (internal): ${imports.internal.length ? imports.internal.join(", ") : "none"}`);
        console.log(`Imports (external): ${imports.external.length ? imports.external.join(", ") : "none"}`);
        console.log(`Used by (${dependents.length}): ${dependents.length ? dependents.join(", ") : "none"}`);
      } finally {
        store.close();
      }
    });

  graph
    .command("dependents")
    .description("List files that import the given file")
    .argument("<path>", "repo-relative file path")
    .action((path: string) => {
      const store = openStore();
      try {
        const dependents = store.getDependents(path);
        if (!dependents.length) console.log(`No files import ${path}.`);
        else dependents.forEach((dependent) => console.log(dependent));
      } finally {
        store.close();
      }
    });

  graph
    .command("symbols")
    .description("List symbols defined in a file")
    .argument("<path>", "repo-relative file path")
    .action((path: string) => {
      const store = openStore();
      try {
        const symbols = store.getFileSymbols(path);
        if (!symbols.length) console.log(`No symbols recorded for ${path}.`);
        else symbols.forEach((symbol) => console.log(`${symbol.line}\t${symbol.symbolKind}\t${symbol.name}`));
      } finally {
        store.close();
      }
    });

  graph
    .command("search")
    .description("Find files/symbols by name or path (accent-insensitive)")
    .argument("<query>", "search text")
    .option("--kind <kind>", "limit to 'file' or 'symbol'")
    .option("--limit <n>", "max results", "30")
    .action((query: string, options: { kind?: "file" | "symbol"; limit: string }) => {
      const store = openStore();
      try {
        const nodes = store.searchGraphNodes(query, { kind: options.kind, limit: Number(options.limit) });
        if (!nodes.length) {
          console.log("No matches.");
          return;
        }
        for (const node of nodes) {
          if (node.kind === "symbol") console.log(`${node.path}:${node.line}\t${node.symbolKind} ${node.name}`);
          else console.log(`${node.path}\t(file, ${node.language ?? "?"})`);
        }
      } finally {
        store.close();
      }
    });

  graph
    .command("map")
    .description("Print a compact structural repo map (manual priority and fan-in first)")
    .option("--limit <n>", "max files", "40")
    .option("--focus <paths>", "comma-separated path substrings to focus on")
    .action((options: { limit: string; focus?: string }) => {
      const store = openStore();
      try {
        const focusPaths = options.focus ? options.focus.split(",").map((value) => value.trim()).filter(Boolean) : undefined;
        const files = store.buildRepoMap({ limit: Number(options.limit), focusPaths });
        console.log(renderRepoMap(files));
      } finally {
        store.close();
      }
    });
}

export function assertWriteLeases(store: ReturnType<typeof openStore>, taskId: string | undefined, filePaths: string[]): void {
  if (!taskId) throw new Error("--task-edited requires an active task. Run `agent-bridge task start --agent <agent>` first.");

  const missing: string[] = [];
  const blocked: string[] = [];
  for (const filePath of [...new Set(filePaths.map((path) => path.replace(/\\/g, "/")))]) {
    const leases = store.listFileLeases({ path: filePath, activeOnly: true, limit: 50 });
    if (leases.some((lease) => lease.taskId === taskId && lease.mode === "write")) continue;

    const blockingLease = leases.find((lease) => lease.taskId !== taskId);
    if (blockingLease) blocked.push(`${filePath} (held by ${blockingLease.agent ?? "unknown"} on ${blockingLease.taskId})`);
    else missing.push(filePath);
  }

  if (!missing.length && !blocked.length) return;

  const details = [
    `Resolved current task: ${taskId}`,
    blocked.length ? `Conflicting active lease(s): ${blocked.join(", ")}` : undefined,
    missing.length ? `Missing write lease(s): ${missing.join(", ")}` : undefined,
    'Acquire a write lease before editing: agent-bridge file lease "<repo-relative-path>" --mode write --agent <agent>',
    "Do not mark a file task-edited until the lease response has acquired=true.",
    blocked.length
      ? "If a blocking lease is your own, you resolved a different task than the lease: pass the same --agent <agent> (or --task <taskId>) you used to take it."
      : undefined
  ].filter(Boolean);
  throw new Error(details.join("\n"));
}