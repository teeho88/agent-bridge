import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { AgentKind, Handoff, Task } from "@agent-bridge/memory";
import {
  getActiveTaskId,
  openStore,
  parseList,
  readStdinUtf8,
  redactIfEnabled,
  syncCurrentTaskArtifact
} from "../workspace.js";

export function registerHandoff(program: Command): void {
  const handoff = program.command("handoff").description("Create handoff packets");

  handoff
    .command("create")
    .option("--summary <summary>", "handoff summary (omit when using --stdin)")
    .option("--from <agent>", "source agent")
    .option("--task <taskId>", "task id")
    .option("--done <items>", "done items")
    .option("--next <items>", "next actions")
    .option("--risks <items>", "risks")
    .option("--files-changed <items>", "files changed")
    .option("--stdin", "read summary from stdin as raw UTF-8 (safe for non-ASCII)")
    .action(
      async (options: {
        summary?: string;
        from?: AgentKind;
        task?: string;
        done?: string;
        next?: string;
        risks?: string;
        filesChanged?: string;
        stdin?: boolean;
      }) => {
        const rawSummary = options.stdin ? await readStdinUtf8() : options.summary;
        if (!rawSummary) {
          throw new Error("No handoff summary. Provide --summary or pipe text with --stdin.");
        }
        const redactList = (value?: string) => parseList(value).map((item) => redactIfEnabled(item));
        const store = openStore();
        try {
          const taskId = options.task ?? getActiveTaskId(store, undefined, undefined, options.from);
          syncCurrentTaskArtifact(store, taskId);
          const created = store.upsertTaskHandoff({
            taskId,
            fromAgent: options.from,
            summary: redactIfEnabled(rawSummary),
            done: redactList(options.done),
            next: redactList(options.next),
            risks: redactList(options.risks),
            filesChanged: redactList(options.filesChanged)
          });
          writeHandoffArtifacts(process.cwd(), created, {
            archive: true,
            task: store.getTask(taskId)
          });
          store.addMemory({
            taskId,
            type: "handoff",
            content: created.summary,
            summary: created.summary,
            importance: 5,
            sourceAgent: options.from
          });
          console.log(`Created handoff ${created.id}`);
        } finally {
          store.close();
        }
      }
    );
}

function bullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None recorded.";
}

export type HandoffArtifactOptions = {
  // Manual handoffs are durable checkpoints. Auto handoffs refresh CURRENT but
  // deliberately skip history so every Stop hook does not create another file.
  archive?: boolean;
  task?: Task;
};

function numbered(items: string[]): string {
  return items.length
    ? items.map((item, index) => `${index + 1}. **P${index}** ${item}`).join("\n")
    : "1. **P0** Review the live repository state and continue the task.";
}

function portableSlug(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "handoff"
  );
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function renderPortableHandoffMarkdown(
  handoff: Handoff,
  task?: Task
): string {
  const title = task?.title ?? (singleLine(handoff.summary).slice(0, 80) || handoff.taskId);
  const readFirst = handoff.filesChanged.slice(0, 5);
  return [
    `# Handoff — ${title}`,
    "",
    `Date: ${handoff.createdAt}`,
    `Task: ${handoff.taskId}`,
    `From: ${handoff.fromAgent ?? "unknown"}`,
    `State: ${task?.status ?? "active"}`,
    "",
    "## Goal",
    task?.goal ?? handoff.summary,
    "",
    "## Current state",
    handoff.summary,
    "",
    "## Completed",
    bullets(handoff.done),
    "",
    "## Open loops",
    numbered(handoff.next),
    "",
    "## Decisions & gotchas",
    bullets(handoff.risks),
    ...(readFirst.length
      ? [
          "",
          "## Read first",
          ...readFirst.map((path, index) => `${index + 1}. \`${path}\``)
        ]
      : []),
    "",
    "## Start here",
    handoff.next[0] ?? "Verify live repository state, then continue the current task.",
    ""
  ].join("\n");
}

function updatePortableIndex(
  indexPath: string,
  handoff: Handoff,
  historyRelativePath: string,
  task?: Task
): void {
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const entries = existing
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- ") && !line.includes(`| ${historyRelativePath}`));
  const label = singleLine(task?.title ?? handoff.summary).replace(/\|/g, "-");
  const timestamp = handoff.createdAt.replace("T", " ").slice(0, 16);
  const entry = `- ${timestamp} | ${label} | ${task?.status ?? "active"} | ${historyRelativePath}`;
  writeFileSync(indexPath, ["# Handoff Index", "", entry, ...entries.slice(0, 19), ""].join("\n"), "utf8");
}

export function writeHandoffArtifacts(
  cwd: string,
  handoff: Handoff,
  options: HandoffArtifactOptions = {}
): void {
  const portableDir = join(cwd, ".handoff");
  const historyDir = join(portableDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const portable = renderPortableHandoffMarkdown(handoff, options.task);
  writeFileSync(join(portableDir, "CURRENT.md"), portable, "utf8");

  if (options.archive) {
    const timestamp = handoff.createdAt
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 13);
    const suffix = handoff.id.replace(/^handoff-/, "").slice(-8);
    const filename = `${timestamp}-${portableSlug(options.task?.title ?? handoff.summary)}-${suffix}.md`;
    writeFileSync(join(historyDir, filename), portable, "utf8");
    updatePortableIndex(
      join(portableDir, "INDEX.md"),
      handoff,
      `.handoff/history/${filename}`,
      options.task
    );
  }
}
