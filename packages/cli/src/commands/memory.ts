import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { AgentKind, MemoryType } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
  openStoreWithEmbeddings,
  parseList,
  readStdinUtf8,
  redactIfEnabled,
  resolveActiveTaskId
} from "../workspace.js";

export function registerMemory(program: Command): void {
  const memory = program.command("memory").description("Manage memory entries");

  memory
    .command("add")
    .argument("[content]", "memory content (omit when using --stdin)")
    .option("--type <type>", "memory type", "note")
    .option("--task <taskId>", "task id")
    .option("--agent <agent>", "source agent")
    .option("--tags <tags>", "comma-separated tags")
    .option("--importance <importance>", "importance 1-5", "3")
    .option("--stdin", "read content from stdin as raw UTF-8 (safe for non-ASCII)")
    .option("--no-dedup", "always insert; skip near-duplicate merge")
    .action(
      async (
        content: string | undefined,
        options: {
          type: MemoryType;
          task?: string;
          agent?: AgentKind;
          tags?: string;
          importance: string;
          stdin?: boolean;
          dedup?: boolean;
        }
      ) => {
        const text = options.stdin ? await readStdinUtf8() : content;
        if (!text) {
          throw new Error("No memory content. Provide <content> or pipe text with --stdin.");
        }
        const store = openStore();
        try {
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.agent);
          const created = store.addMemory({
            taskId,
            type: options.type,
            content: redactIfEnabled(text),
            tags: parseList(options.tags),
            importance: Number(options.importance),
            sourceAgent: options.agent,
            dedupe: options.dedup
          });
          console.log(`Saved memory ${created.id}`);
        } finally {
          store.close();
        }
      }
    );

  memory
    .command("consolidate")
    .description("Merge clusters of related memories into one representative each")
    .option("--task <taskId>", "task id (defaults to the current task)")
    .option("--threshold <value>", "similarity threshold 0-1 (default 0.5)")
    .option("--min <size>", "minimum cluster size (default 2)")
    .option("--dry-run", "report the plan without changing anything")
    .action((options: { task?: string; threshold?: string; min?: string; dryRun?: boolean }) => {
      const store = openStore();
      try {
        const taskId = options.task ?? resolveActiveTaskId(store) ?? undefined;
        if (!taskId) {
          throw new Error("No task. Pass --task <id> or start a task first.");
        }
        const result = store.consolidateMemories({
          taskId,
          threshold: options.threshold ? Number(options.threshold) : undefined,
          minClusterSize: options.min ? Number(options.min) : undefined,
          dryRun: options.dryRun
        });
        if (!result.clusters.length) {
          console.log("No clusters to consolidate.");
          return;
        }
        console.log(
          `${options.dryRun ? "Would consolidate" : "Consolidated"} ${result.clusters.length} cluster(s), ` +
            `superseding ${result.supersededCount} memories:`
        );
        for (const cluster of result.clusters) {
          console.log(`- (${cluster.supersededIds.length}) ${cluster.representativeContent.slice(0, 100)}`);
        }
      } finally {
        store.close();
      }
    });

  memory
    .command("prune")
    .description("Evict low-value memories to keep the pool within a size cap")
    .option("--max <size>", "maximum pool size (default 2000)")
    .option("--dry-run", "report what would be evicted without deleting")
    .action((options: { max?: string; dryRun?: boolean }) => {
      const store = openStore();
      try {
        const evicted = store.pruneMemories({
          maxPoolSize: options.max ? Number(options.max) : undefined,
          dryRun: options.dryRun
        });
        if (!evicted.length) {
          console.log("Nothing to prune; pool is within the cap.");
          return;
        }
        console.log(`${options.dryRun ? "Would evict" : "Evicted"} ${evicted.length} memories:`);
        for (const memory of evicted) {
          console.log(`- [${memory.type}] (${memory.importance}) ${memory.content.slice(0, 80)}`);
        }
      } finally {
        store.close();
      }
    });

  memory
    .command("list")
    .description("List stored memories (current task by default)")
    .option("--task <taskId>", "filter by task id")
    .option("--all", "list across all tasks")
    .option("--limit <limit>", "result limit", "50")
    .action((options: { task?: string; all?: boolean; limit: string }) => {
      const store = openStore();
      try {
        const taskId = options.all ? undefined : options.task ?? resolveActiveTaskId(store) ?? undefined;
        const results = store.listMemories({ taskId, limit: Number(options.limit) });
        if (!results.length) {
          console.log("No memories found.");
          return;
        }
        for (const result of results) {
          console.log(`- [${result.type}] (${result.importance}) ${result.content}`);
          if (result.tags.length) console.log(`  tags: ${result.tags.join(", ")}`);
        }
      } finally {
        store.close();
      }
    });

  memory
    .command("export")
    .description("Export memories as JSON")
    .option("--task <taskId>", "filter by task id")
    .option("--all", "export across all tasks")
    .option("--limit <limit>", "result limit", "1000")
    .option("--output <path>", "write JSON to a file instead of stdout")
    .action((options: { task?: string; all?: boolean; limit: string; output?: string }) => {
      const store = openStore();
      try {
        const taskId = options.all ? undefined : options.task ?? resolveActiveTaskId(store) ?? undefined;
        const results = store.listMemories({ taskId, limit: Number(options.limit) });
        const json = `${JSON.stringify(results, null, 2)}\n`;
        if (options.output) {
          writeFileSync(options.output, json, "utf8");
          console.log(`Exported ${results.length} memories to ${options.output}`);
        } else {
          process.stdout.write(json);
        }
      } finally {
        store.close();
      }
    });

  memory
    .command("search")
    .argument("<query>", "search query")
    .option("--task <taskId>", "task id")
    .option("--limit <limit>", "result limit", "20")
    .option("--semantic", "blend vector similarity with lexical search (needs an embedding provider)")
    .action(async (query: string, options: { task?: string; limit: string; semantic?: boolean }) => {
      const store = options.semantic ? await openStoreWithEmbeddings() : openStore();
      try {
        const limit = Number(options.limit);
        if (options.semantic && !store.hasEmbeddingProvider()) {
          console.log("Semantic search disabled (no embedding provider); using lexical search.");
        }
        const results =
          options.semantic && store.hasEmbeddingProvider()
            ? await store.semanticSearch(query, { taskId: options.task, limit })
            : store.searchMemories(query, { taskId: options.task, limit });
        if (!results.length) {
          console.log("No memories found.");
          return;
        }
        for (const result of results) {
          console.log(`- [${result.type}] (${result.importance}) ${result.content}`);
          if (result.tags.length) console.log(`  tags: ${result.tags.join(", ")}`);
        }
      } finally {
        store.close();
      }
    });

  memory
    .command("reindex")
    .description("Compute embeddings for memories (requires an embedding provider)")
    .option("--task <taskId>", "limit to one task")
    .action(async (options: { task?: string }) => {
      const store = await openStoreWithEmbeddings();
      try {
        if (!store.hasEmbeddingProvider()) {
          console.log(
            "No embedding provider configured. Set AGENT_BRIDGE_EMBEDDING_MODULE to a module exporting createEmbeddingProvider()."
          );
          return;
        }
        const count = await store.reindexEmbeddings({ taskId: options.task });
        console.log(`Embedded ${count} memories.`);
      } finally {
        store.close();
      }
    });
}
